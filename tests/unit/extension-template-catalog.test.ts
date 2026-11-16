import { createRequire } from 'node:module'
import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExtensionTemplateCatalog } from '../../src/main/extensions/extension-template-catalog'
import type { ExtensionRegistryRecord } from '../../src/main/extensions/extension-registry'

const require = createRequire(import.meta.url)
const {
  buildTemplates
}: {
  buildTemplates: (options?: Record<string, unknown>) => unknown
} = require('../../scripts/build-extension-templates.cjs')

const roots: string[] = []

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-catalog-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.removeSync(root)
})

interface Harness {
  root: string
  catalog: ExtensionTemplateCatalog
  records: Map<string, ExtensionRegistryRecord>
}

function setup(
  options: { records?: ExtensionRegistryRecord[]; platform?: NodeJS.Platform } = {}
): Harness {
  const work = tempRoot()
  const sourceRoot = path.join(work, 'examples')
  fs.copySync(path.join(process.cwd(), 'examples/extensions'), sourceRoot)
  const templateRoot = path.join(work, 'templates')
  buildTemplates({
    sourceRoot,
    outputDir: templateRoot,
    lockFile: path.join(work, 'lock.json')
  })

  const records = new Map<string, ExtensionRegistryRecord>()
  for (const record of options.records ?? []) records.set(record.id, record)

  const catalog = new ExtensionTemplateCatalog({
    templateRoot,
    getRecord: (id) => records.get(id),
    resolveInstallDir: (id) => path.join(work, 'extensions', id),
    platform: options.platform ?? 'darwin',
    probePython: () => '/usr/bin/python3',
    probeChrome: () => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  })
  return { root: work, catalog, records }
}

function record(overrides: Partial<ExtensionRegistryRecord>): ExtensionRegistryRecord {
  return {
    id: 'com.example.keyword-bot',
    version: '1.0.1',
    apiVersion: '1',
    enabled: false,
    grantedPermissions: [],
    installedAt: 1,
    updatedAt: 1,
    source: 'template',
    templateId: 'keyword-bot',
    templateVersion: '1.0.1',
    ...overrides
  }
}

describe('官方模板目录', () => {
  it('列出两个模板，未安装时状态为 not-installed', async () => {
    const { catalog } = setup()
    const list = await catalog.list()
    expect(list.map((item) => item.template.templateId).sort()).toEqual([
      'douyin-sender',
      'keyword-bot'
    ])
    expect(list.every((item) => item.state === 'not-installed')).toBe(true)
    // 版本来自 manifest，不是硬编码。
    const keyword = list.find((item) => item.template.templateId === 'keyword-bot')
    expect(keyword?.template.version).toBe('1.0.1')
  })

  it('已安装同版本显示 installed，本地版本更新时也视为已安装', async () => {
    const { catalog } = setup({
      records: [
        record({ version: '1.0.1' }),
        record({ id: 'com.example.douyin-sender', version: '9.9.9', templateId: 'douyin-sender' })
      ]
    })
    const list = await catalog.list()
    expect(list.find((item) => item.template.templateId === 'keyword-bot')?.state).toBe('installed')
    expect(list.find((item) => item.template.templateId === 'douyin-sender')?.state).toBe(
      'installed'
    )
  })

  it('模板版本更高时显示 update-available', async () => {
    const { catalog } = setup({ records: [record({ version: '0.9.0' })] })
    const list = await catalog.list()
    expect(list.find((item) => item.template.templateId === 'keyword-bot')?.state).toBe(
      'update-available'
    )
  })

  it('同 ID 的非模板扩展显示 conflict，不会自动接管', async () => {
    const { catalog } = setup({ records: [record({ source: 'directory' })] })
    const list = await catalog.list()
    const keyword = list.find((item) => item.template.templateId === 'keyword-bot')
    expect(keyword?.state).toBe('conflict')
    expect(keyword?.message).toContain('不会自动替换')
  })

  it('平台不在支持范围时显示 unsupported', async () => {
    const { catalog } = setup({ platform: 'linux' })
    const list = await catalog.list()
    expect(list.every((item) => item.state === 'unsupported')).toBe(true)
  })

  it('ZIP 被替换后状态变为 damaged，且 resolveZip 拒绝安装', async () => {
    const { root } = setup()
    const zipPath = path.join(root, 'templates', 'keyword-bot-1.0.1.zip')
    const original = fs.readFileSync(zipPath)
    fs.writeFileSync(zipPath, Buffer.concat([original, Buffer.from('tampered')]))

    // 新实例避免读到缓存的索引状态。
    const fresh = new ExtensionTemplateCatalog({
      templateRoot: path.join(root, 'templates'),
      getRecord: () => undefined,
      resolveInstallDir: (id) => path.join(root, 'extensions', id),
      platform: 'darwin',
      probePython: () => '/usr/bin/python3',
      probeChrome: () => '/usr/bin/chrome'
    })
    const list = await fresh.list()
    expect(list.find((item) => item.template.templateId === 'keyword-bot')?.state).toBe('damaged')
    await expect(fresh.resolveZip('keyword-bot')).rejects.toMatchObject({
      code: 'EXTENSION_INSTALL_FAILED'
    })
  })

  it('依赖检测区分「必填缺失」与「安装后再检测」', async () => {
    const { catalog } = setup()
    const list = await catalog.list()
    const douyin = list.find((item) => item.template.templateId === 'douyin-sender')
    const scriptCheck = douyin?.dependencies.checks.find((check) => check.id === 'externalScript')
    // 未安装时不判定为缺失，只提示「安装后检测」。
    expect(scriptCheck?.ok).toBe(false)
    expect(scriptCheck?.blocking).toBe(false)
    expect(scriptCheck?.detail).toContain('安装后检测')
    // Python / Chrome 已由注入的探测返回可用。
    expect(douyin?.dependencies.checks.find((check) => check.id === 'python')?.ok).toBe(true)
    expect(douyin?.dependencies.ready).toBe(true)

    const keyword = list.find((item) => item.template.templateId === 'keyword-bot')
    expect(keyword?.dependencies.checks).toEqual([])
    expect(keyword?.dependencies.ready).toBe(true)
  })

  it('已安装但缺少解析脚本时，依赖为未就绪', async () => {
    const { catalog, records, root } = setup({
      records: [
        record({ id: 'com.example.douyin-sender', version: '1.0.5', templateId: 'douyin-sender' })
      ]
    })
    records.set(
      'com.example.douyin-sender',
      record({
        id: 'com.example.douyin-sender',
        version: '1.0.5',
        templateId: 'douyin-sender'
      })
    )
    fs.ensureDirSync(path.join(root, 'extensions', 'com.example.douyin-sender'))
    const list = await catalog.list()
    const douyin = list.find((item) => item.template.templateId === 'douyin-sender')
    const scriptCheck = douyin?.dependencies.checks.find((check) => check.id === 'externalScript')
    expect(scriptCheck?.ok).toBe(false)
    expect(scriptCheck?.blocking).toBe(true)
    expect(douyin?.dependencies.ready).toBe(false)
  })
})
