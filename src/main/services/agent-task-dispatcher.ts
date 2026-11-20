import { randomUUID } from 'node:crypto'
import type { AgentTaskRecord, AgentTaskReply } from '../../shared/agent-task'
import type { NormalizedIncomingMessage } from './message-listener-service'
import { classifyProviderError, type AgentTaskProvider } from './agent-task-provider'
import type { AgentTaskStore } from './agent-task-store'
import type { WorkBuddyAgentSettings } from './agent-task-config'

/**
 * AgentTaskDispatcher —— `/ai` 命令闸门 + 任务投递 + 回复轮询。
 *
 * **默认关闭，且只认白名单会话**。这是刻意的产品边界：
 * 收到任意普通微信消息就唤醒 AI，等于把聊天记录变成无人监督的指令流。
 *
 * ```text
 * NormalizedIncomingMessage
 *   ├─ enabled?            no → 丢弃
 *   ├─ 白名单会话?          no → 丢弃
 *   ├─ 自己发的?            yes → 丢弃（防自触发循环）
 *   ├─ 以 `/ai ` 开头?      no → 丢弃
 *   └─ triggerKey 已提交?   yes → 丢弃（同一条消息只投一次）
 *          ↓
 *   AgentTaskProvider.submitTask
 *          ↓
 *   状态持久化（submitting → submitted → completed / timeout / auth_failed ...）
 * ```
 *
 * **不做的事**：不执行 shell、不删文件、不推代码、不发微信。
 * 任务内容只是转交给远端助理的一段文本；本模块不解释、不放行任何高风险动作。
 */

const MAX_REPLIES_PER_TASK = 50
const MAX_PROMPT_CHARS = 4000

export type AgentTaskDispatchOutcome =
  | 'disabled'
  | 'ignored'
  | 'duplicate'
  | 'submitted'
  | 'offline'
  | 'auth_failed'
  | 'failed'

export interface AgentTaskDispatcherOptions {
  settings: WorkBuddyAgentSettings
  store: AgentTaskStore
  provider: AgentTaskProvider
  resolveConversationId: (sessionId: string) => string | undefined
  now?: () => number
}

export class AgentTaskDispatcher {
  private readonly now: () => number
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private polling = false

  constructor(private readonly options: AgentTaskDispatcherOptions) {
    this.now = options.now ?? Date.now
  }

  /**
   * 处理一条已规范化的消息。
   *
   * 前置判断全部同步完成（没有 await），保证同一批事件里重复投递的同一条消息
   * 会在第二次调用时直接命中去重表。
   */
  async handleMessage(message: NormalizedIncomingMessage): Promise<AgentTaskDispatchOutcome> {
    const settings = this.options.settings
    if (!settings.enabled) return 'disabled'
    if (message.isSelf) return 'ignored'

    const prompt = matchCommand(message.content, settings.commandPrefix)
    if (!prompt) return 'ignored'

    const conversationId = this.options.resolveConversationId(message.sessionId)
    if (!conversationId) return 'ignored'
    if (!settings.allowedConversations.includes(conversationId)) return 'ignored'

    await this.options.store.load()

    const triggerKey = `${message.sessionId}:${message.localId}`
    if (this.options.store.findByTrigger(triggerKey)) return 'duplicate'

    const now = this.now()
    const record: AgentTaskRecord = {
      id: randomUUID(),
      provider: this.options.provider.id,
      conversationId,
      triggerKey,
      prompt: prompt.slice(0, MAX_PROMPT_CHARS),
      status: 'submitting',
      createdAt: now,
      updatedAt: now,
      replies: []
    }
    this.options.store.upsert(record)
    /*
     * 必须在发请求前落盘。debounce 的写入不足以支撑「不重复提交」——
     * 崩溃窗口正是发生在这两步之间。
     */
    await this.options.store.flush()

    let online: boolean
    try {
      online = await this.options.provider.checkOnline()
    } catch (error) {
      return this.finishFailure(record, error, 'online_check')
    }
    if (!online) {
      this.update(record, {
        status: 'offline',
        errorKind: 'offline',
        errorMessage: 'WorkBuddy 本机助理不在线，未提交'
      })
      await this.options.store.flush()
      return 'offline'
    }

    try {
      const { messageId } = await this.options.provider.submitTask({ content: record.prompt })
      this.update(record, {
        status: 'submitted',
        submittedAt: this.now(),
        externalMessageId: messageId,
        lastReplyId: messageId,
        errorKind: undefined,
        errorMessage: undefined
      })
      await this.options.store.flush()
      return 'submitted'
    } catch (error) {
      return this.finishFailure(record, error, 'submit')
    }
  }

  /** 启动轮询。重复调用是幂等的。 */
  start(): void {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => {
      void this.pollOnce()
    }, this.options.settings.pollIntervalMs)
    this.pollTimer.unref?.()
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  /**
   * 拉取所有 `submitted` 任务的增量回复。
   *
   * 返回本次处理的任务数（便于测试与诊断）。并发调用会被直接跳过。
   */
  async pollOnce(): Promise<number> {
    if (this.polling) return 0
    this.polling = true
    try {
      await this.options.store.load()
      const pending = this.options.store
        .list(200)
        .filter((record) => record.status === 'submitted' && Boolean(record.externalMessageId))
      let processed = 0

      for (const record of pending) {
        const startedAt = record.submittedAt ?? record.createdAt
        if (this.now() - startedAt > this.options.settings.maxPollDurationMs) {
          this.update(record, {
            status: 'timeout',
            errorKind: 'timeout',
            errorMessage: '等待 WorkBuddy 回复超时，已停止轮询'
          })
          processed += 1
          continue
        }

        try {
          const replies = await this.options.provider.fetchReplies(
            record.lastReplyId ?? String(record.externalMessageId)
          )
          const merged = mergeReplies(record.replies, replies)
          const assistant = merged.find((reply) => reply.role === 'assistant')
          this.update(record, {
            replies: merged,
            lastReplyId:
              merged.length > 0 ? merged[merged.length - 1].messageId : record.lastReplyId,
            ...(assistant
              ? {
                  status: 'completed' as const,
                  completedAt: this.now(),
                  errorKind: undefined,
                  errorMessage: undefined
                }
              : {})
          })
          processed += 1
        } catch (error) {
          this.finishFailure(record, error, 'poll')
        }
      }

      if (processed > 0) await this.options.store.flush()
      return processed
    } finally {
      this.polling = false
    }
  }

  private finishFailure(
    record: AgentTaskRecord,
    error: unknown,
    stage: 'online_check' | 'submit' | 'poll'
  ): AgentTaskDispatchOutcome {
    const info = classifyProviderError(error)
    const authFailure = info.kind === 'auth_expired' || info.kind === 'auth_missing'

    /*
     * 投递阶段只要发生「可能已经到达远端」的失败（超时 / 可重试的 5xx / 网络错误），
     * 就必须记成 ambiguous_submission —— 自动重试会造成重复任务。
     */
    const ambiguous =
      stage === 'submit' &&
      (info.kind === 'timeout' || (info.kind === 'http_error' && info.retryable))

    if (ambiguous) {
      this.update(record, {
        status: 'failed',
        errorKind: 'ambiguous_submission',
        errorMessage: `投递结果未知：${info.message}；不会自动重试`
      })
      void this.options.store.flush()
      return 'failed'
    }

    /*
     * 轮询阶段的普通失败（5xx / 网络抖动）不应把任务判死：
     * 远端可能仍在执行，下一轮继续拉取即可。只有鉴权失败才改状态。
     */
    if (stage === 'poll' && !authFailure) {
      this.update(record, {
        status: record.status,
        errorKind: info.kind,
        errorMessage: info.message
      })
      void this.options.store.flush()
      return 'failed'
    }

    this.update(record, {
      status: authFailure ? 'auth_failed' : 'failed',
      errorKind: info.kind,
      errorMessage: info.message
    })
    void this.options.store.flush()
    return authFailure ? 'auth_failed' : 'failed'
  }

  private update(record: AgentTaskRecord, patch: Partial<AgentTaskRecord>): void {
    Object.assign(record, patch, { updatedAt: this.now() })
    if (record.errorKind === undefined) delete record.errorKind
    if (record.errorMessage === undefined) delete record.errorMessage
    this.options.store.upsert(record)
  }
}

/**
 * 只接受「前缀 + 空白」或整条等于前缀。
 *
 * `/ai写日报` 不触发：没有分隔符时无法区分命令与普通文本，
 * 宁可漏触发也不要把正常聊天吞掉。
 */
export function matchCommand(content: string | undefined, prefix: string): string | null {
  const text = String(content ?? '').trim()
  if (!text || !prefix) return null
  if (!text.toLowerCase().startsWith(prefix.toLowerCase())) return null
  const rest = text.slice(prefix.length)
  if (rest && !/^\s/.test(rest)) return null
  return rest.trim()
}

function mergeReplies(existing: AgentTaskReply[], incoming: AgentTaskReply[]): AgentTaskReply[] {
  if (incoming.length === 0) return existing
  const seen = new Set(existing.map((reply) => reply.messageId))
  const merged = [...existing]
  for (const reply of incoming) {
    if (seen.has(reply.messageId)) continue
    seen.add(reply.messageId)
    merged.push(reply)
  }
  return merged.slice(-MAX_REPLIES_PER_TASK)
}
