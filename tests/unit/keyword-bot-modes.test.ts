import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const MATCHER = path.join(process.cwd(), 'examples/extensions/keyword-bot/lib/matcher.js')
const BACKGROUND = path.join(process.cwd(), 'examples/extensions/keyword-bot/background/index.js')

const { normalizeConfig } = require(MATCHER) as {
  normalizeConfig: (raw: unknown) => {
    executionMode: 'subscribe' | 'automation'
    enabled: boolean
    rules: Array<{ id: string; keyword: string; reply: string }>
  }
}

interface FakeApi {
  storage: {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<void>
  }
  events: { on: (name: string, handler: (event: unknown) => unknown) => void }
  automation: { registerAction: (definition: Record<string, unknown>) => void }
  wechat: { send: (payload: Record<string, unknown>) => Promise<void> }
  log: { info: () => void; warn: () => void; error: () => void }
}

function createApi(config: Record<string, unknown>): {
  api: FakeApi
  sends: Array<Record<string, unknown>>
  handlers: Map<string, (event: unknown) => unknown>
  getAction: () => Record<string, unknown> | null
} {
  const sends: Array<Record<string, unknown>> = []
  const handlers = new Map<string, (event: unknown) => unknown>()
  let action: Record<string, unknown> | null = null
  const api: FakeApi = {
    storage: {
      get: async () => config,
      set: async () => undefined
    },
    events: {
      on: (name, handler) => handlers.set(name, handler)
    },
    automation: {
      registerAction: (definition) => {
        action = definition
      }
    },
    wechat: {
      send: async (payload) => {
        sends.push(payload)
      }
    },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined }
  }
  return { api, sends, handlers, getAction: () => action }
}

function loadBackground(): (api: FakeApi) => void {
  delete require.cache[require.resolve(BACKGROUND)]
  return require(BACKGROUND) as (api: FakeApi) => void
}

const baseConfig = {
  enabled: true,
  executionMode: 'subscribe',
  rules: [{ id: 'r1', keyword: '你好', mode: 'contains', reply: '你好呀', enabled: true }],
  scope: { groups: [], includeDirect: true, requireMentionMe: false }
}

const messageEvent = {
  eventId: 'evt-1',
  type: 'text',
  isSelf: false,
  conversationId: 'room@chatroom',
  conversationName: '测试群',
  senderId: 'wxid_peer',
  senderName: '张三',
  text: '你好',
  isGroup: true,
  mentionsMe: false,
  receivedAt: Date.now()
}

describe('关键词机器人执行模式', () => {
  it('默认是订阅模式，非法值回落', () => {
    expect(normalizeConfig(undefined).executionMode).toBe('subscribe')
    expect(normalizeConfig({ executionMode: 'nonsense' }).executionMode).toBe('subscribe')
    expect(normalizeConfig({ executionMode: 'automation' }).executionMode).toBe('automation')
  })

  it('订阅模式：事件路径回复一次，动作路径跳过', async () => {
    const activate = loadBackground()
    const harness = createApi(baseConfig)
    activate(harness.api as never)

    const onMessage = harness.handlers.get('message.received')
    expect(onMessage).toBeTruthy()
    await onMessage?.(messageEvent)
    expect(harness.sends).toHaveLength(1)

    const action = harness.getAction()
    expect(action).toBeTruthy()
    const result = (await (action!.handler as (input: unknown) => Promise<unknown>)({
      text: '你好'
    })) as { success: boolean; output?: { skipped?: string } }
    expect(result.success).toBe(true)
    expect(result.output?.skipped).toBe('subscribe-mode')
  })

  it('自动化模式：事件路径不发送，动作路径给出回复', async () => {
    const activate = loadBackground()
    const harness = createApi({ ...baseConfig, executionMode: 'automation' })
    activate(harness.api as never)

    const onMessage = harness.handlers.get('message.received')
    await onMessage?.(messageEvent)
    expect(harness.sends).toHaveLength(0)

    const action = harness.getAction()
    const result = (await (action!.handler as (input: unknown) => Promise<unknown>)({
      text: '你好'
    })) as { success: boolean; reply?: { text: string }; output?: { matched?: boolean } }
    expect(result.success).toBe(true)
    expect(result.output?.matched).toBe(true)
    expect(result.reply?.text).toBe('你好呀')
  })

  it('文本相同但事件不同，订阅模式各自回复', async () => {
    const activate = loadBackground()
    const harness = createApi({
      ...baseConfig,
      rules: [
        {
          id: 'r1',
          keyword: '你好',
          mode: 'contains',
          reply: '你好呀',
          enabled: true,
          cooldownSeconds: 0
        }
      ]
    })
    activate(harness.api as never)
    const onMessage = harness.handlers.get('message.received')

    await onMessage?.({ ...messageEvent, eventId: 'evt-a' })
    await onMessage?.({ ...messageEvent, eventId: 'evt-b' })
    // 没有按文本去重：两条独立消息都应回复。
    expect(harness.sends).toHaveLength(2)
  })
})
