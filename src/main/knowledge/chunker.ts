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

  const chunks: KnowledgeChunk[] = []
  let current: KnowledgeNormalizedMessage[] = []
  let currentCharacters = 0
  for (const message of sorted) {
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
  if (current.length) chunks.push(buildChunk(current, config))
  return chunks
}
