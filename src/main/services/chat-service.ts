import { createHash, randomUUID } from 'node:crypto'
import { WechatDb, WechatMessage } from '../wechat-db'
import {
  parseImageBufferDataUrlFromRow,
  parseImageDatNameFromRow,
  parseMessageContent,
  parseStickerMessageFromRow
} from '../message-parser'
import type {
  DatabaseKeyValidationCode,
  DatabaseKeyValidationResult
} from '../../shared/database-key'
import {
  isWindowsVcRuntimeMissingError,
  WINDOWS_VC_RUNTIME_ERROR_MESSAGE
} from '../../shared/windows-runtime'
import { mergeRecallArchiveMessages, recordRecallArchiveMessages } from './recall-archive-service'
import type { ExportImageQuality } from '../../shared/image-quality'
import type { ImageMessageCountProbe } from '../../shared/image-text-index'
import { imageTextWindowToSeconds } from '../../shared/image-text-index'
import { wcdbDebugLog } from '../wcdb-debug'
import {
  buildContactSearchIndex,
  filterContactSearchIndex,
  type ContactSearchIndex
} from '../../shared/contact-search'

/**
 * 谁在读消息。
 *
 * 只允许下面这几个固定标签 —— 日志里**不能**出现会话 md5 / session id / wxid /
 * 群名 / 联系人 / 路径，所以调用方身份只能靠标签表达。
 * 落在集合外的调用点一律记 `unknown`。
 */
export type ListMessagesCaller =
  | 'image-text-index'
  | 'group-monitor'
  | 'archive'
  | 'knowledge'
  | 'unknown'

/** 进程生命周期内单调递增的读取序号，用来把"同一段时间的几次调用"关联起来（不是稳定标识）。 */
let listMessagesRequestSeq = 0

export function nextListMessagesRequestId(): string {
  listMessagesRequestSeq += 1
  return `request-${listMessagesRequestSeq}`
}

/**
 * 一次 `listMessages` 的性能拆解。
 *
 * 存在的意义：大会话的全量读取会把主进程卡住数秒，而原来只有一行 `totalMs`，
 * 无法判断时间花在 **WCDB 查询**、**JS 逐条格式化**，还是 **内容解析**上。
 *
 * 覆盖面：`totalMs` 是外层入口的整段耗时；`formatMs` 包含 `contentParseMs` 与
 * `dateFormatMs`（后两者是它的子集，不可与 `formatMs` 相加）。
 */
export interface ListMessagesPerf {
  caller: ListMessagesCaller
  requestId: string
  /** WCDB 返回的原始行数（异步路径里含原生查询时间）。 */
  rawRows: number
  formattedRows: number
  totalMs: number
  /** 取原始行：同步 `getUserMessages` 或 `await getUserMessagesAsync`。 */
  rawReadMs: number
  /** 逐条构造 `FormattedMessage`（整个 `map`）。 */
  formatMs: number
  /** └ 其中：日期格式化（`toLocaleString`）。 */
  dateFormatMs: number
  /** └ 其中：内容解析（`parseMessageContent` / `parseStickerMessageFromRow`）。 */
  contentParseMs: number
  /** 召回归档合并与排序。 */
  sortMs: number
  /** `totalMs` 减去上面已计部分。 */
  otherMs: number
}

function emptyPerf(caller: ListMessagesCaller, requestId: string): ListMessagesPerf {
  return {
    caller,
    requestId,
    rawRows: 0,
    formattedRows: 0,
    totalMs: 0,
    rawReadMs: 0,
    formatMs: 0,
    dateFormatMs: 0,
    contentParseMs: 0,
    sortMs: 0,
    otherMs: 0
  }
}

/**
 * 只在**值得看**的时候打一行：大会话、或者总耗时已经明显影响交互。
 * 单行、可 grep、无任何会话标识。
 */
function logListMessagesPerf(perf: ListMessagesPerf): void {
  perf.otherMs = Math.max(0, perf.totalMs - perf.rawReadMs - perf.formatMs - perf.sortMs)
  const noteworthy = perf.formattedRows >= 20_000 || perf.totalMs >= 1_000
  if (!noteworthy) return
  console.log(
    `[ChatServicePerf] caller=${perf.caller} request=${perf.requestId} rows=${perf.formattedRows} rawRows=${perf.rawRows} totalMs=${perf.totalMs} rawReadMs=${perf.rawReadMs} formatMs=${perf.formatMs} dateFormatMs=${perf.dateFormatMs} contentParseMs=${perf.contentParseMs} sortMs=${perf.sortMs} otherMs=${perf.otherMs}`
  )
}

export function getCurrentKey(): string {
  if (!dbRef) return ''
  try {
    return dbRef.getWcdb4Client().getKey()
  } catch {
    return ''
  }
}

export function getCurrentAccountRoot(): string {
  if (!dbRef) return ''
  try {
    return dbRef.getWcdb4Client().getAccountRoot()
  } catch {
    return ''
  }
}

export interface FormattedContact {
  m_nsUsrName: string
  m_nsNickName: string
  md5: string
  type: 'user' | 'group'
  isOfficialAccount?: boolean
  avatar?: string
  wechatNickname?: string
  remark?: string
  alias?: string
  wechatId?: string
  wxid?: string
  legacyIdentifier?: string
  isFolded?: boolean
  isMuted?: boolean
}

export interface FormattedMessage {
  id: string
  from: string
  type: string
  datetime: string
  content: string
  isSender: boolean
  img?: string
  name?: string
  senderId?: string
  contentData?: ReturnType<typeof parseMessageContent>
  media?: {
    type: 'image'
    available: boolean
    url: string
  }
  voiceDataUrl?: string
  voiceDuration?: number
  voiceTranscript?: string
  voiceTranscriptError?: string
  exportMediaUrl?: string
  exportMediaType?: 'image' | 'video' | 'sticker' | 'file'
  exportMediaName?: string
  exportMediaQuality?: ExportImageQuality
  exportShowAvatar?: boolean
  exportMediaError?: string
  exportAvatarUrl?: string
  localId?: number
  serverId?: string
  createTime?: number
  sessionId?: string
  recalled?: boolean
  recalledBy?: string
}

export interface GroupSnapshot {
  roomId: string
  memberCount: number
  groupName?: string
  /** 只读 roominfo（contact.db / chatroom）；字段可能随版本缺失。 */
  roomInfo?: GroupRoomInfo
  members: {
    wxid: string
    nickname: string
    groupNickname: string
    wechatNickname: string
    remark: string
    avatar: string
  }[]
}

/** 群 roominfo 只读字段（列名兼容多版本；缺失则为 undefined）。 */
export interface GroupRoomInfo {
  roomId: string
  owner?: string
  announcement?: string
  announcementEditor?: string
  maxMemberCount?: number
  chatName?: string
  openImAccountType?: string
  isOpenIm?: boolean
}

export interface GroupMembershipSnapshot {
  roomId: string
  memberIds: string[]
}

export interface GroupMembershipBatchSnapshot extends GroupMembershipSnapshot {
  status: 'ok' | 'not_found'
}

const MSG_TYPE_DICT: Record<number, string> = {
  1: '普通文本',
  3: '图片',
  34: '语音',
  42: '名片',
  43: '视频',
  47: '表情包',
  48: '位置',
  49: '分享消息',
  50: '通话',
  10000: '系统消息'
}

function normalizeMsgType(value: string | number | undefined): number {
  const raw = String(value ?? '').trim()
  if (!raw) return 0

  try {
    const parsed = BigInt(raw)
    const low32 = Number(parsed & 0xffffffffn)
    return low32 || Number(parsed)
  } catch {
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return 0
    return parsed > 0xffffffff ? parsed >>> 0 : parsed
  }
}

let dbRef: WechatDb | null = null
let contactSearchIndexCache: { signature: string; index: ContactSearchIndex } | null = null
let shutdownRequested = false

export interface ImageMessageReference {
  messageId: string
  sessionId: string
  imageMd5?: string
  imageDatName?: string
  createTime?: number
}

const imageMessageReferences = new Map<string, ImageMessageReference | null>()
let imageReferenceScope = randomUUID()

/** Replace the active database and invalidate connection-scoped lookup caches. */
export function setChatDb(db: WechatDb | null): boolean {
  if (shutdownRequested) {
    db?.close()
    return false
  }
  dbRef?.close()
  dbRef = db
  contactSearchIndexCache = null
  imageMessageReferences.clear()
  imageReferenceScope = randomUUID()
  return true
}

export function getImageMessageReference(messageId: string): ImageMessageReference | null {
  if (!dbRef) return null
  const normalizedId = String(messageId || '').trim()
  if (!normalizedId) return null
  return imageMessageReferences.get(normalizedId) || null
}

export async function closeChatDbForQuit(): Promise<boolean> {
  shutdownRequested = true
  const current = dbRef
  dbRef = null
  if (!current) return true
  return current.closeAsync()
}

export function getChatDb(): WechatDb | null {
  return dbRef
}

export function isReady(): boolean {
  return dbRef !== null
}

/** Session 行的时间字段可能是秒，也可能是毫秒；1e11 以下按秒换算。 */
function sessionTimeToEpochMs(value: unknown): number | null {
  const numeric =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  return Math.round(numeric < 1e11 ? numeric * 1000 : numeric)
}

/**
 * 源数据（WCDB Session）里最新的活跃时间（epoch ms）。
 *
 * Session 列表本来就带着 `last_timestamp`，所以这是**零额外 WCDB 调用**的 freshness 信号：
 * 有了它才能区分「源数据本来就没有新消息」和「有新消息但派生索引还没追到」。
 * 只读取会话级的活跃时间戳，不读取任何消息内容。
 */
export function getSourceLatestActivityMs(): number | null {
  if (!dbRef) return null
  try {
    let latest = 0
    for (const session of dbRef.getWcdb4Client().getSessions()) {
      const value = sessionTimeToEpochMs(session.raw?.['last_timestamp'])
      if (value !== null && value > latest) latest = value
    }
    return latest > 0 ? latest : null
  } catch {
    return null
  }
}

/**
 * 每个会话在源数据里最后的活跃时间（epoch ms），按会话 md5 索引。
 *
 * 与 `getSourceLatestActivityMs` 同源（Session 行的 `last_timestamp`），同样是**零额外
 * WCDB 调用**。增量索引 pass 用它判断「这个会话自上次索引以来有没有新消息」，
 * 从而整段跳过没有变化的会话 —— 这是增量同步名副其实的前提。
 */
export function getConversationActivityMs(): Map<string, number> {
  const result = new Map<string, number>()
  if (!dbRef) return result
  try {
    for (const session of dbRef.getWcdb4Client().getSessions()) {
      const username = typeof session.username === 'string' ? session.username : ''
      if (!username) continue
      const value = sessionTimeToEpochMs(session.raw?.['last_timestamp'])
      if (value === null) continue
      const md5 = dbRef.md5(username)
      if (!md5) continue
      const existing = result.get(md5)
      if (existing === undefined || value > existing) result.set(md5, value)
    }
  } catch {
    return result
  }
  return result
}

export function listContacts(filter?: string): FormattedContact[] {
  if (!dbRef) return []

  const contacts: FormattedContact[] = []
  const groupContacts = dbRef.getAllGroupContacts()
  const userList = dbRef.getUserList()
  const existingMd5s = new Set<string>()

  for (const user of userList) {
    const md5 = dbRef.md5(user.m_nsUsrName)
    const isGroup = user.m_nsUsrName.endsWith('@chatroom')
    existingMd5s.add(md5)
    contacts.push({
      m_nsUsrName: user.m_nsUsrName,
      m_nsNickName: user.nickname || '未知用户',
      md5,
      type: isGroup ? 'group' : 'user',
      isOfficialAccount: !isGroup && user.m_nsUsrName.startsWith('gh_'),
      avatar: typeof user.avatar === 'string' ? user.avatar : undefined,
      wechatNickname: user.wechatNickname,
      remark: user.remark,
      alias: user.alias,
      wechatId: user.wechatId,
      wxid: user.wxid || user.m_nsUsrName,
      legacyIdentifier: user.legacyIdentifier,
      isFolded: user.isFolded,
      isMuted: user.isMuted
    })
  }

  // The session list already covers normal conversations. Only scan Chat_*
  // tables as a recovery fallback when the session query returned nothing.
  if (userList.length === 0) {
    const chatTables = dbRef.getAllChatTables()
    for (const table of chatTables) {
      if (!table.name.startsWith('Chat_')) continue
      const md5 = table.name.substring(5)
      if (existingMd5s.has(md5)) continue
      if (groupContacts[md5]) {
        contacts.push({
          m_nsUsrName: `Group_${md5}`,
          m_nsNickName: groupContacts[md5],
          md5,
          type: 'group'
        })
      } else {
        contacts.push({
          m_nsUsrName: `Unknown_${md5}`,
          m_nsNickName: `Chat_${md5}`,
          md5,
          type: 'user'
        })
      }
    }
  }
  if (!filter) return contacts
  const signature = contacts
    .map((contact) =>
      [
        contact.md5,
        contact.m_nsNickName,
        contact.remark,
        contact.wechatNickname,
        contact.alias,
        contact.wechatId,
        contact.wxid,
        contact.legacyIdentifier,
        contact.avatar,
        contact.isFolded,
        contact.isMuted
      ]
        .map((value) => String(value || ''))
        .join('\u0001')
    )
    .join('\u0002')
  if (!contactSearchIndexCache || contactSearchIndexCache.signature !== signature) {
    contactSearchIndexCache = { signature, index: buildContactSearchIndex(contacts) }
  }
  return filterContactSearchIndex(contactSearchIndexCache.index, filter)
}

export async function listContactsAsync(filter?: string): Promise<FormattedContact[]> {
  if (!dbRef) return []
  await dbRef.getWcdb4Client().getSessionsAsync({
    // macOS session rows frequently contain only wxid/chatroom ids. Hydrate
    // contact display names before exposing the list to the renderer.
    hydrateDisplayNames: true,
    hydrateStatuses: true
  })
  await dbRef.hydrateContactIdentitiesAsync?.()
  return listContacts(filter)
}

/** 读取已缓存/轻量 Session 群名，不执行成员、头像或联系人资料 hydration。 */
export async function getGroupNamesAsync(): Promise<Record<string, string>> {
  if (!dbRef) return {}
  const sessions = await dbRef.getWcdb4Client().getSessionsAsync({ hydrateDisplayNames: false })
  const names: Record<string, string> = {}
  for (const session of sessions) {
    if (!session.username.endsWith('@chatroom')) continue
    const name = String(session.nickname || '').trim()
    if (name) names[session.username] = name
  }
  return names
}

export async function getContactAvatars(
  usernames: string[],
  options?: { refresh?: boolean }
): Promise<Record<string, string>> {
  if (!dbRef) return {}
  const normalized = Array.from(
    new Set((usernames || []).map((username) => String(username || '').trim()).filter(Boolean))
  )
  if (normalized.length === 0) return {}
  const client = dbRef.getWcdb4Client()
  if (options?.refresh) client.invalidateAvatarCache(normalized)
  return client.getAvatarUrlsAsync(normalized)
}

/** Format source rows and register image handles without merging recall archives. */
function listSourceMessages(
  userMd5: string,
  startTime?: number,
  endTime?: number,
  options?: { limit?: number },
  rawMessagesOverride?: WechatMessage[],
  requestId = 'NO-REQUEST',
  perf?: ListMessagesPerf
): FormattedMessage[] {
  if (!dbRef) return []

  const wcdb4Client = dbRef.getWcdb4Client()
  const username = wcdb4Client.getUsernameByMd5(userMd5)
  const isGroupChat = Boolean(username?.endsWith('@chatroom'))
  wcdbDebugLog(
    `[${requestId}] ChatService listSourceMessages start start=${startTime || 0} end=${endTime || 0} limit=${options?.limit || 0} hasOverride=${rawMessagesOverride ? 1 : 0}`
  )
  const rawReadStartedAt = Date.now()
  const rawMessages =
    rawMessagesOverride ?? dbRef.getUserMessages(userMd5, startTime, endTime, options)
  if (perf) {
    perf.rawReadMs += Date.now() - rawReadStartedAt
    perf.rawRows += rawMessages.length
  }
  wcdbDebugLog(
    `[${requestId}] ChatService raw snapshot ready raw=${rawMessages.length} cost=${Date.now() - rawReadStartedAt}ms`
  )

  /** 把"内容解析"单独计时，才能区分"消息多"和"每条都在做解析"。 */
  const timedParse = <T>(fn: () => T): T => {
    if (!perf) return fn()
    const startedAt = Date.now()
    try {
      return fn()
    } finally {
      perf.contentParseMs += Date.now() - startedAt
    }
  }

  const formatStartedAt = Date.now()
  const formatted = rawMessages.map((msg: WechatMessage) => {
    const rawMsgType = parseInt(msg.messageType)
    const msgType = normalizeMsgType(msg.messageType)
    const createTime = parseInt(msg.msgCreateTime)
    const date = new Date(createTime * 1000)
    /**
     * 逐条 `toLocaleString` 每次都会新建一个 ICU formatter —— 大会话里这是主要成本，
     * 所以单独计时，避免它被笼统算进"格式化耗时"。
     */
    const dateFormatStartedAt = perf ? Date.now() : 0
    const datetimeText = date.toLocaleString('zh-CN', { hour12: false })
    if (perf) perf.dateFormatMs += Date.now() - dateFormatStartedAt
    const isMine = msg.mesDes !== 1
    const localId = parseInt(msg.mesLocalID) || 0

    let content = msg.msgContent
    let img = ''
    let name = ''
    let senderId = typeof msg.sender === 'string' ? msg.sender : ''
    if (isMine) {
      name = typeof msg.senderNickname === 'string' ? msg.senderNickname : ''
    } else {
      if (typeof msg.senderAvatar === 'string') img = msg.senderAvatar
      if (typeof msg.senderNickname === 'string') name = msg.senderNickname
    }
    if (isGroupChat && content && typeof content === 'string') {
      const colonIndex = content.indexOf(':')
      if (colonIndex > 0) {
        const potentialSenderId = content.substring(0, colonIndex).trim()
        if (/^[a-zA-Z0-9_@.-]{3,64}$/.test(potentialSenderId)) {
          senderId = senderId || potentialSenderId
          name = name || potentialSenderId
          content = content.substring(colonIndex + 1).replace(/^\s+/, '')
        }
      }
    }
    if (!isMine && !name && senderId) name = senderId

    let contentData: ReturnType<typeof parseMessageContent> | undefined
    let displayType = MSG_TYPE_DICT[msgType] || msg.messageType
    const rawContent = String(content || '')
    const isPatMessage =
      /<patinfo\b|<type>\s*62\s*<\/type>/i.test(rawContent) ||
      ([10000, 10002].includes(msgType) && /拍了拍/i.test(rawContent))
    if (isPatMessage) {
      const system = timedParse(() => parseMessageContent(content, 10000))
      const patContent =
        system.type === 'system'
          ? { ...system, pat: true }
          : {
              type: 'system' as const,
              content: String(content || '')
                .replace(/<[^>]+>/g, '')
                .trim(),
              pat: true
            }
      contentData = patContent
      content = patContent.content
      displayType = '系统消息'
    }
    const inferredMsgType =
      typeof content === 'string' &&
      /<appmsg\b|<refermsg\b|&lt;appmsg\b|&lt;refermsg\b/i.test(content)
        ? 49
        : msgType
    if (!isPatMessage && [3, 34, 42, 43, 47, 48, 49, 50, 10000, 10002].includes(inferredMsgType)) {
      try {
        const isQuotePayload = /<refermsg\b/i.test(content)
        const hasStickerPayload =
          /<(?:emoji|sticker|emoticon)\b/i.test(content) || /<type>\s*47\s*<\/type>/i.test(content)
        const rowSticker =
          inferredMsgType === 47 || (inferredMsgType === 49 && !isQuotePayload && hasStickerPayload)
            ? timedParse(() => parseStickerMessageFromRow(msg, content))
            : undefined
        const parsedContent = timedParse(() => parseMessageContent(content, inferredMsgType))
        const rowStickerUrl = rowSticker?.type === 'sticker' ? String(rowSticker.url || '') : ''
        const parsedShareUrl = parsedContent.type === 'share' ? parsedContent.url : ''
        const redPacketUrl = rowStickerUrl || parsedShareUrl
        const isRedPacketFallback =
          (parsedContent.type === 'share' && parsedContent.typeVal === '2001') ||
          /wxapp\.tenpay\.com\/mmpayhb/i.test(redPacketUrl)
        const parsed: ReturnType<typeof parseMessageContent> =
          parsedContent.type === 'miniProgram' || parsedContent.type === 'redPacket'
            ? parsedContent
            : isRedPacketFallback
              ? {
                  type: 'redPacket',
                  title:
                    parsedContent.type === 'share' && parsedContent.title
                      ? parsedContent.title
                      : '微信红包',
                  description:
                    parsedContent.type === 'share' && parsedContent.des
                      ? parsedContent.des
                      : '恭喜发财，大吉大利',
                  url: redPacketUrl || undefined
                }
              : rowSticker?.type === 'sticker'
                ? rowSticker
                : parsedContent
        if (parsed.type === 'system') {
          content = parsed.content
          contentData = parsed
        } else {
          content = ''
        }
        if (parsed.type === 'image') {
          const imageDatName = parseImageDatNameFromRow(msg)
          contentData = { ...parsed, datName: parsed.datName || imageDatName }
        } else if (parsed.type === 'miniProgram') {
          contentData = {
            ...parsed,
            thumbDatName: parsed.thumbDatName || parseImageDatNameFromRow(msg),
            thumbDataUrl: parsed.thumbDataUrl || parseImageBufferDataUrlFromRow(msg.raw || msg)
          }
        } else if (parsed.type !== 'system') {
          if (parsed.type === 'sticker' && !parsed.url && parsed.md5) {
            parsed.url = wcdb4Client.resolveEmoticonCdnUrl(parsed.md5)
          }
          contentData = parsed
        }
        if (inferredMsgType !== msgType || rawMsgType !== msgType) {
          displayType = MSG_TYPE_DICT[inferredMsgType] || displayType
        }
        if (parsed.type === 'quote') displayType = '引用消息'
        if (parsed.type === 'sticker') displayType = '表情包'
        if (parsed.type === 'miniProgram') displayType = '小程序'
        if (parsed.type === 'redPacket') displayType = '微信红包'
        if (parsed.type === 'forwardBundle') displayType = '合并转发'
        if (parsed.type === 'unknown') {
          displayType = '不支持的消息'
          contentData = { ...parsed, messageType: msgType }
        }
        if (parsed.type === 'share') {
          if (parsed.typeVal === '5') displayType = '公众号链接'
          if (parsed.typeVal === '6') displayType = '文件'
          if (parsed.typeVal === '74') displayType = '文件发送中'
          if (parsed.typeVal === '51') displayType = '视频号'
          if (parsed.typeVal === '2000') displayType = '转账'
        }
      } catch {
        // ignore parse errors
      }
    }

    if (!contentData && typeof content === 'string' && /^[0-9a-fA-F]{64,}$/.test(content.trim())) {
      const parsed = timedParse(() => parseStickerMessageFromRow(msg, content))
      if (parsed.type === 'sticker') {
        if (!parsed.url && parsed.md5) {
          parsed.url = wcdb4Client.resolveEmoticonCdnUrl(parsed.md5)
        }
        content = ''
        contentData = parsed
        displayType = '表情包'
      }
    }

    if (!contentData && !MSG_TYPE_DICT[msgType] && msgType !== 0) {
      contentData = { type: 'unknown', raw: rawContent, messageType: msgType }
      content = ''
      displayType = '不支持的消息'
    }

    if (msgType === 34) content = '[语音消息]'

    const recoveredFromRecallJournal = Boolean(msg['_wxe_recovered'] || msg.raw?.['_wxe_recovered'])

    const messageId = String(
      recoveredFromRecallJournal
        ? `recovered:${msg.mesLocalID || msg.serverId || createTime}`
        : msg.mesLocalID || Math.random().toString()
    )
    const imageContent = contentData?.type === 'image' ? contentData : undefined
    // 语音时长来自 message_content 的 <voicemsg voicelength>（毫秒）——注意不是 length，
    // 那是 SILK 数据字节数。已在 parseMessageContent 里换算成秒。
    const voiceDuration = contentData?.type === 'voice' ? contentData.duration : undefined
    // Local ids repeat across conversations. Scope media handles to this database
    // connection and image without changing the message id used by other clients.
    const mediaId = imageContent
      ? `image:${createHash('sha256')
          .update(
            JSON.stringify([
              imageReferenceScope,
              userMd5,
              messageId,
              String(msg.serverId || ''),
              createTime,
              imageContent.md5 || '',
              imageContent.datName || ''
            ])
          )
          .digest('hex')}`
      : ''
    const media = imageContent
      ? {
          type: 'image' as const,
          available: Boolean(imageContent.md5 || imageContent.datName),
          url: `/api/v1/media/${encodeURIComponent(mediaId)}`
        }
      : undefined
    if (imageContent && media) {
      const reference: ImageMessageReference = {
        messageId,
        sessionId: username || '',
        imageMd5: imageContent.md5,
        imageDatName: imageContent.datName,
        createTime
      }
      imageMessageReferences.set(mediaId, reference)
      // Keep old bare-id URLs working only while they are unambiguous.
      const previous = imageMessageReferences.get(messageId)
      if (
        previous &&
        (previous.sessionId !== reference.sessionId ||
          previous.imageMd5 !== reference.imageMd5 ||
          previous.imageDatName !== reference.imageDatName)
      ) {
        // Local message ids can repeat between conversations. Never resolve an
        // ambiguous id to the wrong account or image.
        imageMessageReferences.set(messageId, null)
      } else if (previous !== null) {
        imageMessageReferences.set(messageId, reference)
      }
    }

    return {
      id: messageId,
      from: contentData?.type === 'system' ? 'system' : isMine ? 'assistant' : 'user',
      isSender: isMine,
      type: displayType,
      datetime: datetimeText,
      content,
      img,
      name,
      senderId,
      sessionId: username,
      localId,
      serverId:
        typeof msg.serverId === 'string' || typeof msg.serverId === 'bigint'
          ? String(msg.serverId)
          : undefined,
      createTime,
      recoveredFromRecallJournal,
      contentData,
      media,
      voiceDuration
    }
  })

  if (perf) {
    perf.formatMs += Date.now() - formatStartedAt
    perf.formattedRows += formatted.length
  }
  return formatted
}

export function listMessages(
  userMd5: string,
  startTime?: number,
  endTime?: number,
  options?: { limit?: number },
  caller: ListMessagesCaller = 'unknown'
): FormattedMessage[] {
  const perf = emptyPerf(caller, nextListMessagesRequestId())
  const totalStartedAt = Date.now()
  try {
    const sourceMessages = listSourceMessages(
      userMd5,
      startTime,
      endTime,
      options,
      undefined,
      perf.requestId,
      perf
    )
    if (!dbRef) return sourceMessages
    const username = dbRef.getWcdb4Client().getUsernameByMd5(userMd5) || ''
    const recallStartedAt = Date.now()
    recordRecallArchiveMessages(userMd5, username, sourceMessages)
    const result = mergeRecallArchiveMessages(
      userMd5,
      sourceMessages,
      startTime,
      endTime,
      options?.limit
    )
    perf.sortMs += Date.now() - recallStartedAt
    return result
  } finally {
    perf.totalMs = Date.now() - totalStartedAt
    logListMessagesPerf(perf)
  }
}

export async function listMessagesAsync(
  userMd5: string,
  startTime?: number,
  endTime?: number,
  options?: { limit?: number },
  requestId = '',
  caller: ListMessagesCaller = 'unknown'
): Promise<FormattedMessage[]> {
  if (!dbRef) return []
  const perf = emptyPerf(caller, requestId || nextListMessagesRequestId())
  const totalStartedAt = Date.now()
  try {
    wcdbDebugLog(`[${perf.requestId}] ChatService listMessagesAsync start`)
    const rawReadStartedAt = Date.now()
    const rawMessages = await dbRef.getUserMessagesAsync(
      userMd5,
      startTime,
      endTime,
      options,
      perf.requestId
    )
    perf.rawReadMs += Date.now() - rawReadStartedAt
    wcdbDebugLog(
      `[${perf.requestId}] ChatService getUserMessagesAsync end raw=${rawMessages.length} cost=${Date.now() - rawReadStartedAt}ms`
    )
    const sourceMessages = listSourceMessages(
      userMd5,
      startTime,
      endTime,
      options,
      rawMessages,
      perf.requestId,
      perf
    )
    const username = dbRef.getWcdb4Client().getUsernameByMd5(userMd5) || ''
    const recallStartedAt = Date.now()
    recordRecallArchiveMessages(userMd5, username, sourceMessages)
    const result = mergeRecallArchiveMessages(
      userMd5,
      sourceMessages,
      startTime,
      endTime,
      options?.limit
    )
    perf.sortMs += Date.now() - recallStartedAt
    wcdbDebugLog(
      `[${perf.requestId}] ChatService listMessagesAsync end formatted=${result.length} cost=${Date.now() - totalStartedAt}ms`
    )
    return result
  } finally {
    perf.totalMs = Date.now() - totalStartedAt
    logListMessagesPerf(perf)
  }
}

/**
 * 只取**图片消息**（图片文字索引专用）。
 *
 * 与 `listMessagesAsync` 的唯一差别是"读哪些行"：由 WCDB 在 SQL 层按消息类型过滤，
 * 而不是把整个会话读进来再在 JS 里筛。格式化和消息身份走的是**同一套代码**
 * （同一个 `listSourceMessages`），所以 `messageId` / `contentData` / 派生键完全不变。
 *
 * 存在的理由：大会话（十几万到二十几万条消息）全量读一次要 15s 以上，
 * 而图片索引只关心图片；这是数据边界错了，不是性能调优问题。
 */
export async function listImageMessagesAsync(
  userMd5: string,
  window: {
    /** 闭下界（epoch ms）。 */
    sinceMs?: number
    /** 开上界（epoch ms）。 */
    beforeMs?: number
    limit?: number
  } = {},
  requestId = '',
  caller: ListMessagesCaller = 'unknown'
): Promise<FormattedMessage[]> {
  if (!dbRef) return []
  const perf = emptyPerf(caller, requestId || nextListMessagesRequestId())
  const totalStartedAt = Date.now()
  // ms 半开区间 → 秒闭区间。换算只有共享契约里那一处实现。
  const { sinceSec, beforeSecInclusive } = imageTextWindowToSeconds(window)
  const startTime = sinceSec ?? undefined
  const endTime = beforeSecInclusive ?? undefined
  try {
    const rawReadStartedAt = Date.now()
    const rawMessages = await dbRef.getWcdb4Client().listImageMessagesAsync(userMd5, {
      ...(window.sinceMs !== undefined ? { sinceMs: window.sinceMs } : {}),
      ...(window.beforeMs !== undefined ? { beforeMs: window.beforeMs } : {}),
      ...(window.limit !== undefined ? { limit: window.limit } : {}),
      // recent-first：同一时间窗内**新的图片先处理**。
      order: 'desc',
      requestId: perf.requestId
    })
    perf.rawReadMs += Date.now() - rawReadStartedAt
    /**
     * 时间边界必须同时交给格式化与召回归档合并。
     *
     * 少了这一步，归档合并会把**窗口之外**的撤回图片补回来 —— 于是"最近 7 天"
     * 这一段会混进十年前的消息，分段窗口形同虚设。
     */
    const sourceMessages = listSourceMessages(
      userMd5,
      startTime,
      endTime,
      window.limit !== undefined ? { limit: window.limit } : undefined,
      rawMessages,
      perf.requestId,
      perf
    )
    const username = dbRef.getWcdb4Client().getUsernameByMd5(userMd5) || ''
    const recallStartedAt = Date.now()
    recordRecallArchiveMessages(userMd5, username, sourceMessages)
    // 召回归档里可能还留着已被撤回的图片；跳过合并会漏索引，所以照旧合并。
    const result = mergeRecallArchiveMessages(
      userMd5,
      sourceMessages,
      startTime,
      endTime,
      window.limit
    )
    perf.sortMs += Date.now() - recallStartedAt
    return result
  } finally {
    perf.totalMs = Date.now() - totalStartedAt
    logListMessagesPerf(perf)
  }
}

export async function listMessagesForExport(
  userMd5: string,
  startTime?: number,
  endTime?: number
): Promise<FormattedMessage[]> {
  if (!dbRef) return []
  const perf = emptyPerf('archive', nextListMessagesRequestId())
  const totalStartedAt = Date.now()
  try {
    const rawReadStartedAt = Date.now()
    const rawMessages = await dbRef.getUserMessagesForExport(userMd5, startTime, endTime)
    perf.rawReadMs += Date.now() - rawReadStartedAt
    const sourceMessages = listSourceMessages(
      userMd5,
      startTime,
      endTime,
      undefined,
      rawMessages,
      perf.requestId,
      perf
    )
    const username = dbRef.getWcdb4Client().getUsernameByMd5(userMd5) || ''
    const recallStartedAt = Date.now()
    recordRecallArchiveMessages(userMd5, username, sourceMessages)
    const mergedMessages = mergeRecallArchiveMessages(userMd5, sourceMessages, startTime, endTime)
    perf.sortMs += Date.now() - recallStartedAt
    return mergedMessages
  } finally {
    perf.totalMs = Date.now() - totalStartedAt
    logListMessagesPerf(perf)
  }
}

/**
 * 图片消息计数（SQL 统计，不解密）。
 *
 * 返回 `count: null` 表示**统计失败**，不是 0 张。调用方必须区分这两件事 ——
 * 否则"数不出来"会被显示成"账号里没有图片"，用户会因此放弃建立索引。
 */
export async function countImageMessagesAsync(
  userMd5: string,
  range?: number | { sinceMs?: number; beforeMs?: number }
): Promise<ImageMessageCountProbe> {
  if (!dbRef) return { count: null, typeColumn: null, error: '微信数据库尚未就绪' }
  return dbRef.getWcdb4Client().countImageMessagesAsync(userMd5, range)
}

/**
 * 图片消息的增量水位（条数 + 最大插入序）。
 *
 * 增量索引**不能只比条数**：召回一张旧图的同时新增一张新图，条数不变但集合变了。
 * 返回 null = 当前数据库不支持该统计（调用方须退化成"每轮重扫"，宁可慢也不可漏）。
 */
export async function imageConversationWatermarkAsync(
  userMd5: string,
  range?: number | { sinceMs?: number; beforeMs?: number }
): Promise<{ count: number; maxLocalId: number } | null> {
  if (!dbRef) return null
  return dbRef.getWcdb4Client().imageConversationWatermarkAsync(userMd5, range)
}

export async function countVoiceMessagesAsync(
  userMd5: string,
  startTime?: number,
  endTime?: number
): Promise<number | null> {
  if (!dbRef) return null
  return dbRef.getUserVoiceMessageCountAsync(userMd5, startTime, endTime)
}

export function getGroupSnapshot(userMd5: string): GroupSnapshot | null {
  if (!dbRef) return null
  const wcdb4Client = dbRef.getWcdb4Client()
  const roomId = wcdb4Client.getUsernameByMd5(userMd5)
  if (!roomId || !roomId.endsWith('@chatroom')) return null

  const rawMembers = wcdb4Client.getGroupMembers(roomId)
  const members = (Array.isArray(rawMembers) ? rawMembers : [])
    .filter((member) => member?.m_nsUsrName)
    .map((member) => ({
      wxid: member.m_nsUsrName,
      nickname: member.nickname || '',
      groupNickname: member.groupNickname || '',
      wechatNickname: member.wechatNickname || '',
      remark: member.remark || '',
      avatar: member.m_nsHeadImgUrl || ''
    }))

  return { roomId, memberCount: members.length, members, roomInfo: wcdb4Client.getRoomInfo(roomId) || undefined }
}

export async function getGroupSnapshotAsync(userMd5: string): Promise<GroupSnapshot | null> {
  if (!dbRef) return null
  const wcdb4Client = dbRef.getWcdb4Client()
  const roomId = wcdb4Client.getUsernameByMd5(userMd5)
  if (!roomId || !roomId.endsWith('@chatroom')) return null

  const rawMembers = await wcdb4Client.getGroupMembersAsync(roomId)
  const members = (Array.isArray(rawMembers) ? rawMembers : [])
    .filter((member) => member?.m_nsUsrName)
    .map((member) => ({
      wxid: member.m_nsUsrName,
      nickname: member.nickname || '',
      groupNickname: member.groupNickname || '',
      wechatNickname: member.wechatNickname || '',
      remark: member.remark || '',
      avatar: member.m_nsHeadImgUrl || ''
    }))
  const session = wcdb4Client.getSessions().find((item) => item.username === roomId)
  return {
    roomId,
    groupName: session?.nickname || undefined,
    memberCount: members.length,
    members,
    roomInfo: (await wcdb4Client.getRoomInfoAsync(roomId)) || undefined
  }
}

/** 退群检测专用轻量读取，不执行成员名称或头像 hydration。 */
export async function getGroupMemberIdsAsync(
  roomId: string
): Promise<GroupMembershipSnapshot | null> {
  if (!dbRef || !roomId.endsWith('@chatroom')) return null
  const memberIds = await dbRef.getWcdb4Client().getGroupMemberIdsAsync(roomId)
  return memberIds ? { roomId, memberIds } : null
}

/**
 * Evidence sender enrichment 专用：只解析**请求到的** wxid 的显示名。
 *
 * **不**走 `getGroupSnapshotAsync` —— 后者会 materialize 整群成员并 hydrate 头像，
 * 为拿 1~N 个名字付整群成本。返回结构故意与 `GroupSnapshot['members']` 一致，
 * 这样调用方可以复用同一套显示名优先级规则，不会把「张三」退化成「wxid_xxx」。
 * `avatar` 恒为 `''`：头像若将来需要，走 lazy UI 路径，不进入 Query Tool 成本。
 */
export async function getGroupMemberNamesAsync(
  userMd5: string,
  wxids: string[]
): Promise<GroupSnapshot['members']> {
  if (!dbRef) return []
  const requested = Array.from(new Set((wxids || []).filter(Boolean)))
  if (requested.length === 0) return []
  const wcdb4Client = dbRef.getWcdb4Client()
  const roomId = wcdb4Client.getUsernameByMd5(userMd5)
  if (!roomId || !roomId.endsWith('@chatroom')) return []
  const members = await wcdb4Client.getGroupMemberNamesAsync(roomId, requested)
  return members.map((member) => ({
    wxid: member.m_nsUsrName,
    nickname: member.nickname || '',
    groupNickname: member.groupNickname || '',
    wechatNickname: member.wechatNickname || '',
    remark: member.remark || '',
    avatar: member.m_nsHeadImgUrl || ''
  }))
}

export function isGroupMemberIdsBatchAvailable(): boolean {
  return Boolean(dbRef?.getWcdb4Client().isGroupMemberIdsBatchAvailable())
}

export async function getGroupMemberIdsBatchAsync(
  roomIds: string[]
): Promise<GroupMembershipBatchSnapshot[] | null> {
  if (!dbRef) return null
  const results = await dbRef.getWcdb4Client().getGroupMemberIdsBatchAsync(roomIds)
  return results
    ? results.map((result) => ({
        roomId: result.roomId,
        status: result.status,
        memberIds: result.memberWxids
      }))
    : null
}

export function searchMessages(keyword: string): string | null {
  if (!dbRef) return null
  return dbRef.searchAllMessages(keyword)
}

export function listRecentChat(limit = 50): FormattedContact[] {
  const contacts = listContacts()
  return contacts.slice(0, limit)
}

export function resolveMd5(query: string): FormattedContact | null {
  const trimmed = query.trim()
  if (!trimmed) return null
  const lower = trimmed.toLowerCase()
  const contacts = listContacts()

  const exact = contacts.find(
    (c) =>
      c.md5 === trimmed ||
      c.m_nsUsrName.toLowerCase() === lower ||
      c.wechatId?.toLowerCase() === lower ||
      c.wxid?.toLowerCase() === lower ||
      c.m_nsNickName.toLowerCase() === lower
  )
  if (exact) return exact

  const partial = contacts.find(
    (c) =>
      c.m_nsNickName.toLowerCase().includes(lower) ||
      c.m_nsUsrName.toLowerCase().includes(lower) ||
      c.wechatId?.toLowerCase().includes(lower) ||
      c.wxid?.toLowerCase().includes(lower)
  )
  return partial || null
}

export interface SelfAccountInfo {
  wxid: string
  nickname: string
  avatar?: string
  accountRoot: string
}

export function getSelfAccountInfo(): SelfAccountInfo | null {
  if (!dbRef) return null
  const wcdb = dbRef.getWcdb4Client()
  const accountRoot = wcdb.getAccountRoot()
  const usernameCandidates = wcdb.getMyUsernameCandidates()
  const primaryUsername = usernameCandidates[0] ?? ''
  const wxid =
    primaryUsername && primaryUsername.toLowerCase().startsWith('wxid_')
      ? primaryUsername
      : wcdb.getUsernameByMd5(wcdb.md5(accountRoot.split('/').pop() || '')) || primaryUsername

  let nickname = ''
  let avatar: string | undefined
  try {
    avatar = wcdb.getMyAvatarUrl()
  } catch {
    avatar = undefined
  }

  if (usernameCandidates.length) {
    const contacts = listContacts()
    const self = contacts.find(
      (c) =>
        usernameCandidates.includes(c.m_nsUsrName) ||
        (c.type === 'user' && usernameCandidates.some((u) => c.m_nsUsrName.includes(u)))
    )
    if (self) {
      nickname = self.m_nsNickName
      avatar = avatar || self.avatar
    }
  }

  return {
    wxid: wxid || primaryUsername || '',
    nickname: nickname || wxid || '我',
    avatar,
    accountRoot
  }
}

export async function getSelfAccountInfoAsync(): Promise<SelfAccountInfo | null> {
  const current = dbRef
  if (!current) return null
  try {
    await current.getWcdb4Client().getSessionsAsync({ hydrateDisplayNames: true })
  } catch {
    // Nickname hydration is best-effort; the synchronous fallback still returns the account id.
  }
  if (dbRef !== current) return getSelfAccountInfo()
  return getSelfAccountInfo()
}

export function testConnection(key: string, accountRoot?: string): DatabaseKeyValidationResult {
  const probeKey = key.replace(/^0x/i, '').trim()
  if (!/^[0-9a-f]{64}$/i.test(probeKey)) {
    return {
      success: false,
      code: 'INVALID_FORMAT',
      error: '密钥格式不正确'
    }
  }

  let probe: WechatDb | null = null
  let ownsProbe = false
  try {
    const current = dbRef
    const canReuseCurrent =
      current &&
      getCurrentKey().replace(/^0x/i, '').trim() === probeKey &&
      (!accountRoot || getCurrentAccountRoot() === accountRoot)
    const validationDb = canReuseCurrent
      ? current
      : accountRoot
        ? new WechatDb(probeKey, accountRoot)
        : new WechatDb(probeKey)
    probe = validationDb
    ownsProbe = validationDb !== current
    const client = validationDb.getWcdb4Client()
    const contacts = client.getSessions()
    const messages = client.getChatTables()
    if (contacts[0]) client.getMessages(contacts[0].username, undefined, undefined, { limit: 1 })
    return {
      success: true,
      accountRoot: client.getAccountRoot(),
      wxid: (client.getMyUsernameCandidates?.() ?? [])[0] || '',
      contacts: { available: true, count: contacts.length },
      messages: { available: true, count: messages.length }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const code = mapConnectionError(detail)
    return {
      success: false,
      code,
      error: DATABASE_KEY_ERROR_MESSAGES[code]
    }
  } finally {
    try {
      // macOS native shutdown is process-wide. Do not tear down the active reader
      // when validating a replacement key; the new runtime connection takes over on save.
      if (ownsProbe && !(process.platform === 'darwin' && dbRef)) probe?.close()
    } catch {
      // Validation probes are best-effort closed without exposing native details.
    }
  }
}

const DATABASE_KEY_ERROR_MESSAGES: Record<DatabaseKeyValidationCode, string> = {
  INVALID_FORMAT: '密钥格式不正确',
  DATABASE_OPEN_FAILED: '无法打开数据库',
  ACCOUNT_MISMATCH: '密钥与当前账号不匹配',
  ROOT_UNAVAILABLE: '当前数据库目录不可用',
  DATABASE_FILE_MISSING: '数据库文件缺失',
  VC_RUNTIME_MISSING: WINDOWS_VC_RUNTIME_ERROR_MESSAGE,
  UNKNOWN_VALIDATION_ERROR: '未知验证错误'
}

function mapConnectionError(detail: string): DatabaseKeyValidationCode {
  const normalized = detail.toLowerCase()
  if (isWindowsVcRuntimeMissingError(detail, process.platform)) return 'VC_RUNTIME_MISSING'
  if (normalized.includes('-1005') || normalized.includes('不匹配')) return 'ACCOUNT_MISMATCH'
  if (normalized.includes('session.db') || normalized.includes('数据库文件')) {
    return 'DATABASE_FILE_MISSING'
  }
  if (
    normalized.includes('数据目录') ||
    normalized.includes('账号目录') ||
    normalized.includes('db_storage')
  ) {
    return 'ROOT_UNAVAILABLE'
  }
  if (normalized.includes('wcdb_open_account') || normalized.includes('open')) {
    return 'DATABASE_OPEN_FAILED'
  }
  return 'UNKNOWN_VALIDATION_ERROR'
}

export function reopenWithRoot(accountRoot: string): boolean {
  if (!dbRef) return false
  const key = getCurrentKey()
  if (!key) return false
  try {
    const next = new WechatDb(key, accountRoot)
    return setChatDb(next)
  } catch (error) {
    console.error('[ChatService] reopen with root failed:', error)
    return false
  }
}
