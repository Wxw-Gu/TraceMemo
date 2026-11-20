import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentTaskDispatcher, matchCommand } from '../../src/main/services/agent-task-dispatcher'
import { AgentTaskStore } from '../../src/main/services/agent-task-store'
import {
  AgentTaskProviderError,
  type AgentTaskProvider
} from '../../src/main/services/agent-task-provider'
import type { WorkBuddyAgentSettings } from '../../src/main/services/agent-task-config'
import type { NormalizedIncomingMessage } from '../../src/main/services/message-listener-service'

/**
 * `/ai` 闸门与任务生命周期。
 *
 * 重点不是「能提交」，而是**不该提交的时候一次都不提交**：
 * 默认禁用、非白名单、自己发的、没有 `/ai ` 前缀、同一条消息重复投递。
 */

const SESSION = 'group_A@chatroom'
const CONVERSATION = 'md5_conversation_a'
const NOW = 1_800_000_000_000

const settings = (overrides: Partial<WorkBuddyAgentSettings> = {}): WorkBuddyAgentSettings => ({
  enabled: true,
  allowedConversations: [CONVERSATION],
  commandPrefix: '/ai',
  baseUrl: 'https://workbuddy.test',
  timeoutMs: 500,
  pollIntervalMs: 1000,
  maxPollDurationMs: 60_000,
  ...overrides
})

const makeMessage = (
  overrides: Partial<NormalizedIncomingMessage> = {}
): NormalizedIncomingMessage => ({
  sessionId: SESSION,
  localId: '100',
  createTime: Math.floor(NOW / 1000),
  messageType: 1,
  isSelf: false,
  senderId: 'OTHER_USER',
  content: '/ai 写一份今天的日报',
  isGroup: true,
  mentionTargets: [],
  ...overrides
})

function makeProvider(overrides: Partial<AgentTaskProvider> = {}): AgentTaskProvider & {
  checkOnline: ReturnType<typeof vi.fn>
  submitTask: ReturnType<typeof vi.fn>
  fetchReplies: ReturnType<typeof vi.fn>
} {
  return {
    id: 'workbuddy',
    checkOnline: vi.fn(async () => true),
    submitTask: vi.fn(async () => ({ messageId: 'msg-1' })),
    fetchReplies: vi.fn(async () => []),
    ...overrides
  } as never
}

let root: string
const stores: AgentTaskStore[] = []

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tracememo-agent-task-'))
})

afterEach(async () => {
  // 先 flush 再删目录，否则 debounce 的写盘会和 teardown 抢跑（ENOENT 噪声）。
  await Promise.all(stores.splice(0).map((store) => store.flush()))
  fs.rmSync(root, { recursive: true, force: true })
})

function makeDispatcher(
  options: {
    settings?: WorkBuddyAgentSettings
    provider?: ReturnType<typeof makeProvider>
    storeFile?: string
  } = {}
): {
  dispatcher: AgentTaskDispatcher
  store: AgentTaskStore
  provider: ReturnType<typeof makeProvider>
} {
  const provider = options.provider ?? makeProvider()
  const store = new AgentTaskStore({
    filePath: options.storeFile ?? path.join(root, 'agent-tasks.json'),
    debounceMs: 0
  })
  stores.push(store)
  const dispatcher = new AgentTaskDispatcher({
    settings: options.settings ?? settings(),
    store,
    provider,
    resolveConversationId: (sessionId) => (sessionId === SESSION ? CONVERSATION : undefined),
    now: () => NOW
  })
  return { dispatcher, store, provider }
}

describe('命令识别', () => {
  it('只接受「前缀 + 空白」，`/ai写` 不触发', () => {
    expect(matchCommand('/ai 写日报', '/ai')).toBe('写日报')
    expect(matchCommand('  /ai   写日报  ', '/ai')).toBe('写日报')
    expect(matchCommand('/ai', '/ai')).toBe('')
    expect(matchCommand('/ai写日报', '/ai')).toBeNull()
    expect(matchCommand('请 /ai 写日报', '/ai')).toBeNull()
    expect(matchCommand(undefined, '/ai')).toBeNull()
  })

  it('前缀大小写不敏感，但内容原样保留', () => {
    expect(matchCommand('/AI 保留大小写 ABC', '/ai')).toBe('保留大小写 ABC')
  })
})

describe('闸门：不该提交时一次都不提交', () => {
  it('默认禁用', async () => {
    const { dispatcher, provider } = makeDispatcher({ settings: settings({ enabled: false }) })
    await expect(dispatcher.handleMessage(makeMessage())).resolves.toBe('disabled')
    expect(provider.checkOnline).not.toHaveBeenCalled()
    expect(provider.submitTask).not.toHaveBeenCalled()
  })

  it('白名单为空时等同于不触发', async () => {
    const { dispatcher, provider } = makeDispatcher({
      settings: settings({ allowedConversations: [] })
    })
    await expect(dispatcher.handleMessage(makeMessage())).resolves.toBe('ignored')
    expect(provider.submitTask).not.toHaveBeenCalled()
  })

  it('非白名单会话不触发', async () => {
    const { dispatcher, provider } = makeDispatcher({
      settings: settings({ allowedConversations: ['md5_other'] })
    })
    await expect(dispatcher.handleMessage(makeMessage())).resolves.toBe('ignored')
    expect(provider.submitTask).not.toHaveBeenCalled()
  })

  it('自己发送的消息不触发（防自循环）', async () => {
    const { dispatcher, provider } = makeDispatcher()
    await expect(dispatcher.handleMessage(makeMessage({ isSelf: true }))).resolves.toBe('ignored')
    expect(provider.submitTask).not.toHaveBeenCalled()
  })

  it('普通消息不唤醒 AI', async () => {
    const { dispatcher, provider } = makeDispatcher()
    await expect(dispatcher.handleMessage(makeMessage({ content: '今天吃什么' }))).resolves.toBe(
      'ignored'
    )
    await expect(dispatcher.handleMessage(makeMessage({ content: '/ai写日报' }))).resolves.toBe(
      'ignored'
    )
    await expect(dispatcher.handleMessage(makeMessage({ content: '/ai ' }))).resolves.toBe(
      'ignored'
    )
    expect(provider.submitTask).not.toHaveBeenCalled()
  })

  it('无法映射会话时不提交（拿不到 stable conversationId）', async () => {
    const { dispatcher, provider } = makeDispatcher()
    await expect(
      dispatcher.handleMessage(makeMessage({ sessionId: 'unknown@chatroom' }))
    ).resolves.toBe('ignored')
    expect(provider.submitTask).not.toHaveBeenCalled()
  })
})

describe('提交与幂等', () => {
  it('`/ai ` 命令只把去前缀后的文本交给 provider', async () => {
    const { dispatcher, provider, store } = makeDispatcher()
    await expect(dispatcher.handleMessage(makeMessage())).resolves.toBe('submitted')

    expect(provider.submitTask).toHaveBeenCalledTimes(1)
    expect(provider.submitTask).toHaveBeenCalledWith({ content: '写一份今天的日报' })

    const task = store.findByTrigger(`${SESSION}:100`)
    expect(task).toMatchObject({
      status: 'submitted',
      externalMessageId: 'msg-1',
      provider: 'workbuddy',
      conversationId: CONVERSATION
    })
  })

  it('同一条微信消息重复投递只提交一次', async () => {
    const { dispatcher, provider } = makeDispatcher()
    await expect(dispatcher.handleMessage(makeMessage())).resolves.toBe('submitted')
    await expect(dispatcher.handleMessage(makeMessage())).resolves.toBe('duplicate')
    await expect(dispatcher.handleMessage(makeMessage())).resolves.toBe('duplicate')

    expect(provider.submitTask).toHaveBeenCalledTimes(1)
  })

  it('进程重启后仍按 triggerKey 去重，不重复提交', async () => {
    const storeFile = path.join(root, 'agent-tasks.json')
    const first = makeDispatcher({ storeFile })
    await first.dispatcher.handleMessage(makeMessage())
    await first.store.flush()

    const second = makeDispatcher({ storeFile })
    await expect(second.dispatcher.handleMessage(makeMessage())).resolves.toBe('duplicate')
    expect(second.provider.submitTask).not.toHaveBeenCalled()
  })

  it('离线时不提交，并如实记录 offline', async () => {
    const provider = makeProvider({ checkOnline: vi.fn(async () => false) })
    const { dispatcher, store } = makeDispatcher({ provider })
    await expect(dispatcher.handleMessage(makeMessage())).resolves.toBe('offline')

    expect(provider.submitTask).not.toHaveBeenCalled()
    expect(store.findByTrigger(`${SESSION}:100`)).toMatchObject({
      status: 'offline',
      errorKind: 'offline'
    })
  })

  it('鉴权失败时记录 auth_failed，不重试', async () => {
    const provider = makeProvider({
      checkOnline: vi.fn(async () => {
        throw new AgentTaskProviderError('auth_expired', 'token 过期', false, 401)
      })
    })
    const { dispatcher, store } = makeDispatcher({ provider })
    await expect(dispatcher.handleMessage(makeMessage())).resolves.toBe('auth_failed')
    expect(provider.submitTask).not.toHaveBeenCalled()
    expect(store.findByTrigger(`${SESSION}:100`)).toMatchObject({
      status: 'auth_failed',
      errorKind: 'auth_expired'
    })
  })

  it('投递超时记为 ambiguous_submission，绝不自动重试', async () => {
    const provider = makeProvider({
      submitTask: vi.fn(async () => {
        throw new AgentTaskProviderError('timeout', 'request timeout', true)
      })
    })
    const { dispatcher, store } = makeDispatcher({ provider })
    await expect(dispatcher.handleMessage(makeMessage())).resolves.toBe('failed')

    const task = store.findByTrigger(`${SESSION}:100`)
    expect(task).toMatchObject({ status: 'failed', errorKind: 'ambiguous_submission' })
    expect(task?.errorMessage).toContain('不会自动重试')

    // 再投一次同一条消息：仍然被 triggerKey 去重，不会出现第二次远端调用。
    await expect(dispatcher.handleMessage(makeMessage())).resolves.toBe('duplicate')
    expect(provider.submitTask).toHaveBeenCalledTimes(1)
  })
})

describe('回复轮询', () => {
  it('拿到 assistant 回复后置 completed 并保存回复内容', async () => {
    const provider = makeProvider({
      fetchReplies: vi.fn(async () => [
        { messageId: 'm2', role: 'assistant' as const, text: '日报已生成' }
      ])
    })
    const { dispatcher, store } = makeDispatcher({ provider })
    await dispatcher.handleMessage(makeMessage())
    await expect(dispatcher.pollOnce()).resolves.toBe(1)

    expect(provider.fetchReplies).toHaveBeenCalledWith('msg-1')
    const task = store.findByTrigger(`${SESSION}:100`)
    expect(task).toMatchObject({
      status: 'completed',
      replies: [{ messageId: 'm2', role: 'assistant', text: '日报已生成' }]
    })
    expect(task?.completedAt).toBe(NOW)
  })

  it('只拿到 user 回显时保持 submitted，不提前宣告完成', async () => {
    const provider = makeProvider({
      fetchReplies: vi.fn(async () => [{ messageId: 'm2', role: 'user' as const, text: '写日报' }])
    })
    const { dispatcher, store } = makeDispatcher({ provider })
    await dispatcher.handleMessage(makeMessage())
    await dispatcher.pollOnce()

    expect(store.findByTrigger(`${SESSION}:100`)?.status).toBe('submitted')
  })

  it('超过 maxPollDurationMs 后置 timeout 并停止轮询', async () => {
    const provider = makeProvider()
    const { dispatcher, store } = makeDispatcher({
      provider,
      settings: settings({ maxPollDurationMs: -1 })
    })
    await dispatcher.handleMessage(makeMessage())
    await dispatcher.pollOnce()

    expect(store.findByTrigger(`${SESSION}:100`)?.status).toBe('timeout')
    provider.fetchReplies.mockClear()
    await dispatcher.pollOnce()
    expect(provider.fetchReplies).not.toHaveBeenCalled()
  })

  it('轮询失败不会把已提交任务改成失败（保留下次重试）', async () => {
    const provider = makeProvider({
      fetchReplies: vi.fn(async () => {
        throw new AgentTaskProviderError('http_error', 'temporary', true, 503)
      })
    })
    const { dispatcher, store } = makeDispatcher({ provider })
    await dispatcher.handleMessage(makeMessage())
    await dispatcher.pollOnce()

    expect(store.findByTrigger(`${SESSION}:100`)?.status).toBe('submitted')
  })
})

describe('持久化恢复', () => {
  it('`submitting` 状态的记录在重启后被标记成不可重试的 ambiguous_submission', async () => {
    const storeFile = path.join(root, 'agent-tasks.json')
    fs.writeFileSync(
      storeFile,
      JSON.stringify([
        {
          id: 'task-1',
          provider: 'workbuddy',
          conversationId: CONVERSATION,
          triggerKey: `${SESSION}:100`,
          prompt: '写日报',
          status: 'submitting',
          createdAt: NOW,
          updatedAt: NOW,
          replies: []
        }
      ])
    )

    const store = new AgentTaskStore({ filePath: storeFile, debounceMs: 0 })
    await store.load()
    expect(store.findByTrigger(`${SESSION}:100`)).toMatchObject({
      status: 'failed',
      errorKind: 'ambiguous_submission'
    })
  })

  it('store 文件权限为 0600', async () => {
    const storeFile = path.join(root, 'agent-tasks.json')
    const { dispatcher, store } = makeDispatcher({ storeFile })
    await dispatcher.handleMessage(makeMessage())
    await store.flush()

    expect(fs.statSync(storeFile).mode & 0o777).toBe(0o600)
  })
})
