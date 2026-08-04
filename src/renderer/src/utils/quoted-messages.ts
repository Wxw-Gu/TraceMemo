import type { Message } from '../../../shared/types'

const normalizeQuotedText = (value: string | undefined): string =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .trim()

export const isInternalReferenceSender = (value: string | undefined): boolean => {
  const sender = String(value || '').trim()
  return (
    !sender ||
    sender.endsWith('@chatroom') ||
    sender.startsWith('wxid_') ||
    /^[a-z0-9_@.-]{12,}$/i.test(sender)
  )
}

export function enrichQuotedMessages(
  messages: Message[],
  referenceMessages: Message[],
  resolveSenderName?: (senderId: string) => string | undefined
): Message[] {
  const imageDatNameByMd5 = new Map<string, string>()
  const messagesByContent = new Map<string, Message[]>()
  const senderNames = new Map<string, string>()

  for (const message of referenceMessages) {
    if (
      message.contentData?.type === 'image' &&
      message.contentData.md5 &&
      message.contentData.datName
    ) {
      imageDatNameByMd5.set(message.contentData.md5, message.contentData.datName)
    }
    const senderId = String(message.senderId || '').trim()
    const senderName = String(message.name || '').trim()
    if (senderId && senderName && !isInternalReferenceSender(senderName)) {
      senderNames.set(senderId, senderName)
    }
    const content = normalizeQuotedText(message.content)
    if (!content) continue
    const candidates = messagesByContent.get(content) || []
    candidates.push(message)
    messagesByContent.set(content, candidates)
  }

  return messages.map((message) => {
    if (message.contentData?.type !== 'quote') return message
    const quote = message.contentData
    let quotedImageDatName = quote.quotedImageDatName
    if (!quotedImageDatName && quote.quotedImageMd5) {
      quotedImageDatName = imageDatNameByMd5.get(quote.quotedImageMd5)
    }

    let quotedSender = quote.quotedSender
    if (isInternalReferenceSender(quotedSender)) {
      const senderId = String(quotedSender || '').trim()
      const mappedName =
        (senderId ? resolveSenderName?.(senderId) : undefined) || senderNames.get(senderId)
      if (mappedName && !isInternalReferenceSender(mappedName)) {
        quotedSender = mappedName
      } else {
        const candidates = messagesByContent.get(normalizeQuotedText(quote.quotedContent)) || []
        const source = candidates
          .filter((candidate) => (candidate.createTime || 0) <= (message.createTime || Infinity))
          .sort((left, right) => (right.createTime || 0) - (left.createTime || 0))[0]
        if (source?.name && !isInternalReferenceSender(source.name)) quotedSender = source.name
      }
    }

    if (quotedSender === quote.quotedSender && quotedImageDatName === quote.quotedImageDatName) {
      return message
    }
    return {
      ...message,
      contentData: { ...quote, quotedSender, quotedImageDatName }
    }
  })
}
