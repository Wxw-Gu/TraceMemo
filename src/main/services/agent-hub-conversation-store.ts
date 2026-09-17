import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  agentHubKindPlaceholder,
  type AgentHubConversation,
  type AgentHubConversationMessage,
  type AgentHubConversationSummary,
  type AgentHubMessageKind,
  type AgentHubMessageStatus
} from '../../shared/agent-hub-conversation'

/**
 * Agent Hub 对话记录存储。
 *
 * 设计取向：
 * - 一个 JSON 文件装全部会话，按「最近活跃」排序，避免为几十个会话开目录；
 * - 每个会话最多保留 N 条（默认 500），超出丢最旧的，文件不会无限增长；
 * - 会话数也有上限（默认 50），只保留最近活跃的；
 * - 原子写（tmp + rename）+ 0600，任何一个环节失败都不能影响真实收发。
 *
 * 与 `WechatInboundInbox` 的区别：收件箱是**待处理的在途消息**（处理完即删），
 * 这里是**供人回看的历史**（按上限长期保留）。
 */

const DEFAULT_MAX_MESSAGES_PER_CONVERSATION = 500
const DEFAULT_MAX_CONVERSATIONS = 50

interface ConversationFile {
  version: 1
  conversations: AgentHubConversation[]
}

export interface AgentHubConversationStoreOptions {
  filePath: () => string
  maxMessagesPerConversation?: number
  maxConversations?: number
  now?: () => number
  createId?: () => string
}

export interface AppendInput {
  userId: string
  accountId?: string
  direction: 'in' | 'out'
  kind: AgentHubMessageKind
  text: string
  messageId?: string
  status?: AgentHubMessageStatus
  errorCode?: string
  createdAt?: number
}

export class AgentHubConversationStore {
  private readonly options: AgentHubConversationStoreOptions
  private readonly maxMessages: number
  private readonly maxConversations: number
  private cache: AgentHubConversation[] | null = null

  constructor(options: AgentHubConversationStoreOptions) {
    this.options = options
    this.maxMessages = options.maxMessagesPerConversation ?? DEFAULT_MAX_MESSAGES_PER_CONVERSATION
    this.maxConversations = options.maxConversations ?? DEFAULT_MAX_CONVERSATIONS
  }

  /** 追加一条消息，返回受影响会话的摘要与这条消息（供 UI 增量刷新）。 */
  append(
    input: AppendInput
  ): { summary: AgentHubConversationSummary; message: AgentHubConversationMessage } | null {
    const userId = String(input.userId || '').trim()
    if (!userId) return null

    const createdAt = input.createdAt ?? this.options.now?.() ?? Date.now()
    const message: AgentHubConversationMessage = {
      id: this.options.createId?.() ?? randomUUID(),
      direction: input.direction,
      kind: input.kind,
      text: String(input.text ?? ''),
      createdAt,
      ...(input.status ? { status: input.status } : {}),
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      ...(input.messageId ? { messageId: input.messageId } : {})
    }

    try {
      const conversations = this.load()
      const index = conversations.findIndex((item) => item.userId === userId)
      if (index >= 0) {
        const existing = conversations[index]
        const messages = [...existing.messages, message].slice(-this.maxMessages)
        conversations[index] = {
          ...existing,
          ...(input.accountId ? { accountId: input.accountId } : {}),
          lastAt: createdAt,
          messages
        }
      } else {
        conversations.push({
          userId,
          ...(input.accountId ? { accountId: input.accountId } : {}),
          firstAt: createdAt,
          lastAt: createdAt,
          messages: [message]
        })
      }

      // 只保留最近活跃的 maxConversations 个会话。
      const trimmed = conversations
        .sort((left, right) => right.lastAt - left.lastAt)
        .slice(0, this.maxConversations)
      this.persist(trimmed)
      this.cache = trimmed
      const summary = this.toSummary(trimmed.find((item) => item.userId === userId) ?? null)
      return summary ? { summary, message } : null
    } catch (error) {
      // 记录历史失败绝不能影响真实收发。
      console.warn('[AgentHubConversation] 写入对话记录失败:', error)
      return null
    }
  }

  listSummaries(): AgentHubConversationSummary[] {
    return this.load()
      .slice()
      .sort((left, right) => right.lastAt - left.lastAt)
      .map((conversation) => this.toSummary(conversation))
      .filter((summary): summary is AgentHubConversationSummary => summary !== null)
  }

  get(userId: string): AgentHubConversation | null {
    const normalized = String(userId || '').trim()
    if (!normalized) return null
    const found = this.load().find((item) => item.userId === normalized)
    if (!found) return null
    return { ...found, messages: found.messages.map((message) => ({ ...message })) }
  }

  clear(): void {
    this.persist([])
    this.cache = []
  }

  private toSummary(conversation: AgentHubConversation | null): AgentHubConversationSummary | null {
    if (!conversation) return null
    const last = conversation.messages[conversation.messages.length - 1]
    const preview = last ? last.text.trim() || agentHubKindPlaceholder(last.kind) : ''
    return {
      userId: conversation.userId,
      ...(conversation.accountId ? { accountId: conversation.accountId } : {}),
      firstAt: conversation.firstAt,
      lastAt: conversation.lastAt,
      messageCount: conversation.messages.length,
      lastPreview: preview,
      lastDirection: last?.direction ?? 'in'
    }
  }

  private load(): AgentHubConversation[] {
    if (this.cache) return this.cache
    let parsed: ConversationFile | null = null
    try {
      parsed = JSON.parse(readFileSync(this.options.filePath(), 'utf8')) as ConversationFile
    } catch {
      parsed = null
    }
    const conversations = Array.isArray(parsed?.conversations)
      ? parsed!.conversations.filter((item): item is AgentHubConversation =>
          Boolean(item && typeof item === 'object' && String(item.userId || '').trim())
        )
      : []
    this.cache = conversations
    return conversations
  }

  private persist(conversations: AgentHubConversation[]): void {
    const path = this.options.filePath()
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`
    try {
      writeFileSync(
        tempPath,
        JSON.stringify({ version: 1, conversations } satisfies ConversationFile),
        { encoding: 'utf8', mode: 0o600 }
      )
      chmodSync(tempPath, 0o600)
      renameSync(tempPath, path)
      chmodSync(path, 0o600)
    } catch (error) {
      rmSync(tempPath, { force: true })
      throw error
    }
  }
}
