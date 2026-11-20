import { createHash } from 'crypto'
import type {
  KnowledgeChunk,
  KnowledgeChunkerConfig,
  KnowledgeNormalizedMessage
} from '../../shared/knowledge'
import { isIndexableKnowledgeMessage } from './normalizer'

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function formatChunkText(messages: KnowledgeNormalizedMessage[]): string {
  return messages
    .map((message) => {
      const sender = message.senderName || message.senderId || '未知成员'
      return `[${new Date(message.createTime).toISOString()}] ${sender}: ${message.searchableText}`
    })
    .join('\n')
}

function buildChunk(
  messages: KnowledgeNormalizedMessage[],
  config: KnowledgeChunkerConfig
): KnowledgeChunk {
  const first = messages[0]
  const last = messages[messages.length - 1]
  const text = formatChunkText(messages)
  const messageIds = messages.map((message) => message.messageId)
  const participantIds = Array.from(
    new Set(messages.map((message) => message.senderId).filter((value): value is string => Boolean(value)))
  )
  const messageKinds = Array.from(new Set(messages.map((message) => message.kind)))
  const identity = `${first.accountId}|${first.conversationId}|${config.version}|${messageIds.join('|')}`
  return {
    chunkId: digest(identity),
    accountId: first.accountId,
    conversationId: first.conversationId,
    startTime: first.createTime,
    endTime: last.createTime,
    text,
    messageIds,
    participantIds,
    messageKinds,
    contentHash: digest(`${identity}|${text}`),
    chunkerVersion: config.version
  }
}

/** Chunks one conversation only; cross-conversation chunks are never allowed. */
export function chunkConversation(
  messages: KnowledgeNormalizedMessage[],
  config: KnowledgeChunkerConfig
): KnowledgeChunk[] {
  const sorted = messages
    .filter(isIndexableKnowledgeMessage)
    .slice()
    .sort((left, right) => left.createTime - right.createTime || left.messageId.localeCompare(right.messageId))
  if (!sorted.length) return []

  const conversationId = sorted[0].conversationId
  const accountId = sorted[0].accountId
  if (sorted.some((message) => message.conversationId !== conversationId || message.accountId !== accountId)) {
    throw new Error('Conversation chunker received messages from multiple accounts or conversations')
  }

  const streamer = createChunkStreamer(config)
  return [...streamer.push(sorted), ...streamer.drain()]
}

export interface KnowledgeChunkStreamer {
  /** 追加一批有序消息，返回因此**收盘**的 chunk（不含尾部未完成段）。 */
  push(messages: KnowledgeNormalizedMessage[]): KnowledgeChunk[]
  /** 收盘尾部未完成段；之后再 `push` 会开启新段。 */
  drain(): KnowledgeChunk[]
  /** 尚未收盘的消息数；用于持久化续跑位置。 */
  pendingCount(): number
}

/**
 * 切分只依赖相邻两条与累积长度，所以分批 push 与一次性切分逐字等价。
 */
export function createChunkStreamer(config: KnowledgeChunkerConfig): KnowledgeChunkStreamer {
  let current: KnowledgeNormalizedMessage[] = []
  let currentCharacters = 0

  return {
    push(messages) {
      const chunks: KnowledgeChunk[] = []
      for (const message of messages) {
        if (!isIndexableKnowledgeMessage(message)) continue
        const previous = current[current.length - 1]
        const nextCharacters = currentCharacters + message.searchableText.length
        const shouldSplit =
          current.length > 0 &&
          (message.createTime - previous.createTime > config.maxGapMs ||
            current.length >= config.maxMessages ||
            nextCharacters > config.maxCharacters)
        if (shouldSplit) {
          chunks.push(buildChunk(current, config))
          current = []
          currentCharacters = 0
        }
        current.push(message)
        currentCharacters += message.searchableText.length
      }
      return chunks
    },
    drain() {
      if (!current.length) return []
      const chunk = buildChunk(current, config)
      current = []
      currentCharacters = 0
      return [chunk]
    },
    pendingCount() {
      return current.length
    }
  }
}
