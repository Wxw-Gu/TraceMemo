import crypto from 'node:crypto'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  tempDirectory: '',
  fetch: vi.fn(),
  install: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'temp' ? mocks.tempDirectory : mocks.tempDirectory)
  }
}))

vi.mock('../../src/main/report-template-service', () => ({
  reportTemplateService: {
    install: mocks.install
  }
}))

import { ReportTemplateMarketService } from '../../src/main/report-template-market-service'
import { REPORT_TEMPLATE_CATALOG_URL } from '../../src/shared/report-template-market'
import {
  decodeExternalReportTemplateId,
  encodeExternalReportTemplateId
} from '../../src/shared/report-templates'

const commit = 'a'.repeat(40)
const packageBytes = Buffer.from('fixture-template-package')
const packageSha256 = crypto.createHash('sha256').update(packageBytes).digest('hex')
const templateId = 'community.github.tracememo.quickread'
const templateVersion = '1.0.0'
const downloadUrl = `https://raw.githubusercontent.com/Wxw-Gu/TraceMemo-Templates/${commit}/packages/${templateId}/${templateVersion}/${templateId}-${templateVersion}.zip`
const previewUrl = `https://raw.githubusercontent.com/Wxw-Gu/TraceMemo-Templates/${commit}/previews/${templateId}/${templateVersion}.png`

const catalog = (
  patch: Record<string, unknown> = {}
): {
  schemaVersion: string
  generatedAt: string
  source: { repository: string; commit: string }
  status: string
  templates: Array<Record<string, unknown>>
} => ({
  schemaVersion: '1',
  generatedAt: '2026-09-07T08:08:13Z',
  source: { repository: 'Wxw-Gu/TraceMemo-Templates', commit },
  status: 'published',
  templates: [
    {
      id: templateId,
      version: templateVersion,
      interfaceVersion: '1',
      name: '极简速读',
      description: '虚构模板目录条目',
      author: 'fixture',
      platform: 'mobile',
      tags: ['fixture'],
      license: 'MIT',
      minAppVersion: null,
      download: downloadUrl,
      sizeBytes: packageBytes.length,
      sha256: packageSha256,
      preview: previewUrl,
      publishedAt: '2026-09-07T08:08:13Z',
      status: 'published'
    }
  ],
  ...patch
})

const responseFor = (body: Buffer | string, status = 200): Response =>
  new Response(body, {
    status,
    headers: { 'content-length': String(Buffer.byteLength(body)) }
  })

const installResult = {
  id: templateId,
  version: templateVersion,
  interfaceVersion: '1',
  source: 'installed' as const,
  name: '极简速读',
  author: 'fixture',
  entryPath: '/tmp/fixture-template/template.html',
  capture: { width: 430, maxWidth: 430, maxHeight: 20_000 },
  license: { spdx: 'MIT' }
}

describe('ReportTemplateMarketService', () => {
  let service: ReportTemplateMarketService

  beforeEach(async () => {
    mocks.tempDirectory = await mkdtemp(join(tmpdir(), 'tracememo-template-market-test-'))
    service = new ReportTemplateMarketService()
    mocks.fetch.mockReset()
    mocks.install.mockReset()
    vi.stubGlobal('fetch', mocks.fetch)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(mocks.tempDirectory, { recursive: true, force: true })
  })

  it('loads and normalizes a published catalog entry from the fixed raw URL', async () => {
    mocks.fetch.mockResolvedValueOnce(responseFor(JSON.stringify(catalog())))

    const result = await service.listCatalog()

    expect(result).toEqual({ success: true, catalog: catalog() })
    expect(mocks.fetch).toHaveBeenCalledOnce()
    expect(mocks.fetch).toHaveBeenCalledWith(
      new URL(REPORT_TEMPLATE_CATALOG_URL),
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'application/json, application/zip, image/png',
          'User-Agent': 'TraceMemo'
        }),
        redirect: 'error'
      })
    )
  })

  it('rejects incompatible interfaces and non-raw download URLs before install', async () => {
    mocks.fetch.mockResolvedValueOnce(
      responseFor(JSON.stringify(catalog({ templates: [{ ...catalog().templates[0], interfaceVersion: '2' }] })))
    )

    const incompatible = await service.listCatalog()

    expect(incompatible.success).toBe(false)
    expect(incompatible.code).toBe('unsupported_interface')
    expect(incompatible.error).toContain('模板接口版本不兼容')

    mocks.fetch.mockReset()
    mocks.fetch.mockResolvedValueOnce(
      responseFor(JSON.stringify(catalog({ templates: [{ ...catalog().templates[0], download: 'https://evil.example/template.zip' }] })))
    )

    const invalidUrl = await service.listCatalog()

    expect(invalidUrl.success).toBe(false)
    expect(invalidUrl.code).toBe('invalid_catalog')
    expect(invalidUrl.error).toContain('只允许 GitHub raw HTTPS 地址')
    expect(mocks.install).not.toHaveBeenCalled()
  })

  it('rejects a catalog URL from another raw GitHub repository', async () => {
    mocks.fetch.mockResolvedValueOnce(
      responseFor(
        JSON.stringify(
          catalog({
            templates: [
              {
                ...catalog().templates[0],
                download: `https://raw.githubusercontent.com/another-owner/another-repo/${commit}/template.zip`
              }
            ]
          })
        )
      )
    )

    const result = await service.listCatalog()

    expect(result.success).toBe(false)
    expect(result.code).toBe('invalid_catalog')
    expect(result.error).toContain('只允许 GitHub raw HTTPS 地址')
  })

  it('rejects package references that are not pinned to the catalog source commit', async () => {
    mocks.fetch.mockResolvedValueOnce(
      responseFor(
        JSON.stringify(
          catalog({
            templates: [
              {
                ...catalog().templates[0],
                download: `https://raw.githubusercontent.com/Wxw-Gu/TraceMemo-Templates/${'b'.repeat(40)}/packages/${templateId}/${templateVersion}/${templateId}-${templateVersion}.zip`
              }
            ]
          })
        )
      )
    )

    const result = await service.listCatalog()

    expect(result.success).toBe(false)
    expect(result.code).toBe('invalid_catalog')
    expect(result.error).toContain('未固定到目录 source.commit')
  })

  it('reports a missing catalog version without downloading a package', async () => {
    mocks.fetch.mockResolvedValueOnce(responseFor(JSON.stringify(catalog())))

    const result = await service.installFromCatalog(templateId, '9.9.9')

    expect(result).toEqual({
      success: false,
      code: 'catalog_template_not_found',
      error: `远端目录不存在：${templateId}@9.9.9`
    })
    expect(mocks.fetch).toHaveBeenCalledOnce()
    expect(mocks.install).not.toHaveBeenCalled()
  })

  it('rejects a package when downloaded bytes do not match catalog size or SHA-256', async () => {
    mocks.fetch
      .mockResolvedValueOnce(responseFor(JSON.stringify(catalog())))
      .mockResolvedValueOnce(responseFor(Buffer.from('tampered-package')))

    const result = await service.installFromCatalog(templateId, templateVersion)

    expect(result).toMatchObject({
      success: false,
      code: 'download_integrity_failed',
      catalogEntry: expect.objectContaining({ id: templateId, version: templateVersion })
    })
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    expect(mocks.install).not.toHaveBeenCalled()
  })

  it('writes a verified package to a temporary path, installs it, and removes the temporary directory', async () => {
    mocks.fetch
      .mockResolvedValueOnce(responseFor(JSON.stringify(catalog())))
      .mockResolvedValueOnce(responseFor(packageBytes))
    let packagePath = ''
    mocks.install.mockImplementationOnce(async (candidatePath: string) => {
      packagePath = candidatePath
      await expect(readFile(candidatePath)).resolves.toEqual(packageBytes)
      return installResult
    })

    const result = await service.installFromCatalog(templateId, templateVersion)

    expect(result).toEqual({ success: true, template: installResult, catalogEntry: catalog().templates[0] })
    expect(mocks.install).toHaveBeenCalledOnce()
    expect(packagePath).toContain(`${templateId}-${templateVersion}.zip`)
    await expect(access(packagePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('external report template selection keys', () => {
  it('round-trips IDs and versions without collapsing them into built-in IDs', () => {
    const selectionId = encodeExternalReportTemplateId(templateId, templateVersion)

    expect(selectionId).toBe(`external:${templateId}@${templateVersion}`)
    expect(decodeExternalReportTemplateId(selectionId)).toEqual({
      id: templateId,
      version: templateVersion
    })
  })

  it('rejects malformed, incomplete, or non-string external keys', () => {
    for (const value of [
      undefined,
      null,
      'mobile-feed',
      'external:',
      'external:community.github.example@',
      'external:@1.0.0',
      'external:community.github.example@1.0.0@extra',
      'external:community.github.example'
    ]) {
      expect(decodeExternalReportTemplateId(value)).toBeNull()
    }
  })
})
