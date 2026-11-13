import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import {
  ExtensionHost,
  type ExtensionHostChild,
  type ExtensionHostSpawnOptions
} from '../../src/main/extensions/extension-host'
import { ExtensionStorage } from '../../src/main/extensions/extension-storage'
import { EXTENSION_HOST_PROTOCOL_VERSION } from '../../src/shared/extensions/rpc'

type Listener = (...args: unknown[]) => void

class FakeChild implements ExtensionHostChild {
  readonly sent: Array<Record<string, unknown>> = []
  readonly listeners = new Map<string, Listener[]>()
  killed = false
  autoActivate = true
  activationOk = true
  actionOutput: unknown = { success: true, output: { matched: true } }

  send(message: unknown): void {
    const payload = message as Record<string, unknown>
    this.sent.push(payload)
    if (payload.type === 'activate') {
      queueMicrotask(() => {
        this.emit('message', {
          type: 'activated',
          version: EXTENSION_HOST_PROTOCOL_VERSION,
          ok: this.activationOk,
          ...(this.activationOk ? {} : { error: { code: 'ACTION_FAILED', message: 'boom' } })
        })
      })
    }
    if (payload.type === 'shutdown') {
      queueMicrotask(() => this.emit('exit', 0, null))
    }
    if (payload.type === 'invoke-action') {
      queueMicrotask(() => {
        this.emit('message', {
          type: 'action-result',
          version: EXTENSION_HOST_PROTOCOL_VERSION,
          requestId: payload.requestId,
          ok: true,
          output: this.actionOutput
        })
      })
    }
  }

  kill(): void {
    this.killed = true
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

const roots: string[] = []

function storage(): ExtensionStorage {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-extension-host-'))
  roots.push(root)
  return new ExtensionStorage({ dataRoot: root })
}

function createHost(overrides: Partial<ConstructorParameters<typeof ExtensionHost>[0]> = {}): {
  host: ExtensionHost
  child: FakeChild
  spawn: ReturnType<typeof vi.fn>
} {
  const child = new FakeChild()
  const spawn = vi.fn((options: ExtensionHostSpawnOptions) => {
    void options
    return child
  })
  const host = new ExtensionHost({
    extensionId: 'com.example.keyword-bot',
    extensionDir: '/tmp/fixture-extension',
    dataDir: '/tmp/fixture-extension-data',
    permissions: ['storage', 'wechat.send.text'],
    storage: storage(),
    spawn,
    ...overrides
  })
  return { host, child, spawn }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.removeSync(root)
  vi.useRealTimers()
})

describe('extension host', () => {
  it('激活握手后进入 active，并把权限传给子进程', async () => {
    const { host, child } = createHost()
    await host.start()
    expect(host.snapshot().state).toBe('active')
    const activate = child.sent.find((message) => message.type === 'activate')
    expect(activate?.extensionId).toBe('com.example.keyword-bot')
    expect(activate?.permissions).toEqual(['wechat.send.text', 'storage'])
  })

  it('后台注册的动作会被记录，未注册的动作拒绝调用', async () => {
    const { host, child } = createHost()
    await host.start()
    await expect(host.invokeAction('keyword.reply', {})).rejects.toMatchObject({
      code: 'ACTION_FAILED'
    })
    child.emit('message', {
      type: 'register-action',
      version: EXTENSION_HOST_PROTOCOL_VERSION,
      action: { id: 'keyword.reply', title: '关键词回复', hasInputSchema: true }
    })
    expect(host.registeredActions()).toEqual([{ id: 'keyword.reply', title: '关键词回复' }])
  })

  it('动作调用走 invoke-action 并回传输出', async () => {
    const { host, child } = createHost()
    await host.start()
    child.emit('message', {
      type: 'register-action',
      version: EXTENSION_HOST_PROTOCOL_VERSION,
      action: { id: 'keyword.reply', title: '关键词回复', hasInputSchema: true }
    })
    const result = await host.invokeAction('keyword.reply', { text: '你好' })
    expect(result).toMatchObject({ success: true, output: { matched: true } })
    expect(child.sent.some((message) => message.type === 'invoke-action')).toBe(true)
  })

  it('激活失败时 start 拒绝，状态为 error', async () => {
    const { host, child } = createHost()
    child.activationOk = false
    await expect(host.start()).rejects.toMatchObject({ code: 'ACTION_FAILED' })
    expect(host.snapshot().state).toBe('error')
  })

  it('未激活时不投递事件，激活后按 envelope 投递', async () => {
    const { host } = createHost()
    expect(host.deliverEvent({ version: 1, kind: 'message.received', event: {} as never })).toBe(
      false
    )
    await host.start()
    expect(
      host.deliverEvent({
        version: 1,
        kind: 'message.received',
        event: {
          eventId: 'message:1',
          accountId: 'wxid_self',
          conversationId: 'fixture@chatroom',
          messageId: '1',
          isGroup: true,
          isSelf: false,
          type: 'text',
          mentionsMe: false,
          timestamp: 1
        }
      })
    ).toBe(true)
  })

  it('停止时发送 shutdown 并回到 inactive', async () => {
    const { host, child } = createHost()
    await host.start()
    await host.stop()
    expect(child.sent.some((message) => message.type === 'shutdown')).toBe(true)
    expect(host.snapshot().state).toBe('inactive')
  })

  it('异常退出后按退避重启，超过次数标记 crashed', async () => {
    vi.useFakeTimers()
    const children: FakeChild[] = []
    const spawn = vi.fn((options: ExtensionHostSpawnOptions) => {
      void options
      const child = new FakeChild()
      children.push(child)
      return child
    })
    const host = new ExtensionHost({
      extensionId: 'com.example.keyword-bot',
      extensionDir: '/tmp/fixture-extension',
      dataDir: '/tmp/fixture-extension-data',
      permissions: [],
      storage: storage(),
      spawn,
      now: () => Date.now()
    })
    await host.start()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      children[children.length - 1].emit('exit', 1, null)
      await vi.advanceTimersByTimeAsync(10_000)
    }
    children[children.length - 1].emit('exit', 1, null)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(host.snapshot().state).toBe('crashed')
  })

  it('子进程请求的能力在未授权时被拒绝', async () => {
    const { host, child } = createHost({ permissions: [] })
    await host.start()
    child.emit('message', {
      type: 'call',
      version: EXTENSION_HOST_PROTOCOL_VERSION,
      callId: 'call-1',
      method: 'storage.get',
      params: { key: 'x' }
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const result = child.sent.find((message) => message.type === 'call-result')
    expect(result?.ok).toBe(false)
    expect((result?.error as { code: string }).code).toBe('PERMISSION_DENIED')
  })
})
