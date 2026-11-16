import { createRequire } from 'node:module'
import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExtensionManager } from '../../src/main/extensions/extension-manager'
import { createExtensionPaths } from '../../src/main/extensions/extension-paths'
import type {
  ExtensionHostChild,
  ExtensionHostSpawnOptions
} from '../../src/main/extensions/extension-host'
import { EXTENSION_HOST_PROTOCOL_VERSION } from '../../src/shared/extensions/rpc'
import type { PersonalWechatSendCapability } from '../../src/shared/personal-wechat'

const require = createRequire(import.meta.url)
const {
  buildTemplates
}: {
  buildTemplates: (options?: Record<string, unknown>) => unknown
} = require('../../scripts/build-extension-templates.cjs')

type Listener = (...args: unknown[]) => void

class FakeChild implements ExtensionHostChild {
  readonly sent: Array<Record<string, unknown>> = []
  private readonly listeners = new Map<string, Listener[]>()

  send(message: unknown): void {
    const payload = message as Record<string, unknown>
    this.sent.push(payload)
    if (payload.type === 'activate') {
      queueMicrotask(() =>
        this.emit('message', {
          type: 'activated',
          version: EXTENSION_HOST_PROTOCOL_VERSION,
          ok: true
        })
      )
    }
    if (payload.type === 'shutdown') {
      queueMicrotask(() => this.emit('exit', 0, null))
    }
  }

  kill(): void {
    this.emit('exit', 1, null)
  }

  on(event: 'message', listener: (message: unknown) => void): void
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  on(event: string, listener: (...args: never[]) => void): void {
    const list = this.listeners.get(event) ?? []
    list.push(listener as unknown as Listener)
    this.listeners.set(event, list)
  }

  once(event: string, listener: Listener): void {
    this.on(event as 'message', listener as (message: unknown) => void)
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }
}

const capability = {
  supported: true,
  ready: true,
  status: 'ready',
  capabilities: { text: true, image: true, video: true },
  senderStatus: {},
  message: '已就绪'
} as unknown as PersonalWechatSendCapability

const roots: string[] = []
let userData: string
let templateRoot: string

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-template-install-'))
  roots.push(root)
  return root
}

function createManager(): {
  manager: ExtensionManager
  paths: ReturnType<typeof createExtensionPaths>
  children: FakeChild[]
} {
  const paths = createExtensionPaths(userData)
  const children: FakeChild[] = []
  const manager = new ExtensionManager({
    paths,
    appVersion: '2.6.0',
    secretCipher: {
      isAvailable: () => true,
      encrypt: (plain: string) => Buffer.from(plain, 'utf8'),
      decrypt: (payload: Buffer) => payload.toString('utf8')
    },

    templatesRoot: templateRoot,
    spawn: (options: ExtensionHostSpawnOptions) => {
      void options
      const child = new FakeChild()
      children.push(child)
      return child
    },
    getCapability: async () => capability,
    checkEntitlement: async () => ({ ok: true, message: '授权有效', source: 'mac_license' }),
    executeAction: async () => ({
      actionId: 'action-1',
      status: 'sent',
      decision: 'allow',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z'
    }),
    queryMessages: async () => [],
    listGroups: async () => [],
    aiChat: async () => ({ text: '' }),
    getAccountId: () => 'wxid_self',
    getSelfUsernames: () => ['wxid_self'],
    isDatabaseReady: () => true,
    now: () => 1_000
  })
  return { manager, paths, children }
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  userData = tempRoot()
  const work = tempRoot()
  const sourceRoot = path.join(work, 'examples')
  fs.copySync(path.join(process.cwd(), 'examples/extensions'), sourceRoot)
  templateRoot = path.join(work, 'templates')
  buildTemplates({
    sourceRoot,
    outputDir: templateRoot,
    lockFile: path.join(work, 'lock.json')
  })
})

afterEach(() => {
  for (const root of roots.splice(0)) fs.removeSync(root)
})

// 全量并发时文件级调度会拖慢每个用例；这里只放宽超时，断言不变。
describe('官方模板安装', { timeout: 20_000 }, () => {
  it('安装模板：代码落地、来源为 template、默认不启用', async () => {
    const { manager, paths, children } = createManager()
    await manager.initialize()

    const result = await manager.installTemplate('keyword-bot')
    expect(result.success).toBe(true)
    expect(result.extension?.id).toBe('com.example.keyword-bot')
    expect(result.extension?.source).toBe('template')
    expect(result.extension?.template?.id).toBe('keyword-bot')
    // 安装不等于启用，也不拉起后台。
    expect(result.extension?.enabled).toBe(false)
    expect(children).toHaveLength(0)
    expect(
      fs.existsSync(
        path.join(paths.installDir('com.example.keyword-bot'), 'background', 'index.js')
      )
    ).toBe(true)
  })

  it('列出的模板版本来自 manifest，安装后状态变为 installed', async () => {
    const { manager } = createManager()
    await manager.initialize()

    const before = await manager.listTemplates()
    const keyword = before.find((item) => item.template.templateId === 'keyword-bot')
    expect(keyword?.state).toBe('not-installed')

    await manager.installTemplate('keyword-bot')
    const after = await manager.listTemplates()
    expect(after.find((item) => item.template.templateId === 'keyword-bot')?.state).toBe(
      'installed'
    )
    expect(after.find((item) => item.template.templateId === 'keyword-bot')?.installedVersion).toBe(
      keyword?.template.version
    )
  })

  it('同版本重复安装被拒绝', async () => {
    const { manager } = createManager()
    await manager.initialize()
    await manager.installTemplate('keyword-bot')

    const again = await manager.installTemplate('keyword-bot')
    expect(again.success).toBe(false)
    expect(again.error?.code).toBe('EXTENSION_ALREADY_INSTALLED')
  })

  it('同 ID 的非模板扩展不会被静默接管', async () => {
    const { manager, paths } = createManager()
    await manager.initialize()

    // 模拟用户从 GitHub 手工装过同一 ID 的扩展。
    const source = path.join(tempRoot(), 'manual')
    fs.ensureDirSync(path.join(source, 'ui'))
    fs.ensureDirSync(path.join(source, 'background'))
    fs.writeJsonSync(path.join(source, 'manifest.json'), {
      manifestVersion: 1,
      id: 'com.example.keyword-bot',
      name: '手工版本',
      version: '0.1.0',
      apiVersion: '1',
      permissions: ['storage'],
      entrypoints: { page: 'ui/index.html', background: 'background/index.js' },
      contributions: { pages: [{ id: 'settings', title: '配置' }] }
    })
    fs.writeFileSync(path.join(source, 'ui', 'index.html'), '<!doctype html>')
    fs.writeFileSync(path.join(source, 'background', 'index.js'), 'module.exports=()=>{}')
    const installed = await manager.installFromDirectory(source)
    expect(installed.success).toBe(true)
    expect(installed.extension?.source).toBe('directory')

    const blocked = await manager.installTemplate('keyword-bot')
    expect(blocked.success).toBe(false)
    expect(blocked.error?.code).toBe('EXTENSION_ALREADY_INSTALLED')
    expect(blocked.error?.message).toContain('非官方')
    // 原扩展仍在，未被替换。
    expect(manager.get('com.example.keyword-bot')?.name).toBe('手工版本')
    expect(
      fs.readJsonSync(path.join(paths.installDir('com.example.keyword-bot'), 'manifest.json'))
        .version
    ).toBe('0.1.0')
  })

  it('模板 ZIP 被篡改时拒绝安装', async () => {
    const { manager } = createManager()
    await manager.initialize()

    const zipPath = path.join(templateRoot, 'keyword-bot-1.0.1.zip')
    fs.writeFileSync(zipPath, Buffer.concat([fs.readFileSync(zipPath), Buffer.from('x')]))

    const result = await manager.installTemplate('keyword-bot')
    expect(result.success).toBe(false)
    expect(result.error?.message).toContain('校验失败')
  })

  it('模板升级保留用户配置与启用状态', async () => {
    const { manager, paths } = createManager()
    await manager.initialize()
    const installed = await manager.installTemplate('keyword-bot')
    expect(installed.success).toBe(true)

    await manager.setEnabled('com.example.keyword-bot', true)
    await tick()
    await manager.pageRequest('com.example.keyword-bot', 'storage.set', {
      key: 'rules',
      value: [{ id: 'r1' }]
    })

    // 把模板索引与 ZIP 换成 1.1.0（模拟新版本随应用更新）。
    const source = path.join(tempRoot(), 'examples-next')
    fs.copySync(path.join(process.cwd(), 'examples/extensions'), source)
    const manifestPath = path.join(source, 'keyword-bot/manifest.json')
    const manifest = fs.readJsonSync(manifestPath)
    fs.writeJsonSync(manifestPath, { ...manifest, version: '1.1.0' })
    buildTemplates({
      sourceRoot: source,
      outputDir: templateRoot,
      lockFile: path.join(tempRoot(), 'lock2.json')
    })

    // 模板随应用更新后需要重新读取索引：真实场景是重启应用。
    const restarted = createManager()
    await restarted.manager.initialize()
    const beforeUpgrade = await restarted.manager.listTemplates()
    expect(beforeUpgrade.find((item) => item.template.templateId === 'keyword-bot')?.state).toBe(
      'update-available'
    )

    const upgraded = await restarted.manager.installTemplate('keyword-bot')
    expect(upgraded.success).toBe(true)
    await tick()

    const after = restarted.manager.get('com.example.keyword-bot')
    expect(after?.version).toBe('1.1.0')
    expect(after?.enabled).toBe(true)
    expect(
      (
        await restarted.manager.pageRequest('com.example.keyword-bot', 'storage.get', {
          key: 'rules'
        })
      ).result
    ).toEqual([{ id: 'r1' }])
    expect(
      fs.existsSync(path.join(paths.extensionDataDir('com.example.keyword-bot'), 'storage.json'))
    ).toBe(true)
  })
})
