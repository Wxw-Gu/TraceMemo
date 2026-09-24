import type { ExportImageQuality } from './image-quality'

export interface Contact {
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

export interface Message {
  id: string
  from: string
  type: string
  datetime: string
  content: string
  isSender: boolean
  img?: string
  name?: string
  senderId?: string
  contentData?: ParsedContent
  media?: {
    type: 'image'
    available: boolean
    url: string
  }
  voiceDataUrl?: string
  voiceDuration?: number
  voiceTranscript?: string
  voiceTranscriptError?: string
  localId?: number
  serverId?: string
  createTime?: number
  sessionId?: string
  recalled?: boolean
  recalledBy?: string
  recoveredFromRecallJournal?: boolean
  exportMediaUrl?: string
  exportMediaType?: 'image' | 'video' | 'sticker' | 'file'
  exportMediaName?: string
  exportMediaQuality?: ExportImageQuality
  exportShowAvatar?: boolean
  exportMediaError?: string
  exportAvatarUrl?: string
  exportConversationId?: string
  exportConversationName?: string
  exportConversationAvatarUrl?: string
}

/**
 * 「跳转到原聊天」的锚点读取结果。
 *
 * `found: false` 是**有意义**的返回值，不是错误：它表示会话已经打开、窗口也加载了，
 * 但目标消息不在窗口里（被清理 / 时间戳口径漂移）。UI 必须据此诚实提示，
 * 而不是把"跳到了会话"说成"定位到了消息"。
 */
export interface MessagesAroundResult {
  messages: Message[]
  /** 窗口内精确匹配到目标消息（按规范化消息 id，不是按时间）。 */
  found: boolean
  /** 实际使用的窗口半径（秒）；0 表示没有可用锚点时间、只做了兜底读取。 */
  radiusSeconds: number
  /** 窗口消息数超过单次上限被截断。 */
  truncated: boolean
}

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
export type ShareArticle = {
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
  /** `wcpayinfo` when typeVal === '2000' (微信转账). Display/export only. */
  transfer?: TransferPaymentInfo
}

/** 转账 `wcpayinfo` 字段（只读展示；不含支付操作）。 */
export type TransferPaymentInfo = {
  paySubtype?: string
  amountText?: string
  transcationId?: string
  transferId?: string
  invalidTime?: string
  beginTransferTime?: string
  effectiveDate?: string
  payMemo?: string
  receiverUsername?: string
  payerUsername?: string
  transferStatus?: string
  /** `transfer_status` 展示文案（只读）。 */
  transferStatusText?: string
  /** `trans_id` / `fee_type` / `transfer_attach` / `refund_bank_type`（若消息带；只读透传）。 */
  transId?: string
  feeType?: string
  transferAttach?: string
  refundBankType?: string
}

/** 红包 `wcpayinfo` 字段（只读展示）。 */
export type RedPacketPaymentInfo = {
  templateId?: string
  receiveTitle?: string
  sendTitle?: string
  sceneText?: string
  senderDes?: string
  receiverDes?: string
  iconUrl?: string
  nativeUrl?: string
  sendId?: string
  hbType?: string
  hbStatus?: string
  receiveStatus?: string
  /** 展示文案（只读）。 */
  redPacketStatusText?: string
}
export type ForwardedMessageItem = {
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
  /** `wcpayinfo` 展示字段（只读）。 */
  pay?: RedPacketPaymentInfo
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

export interface ChatTable {
  name: string
  db_number: string
}
