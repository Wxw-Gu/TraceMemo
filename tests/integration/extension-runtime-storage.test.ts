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
    if (payload.type === 'invoke-action') {
      queueMicrotask(() =>
        this.emit('message', {
          type: 'action-result',
          version: EXTENSION_HOST_PROTOCOL_VERSION,
          requestId: payload.requestId,
          ok: true,
          output: { success: true }
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-runtime-storage-'))
  roots.push(root)
  return root
}

function manifest(
  id = 'com.example.runtime-bot',
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id,
    name: '运行期测试扩展',
    version: '1.0.0',
    apiVersion: '1',
    minAppVersion: '2.6.0',
    permissions: ['storage', 'messages.subscribe', 'wechat.send.text', 'automation.action'],
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
  fs.writeJsonSync(path.join(source, 'manifest.json'), manifest(undefined, overrides))
  fs.writeFileSync(path.join(source, 'ui', 'index.html'), '<!doctype html><title>x</title>')
  fs.writeFileSync(path.join(source, 'background', 'index.js'), 'module.exports=()=>{}')
  return source
}

function createManager(): {
  manager: ExtensionManager
  paths: ReturnType<typeof createExtensionPaths>
  children: FakeChild[]
  executeAction: { calls: unknown[] }
} {
  const paths = createExtensionPaths(userData)
  const children: FakeChild[] = []
  const executeAction = {
    calls: [] as unknown[],
    run: async (request: unknown) => {
      executeAction.calls.push(request)
      return {
        actionId: 'action-1',
        status: 'sent',
        decision: 'allow',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:00:01.000Z'
      }
    }
  }
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
    executeAction: executeAction.run as never,
    queryMessages: async () => [],
    listGroups: async () => [],
    aiChat: async () => ({ text: '' }),
    getAccountId: () => 'wxid_self',
    getSelfUsernames: () => ['wxid_self'],
    isDatabaseReady: () => true,
    now: () => 1_000
  })
  return { manager, paths, children, executeAction }
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** 直接写坏主存储；目录可能还没被创建过（扩展从没写过配置）。 */
function corruptStorage(paths: ReturnType<typeof createExtensionPaths>, id: string): string {
  const file = path.join(paths.extensionDataDir(id), 'storage.json')
  fs.ensureDirSync(path.dirname(file))
  fs.writeFileSync(file, 'broken-in-runtime', 'utf8')
  return file
}

beforeEach(() => {
  userData = tempRoot()
})

afterEach(() => {
  for (const root of roots.splice(0)) fs.removeSync(root)
})

describe('运行期 Storage 恢复', { timeout: 20_000 }, () => {
  it('运行中配置损坏后，扩展读不到旧配置且被立即暂停', async () => {
    const { manager, paths, children } = createManager()
    await manager.initialize()
    await manager.installFromDirectory(createSource())
    await manager.setEnabled('com.example.runtime-bot', true)
    await tick()
    expect(children).toHaveLength(1)

    // 写入配置，并再写一次让备份有内容。
    await manager.pageRequest('com.example.runtime-bot', 'storage.set', {
      key: 'enabled',
      value: true
    })
    await manager.pageRequest('com.example.runtime-bot', 'storage.set', {
      key: 'rules',
      value: ['旧规则']
    })

    // 运行期主文件损坏。
    corruptStorage(paths, 'com.example.runtime-bot')

    // 下一次读取必须失败：不能把备份里的旧配置交给扩展继续回复。
    const read = await manager.pageRequest('com.example.runtime-bot', 'storage.get', {
      key: 'rules'
    })
    expect(read.ok).toBe(false)
    expect(read.error?.code).toBe('EXTENSION_STORAGE_CORRUPTED')

    // 扩展被暂停：停用 + 停后台。
    const extension = manager.get('com.example.runtime-bot')
    expect(extension?.enabled).toBe(false)
    expect(extension?.storage.state).toBe('recovered-from-backup')
    await tick()
    expect(children[0].sent.some((message) => message.type === 'shutdown')).toBe(true)
  })

  it('暂停后自动化动作被拒绝，不会继续执行旧规则', async () => {
    const { manager, paths } = createManager()
    await manager.initialize()
    await manager.installFromDirectory(createSource())
    await manager.setEnabled('com.example.runtime-bot', true)
    await tick()

    const storageFile = corruptStorage(paths, 'com.example.runtime-bot')
    fs.writeFileSync(`${storageFile}.bak`, 'also-broken', 'utf8')

    await manager.pageRequest('com.example.runtime-bot', 'storage.get', { key: 'rules' })

    await expect(
      manager.invokeAutomationAction('com.example.runtime-bot', 'reply', {})
    ).rejects.toMatchObject({
      code: expect.stringMatching(
        /EXTENSION_DISABLED|EXTENSION_STORAGE_CORRUPTED|EXTENSION_HOST_UNAVAILABLE/
      )
    })
  })

  it('一个扩展的配置损坏不影响另一个扩展', async () => {
    const { manager, paths, children } = createManager()
    await manager.initialize()
    await manager.installFromDirectory(createSource())
    // 第二个扩展用不同 id。
    const otherSource = createSource({ id: 'com.example.other-bot', name: '另一个扩展' })
    await manager.installFromDirectory(otherSource)
    await manager.setEnabled('com.example.runtime-bot', true)
    await manager.setEnabled('com.example.other-bot', true)
    await tick()

    corruptStorage(paths, 'com.example.runtime-bot')

    await manager.pageRequest('com.example.runtime-bot', 'storage.get', { key: 'x' })

    const other = manager.get('com.example.other-bot')
    expect(other?.enabled).toBe(true)
    expect(other?.storage.state).toBe('ok')
    // 另一个扩展的读写仍正常。
    const write = await manager.pageRequest('com.example.other-bot', 'storage.set', {
      key: 'ok',
      value: 1
    })
    expect(write.ok).toBe(true)
    expect(children.length).toBeGreaterThanOrEqual(2)
  })

  it('用户确认恢复后读写与启用恢复正常', async () => {
    const { manager, paths } = createManager()
    await manager.initialize()
    await manager.installFromDirectory(createSource())
    await manager.setEnabled('com.example.runtime-bot', true)
    await manager.pageRequest('com.example.runtime-bot', 'storage.set', {
      key: 'rules',
      value: ['r1']
    })
    await manager.pageRequest('com.example.runtime-bot', 'storage.set', {
      key: 'b',
      value: 2
    })

    corruptStorage(paths, 'com.example.runtime-bot')

    await manager.pageRequest('com.example.runtime-bot', 'storage.get', { key: 'rules' })
    expect(manager.get('com.example.runtime-bot')?.storage.state).toBe('recovered-from-backup')

    const acknowledged = manager.acknowledgeStorageRecovery('com.example.runtime-bot')
    expect(acknowledged.success).toBe(true)
    expect(manager.get('com.example.runtime-bot')?.storage.state).toBe('ok')

    // 恢复出来的旧配置可以读了。
    const read = await manager.pageRequest('com.example.runtime-bot', 'storage.get', {
      key: 'rules'
    })
    expect(read.ok).toBe(true)
    expect(read.result).toEqual(['r1'])

    const enabled = await manager.setEnabled('com.example.runtime-bot', true)
    expect(enabled.success).toBe(true)
  })
})
