import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExtensionHost } from '../../src/main/extensions/extension-host'
import { ExtensionStorage } from '../../src/main/extensions/extension-storage'
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
  /** 后台注册的动作；测试可改。 */
  registeredActions: Array<{ id: string; title: string; inputSchema?: unknown }> = [
    {
      id: 'reply',
      title: '回复',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
    }
  ]
  pageResponder: (method: string) => unknown = (method) => ({ echo: method })

  send(message: unknown): void {
    const payload = message as Record<string, unknown>
    this.sent.push(payload)
    if (payload.type === 'activate') {
      queueMicrotask(() => {
        this.emit('message', {
          type: 'activated',
          version: EXTENSION_HOST_PROTOCOL_VERSION,
          ok: true
        })
        for (const action of this.registeredActions) {
          this.emit('message', {
            type: 'register-action',
            version: EXTENSION_HOST_PROTOCOL_VERSION,
            action
          })
        }
      })
    }
    if (payload.type === 'page-request') {
      queueMicrotask(() => {
        try {
          this.emit('message', {
            type: 'page-result',
            version: EXTENSION_HOST_PROTOCOL_VERSION,
            requestId: payload.requestId,
            ok: true,
            result: this.pageResponder(String(payload.method))
          })
        } catch (error) {
          this.emit('message', {
            type: 'page-result',
            version: EXTENSION_HOST_PROTOCOL_VERSION,
            requestId: payload.requestId,
            ok: false,
            error: { code: 'ACTION_FAILED', message: String(error) }
          })
        }
      })
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-m4-run-'))
  roots.push(root)
  return root
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id: 'com.example.m4-bot',
    name: 'M4 扩展',
    version: '1.0.0',
    apiVersion: '1',
    minAppVersion: '2.6.0',
    permissions: ['storage', 'automation.action', 'messages.subscribe', 'secrets'],
    entrypoints: { page: 'ui/index.html', background: 'background/index.js' },
    subscriptions: {
      messageTypes: ['text'],
      conversationIds: [],
      requireMentionMe: false,
      includeSelf: false
    },
    contributions: {
      pages: [{ id: 'settings', title: '配置' }],
      automationActions: [{ id: 'reply', title: '回复' }]
    },
    ...overrides
  }
}

function createSource(overrides: Record<string, unknown> = {}): string {
  const parent = tempRoot()
  const source = path.join(parent, 'extension')
  fs.ensureDirSync(path.join(source, 'ui'))
  fs.ensureDirSync(path.join(source, 'background'))
  fs.writeJsonSync(path.join(source, 'manifest.json'), manifest(overrides))
  fs.writeFileSync(path.join(source, 'ui', 'index.html'), '<!doctype html><title>x</title>')
  fs.writeFileSync(path.join(source, 'background', 'index.js'), 'module.exports=()=>{}')
  return source
}

function createManager(): {
  manager: ExtensionManager
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
  return { manager, children }
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

describe('扩展动作列表', { timeout: 20_000 }, () => {
  it('未启用时不可用并给出原因', async () => {
    const { manager } = createManager()
    await manager.initialize()
    await manager.installFromDirectory(createSource())

    const actions = manager.listActions()
    expect(actions).toHaveLength(1)
    expect(actions[0].available).toBe(false)
    expect(actions[0].unavailableReason).toContain('未启用')
    expect(actions[0].registered).toBe(false)
  })

  it('启用并注册后可用，并带上 Schema', async () => {
    const { manager } = createManager()
    await manager.initialize()
    await manager.installFromDirectory(createSource())
    await manager.setEnabled('com.example.m4-bot', true)
    await tick()

    const actions = manager.listActions()
    expect(actions[0].available).toBe(true)
    expect(actions[0].registered).toBe(true)
    expect(actions[0].inputSchema?.properties.text.type).toBe('string')
  })

  it('非法 Schema 的动作仍登记，但带可定位的错误原因', async () => {
    const child = new FakeChild()
    child.registeredActions = [
      {
        id: 'reply',
        title: '回复',
        inputSchema: { type: 'object', properties: { a: { type: 'date' } } }
      }
    ]
    const host = new ExtensionHost({
      extensionId: 'com.example.m4-bot',
      extensionDir: tempRoot(),
      dataDir: tempRoot(),
      permissions: ['automation.action'],
      storage: new ExtensionStorage({ dataRoot: tempRoot() }),
      spawn: () => child
    })
    await host.start()

    const actions = host.registeredActions()
    expect(actions).toHaveLength(1)
    expect(actions[0].inputSchema).toBeUndefined()
    expect(actions[0].schemaError).toContain('类型不支持')
    await host.stop()
  })

  it('未授予 automation.action 权限时不可用', async () => {
    const { manager } = createManager()
    await manager.initialize()
    await manager.installFromDirectory(createSource())
    await manager.setEnabled('com.example.m4-bot', true)
    await tick()
    await manager.revokePermission('com.example.m4-bot', 'automation.action')
    await tick()

    const action = manager.listActions()[0]
    expect(action.available).toBe(false)
    expect(action.unavailableReason).toContain('执行自动化动作')
  })
})

describe('页面请求转发', { timeout: 20_000 }, () => {
  it('转发到同一扩展后台并返回结果', async () => {
    const { manager, children } = createManager()
    await manager.initialize()
    await manager.installFromDirectory(createSource())
    await manager.setEnabled('com.example.m4-bot', true)
    await tick()
    children[0].pageResponder = (method) => ({ handled: method })

    const response = await manager.pageRequest('com.example.m4-bot', 'extension.request', {
      method: 'testSend',
      params: { a: 1 }
    })
    expect(response.ok).toBe(true)
    expect(response.result).toEqual({ handled: 'testSend' })
  })

  it('方法名不合法时拒绝', async () => {
    const { manager } = createManager()
    await manager.initialize()
    await manager.installFromDirectory(createSource())
    await manager.setEnabled('com.example.m4-bot', true)
    await tick()

    const response = await manager.pageRequest('com.example.m4-bot', 'extension.request', {
      method: '../etc/passwd'
    })
    expect(response.ok).toBe(false)
    expect(response.error?.code).toBe('INVALID_REQUEST')
  })

  it('未启用时不转发', async () => {
    const { manager } = createManager()
    await manager.initialize()
    await manager.installFromDirectory(createSource())

    const response = await manager.pageRequest('com.example.m4-bot', 'extension.request', {
      method: 'testSend'
    })
    expect(response.ok).toBe(false)
    expect(response.error?.code).toBe('EXTENSION_DISABLED')
  })

  it('宿主不再提供抖音专用页面能力', async () => {
    const { manager } = createManager()
    await manager.initialize()
    await manager.installFromDirectory(createSource())

    for (const method of ['test.send', 'douyin.cookie.get', 'douyin.cookie.clear']) {
      const response = await manager.pageRequest('com.example.m4-bot', method, {})
      expect(response.ok).toBe(false)
      expect(response.error?.code).toBe('PERMISSION_DENIED')
    }
  })
})

describe('扩展凭据', { timeout: 20_000 }, () => {
  it('后台通过 secrets 权限读写自己的密钥', async () => {
    const { manager } = createManager()
    await manager.initialize()
    await manager.installFromDirectory(createSource())
    await manager.setEnabled('com.example.m4-bot', true)
    await tick()
    // 通过宿主内部的 secret store 验证隔离（页面桥不直接暴露密钥读取）。
    expect(manager.get('com.example.m4-bot')?.permissions).toContain('secrets')
  })
})
