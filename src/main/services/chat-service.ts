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
  members: {
    wxid: string
    nickname: string
    groupNickname: string
    wechatNickname: string
    remark: string
    avatar: string
  }[]
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
let shutdownRequested = false

export function setChatDb(db: WechatDb | null): boolean {
  if (shutdownRequested) {
    db?.close()
    return false
  }
  dbRef?.close()
  dbRef = db
  return true
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

export function listContacts(filter?: string): FormattedContact[] {
  if (!dbRef) return []

  const contacts: FormattedContact[] = []
  const groupContacts = dbRef.getAllGroupContacts()
  const userList = dbRef.getUserList(filter)
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
  return contacts
}

export async function listContactsAsync(filter?: string): Promise<FormattedContact[]> {
  if (!dbRef) return []
  await dbRef.getWcdb4Client().getSessionsAsync({
    // macOS session rows frequently contain only wxid/chatroom ids. Hydrate
    // contact display names before exposing the list to the renderer.
    hydrateDisplayNames: true,
    hydrateStatuses: true
  })
  return listContacts(filter)
}

export async function getContactAvatars(usernames: string[]): Promise<Record<string, string>> {
  if (!dbRef) return {}
  const normalized = Array.from(
    new Set((usernames || []).map((username) => String(username || '').trim()).filter(Boolean))
  )
  if (normalized.length === 0) return {}
  return dbRef.getWcdb4Client().getAvatarUrlsAsync(normalized)
}

function listSourceMessages(
  userMd5: string,
  startTime?: number,
  endTime?: number,
  options?: { limit?: number },
  rawMessagesOverride?: WechatMessage[]
): FormattedMessage[] {
  if (!dbRef) return []

  const startedAt = Date.now()
  const wcdb4Client = dbRef.getWcdb4Client()
  const username = wcdb4Client.getUsernameByMd5(userMd5)
  const isGroupChat = Boolean(username?.endsWith('@chatroom'))
  console.log(
    `[ChatService] listMessages begin md5=${userMd5} username=${username || ''} start=${startTime || 0} end=${endTime || 0} limit=${options?.limit || 0}`
  )
  const rawMessages =
    rawMessagesOverride ?? dbRef.getUserMessages(userMd5, startTime, endTime, options)
  console.log(
    `[ChatService] listMessages native done md5=${userMd5} raw=${rawMessages.length} cost=${Date.now() - startedAt}ms`
  )

  const formatted = rawMessages.map((msg: WechatMessage) => {
    const rawMsgType = parseInt(msg.messageType)
    const msgType = normalizeMsgType(msg.messageType)
    const createTime = parseInt(msg.msgCreateTime)
    const date = new Date(createTime * 1000)
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
      const system = parseMessageContent(content, 10000)
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
            ? parseStickerMessageFromRow(msg, content)
            : undefined
        const parsedContent = parseMessageContent(content, inferredMsgType)
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
      const parsed = parseStickerMessageFromRow(msg, content)
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

    return {
      id: recoveredFromRecallJournal
        ? `recovered:${msg.mesLocalID || msg.serverId || createTime}`
        : msg.mesLocalID || Math.random().toString(),
      from: contentData?.type === 'system' ? 'system' : isMine ? 'assistant' : 'user',
      isSender: isMine,
      type: displayType,
      datetime: date.toLocaleString('zh-CN', { hour12: false }),
      content,
      img,
      name,
      senderId,
      sessionId: username,
      localId,
      serverId: typeof msg.serverId === 'string' ? msg.serverId : undefined,
      createTime,
      recoveredFromRecallJournal,
      contentData
    }
  })

  console.log(
    `[ChatService] listMessages end md5=${userMd5} formatted=${formatted.length} cost=${Date.now() - startedAt}ms`
  )
  return formatted
}

export function listMessages(
  userMd5: string,
  startTime?: number,
  endTime?: number,
  options?: { limit?: number }
): FormattedMessage[] {
  const sourceMessages = listSourceMessages(userMd5, startTime, endTime, options)
  if (!dbRef) return sourceMessages
  const username = dbRef.getWcdb4Client().getUsernameByMd5(userMd5) || ''
  recordRecallArchiveMessages(userMd5, username, sourceMessages)
  return mergeRecallArchiveMessages(userMd5, sourceMessages, startTime, endTime, options?.limit)
}

export async function listMessagesAsync(
  userMd5: string,
  startTime?: number,
  endTime?: number,
  options?: { limit?: number }
): Promise<FormattedMessage[]> {
  if (!dbRef) return []
  const rawMessages = await dbRef.getUserMessagesAsync(userMd5, startTime, endTime, options)
  const sourceMessages = listSourceMessages(userMd5, startTime, endTime, options, rawMessages)
  const username = dbRef.getWcdb4Client().getUsernameByMd5(userMd5) || ''
  recordRecallArchiveMessages(userMd5, username, sourceMessages)
  return mergeRecallArchiveMessages(userMd5, sourceMessages, startTime, endTime, options?.limit)
}

export async function listMessagesForExport(
  userMd5: string,
  startTime?: number,
  endTime?: number
): Promise<FormattedMessage[]> {
  if (!dbRef) return []
  const rawMessages = await dbRef.getUserMessagesForExport(userMd5, startTime, endTime)
  const sourceMessages = listSourceMessages(userMd5, startTime, endTime, undefined, rawMessages)
  const username = dbRef.getWcdb4Client().getUsernameByMd5(userMd5) || ''
  recordRecallArchiveMessages(userMd5, username, sourceMessages)
  const mergedMessages = mergeRecallArchiveMessages(userMd5, sourceMessages, startTime, endTime)
  console.log(
    `[ChatService] listMessagesForExport end md5=${userMd5} source=${sourceMessages.length} merged=${mergedMessages.length}`
  )
  return mergedMessages
}

/**
 * Count voice rows without hydrating message content. This is used by the
 * batch-selection view, where loading every conversation would make opening
 * Settings noticeably slow.
 */
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

  const members = wcdb4Client
    .getGroupMembers(roomId)
    .filter((member) => member?.m_nsUsrName)
    .map((member) => ({
      wxid: member.m_nsUsrName,
      nickname: member.nickname || '',
      groupNickname: member.groupNickname || '',
      wechatNickname: member.wechatNickname || '',
      remark: member.remark || '',
      avatar: member.m_nsHeadImgUrl || ''
    }))

  return { roomId, memberCount: members.length, members }
}

export async function getGroupSnapshotAsync(userMd5: string): Promise<GroupSnapshot | null> {
  if (!dbRef) return null
  const wcdb4Client = dbRef.getWcdb4Client()
  const roomId = wcdb4Client.getUsernameByMd5(userMd5)
  if (!roomId || !roomId.endsWith('@chatroom')) return null

  const members = (await wcdb4Client.getGroupMembersAsync(roomId))
    .filter((member) => member?.m_nsUsrName)
    .map((member) => ({
      wxid: member.m_nsUsrName,
      nickname: member.nickname || '',
      groupNickname: member.groupNickname || '',
      wechatNickname: member.wechatNickname || '',
      remark: member.remark || '',
      avatar: member.m_nsHeadImgUrl || ''
    }))
  return { roomId, memberCount: members.length, members }
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
      c.m_nsNickName.toLowerCase() === lower
  )
  if (exact) return exact

  const partial = contacts.find(
    (c) =>
      c.m_nsNickName.toLowerCase().includes(lower) || c.m_nsUsrName.toLowerCase().includes(lower)
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
