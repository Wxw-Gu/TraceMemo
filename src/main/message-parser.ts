type TextContent = { type: 'text'; content: string }
type VoiceContent = { type: 'voice'; duration?: number }
type LocationContent = {
  type: 'location'
  poiname?: string
  label?: string
  lat: number
  lng: number
}
type CardContent = { type: 'card'; username: string; nickname: string; avatarUrl?: string }
type ShareArticle = {
  title: string
  description?: string
  url: string
  coverUrl?: string
}
type ShareContent = {
  type: 'share'
  title: string
  des?: string
  url: string
  appname?: string
  typeVal?: string
  articles?: ShareArticle[]
}
type ForwardedMessageItem = {
  messageType: number
  sender?: string
  sentAt?: string
  text: string
  nested?: ForwardedMessageItem[]
}
type ForwardBundleContent = {
  type: 'forwardBundle'
  title: string
  description?: string
  items: ForwardedMessageItem[]
}
type MiniProgramContent = {
  type: 'miniProgram'
  title: string
  description?: string
  appName?: string
  iconUrl?: string
  thumbMd5?: string
  thumbDatName?: string
  thumbDataUrl?: string
}
type RedPacketContent = {
  type: 'redPacket'
  title: string
  description?: string
  url?: string
}
type VoipContent = { type: 'voip'; duration?: number; status: string; roomType?: number }
type ImageContent = {
  type: 'image'
  md5?: string
  datName?: string
  aeskey?: string
  encrypVer?: number
}
type VideoContent = {
  type: 'video'
  md5?: string
  newMd5?: string
  rawMd5?: string
  byteLength?: number
  duration?: number
  width?: number
  height?: number
}
type StickerContent = {
  type: 'sticker'
  md5?: string
  url?: string
  thumbUrl?: string
  encryptUrl?: string
  aeskey?: string
}
type QuoteContent = {
  type: 'quote'
  title?: string
  content?: string
  sender?: string
  quotedContent?: string
  quotedSender?: string
  quotedType?: string
  quotedImageMd5?: string
  quotedImageDatName?: string
}
type SystemContent = {
  type: 'system'
  content: string
  raw?: string
  pat?: boolean
  recall?: {
    targetId?: string
    targetIds?: string[]
    replacement: string
    actor?: string
    sessionId?: string
    recallTime?: number
  }
}
type UnknownContent = { type: 'unknown'; raw: string; messageType?: string | number }

export type ParsedContent =
  | TextContent
  | VoiceContent
  | LocationContent
  | CardContent
  | ShareContent
  | ForwardBundleContent
  | MiniProgramContent
  | RedPacketContent
  | VoipContent
  | ImageContent
  | VideoContent
  | StickerContent
  | QuoteContent
  | SystemContent
  | UnknownContent

export function parseMessageContent(content: string, messageType: number): ParsedContent {
  // Voice rows may keep their binary payload outside msgContent, so an empty
  // content string is still a valid voice message.
  if (messageType === 34) return { type: 'voice' }
  if (!content || typeof content !== 'string') {
    return { type: 'unknown', raw: content || '' }
  }

  const normalized = content.trim()

  switch (messageType) {
    case 1:
      return { type: 'text', content: normalized }
    case 3:
      return parseImageMessage(normalized)
    case 42:
      return parseCardMessage(normalized)
    case 43:
      return parseVideoMessage(normalized)
    case 47:
      return parseStickerMessage(normalized)
    case 48:
      return parseLocationMessage(normalized)
    case 49:
      return parseShareMessage(normalized)
    case 50:
      return parseVoipMessage(normalized)
    case 10000:
    case 10002:
      return parseSystemMessage(normalized)
    default:
      return { type: 'unknown', raw: normalized, messageType }
  }
}

function parseVideoMessage(content: string): ParsedContent {
  const decoded = decodeXmlEntities(stripChatroomPrefix(content))
  const md5 = normalizeMd5(extractXmlAttribute(decoded, 'videomsg', 'md5'))
  const newMd5 = normalizeMd5(extractXmlAttribute(decoded, 'videomsg', 'newmd5'))
  const rawMd5 = normalizeMd5(extractXmlAttribute(decoded, 'videomsg', 'rawmd5'))
  const byteLength = Number(extractXmlAttribute(decoded, 'videomsg', 'length')) || undefined
  const duration = Number(extractXmlAttribute(decoded, 'videomsg', 'playlength')) || undefined
  const width = Number(extractXmlAttribute(decoded, 'videomsg', 'cdnthumbwidth')) || undefined
  const height = Number(extractXmlAttribute(decoded, 'videomsg', 'cdnthumbheight')) || undefined
  return { type: 'video', md5, newMd5, rawMd5, byteLength, duration, width, height }
}

function parseSystemMessage(content: string): ParsedContent {
  const stripped = stripChatroomPrefix(content)
  const decoded = decodeXmlEntities(stripped)
  const recall = extractRecallMessage(decoded)
  if (recall) {
    return {
      type: 'system',
      content: recall.replacement,
      raw: content,
      recall
    }
  }
  const delChatroomMemberText = extractDelChatroomMemberText(decoded)
  if (delChatroomMemberText) {
    return {
      type: 'system',
      content: normalizeSystemText(delChatroomMemberText),
      raw: content
    }
  }
  const plainText =
    extractXmlNodeText(decoded, 'plain') ||
    extractXmlNodeText(decoded, 'text') ||
    extractXmlNodeText(decoded, 'title') ||
    extractXmlValue(decoded, 'plain') ||
    extractXmlValue(decoded, 'text') ||
    extractXmlValue(decoded, 'title') ||
    ''

  const normalized = normalizeSystemText(plainText || fallbackSystemText(decoded))
  return {
    type: 'system',
    content: normalized || '[系统消息]',
    raw: content
  }
}

function extractRecallMessage(xml: string):
  | {
      targetId?: string
      targetIds?: string[]
      replacement: string
      actor?: string
      sessionId?: string
      recallTime?: number
    }
  | undefined {
  if (!/<revokemsg\b/i.test(xml)) return undefined

  const replacement = normalizeSystemText(
    extractXmlValue(xml, 'replacemsg') ||
      extractXmlNodeText(xml, 'replacemsg') ||
      extractXmlValue(xml, 'content') ||
      extractXmlNodeText(xml, 'content')
  )
  if (!replacement) return undefined

  const actorMatch =
    /^["“](.+?)["”]\s*撤回了一条消息/.exec(replacement) ||
    /^(.+?)\s*撤回了一条消息/.exec(replacement)

  const targetIds = Array.from(
    new Set(
      [
        extractXmlValue(xml, 'newmsgid'),
        extractXmlValue(xml, 'msgid'),
        extractXmlValue(xml, 'clientmsgid')
      ].filter(Boolean)
    )
  )

  return {
    targetId: targetIds[0] || undefined,
    targetIds,
    replacement,
    actor: actorMatch?.[1]?.trim() || undefined,
    sessionId: extractXmlValue(xml, 'session') || undefined,
    recallTime: Number(extractXmlValue(xml, 'revoketime')) || undefined
  }
}

function parseImageMessage(content: string): ParsedContent {
  // 尝试 XML 格式: <img md5="..." aeskey="..."/>
  let md5 = extractXmlAttribute(content, 'img', 'md5') || extractXmlValue(content, 'md5') || ''
  let aeskey =
    extractXmlAttribute(content, 'img', 'aeskey') || extractXmlValue(content, 'aeskey') || undefined
  const encrypVerStr =
    extractXmlAttribute(content, 'img', 'encrypver') || extractXmlValue(content, 'encrypver') || '0'
  let datName = ''

  // 如果 XML 格式解析失败，尝试 JSON 格式
  if (!md5) {
    try {
      const json = JSON.parse(content)
      // 可能是引用消息格式 { type: "...", content: "md5", ... }
      if (
        json.content &&
        typeof json.content === 'string' &&
        /^[a-f0-9]{32}$/i.test(json.content)
      ) {
        md5 = json.content
      } else if (json.md5 && typeof json.md5 === 'string') {
        md5 = json.md5
      }
      if (json.datName && typeof json.datName === 'string') {
        datName = json.datName
      }
      if (json.imageDatName && typeof json.imageDatName === 'string') {
        datName = json.imageDatName
      }
      // 尝试从其他字段获取 aeskey
      if (!aeskey && json.aeskey) {
        aeskey = json.aeskey
      }
      if (!aeskey && json.aeskey_v2) {
        aeskey = json.aeskey_v2
      }
    } catch {
      // 不是 JSON 格式
    }
  }

  const encrypVer = parseInt(encrypVerStr, 10)

  if (!md5 && !datName) {
    return { type: 'unknown', raw: content }
  }

  return { type: 'image', md5: md5 || undefined, datName: datName || undefined, aeskey, encrypVer }
}

function parseStickerMessage(content: string): ParsedContent {
  // 表情包消息可能包含 md5 或 url
  const md5 =
    extractXmlAttribute(content, 'emoji', 'md5') ||
    extractXmlValue(content, 'md5') ||
    extractXmlAttribute(content, 'sticker', 'md5') ||
    extractLooseHexMd5(content) ||
    ''
  const url = decodeXmlUrl(
    extractXmlValue(content, 'url') ||
      extractXmlAttribute(content, 'emoji', 'cdnurl') ||
      extractXmlAttribute(content, 'emoji', 'url') ||
      extractXmlAttribute(content, 'emoji', 'thumburl') ||
      extractLooseAttribute(content, 'cdnurl') ||
      extractLooseAttribute(content, 'url') ||
      extractLooseAttribute(content, 'thumburl') ||
      ''
  )
  const thumbUrl = decodeXmlUrl(
    extractXmlAttribute(content, 'emoji', 'thumburl') || extractLooseAttribute(content, 'thumburl')
  )
  const encryptUrl = decodeXmlUrl(
    extractXmlAttribute(content, 'emoji', 'encrypturl') ||
      extractLooseAttribute(content, 'encrypturl')
  )
  const aeskey =
    extractXmlAttribute(content, 'emoji', 'aeskey') ||
    extractLooseAttribute(content, 'aeskey') ||
    undefined

  if (!md5 && !url && !thumbUrl && !encryptUrl) {
    return { type: 'unknown', raw: content }
  }

  return {
    type: 'sticker',
    md5,
    url: url || thumbUrl || undefined,
    thumbUrl: thumbUrl || undefined,
    encryptUrl: encryptUrl || undefined,
    aeskey
  }
}

export function parseStickerMessageFromRow(
  row: Record<string, unknown>,
  content: string
): ParsedContent {
  const supplementalPayload = [
    content,
    pickRowString(row, ['emoji_md5', 'emojiMd5', 'md5']),
    pickRowString(row, ['emoji_cdn_url', 'emojiCdnUrl', 'cdnurl', 'emoji_url', 'emojiUrl']),
    decodeSupplementalPayload(
      pickRowString(row, [
        'packed_info_data',
        'packed_info',
        'packedInfoData',
        'packedInfo',
        'PackedInfoData',
        'PackedInfo',
        'WCDB_CT_packed_info_data',
        'WCDB_CT_packed_info'
      ])
    ),
    decodeSupplementalPayload(pickRowString(row, ['reserved0', 'Reserved0', 'WCDB_CT_reserved0']))
  ]
    .filter(Boolean)
    .join('\n')

  const directMd5 = normalizeMd5(pickRowString(row, ['emoji_md5', 'emojiMd5', 'md5']))
  const directUrl = decodeXmlUrl(
    String(
      pickRowString(row, ['emoji_cdn_url', 'emojiCdnUrl', 'cdnurl', 'emoji_url', 'emojiUrl']) || ''
    )
  )
  const parsed = parseStickerMessage(supplementalPayload)

  if (parsed.type === 'sticker') {
    return {
      ...parsed,
      md5: parsed.md5 || directMd5,
      url: parsed.url || directUrl || undefined
    }
  }

  if (directMd5 || directUrl) {
    return {
      type: 'sticker',
      md5: directMd5,
      url: directUrl || undefined
    }
  }

  return parsed
}

function parseCardMessage(content: string): ParsedContent {
  const username =
    extractXmlValue(content, 'username') || extractXmlValue(content, 'cardUsername') || ''
  const nickname =
    extractXmlValue(content, 'nickname') || extractXmlValue(content, 'cardNickname') || ''
  const avatarUrl =
    extractXmlValue(content, 'avatarUrl') ||
    extractXmlValue(content, 'smallHeadImgUrl') ||
    undefined

  if (!username && !nickname) {
    return { type: 'unknown', raw: content }
  }

  return { type: 'card', username, nickname, avatarUrl }
}

function parseLocationMessage(content: string): ParsedContent {
  const poiname = extractXmlValue(content, 'poiname') || extractXmlValue(content, 'poiName') || ''
  const label = extractXmlValue(content, 'label') || ''

  const latStr =
    extractXmlAttribute(content, 'location', 'x') ||
    extractXmlAttribute(content, 'location', 'latitude') ||
    '0'
  const lngStr =
    extractXmlAttribute(content, 'location', 'y') ||
    extractXmlAttribute(content, 'location', 'longitude') ||
    '0'

  const lat = parseFloat(latStr)
  const lng = parseFloat(lngStr)

  if (!poiname && lat === 0 && lng === 0) {
    return { type: 'unknown', raw: content }
  }

  return { type: 'location', poiname, label, lat, lng }
}

function parseShareMessage(content: string): ParsedContent {
  const appMsgType = extractAppMsgType(content)
  const isFileMessage = appMsgType === '6' || appMsgType === '74'
  if (appMsgType === '19') {
    return parseForwardBundle(content)
  }
  if (!isFileMessage && /<recorditem\b|<dataitem\b/i.test(content)) {
    const forwardBundle = parseForwardBundle(content)
    if (forwardBundle.items.length > 0) return forwardBundle
  }
  if (appMsgType === '47' || /<(?:emoji|sticker|emoticon)\b/i.test(content)) {
    const sticker = parseStickerMessage(content)
    if (sticker.type === 'sticker') return sticker
  }
  if (appMsgType === '57' || content.includes('<refermsg>')) {
    const quote = parseQuoteMessage(content)
    const title = extractXmlValue(content, 'title') || undefined
    return {
      type: 'quote',
      title,
      content: title,
      quotedContent: quote.content || '[引用消息]',
      quotedSender: quote.sender,
      quotedType: quote.type,
      quotedImageMd5: quote.imageMd5,
      quotedImageDatName: quote.imageDatName
    }
  }

  if (appMsgType === '33' || appMsgType === '36') {
    return {
      type: 'miniProgram',
      title: extractXmlValue(content, 'title') || '小程序',
      description: extractXmlValue(content, 'des') || undefined,
      appName:
        extractXmlValue(content, 'sourcedisplayname') ||
        extractXmlValue(content, 'appname') ||
        '小程序',
      iconUrl: decodeXmlUrl(extractXmlValue(content, 'weappiconurl')) || undefined,
      thumbMd5: normalizeMd5(
        extractXmlValue(content, 'cdnthumbmd5') || extractXmlValue(content, 'md5')
      )
    }
  }

  if (appMsgType === '2001') {
    return {
      type: 'redPacket',
      title: extractXmlValue(content, 'title') || '微信红包',
      description: extractXmlValue(content, 'des') || '恭喜发财，大吉大利',
      url: decodeXmlUrl(extractXmlValue(content, 'url')) || undefined
    }
  }

  const articles = parseShareArticles(content)
  const title = articles[0]?.title || decodeXmlEntities(extractXmlValue(content, 'title')) || ''
  const des =
    articles[0]?.description ||
    decodeXmlEntities(extractXmlValue(content, 'des') || extractXmlValue(content, 'desc')) ||
    ''
  const url = articles[0]?.url || decodeXmlUrl(extractXmlValue(content, 'url')) || ''
  const appname =
    decodeXmlEntities(
      extractXmlValue(content, 'appname') ||
        extractXmlValue(content, 'publisher') ||
        extractXmlValue(content, 'appInfo')
    ) || ''
  const typeVal = extractXmlValue(content, 'type') || ''

  if (!title && !url) {
    return { type: 'unknown', raw: content }
  }

  return {
    type: 'share',
    title,
    des,
    url,
    appname,
    typeVal,
    articles: articles.length > 1 ? articles : undefined
  }
}

function parseShareArticles(content: string): ShareArticle[] {
  if (!/<mmreader\b/i.test(content)) return []
  const articles = Array.from(
    content.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi),
    (match) => match[1] || ''
  )
    .map((item): ShareArticle | null => {
      const title = decodeXmlEntities(extractXmlValue(item, 'title'))
      const url = decodeXmlUrl(extractXmlValue(item, 'url'))
      if (!title && !url) return null
      const description = decodeXmlEntities(
        extractXmlValue(item, 'digest') ||
          extractXmlValue(item, 'summary') ||
          extractXmlValue(item, 'des')
      )
      const coverUrl = decodeXmlUrl(
        extractXmlValue(item, 'cover') || extractXmlValue(item, 'cover_1_1')
      )
      return {
        title: title || '公众号文章',
        url,
        description: description || undefined,
        coverUrl: coverUrl || undefined
      }
    })
    .filter((article): article is ShareArticle => Boolean(article))

  const seen = new Set<string>()
  return articles.filter((article) => {
    const key = `${article.url}|${article.title}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function parseForwardBundle(content: string): ForwardBundleContent {
  const normalized = decodeXmlEntities(stripChatroomPrefix(content))
  const title = decodeXmlEntities(extractXmlValue(normalized, 'title')) || '聊天记录'
  const description = decodeXmlEntities(extractXmlValue(normalized, 'des')) || undefined
  const containers = Array.from(
    normalized.matchAll(/<recorditem\b[^>]*>([\s\S]*?)<\/recorditem>/gi),
    (match) => match[1] || ''
  )
  const sources = containers.length ? containers : [normalized]
  const items = dedupeForwardedItems(sources.flatMap((source) => parseForwardedItems(source)))
  return { type: 'forwardBundle', title, description, items }
}

function parseForwardedItems(container: string, depth = 0): ForwardedMessageItem[] {
  if (!container || depth > 4) return []
  const variants = new Set<string>([container, decodeXmlEntities(container)])
  for (const match of container.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)) {
    if (match[1]) variants.add(decodeXmlEntities(match[1]))
  }

  const items: ForwardedMessageItem[] = []
  for (const variant of variants) {
    for (const match of variant.matchAll(/<dataitem\b([^>]*)>([\s\S]*?)<\/dataitem>/gi)) {
      const attributes = match[1] || ''
      const body = match[2] || ''
      const attrType = /datatype\s*=\s*["']?(\d+)/i.exec(attributes)?.[1]
      const messageType = Number.parseInt(attrType || extractXmlValue(body, 'datatype') || '0', 10)
      const sender = decodeXmlEntities(extractXmlValue(body, 'sourcename')) || undefined
      const sentAt = extractXmlValue(body, 'sourcetime') || undefined
      const title = decodeXmlEntities(extractXmlValue(body, 'datatitle'))
      const description = decodeXmlEntities(
        extractXmlValue(body, 'datadesc') || extractXmlValue(body, 'content')
      )
      const nestedXml = extractXmlBody(body, 'recordxml')
      const nested =
        messageType === 17 && nestedXml
          ? parseForwardedItems(decodeXmlEntities(nestedXml), depth + 1)
          : undefined
      const text = description || title || forwardedTypeLabel(messageType)
      if (!sender && !text && !nested?.length) continue
      items.push({
        messageType: Number.isFinite(messageType) ? messageType : 0,
        sender,
        sentAt,
        text: text || '[消息]',
        nested: nested?.length ? nested : undefined
      })
    }
  }
  return dedupeForwardedItems(items)
}

function dedupeForwardedItems(items: ForwardedMessageItem[]): ForwardedMessageItem[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = `${item.messageType}|${item.sender || ''}|${item.sentAt || ''}|${item.text}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function forwardedTypeLabel(messageType: number): string {
  switch (messageType) {
    case 3:
      return '[图片]'
    case 34:
      return '[语音]'
    case 43:
      return '[视频]'
    case 47:
      return '[表情包]'
    case 8:
    case 49:
      return '[文件或分享]'
    case 17:
      return '[聊天记录]'
    default:
      return '[消息]'
  }
}

function extractXmlBody(xml: string, tagName: string): string {
  const match = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i').exec(xml)
  if (!match?.[1]) return ''
  return match[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim()
}

function parseQuoteMessage(content: string): {
  content?: string
  sender?: string
  type?: string
  imageMd5?: string
  imageDatName?: string
} {
  const referMsgStart = content.indexOf('<refermsg>')
  const referMsgEnd = content.indexOf('</refermsg>')
  if (referMsgStart === -1 || referMsgEnd === -1) return {}

  const referMsgXml = content.substring(referMsgStart, referMsgEnd + '</refermsg>'.length)
  const displayName = sanitizeQuotedContent(extractXmlValue(referMsgXml, 'displayname'))
  const chatUser = sanitizeQuotedSenderId(extractXmlValue(referMsgXml, 'chatusr'))
  const fromUser = sanitizeQuotedSenderId(extractXmlValue(referMsgXml, 'fromusr'))
  const sender = displayName || chatUser || fromUser || undefined
  const referContent = extractXmlValue(referMsgXml, 'content')
  const referType = extractXmlValue(referMsgXml, 'type')

  switch (referType) {
    case '1':
      return { sender, content: sanitizeQuotedContent(referContent), type: referType }
    case '3': {
      const image = parseImageMessage(referContent)
      return {
        sender,
        content: '[图片]',
        type: referType,
        imageMd5: image.type === 'image' ? image.md5 : undefined,
        imageDatName: image.type === 'image' ? image.datName : undefined
      }
    }
    case '34':
      return { sender, content: '[语音]', type: referType }
    case '43':
      return { sender, content: '[视频]', type: referType }
    case '47':
      return { sender, content: '[表情]', type: referType }
    case '49':
      return {
        sender,
        content: extractXmlValue(referMsgXml, 'title') || '[分享消息]',
        type: referType
      }
    default:
      return {
        sender,
        content: sanitizeQuotedContent(referContent) || '[引用消息]',
        type: referType
      }
  }
}

function extractAppMsgType(content: string): string {
  const appmsgMatch = /<appmsg[\s\S]*?>([\s\S]*?)<\/appmsg>/i.exec(content)
  if (!appmsgMatch) return extractXmlValue(content, 'type')
  const inner = appmsgMatch[1]
    .replace(/<refermsg[\s\S]*?<\/refermsg>/gi, '')
    .replace(/<patMsg[\s\S]*?<\/patMsg>/gi, '')
    .replace(/<weappinfo[\s\S]*?<\/weappinfo>/gi, '')
    .replace(/<appattach[\s\S]*?<\/appattach>/gi, '')
    .replace(/<wcpayinfo[\s\S]*?<\/wcpayinfo>/gi, '')
    .replace(/<findernamecard[\s\S]*?<\/findernamecard>/gi, '')
  const typeMatch = /<type>([\s\S]*?)<\/type>/i.exec(inner)
  return typeMatch?.[1]?.trim() || ''
}

function sanitizeQuotedContent(content: string): string {
  const decoded = String(content || '')
    .replace(/^wxid_[^:\n]+:\s*/i, '')
    .trim()
  if (/^(wxid_[\w-]+|[a-z][a-z0-9_-]{5,})$/i.test(decoded)) return ''
  return decoded
}

function sanitizeQuotedSenderId(value: string): string {
  return decodeXmlEntities(String(value || '')).trim()
}

function stripChatroomPrefix(content: string): string {
  return String(content || '')
    .replace(/^[0-9a-z_-]+@chatroom:\s*/i, '')
    .replace(/^wxid_[^:\n]+:\s*/i, '')
    .trim()
}

function normalizeSystemText(content: string): string {
  return String(content || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;!?])/g, '$1')
    .trim()
}

function parseVoipMessage(content: string): ParsedContent {
  const roomTypeStr = extractXmlValue(content, 'room_type')
  const msg = extractXmlValue(content, 'msg') || ''
  const durationStr = extractXmlValue(content, 'duration') || '0'

  const roomType = roomTypeStr ? parseInt(roomTypeStr, 10) : 0
  const duration = parseInt(durationStr, 10)

  let status = msg
  if (!status) {
    status = roomType === 1 ? '[视频通话]' : '[语音通话]'
  }

  return { type: 'voip', duration, status, roomType }
}

function extractXmlValue(xml: string, tagName: string): string {
  const patterns = [
    new RegExp(`<${tagName}[^>]*><!\\[CDATA\\[([^\\]]*)\\]\\]></${tagName}>`, 'i'),
    new RegExp(`<${tagName}[^>]*><!\\[CDATA\\[([^\\]]*)\\]\\]></${tagName}>`, 'i'),
    new RegExp(`<${tagName}[^>]*>([^<]*)</${tagName}>`, 'i'),
    new RegExp(`${tagName}=["']([^"']*)["']`, 'i')
  ]

  for (const pattern of patterns) {
    const match = xml.match(pattern)
    if (match && match[1]) {
      return match[1].trim()
    }
  }

  return ''
}

function extractXmlAttribute(xml: string, tagName: string, attrName: string): string {
  const pattern = new RegExp(
    `<${tagName}\\b[^>]*?(?:\\s|^)${attrName}\\s*=\\s*["']([^"']*)["']`,
    'i'
  )
  const match = xml.match(pattern)
  return match ? match[1].trim() : ''
}

function extractLooseAttribute(content: string, attrName: string): string {
  const quoted = new RegExp(`${attrName}\\s*=\\s*["']([^"']+)["']`, 'i').exec(content)
  if (quoted?.[1]) return quoted[1].trim()
  const unquoted = new RegExp(`${attrName}\\s*=\\s*([^"']+?)(?=\\s|/|>)`, 'i').exec(content)
  return unquoted?.[1]?.trim() || ''
}

function decodeXmlUrl(value: string): string {
  const normalized = String(value || '')
    .replace(/&amp;/g, '&')
    .trim()
  if (!normalized) return ''
  if (!normalized.includes('%')) return normalized
  try {
    return decodeURIComponent(normalized)
  } catch {
    return normalized
  }
}

function decodeXmlEntities(value: string): string {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

function extractXmlNodeText(xml: string, tagName: string): string {
  const match = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i').exec(xml)
  if (!match?.[1]) return ''
  return normalizeSystemText(
    decodeXmlEntities(
      match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ')
    )
  )
}

function fallbackSystemText(xml: string): string {
  return normalizeSystemText(
    decodeXmlEntities(
      String(xml || '')
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/<[^>]+>/g, ' ')
    )
  )
}

function extractDelChatroomMemberText(xml: string): string {
  if (!/<sysmsg[^>]+delchatroommember/i.test(xml)) return ''
  const plainMatch = /<plain[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/plain>/i.exec(xml)
  if (plainMatch?.[1]) return plainMatch[1].trim()
  const textMatch = /<text[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/text>/i.exec(xml)
  if (textMatch?.[1]) return textMatch[1].trim()
  return ''
}

function normalizeMd5(value: unknown): string | undefined {
  const md5 = String(value || '')
    .trim()
    .toLowerCase()
  return /^[a-f0-9]{32}$/.test(md5) ? md5 : undefined
}

function extractLooseHexMd5(content: string): string | undefined {
  if (!content) return undefined
  const match =
    /(?:emoji|sticker|md5)[^a-fA-F0-9]{0,32}([a-fA-F0-9]{32})/i.exec(content) ||
    /([a-fA-F0-9]{32})/i.exec(content)
  return normalizeMd5(match?.[1] || match?.[0])
}

function decodeSupplementalPayload(raw: unknown): string {
  if (!raw) return ''
  if (typeof raw === 'string' && !/^[a-fA-F0-9]+$/.test(raw.trim())) return raw.trim()
  const buffer = decodePackedInfo(raw)
  if (!buffer || buffer.length === 0) return ''
  const decoded = buffer.toString('utf-8')
  const replacementCount = (decoded.match(/\uFFFD/g) || []).length
  if (replacementCount < decoded.length * 0.2) {
    return decoded.replace(/\uFFFD/g, '')
  }
  return Array.from(buffer)
    .map((byte) => (byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ' '))
    .join('')
}

export function parseImageDatNameFromRow(row: Record<string, unknown>): string | undefined {
  const packed = pickRowString(row, [
    'packed_info_data',
    'packed_info',
    'packedInfoData',
    'packedInfo',
    'PackedInfoData',
    'PackedInfo',
    'WCDB_CT_packed_info_data',
    'WCDB_CT_packed_info',
    'WCDB_CT_PackedInfoData',
    'WCDB_CT_PackedInfo'
  ])
  const buffer = decodePackedInfo(packed)
  if (!buffer || buffer.length === 0) return undefined

  const printable = Array.from(buffer).map((byte) => (byte >= 0x20 && byte <= 0x7e ? byte : 0x20))
  const text = Buffer.from(printable).toString('utf-8')
  const match = /([0-9a-fA-F]{8,})(?:\.t)?\.dat/.exec(text)
  if (match?.[1]) return match[1].toLowerCase()
  const hexMatch = /([0-9a-fA-F]{16,})/.exec(text)
  return hexMatch?.[1]?.toLowerCase()
}

export function parseImageBufferDataUrlFromRow(row: Record<string, unknown>): string | undefined {
  const raw = pickRowString(row, [
    'ImgBuf',
    'imgBuf',
    'img_buf',
    'imageBuffer',
    'image_buffer',
    'thumbBuffer',
    'thumb_buffer',
    'WCDB_CT_img_buf',
    'WCDB_CT_ImgBuf'
  ])
  const buffer = decodeInlineImageBuffer(raw)
  if (!buffer || buffer.length === 0) return undefined
  const mime = detectImageMime(buffer)
  return mime ? `data:${mime};base64,${buffer.toString('base64')}` : undefined
}

function decodeInlineImageBuffer(raw: unknown): Buffer | null {
  if (!raw) return null
  if (Buffer.isBuffer(raw)) return raw
  if (raw instanceof Uint8Array) return Buffer.from(raw)
  if (Array.isArray(raw)) return Buffer.from(raw)
  if (typeof raw === 'object') {
    const record = raw as { buffer?: unknown; data?: unknown }
    return decodeInlineImageBuffer(record.buffer ?? record.data)
  }
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  const dataUrl = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/i.exec(value)
  const encoded = dataUrl?.[1] || value
  if (!/^[a-z0-9+/]+={0,2}$/i.test(encoded)) return null
  try {
    return Buffer.from(encoded, 'base64')
  } catch {
    return null
  }
}

function detectImageMime(buffer: Buffer): string | undefined {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer.subarray(1, 4).toString('ascii') === 'PNG'
  ) {
    return 'image/png'
  }
  if (buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('ascii'))) {
    return 'image/gif'
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }
  return undefined
}

function pickRowString(row: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key)) return row[key]
    const foundKey = Object.keys(row).find(
      (candidate) => candidate.toLowerCase() === key.toLowerCase()
    )
    if (foundKey) return row[foundKey]
  }
  return undefined
}

function decodePackedInfo(raw: unknown): Buffer | null {
  if (!raw) return null
  if (Buffer.isBuffer(raw)) return raw
  if (raw instanceof Uint8Array) return Buffer.from(raw)
  if (Array.isArray(raw)) return Buffer.from(raw)
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (/^[a-fA-F0-9]+$/.test(trimmed) && trimmed.length % 2 === 0) {
      try {
        return Buffer.from(trimmed, 'hex')
      } catch {
        // Try base64 below.
      }
    }
    try {
      return Buffer.from(trimmed, 'base64')
    } catch {
      // Unsupported packed_info encoding.
    }
  }
  if (typeof raw === 'object' && raw && Array.isArray((raw as { data?: unknown }).data)) {
    return Buffer.from((raw as { data: number[] }).data)
  }
  return null
}
