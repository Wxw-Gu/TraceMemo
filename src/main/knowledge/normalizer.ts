import { createHash } from 'crypto'
import type {
  KnowledgeNormalizedMessage,
  KnowledgeSourceMessage
} from '../../shared/knowledge'

const compact = (value: string | undefined): string => value?.replace(/\s+/g, ' ').trim() || ''

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Converts a read-only archive record into text safe for local search. Paths,
 * binary media and raw voice data are deliberately excluded.
 */
export function normalizeKnowledgeMessage(
  source: KnowledgeSourceMessage
): KnowledgeNormalizedMessage {
  const sections: string[] = []
  const messageText = compact(source.text)
  if (messageText) sections.push(messageText)

  const transcript = compact(source.voiceTranscript)
  if (transcript) sections.push(`语音转写：${transcript}`)

  const attachmentName = compact(source.attachment?.name)
  if (attachmentName) {
    const label = source.attachment?.kind === 'link' ? '链接' : '附件'
    sections.push(`${label}：${attachmentName}`)
  }
  const url = compact(source.attachment?.url)
  if (url) sections.push(`地址：${url}`)

  const searchableText = sections.join('\n')
  return {
    ...source,
    text: messageText || undefined,
    voiceTranscript: transcript || undefined,
    searchableText,
    contentHash: digest(
      JSON.stringify({
        messageId: source.messageId,
        createTime: source.createTime,
        senderId: source.senderId || '',
        kind: source.kind,
        searchableText
      })
    )
  }
}

export function isIndexableKnowledgeMessage(message: KnowledgeNormalizedMessage): boolean {
  return Boolean(message.searchableText.trim())
}
