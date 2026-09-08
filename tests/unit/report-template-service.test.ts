import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { ZipArchive } from 'archiver'

const mockPaths = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => mockPaths.userData } }))
const userData = await mkdtemp(join(tmpdir(), 'tracememo-template-service-'))
mockPaths.userData = userData

import { ReportTemplateError, REPORT_TEMPLATE_LIMITS } from '../../src/shared/report-template-package'
import { ReportTemplateService } from '../../src/main/report-template-service'

async function makeZip(files: Record<string, string | Buffer>): Promise<string> {
  const zipPath = join(userData, `${Math.random().toString(36).slice(2)}.zip`)
  const output = (await import('node:fs')).createWriteStream(zipPath)
  const archive = new ZipArchive({ zlib: { level: 6 } })
  archive.pipe(output)
  for (const [name, content] of Object.entries(files)) archive.append(content, { name })
  await archive.finalize()
  await new Promise<void>((resolve, reject) => {
    output.on('close', () => resolve())
    output.on('error', reject)
  })
  return zipPath
}

const manifest = (patch: Record<string, unknown> = {}): string => JSON.stringify({
  protocolVersion: '1.0', kind: 'daily-report', id: 'community.github.example.basic-feed', name: '示例',
  author: { name: 'example' }, templateVersion: '1.0.0', interfaceVersion: '1', entry: 'template.html',
  capture: { width: 430, maxWidth: 430, maxHeight: 20000 }, license: { spdx: 'MIT' }, ...patch
})

describe('ReportTemplateService', () => {
  let service: ReportTemplateService
  beforeEach(() => { service = new ReportTemplateService() })
  afterEach(async () => { await rm(join(userData, 'report-templates'), { recursive: true, force: true }) })

  it('installs, lists, reloads and uninstalls a valid package', async () => {
    const zip = await makeZip({ 'manifest.json': manifest(), 'template.html': '<!doctype html><html><head><style>.x{color:red}</style></head><body><h1 class="{{TOPICS_EMPTY_CLASS}}">{{REPORT_TITLE}}</h1></body></html>' })
    const installed = await service.install(zip)
    expect(installed.source).toBe('installed')
    expect((await service.list()).some((item) => item.id === installed.id)).toBe(true)
    const reloaded = new ReportTemplateService()
    expect((await reloaded.list()).find((item) => item.id === installed.id)?.version).toBe('1.0.0')
    await service.uninstall(installed.id, installed.version)
    expect((await service.list()).some((item) => item.id === installed.id)).toBe(false)
  })

  it('rejects missing or incompatible manifest fields', async () => {
    const missing = await makeZip({ 'manifest.json': '{}', 'template.html': '<p>x</p>' })
    await expect(service.install(missing)).rejects.toMatchObject({ code: 'unsupported_protocol' })
    const incompatible = await makeZip({ 'manifest.json': manifest({ interfaceVersion: '2' }), 'template.html': '<p>x</p>' })
    await expect(service.install(incompatible)).rejects.toMatchObject({ code: 'unsupported_interface' })
  })

  it('rejects dangerous HTML, invalid interpolation and duplicate paths', async () => {
    const dangerous = await makeZip({ 'manifest.json': manifest(), 'template.html': '<script>alert(1)</script>' })
    await expect(service.install(dangerous)).rejects.toBeInstanceOf(ReportTemplateError)
    const attr = await makeZip({ 'manifest.json': manifest(), 'template.html': '<div class="{{REPORT_TITLE}}"></div>' })
    await expect(service.install(attr)).rejects.toMatchObject({ code: 'invalid_placeholder_context' })
    const css = await makeZip({ 'manifest.json': manifest(), 'template.html': '<style>.x{background:url(https://evil.test/a.png)}</style>' })
    await expect(service.install(css)).rejects.toMatchObject({ code: 'unsafe_url' })
    const missingAsset = await makeZip({ 'manifest.json': manifest(), 'template.html': '<img src="assets/missing.png">' })
    await expect(service.install(missingAsset)).rejects.toMatchObject({ code: 'missing_asset' })
    const validKinds = await makeZip({ 'manifest.json': manifest(), 'template.html': '<div class="{{TOPICS_EMPTY_CLASS}}">{{TOPICS_MORE_NOTE}}</div>' })
    await expect(service.install(validKinds)).resolves.toMatchObject({ id: 'community.github.example.basic-feed' })
    const duplicate = await makeZip({ 'manifest.json': manifest(), 'template.html': '<p>x</p>', 'TEMPLATE.HTML': '<p>y</p>' })
    await expect(service.install(duplicate)).rejects.toMatchObject({ code: 'duplicate_entry' })
  })

  it('rejects traversal and oversized packages before staging output', async () => {
    const traversal = await makeZip({ 'manifest.json': manifest(), '../escape.txt': 'x', 'template.html': '<p>x</p>' })
    await expect(service.install(traversal)).rejects.toBeInstanceOf(ReportTemplateError)
    const oversized = await makeZip({ 'manifest.json': manifest(), 'template.html': Buffer.alloc(REPORT_TEMPLATE_LIMITS.maxFileBytes + 1) })
    await expect(service.install(oversized)).rejects.toMatchObject({ code: 'file_too_large' })
    await expect(readFile(join(userData, 'escape.txt'))).rejects.toBeDefined()
  })

  it('rejects an uninstall reference that could escape the registry directory', async () => {
    await expect(service.uninstall('../outside', '1.0.0')).rejects.toMatchObject({
      code: 'invalid_template_ref'
    })
    await expect(
      service.uninstall('community.github.example.basic-feed', '../outside')
    ).rejects.toMatchObject({ code: 'invalid_template_ref' })
  })

  it('rejects external refs that target built-in templates', async () => {
    await expect(service.resolve({ id: 'v1', version: '1.0.0' })).rejects.toMatchObject({
      code: 'builtin_template_ref'
    })
  })

  it('checks an expected catalog identity before staging a package', async () => {
    const zip = await makeZip({
      'manifest.json': manifest(),
      'template.html': '<p>{{REPORT_TITLE}}</p>'
    })
    await expect(
      service.install(zip, {
        id: 'community.github.example.other-template',
        version: '1.0.0'
      })
    ).rejects.toMatchObject({ code: 'catalog_manifest_mismatch' })
  })

  it('is idempotent for identical versions and rejects content conflicts', async () => {
    const first = await makeZip({ 'manifest.json': manifest(), 'template.html': '<p>a</p>' })
    const second = await makeZip({ 'manifest.json': manifest(), 'template.html': '<p>b</p>' })
    const installed = await service.install(first)
    await expect(service.install(first)).resolves.toMatchObject({ id: installed.id, version: installed.version })
    await expect(service.install(second)).rejects.toMatchObject({ code: 'version_conflict' })
    expect(await readdir(join(userData, 'report-templates', 'staging'))).toHaveLength(0)
  })

  it('rebuilds a damaged index from installed manifests', async () => {
    const zip = await makeZip({ 'manifest.json': manifest({ templateVersion: '2.0.0' }), 'template.html': '<p>{{REPORT_TITLE}}</p>' })
    const installed = await service.install(zip)
    await writeFile(join(userData, 'report-templates', 'index.json'), '{broken', 'utf8')
    const recovered = new ReportTemplateService()
    await recovered.recover()
    expect((await recovered.list()).find((item) => item.id === installed.id && item.version === '2.0.0')?.entryPath).toContain('installed')
  })
})
