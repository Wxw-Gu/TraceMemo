import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExtensionManager } from '../../src/main/extensions/extension-manager'
import { createExtensionPaths } from '../../src/main/extensions/extension-paths'
import { EXTENSION_HOST_PROTOCOL_VERSION } from '../../src/shared/extensions/rpc'
import type {
  ExtensionHostChild,
  ExtensionHostSpawnOptions
} from '../../src/main/extensions/extension-host'
import type { PersonalWechatSendCapability } from '../../src/shared/personal-wechat'
import type { WechatActionResult } from '../../src/shared/wechat-action'

const MANIFEST = {
  manifestVersion: 1,
  id: 'com.example.fixture-bot',
  name: 'Fixture Bot',
  version: '1.0.0',
  apiVersion: '1',
  minAppVersion: '2.6.0',
  permissions: ['messages.subscribe', 'wechat.send.text', 'storage', 'automation.action', 'contacts.list'],
  entrypoints: { page: 'ui/index.html', background: 'background/index.js' },
  subscriptions: {
    messageTypes: ['text'],
    conversationIds: [],
    requireMentionMe: false,
    includeSelf: false
  },
  contributions: {
    pages: [{ id: 'settings', title: '配置' }],
    automationActions: [{ id: 'keyword.reply', title: '关键词回复' }]
  }
}

const capability = {
  supported: true,
  ready: true,
  status: 'ready',
  capabilities: { text: true, image: true, voice: false },
  senderStatus: {},
  message: '已就绪'
} as unknown as PersonalWechatSendCapability

const sentResult: WechatActionResult = {
  actionId: 'action-1',
  status: 'sent',
  decision: 'allow',
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:00:01.000Z'
}

type Listener = (...args: unknown[]) => void

class FakeChild implements ExtensionHostChild {
  readonly sent: Array<Record<string, unknown>> = []
  private readonly listeners = new Map<string, Listener[]>()

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
        this.emit('message', {
          type: 'register-action',
          version: EXTENSION_HOST_PROTOCOL_VERSION,
          action: { id: 'keyword.reply', title: '关键词回复', hasInputSchema: true }
        })
      })
    }
    if (payload.type === 'invoke-action') {
      queueMicrotask(() =>
        this.emit('message', {
          type: 'action-result',
          version: EXTENSION_HOST_PROTOCOL_VERSION,
          requestId: payload.requestId,
          ok: true,
          output: { success: true, reply: { type: 'text', text: '你好呀！' } }
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

  events(): Array<Record<string, unknown>> {
    return this.sent.filter((message) => message.type === 'event')
  }
}

const roots: string[] = []
let userData: string

function createSourceExtension(): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-extension-src-'))
  roots.push(parent)
  const source = path.join(parent, 'extension')
  fs.ensureDirSync(path.join(source, 'ui'))
  fs.ensureDirSync(path.join(source, 'background'))
  fs.writeJsonSync(path.join(source, 'manifest.json'), MANIFEST)
  fs.writeFileSync(path.join(source, 'ui', 'index.html'), '<!doctype html><title>fixture</title>')
  fs.writeFileSync(path.join(source, 'background', 'index.js'), 'module.exports = () => {}')
  return source
}

function createManager(): {
  manager: ExtensionManager
  paths: ReturnType<typeof createExtensionPaths>
  children: FakeChild[]
  executeAction: ReturnType<typeof vi.fn>
} {
  const paths = createExtensionPaths(userData)
  const children: FakeChild[] = []
  const executeAction = vi.fn(async () => sentResult)
  const manager = new ExtensionManager({
    paths,
    appVersion: '2.6.0',
    spawn: (options: ExtensionHostSpawnOptions) => {
      void options
      const child = new FakeChild()
      children.push(child)
      return child
    },
    getCapability: async () => capability,
    checkEntitlement: async () => ({ ok: true, message: '授权有效', source: 'mac_license' }),
    executeAction,
    queryMessages: async () => [],
    listGroups: async () => [{ id: 'fixture-room@chatroom', name: '测试群' }],
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

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-extension-manager-'))
  roots.push(userData)
})

afterEach(() => {
  for (const root of roots.splice(0)) fs.removeSync(root)
})

describe('extension lifecycle', () => {
  it('安装 → 页面读写配置 → 启用 → 事件 → 动作 → 发送 → 停用 → 卸载', async () => {
    const { manager, paths, children, executeAction } = createManager()
    await manager.initialize()
    const source = createSourceExtension()

    const installed = await manager.installFromDirectory(source)
    expect(installed.success).toBe(true)
    expect(installed.extension?.enabled).toBe(false)
    // 安装只自动授予低风险权限。
    expect(installed.extension?.grantedPermissions).toEqual(['storage'])

    const page = manager.pageUrl('com.example.fixture-bot')
    expect(page.url).toBe('tm-extension://com.example.fixture-bot/ui/index.html')
    const saved = await manager.pageRequest('com.example.fixture-bot', 'storage.set', {
      key: 'greeting',
      value: '你好'
    })
    expect(saved.ok).toBe(true)
    expect(
      (await manager.pageRequest('com.example.fixture-bot', 'storage.get', { key: 'greeting' }))
        .result
    ).toBe('你好')
    // 页面不能发送微信消息。
    expect((await manager.pageRequest('com.example.fixture-bot', 'wechat.send.text', {})).ok).toBe(
      false
    )
    // 页面可以读取群列表（manifest 已声明 contacts.list）。
    const groups = await manager.pageRequest('com.example.fixture-bot', 'contacts.listGroups', {})
    expect(groups.ok).toBe(true)
    expect(groups.result).toEqual({
      groups: [{ id: 'fixture-room@chatroom', name: '测试群' }]
    })

    const enabled = await manager.setEnabled('com.example.fixture-bot', true)
    expect(enabled.success).toBe(true)
    await tick()
    const child = children[0]
    expect(manager.get('com.example.fixture-bot')?.runtime.state).toBe('active')
    expect(manager.get('com.example.fixture-bot')?.automationActions[0]).toMatchObject({
      id: 'keyword.reply',
      registered: true
    })

    manager.handleMessage({
      sessionId: 'fixture-room@chatroom',
      localId: '1001',
      serverId: '9001',
      createTime: 1_700_000_000,
      messageType: 1,
      isSelf: false,
      senderId: 'wxid_peer',
      senderNickname: '张三',
      content: '@我 你好',
      isGroup: true,
      mentionTargets: ['wxid_self']
    })
    const event = child.events()[0]
    expect(event).toBeTruthy()
    const envelope = event.envelope as { event: { mentionsMe: boolean; text: string } }
    expect(envelope.event.mentionsMe).toBe(true)
    expect(envelope.event.text).toBe('@我 你好')

    // 同一条消息重复投递不会再分发。
    manager.handleMessage({
      sessionId: 'fixture-room@chatroom',
      localId: '1001',
      createTime: 1_700_000_000,
      messageType: 1,
      isSelf: false,
      content: '@我 你好',
      isGroup: true,
      mentionTargets: ['wxid_self']
    })
    expect(child.events()).toHaveLength(1)

    const output = await manager.invokeAutomationAction(
      'com.example.fixture-bot',
      'keyword.reply',
      { text: '你好' }
    )
    expect(output.reply).toEqual({ type: 'text', text: '你好呀！' })

    // 后台主动发送：宿主填 origin/purpose，扩展只描述收件人与内容。
    child.emit('message', {
      type: 'call',
      version: EXTENSION_HOST_PROTOCOL_VERSION,
      callId: 'call-1',
      method: 'wechat.send.text',
      params: { to: 'fixture-room@chatroom', text: '你好呀！' }
    })
    await tick()
    const callResult = child.sent.find(
      (message) => message.type === 'call-result' && message.callId === 'call-1'
    )
    expect(callResult?.ok).toBe(true)
    expect(executeAction).toHaveBeenCalledTimes(1)
    expect(executeAction.mock.calls[0][0]).toMatchObject({
      origin: 'extension',
      purpose: 'extension_send',
      triggerType: 'automation',
      recipient: { type: 'group', id: 'fixture-room@chatroom' },
      content: { type: 'text', text: '你好呀！' }
    })

    const disabled = await manager.setEnabled('com.example.fixture-bot', false)
    expect(disabled.success).toBe(true)
    expect(manager.get('com.example.fixture-bot')?.grantedPermissions).toEqual(['storage'])
    manager.handleMessage({
      sessionId: 'fixture-room@chatroom',
      localId: '1002',
      createTime: 1_700_000_100,
      messageType: 1,
      isSelf: false,
      content: '还在吗',
      isGroup: true,
      mentionTargets: []
    })
    expect(child.events()).toHaveLength(1)

    const removed = await manager.uninstall('com.example.fixture-bot', true)
    expect(removed.success).toBe(true)
    expect(fs.existsSync(paths.installDir('com.example.fixture-bot'))).toBe(false)
    expect(fs.existsSync(paths.extensionDataDir('com.example.fixture-bot'))).toBe(true)
    expect(manager.list()).toEqual([])
  })

  it('不兼容的扩展安装被拒绝', async () => {
    const { manager } = createManager()
    await manager.initialize()
    const source = createSourceExtension()
    fs.writeJsonSync(path.join(source, 'manifest.json'), { ...MANIFEST, minAppVersion: '9.9.0' })
    const result = await manager.installFromDirectory(source)
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('EXTENSION_INCOMPATIBLE')
  })

  it('停用状态下页面仍可打开与保存配置', async () => {
    const { manager } = createManager()
    await manager.initialize()
    const source = createSourceExtension()
    await manager.installFromDirectory(source)
    const page = manager.pageUrl('com.example.fixture-bot', 'settings')
    expect(page.pageId).toBe('settings')
    const result = await manager.pageRequest('com.example.fixture-bot', 'storage.set', {
      key: 'draft',
      value: 1
    })
    expect(result.ok).toBe(true)
  })
})
