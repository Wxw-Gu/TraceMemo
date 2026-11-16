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

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-dev-mode-'))
  roots.push(root)
  return root
}

function manifest(
  id = 'com.example.dev-bot',
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id,
    name: '开发模式扩展',
    version: '1.0.0',
    apiVersion: '1',
    minAppVersion: '2.6.0',
    permissions: ['storage', 'messages.subscribe', 'wechat.send.text'],
    entrypoints: { page: 'ui/index.html', background: 'background/index.js' },
    subscriptions: {
      messageTypes: ['text'],
      conversationIds: [],
      requireMentionMe: false,
      includeSelf: false
    },
    contributions: { pages: [{ id: 'settings', title: '配置' }] },
    ...overrides
  }
}

/** 在仓库外模拟一个开发项目目录。 */
function createProject(
  overrides: Record<string, unknown> = {},
  id = 'com.example.dev-bot'
): string {
  const parent = tempRoot()
  const project = path.join(parent, 'my-extension')
  fs.ensureDirSync(path.join(project, 'ui'))
  fs.ensureDirSync(path.join(project, 'background'))
  fs.writeJsonSync(path.join(project, 'manifest.json'), manifest(id, overrides))
  fs.writeFileSync(path.join(project, 'ui', 'index.html'), '<!doctype html><title>dev</title>')
  fs.writeFileSync(path.join(project, 'background', 'index.js'), 'module.exports=()=>{}')
  return project
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

    spawn: (options: ExtensionHostSpawnOptions) => {
      void options
      const child = new FakeChild()
      children.push(child)
      return child
    },
    getCapability: async () => capability,
    checkEntitlement: async () => ({ ok: true, message: '授权有效', source: 'mac_license' }),
    executeAction: async () =>
      ({
        actionId: 'a',
        status: 'sent',
        decision: 'allow',
        startedAt: '',
        finishedAt: ''
      }) as never,
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
})

afterEach(() => {
  for (const root of roots.splice(0)) fs.removeSync(root)
})

describe('开发模式链接', { timeout: 20_000 }, () => {
  it('链接外部目录后登记为 development，默认不启用', async () => {
    const { manager } = createManager()
    await manager.initialize()
    const project = createProject()

    const result = await manager.linkDevelopmentProject(project)
    expect(result.success).toBe(true)
    const extension = manager.get('com.example.dev-bot')
    expect(extension?.source).toBe('development')
    expect(extension?.enabled).toBe(false)
    expect(extension?.development?.available).toBe(true)
    expect(extension?.development?.sourcePath).toBe(fs.realpathSync(project))
    // 没有在 userData 下复制代码。
    expect(fs.existsSync(manager.resolveExtensionRoot('com.example.dev-bot') as string)).toBe(true)
  })

  it('目录不存在时返回明确错误', async () => {
    const { manager } = createManager()
    await manager.initialize()
    const result = await manager.linkDevelopmentProject(path.join(tempRoot(), 'missing'))
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('EXTENSION_SOURCE_MISSING')
  })

  it('manifest 不合法时拒绝链接', async () => {
    const { manager } = createManager()
    await manager.initialize()
    const project = createProject()
    fs.writeJsonSync(path.join(project, 'manifest.json'), { manifestVersion: 1 })
    const result = await manager.linkDevelopmentProject(project)
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('EXTENSION_INVALID_MANIFEST')
  })

  it('入口文件缺失时拒绝链接', async () => {
    const { manager } = createManager()
    await manager.initialize()
    const project = createProject()
    fs.removeSync(path.join(project, 'background', 'index.js'))
    const result = await manager.linkDevelopmentProject(project)
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('EXTENSION_INVALID_MANIFEST')
  })

  it('拒绝把宿主私有目录当作源码', async () => {
    const { manager, paths } = createManager()
    await manager.initialize()
    // 在宿主私有目录里放一个**结构完整**的扩展，验证路径边界先于内容检查生效。
    const sneaky = path.join(paths.dataDir, 'sneaky')
    fs.ensureDirSync(path.join(sneaky, 'ui'))
    fs.ensureDirSync(path.join(sneaky, 'background'))
    fs.writeJsonSync(path.join(sneaky, 'manifest.json'), manifest())
    fs.writeFileSync(path.join(sneaky, 'ui', 'index.html'), '<!doctype html>')
    fs.writeFileSync(path.join(sneaky, 'background', 'index.js'), 'module.exports=()=>{}')
    const result = await manager.linkDevelopmentProject(sneaky)
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('EXTENSION_INVALID_PATH')
  })

  it('同 ID 已被正式安装占用时拒绝链接', async () => {
    const { manager } = createManager()
    await manager.initialize()
    // 先用「从目录安装」建立一个正式安装来源。
    await manager.installFromDirectory(createProject())
    expect(manager.get('com.example.dev-bot')?.source).toBe('directory')

    const second = createProject()
    const linked = await manager.linkDevelopmentProject(second)
    expect(linked.success).toBe(false)
    expect(linked.error?.code).toBe('EXTENSION_ALREADY_INSTALLED')
    // 原来源未被替换。
    expect(manager.get('com.example.dev-bot')?.source).toBe('directory')
  })

  it('链接后重启仍保留记录，源码缺失时标记不可用但配置仍在', async () => {
    const { manager, paths } = createManager()
    await manager.initialize()
    const project = createProject()
    await manager.linkDevelopmentProject(project)
    await manager.pageRequest('com.example.dev-bot', 'storage.set', {
      key: 'rules',
      value: ['r1']
    })

    // 模拟源码目录被移走。
    fs.moveSync(project, `${project}-moved`)

    const restarted = createManager()
    await restarted.manager.initialize()
    const extension = restarted.manager.get('com.example.dev-bot')
    expect(extension?.source).toBe('development')
    expect(extension?.development?.available).toBe(false)
    // 配置仍在。
    expect(
      fs.existsSync(path.join(paths.extensionDataDir('com.example.dev-bot'), 'storage.json'))
    ).toBe(true)
  })
})

describe('重新加载', { timeout: 20_000 }, () => {
  it('修改 manifest 版本后重新加载生效，并保留授权交集', async () => {
    const { manager } = createManager()
    await manager.initialize()
    const project = createProject()
    await manager.linkDevelopmentProject(project)
    await manager.setEnabled('com.example.dev-bot', true)
    await tick()
    expect(manager.get('com.example.dev-bot')?.version).toBe('1.0.0')

    // 开发者在外部目录改版本，并新增一项权限。
    fs.writeJsonSync(
      path.join(project, 'manifest.json'),
      manifest(undefined, {
        version: '1.1.0',
        permissions: ['storage', 'messages.subscribe', 'wechat.send.text', 'automation.action']
      })
    )

    const reloaded = await manager.reloadDevelopment('com.example.dev-bot')
    expect(reloaded.success).toBe(true)
    await tick()

    const extension = manager.get('com.example.dev-bot')
    expect(extension?.version).toBe('1.1.0')
    // 新增权限不自动授予。
    expect(extension?.grantedPermissions).not.toContain('automation.action')
    expect(extension?.pendingPermissions).toContain('automation.action')
    expect(extension?.runtime.state).toBe('active')
  })

  it('删除权限后重新加载立即失效', async () => {
    const { manager } = createManager()
    await manager.initialize()
    const project = createProject()
    await manager.linkDevelopmentProject(project)
    await manager.setEnabled('com.example.dev-bot', true)
    await tick()
    expect(manager.get('com.example.dev-bot')?.grantedPermissions).toContain('wechat.send.text')

    fs.writeJsonSync(
      path.join(project, 'manifest.json'),
      manifest(undefined, { version: '1.0.1', permissions: ['storage'] })
    )
    await manager.reloadDevelopment('com.example.dev-bot')

    expect(manager.get('com.example.dev-bot')?.grantedPermissions).toEqual(['storage'])
  })

  it('源码目录缺失时重新加载给出明确错误', async () => {
    const { manager } = createManager()
    await manager.initialize()
    const project = createProject()
    await manager.linkDevelopmentProject(project)
    fs.removeSync(project)

    const reloaded = await manager.reloadDevelopment('com.example.dev-bot')
    expect(reloaded.success).toBe(false)
    expect(reloaded.error?.code).toBe('EXTENSION_SOURCE_MISSING')
  })
})

describe('移除链接与转换', { timeout: 20_000 }, () => {
  it('移除开发链接不会删除外部源码', async () => {
    const { manager } = createManager()
    await manager.initialize()
    const project = createProject()
    await manager.linkDevelopmentProject(project)

    const unlinked = await manager.unlinkDevelopment('com.example.dev-bot', { keepData: true })
    expect(unlinked.success).toBe(true)
    expect(fs.existsSync(project)).toBe(true)
    expect(manager.get('com.example.dev-bot')).toBeNull()
  })

  it('移除链接时选择清除数据会删除配置但保留源码', async () => {
    const { manager, paths } = createManager()
    await manager.initialize()
    const project = createProject()
    await manager.linkDevelopmentProject(project)
    await manager.pageRequest('com.example.dev-bot', 'storage.set', { key: 'a', value: 1 })

    await manager.unlinkDevelopment('com.example.dev-bot', { keepData: false })
    expect(fs.existsSync(project)).toBe(true)
    expect(fs.existsSync(paths.extensionDataDir('com.example.dev-bot'))).toBe(false)
  })

  it('开发项目可转为正式安装，来源与外部路径一并清除', async () => {
    const { manager, paths } = createManager()
    await manager.initialize()
    const project = createProject()
    await manager.linkDevelopmentProject(project)
    await manager.pageRequest('com.example.dev-bot', 'storage.set', { key: 'a', value: 1 })

    const converted = await manager.convertDevelopmentToInstalled('com.example.dev-bot')
    expect(converted.success).toBe(true)

    const extension = manager.get('com.example.dev-bot')
    expect(extension?.source).toBe('directory')
    expect(extension?.development).toBeUndefined()
    expect(extension?.enabled).toBe(false)
    // 代码已经进 userData。
    expect(fs.existsSync(path.join(paths.installDir('com.example.dev-bot'), 'manifest.json'))).toBe(
      true
    )
    // 配置保留。
    expect(
      (await manager.pageRequest('com.example.dev-bot', 'storage.get', { key: 'a' })).result
    ).toBe(1)
    // 外部源码仍在。
    expect(fs.existsSync(project)).toBe(true)
  })
})
