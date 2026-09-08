import crypto from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import {
  REPORT_TEMPLATE_INTERFACE_VERSION,
  REPORT_TEMPLATE_LIMITS,
  ReportTemplateError,
  type ReportTemplateOperationResult
} from '../shared/report-template-package'
import {
  REPORT_TEMPLATE_CATALOG_URL,
  type ReportTemplateCatalog,
  type ReportTemplateCatalogEntry,
  type ReportTemplateCatalogInstallResult,
  type ReportTemplateCatalogResult
} from '../shared/report-template-market'
import { reportTemplateService } from './report-template-service'

const CATALOG_MAX_BYTES = 2 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 15_000
const SAFE_ID = /^community\.github\.[a-z0-9][a-z0-9-]{0,38}\.[a-z0-9][a-z0-9-]{0,63}$/
const SAFE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/
const SHA256 = /^[a-f0-9]{64}$/
const COMMIT = /^[a-f0-9]{40}$/
const RAW_HOST = 'raw.githubusercontent.com'
const RAW_REPOSITORY_PREFIX = '/Wxw-Gu/TraceMemo-Templates/'

const operationError = (fallbackCode: string, error: unknown): ReportTemplateOperationResult => ({
  success: false,
  code: error instanceof ReportTemplateError ? error.code : fallbackCode,
  error: error instanceof Error ? error.message : String(error)
})

const assertAllowedRemoteUrl = (value: unknown, label: string): URL => {
  let parsed: URL
  try {
    parsed = new URL(String(value || ''))
  } catch {
    throw new ReportTemplateError('invalid_catalog', `${label} URL 无效`)
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== RAW_HOST ||
    parsed.port !== '' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !parsed.pathname.startsWith(RAW_REPOSITORY_PREFIX)
  ) {
    throw new ReportTemplateError('invalid_catalog', `${label} 只允许 GitHub raw HTTPS 地址`)
  }
  return parsed
}

const assertAllowedPackageUrl = (value: unknown, label: string): URL => {
  const parsed = assertAllowedRemoteUrl(value, label)
  const segments = parsed.pathname.split('/').filter(Boolean)
  if (segments.length < 4 || !COMMIT.test(segments[2])) {
    throw new ReportTemplateError('invalid_catalog', `${label} 必须固定到模板仓库 commit`)
  }
  return parsed
}

const remoteCommit = (value: string): string | undefined => {
  try {
    return new URL(value).pathname.split('/').filter(Boolean)[2]
  } catch {
    return undefined
  }
}

const fetchBytes = async (url: URL, maxBytes: number): Promise<Buffer> => {
  const response = await fetch(url, {
    headers: { Accept: 'application/json, application/zip, image/png', 'User-Agent': 'TraceMemo' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: 'error'
  })
  if (!response.ok) throw new ReportTemplateError('catalog_fetch_failed', `远端请求失败：HTTP ${response.status}`)
  const contentLength = Number(response.headers.get('content-length') || 0)
  if (contentLength > maxBytes) throw new ReportTemplateError('catalog_too_large', '远端模板目录或包超过大小限制')
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > maxBytes) throw new ReportTemplateError('catalog_too_large', '远端模板目录或包超过大小限制')
    return bytes
  }
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new ReportTemplateError('catalog_too_large', '远端模板目录或包超过大小限制')
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

const validateCatalogEntry = (value: unknown): ReportTemplateCatalogEntry => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ReportTemplateError('invalid_catalog', '目录条目必须是对象')
  }
  const entry = value as Record<string, unknown>
  const id = String(entry.id || '')
  const version = String(entry.version || '')
  const interfaceVersion = String(entry.interfaceVersion || '')
  const sizeBytes = Number(entry.sizeBytes)
  if (!SAFE_ID.test(id) || !SAFE_VERSION.test(version)) {
    throw new ReportTemplateError('invalid_catalog', '目录模板 ID 或版本无效')
  }
  if (interfaceVersion !== REPORT_TEMPLATE_INTERFACE_VERSION) {
    throw new ReportTemplateError('unsupported_interface', `模板接口版本不兼容：${interfaceVersion}`)
  }
  if (entry.status !== 'published' || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > REPORT_TEMPLATE_LIMITS.maxCompressedBytes) {
    throw new ReportTemplateError('invalid_catalog', `${id}@${version} 目录状态或大小无效`)
  }
  if (typeof entry.name !== 'string' || !entry.name.trim() || typeof entry.description !== 'string' || typeof entry.author !== 'string') {
    throw new ReportTemplateError('invalid_catalog', `${id}@${version} 目录名称或作者无效`)
  }
  if (!SHA256.test(String(entry.sha256 || ''))) throw new ReportTemplateError('invalid_catalog', `${id}@${version} SHA-256 无效`)
  const download = assertAllowedPackageUrl(entry.download, 'download')
  const preview = entry.preview === undefined || entry.preview === null ? undefined : assertAllowedPackageUrl(entry.preview, 'preview')
  const platform = entry.platform === 'mobile' || entry.platform === 'desktop' || entry.platform === 'default' ? entry.platform : undefined
  const tags = Array.isArray(entry.tags) && entry.tags.every((tag) => typeof tag === 'string') ? entry.tags : []
  return {
    id,
    version,
    interfaceVersion,
    name: entry.name.trim(),
    description: entry.description,
    author: entry.author,
    ...(platform ? { platform } : {}),
    tags,
    license: typeof entry.license === 'string' ? entry.license : '',
    minAppVersion: typeof entry.minAppVersion === 'string' ? entry.minAppVersion : null,
    download: download.toString(),
    sizeBytes,
    sha256: String(entry.sha256),
    ...(preview ? { preview: preview.toString() } : {}),
    publishedAt: typeof entry.publishedAt === 'string' ? entry.publishedAt : null,
    status: 'published'
  }
}

const parseCatalog = (bytes: Buffer): ReportTemplateCatalog => {
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new ReportTemplateError('invalid_catalog', '远端模板目录不是有效 JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ReportTemplateError('invalid_catalog', '远端模板目录格式无效')
  }
  const raw = value as Record<string, unknown>
  if (raw.schemaVersion !== '1' || raw.status !== 'published' || !Array.isArray(raw.templates) || raw.templates.length > 100) {
    throw new ReportTemplateError('invalid_catalog', '远端模板目录版本或状态无效')
  }
  const seen = new Set<string>()
  const templates = raw.templates.map(validateCatalogEntry)
  for (const entry of templates) {
    const key = `${entry.id}@${entry.version}`
    if (seen.has(key)) throw new ReportTemplateError('invalid_catalog', `目录包含重复模板：${key}`)
    seen.add(key)
  }
  const source = raw.source && typeof raw.source === 'object' && !Array.isArray(raw.source)
    ? raw.source as Record<string, unknown>
    : undefined
  if (
    !source ||
    source.repository !== 'Wxw-Gu/TraceMemo-Templates' ||
    !COMMIT.test(String(source.commit || ''))
  ) {
    throw new ReportTemplateError('invalid_catalog', '目录 source.repository 或 source.commit 无效')
  }
  for (const entry of templates) {
    if (
      remoteCommit(entry.download) !== source.commit ||
      (entry.preview !== undefined && remoteCommit(entry.preview) !== source.commit)
    ) {
      throw new ReportTemplateError('invalid_catalog', `${entry.id}@${entry.version} 未固定到目录 source.commit`)
    }
  }
  return {
    schemaVersion: '1',
    ...(typeof raw.generatedAt === 'string' ? { generatedAt: raw.generatedAt } : {}),
    ...(source ? { source: { ...(typeof source.repository === 'string' ? { repository: source.repository } : {}), ...(typeof source.commit === 'string' ? { commit: source.commit } : {}) } } : {}),
    status: 'published',
    templates
  }
}

const fetchCatalog = async (): Promise<ReportTemplateCatalog> => {
  const url = assertAllowedRemoteUrl(REPORT_TEMPLATE_CATALOG_URL, 'catalog')
  return parseCatalog(await fetchBytes(url, CATALOG_MAX_BYTES))
}

export class ReportTemplateMarketService {
  async listCatalog(): Promise<ReportTemplateCatalogResult> {
    try {
      return { success: true, catalog: await fetchCatalog() }
    } catch (error) {
      return operationError('catalog_fetch_failed', error) as ReportTemplateCatalogResult
    }
  }

  async installFromCatalog(id: string, version: string): Promise<ReportTemplateCatalogInstallResult> {
    let temporaryDirectory: string | undefined
    try {
      const catalog = await fetchCatalog()
      const entry = catalog.templates.find((candidate) => candidate.id === id && candidate.version === version)
      if (!entry) return { success: false, code: 'catalog_template_not_found', error: `远端目录不存在：${id}@${version}` }
      const bytes = await fetchBytes(assertAllowedPackageUrl(entry.download, 'download'), REPORT_TEMPLATE_LIMITS.maxCompressedBytes)
      const digest = crypto.createHash('sha256').update(bytes).digest('hex')
      if (bytes.length !== entry.sizeBytes || digest !== entry.sha256) {
        return { success: false, code: 'download_integrity_failed', error: `模板包校验失败：${id}@${version}`, catalogEntry: entry }
      }
      temporaryDirectory = await fs.mkdtemp(path.join(app.getPath('temp'), 'tracememo-template-market-'))
      const packagePath = path.join(temporaryDirectory, `${id}-${version}.zip`)
      await fs.writeFile(packagePath, bytes, { flag: 'wx' })
      const template = await reportTemplateService.install(packagePath, {
        id: entry.id,
        version: entry.version
      })
      return { success: true, template, catalogEntry: entry }
    } catch (error) {
      return { ...(operationError('market_install_failed', error) as ReportTemplateCatalogInstallResult) }
    } finally {
      if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

export const reportTemplateMarketService = new ReportTemplateMarketService()
