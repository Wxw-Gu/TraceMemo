export interface Contact {
  m_nsUsrName: string
  m_nsNickName: string
  md5: string
  type: 'user' | 'group'
  avatar?: string
  wechatNickname?: string
  remark?: string
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
  voiceDataUrl?: string
  voiceDuration?: number
  localId?: number
  serverId?: string
  createTime?: number
  sessionId?: string
  recalled?: boolean
  recalledBy?: string
  recoveredFromRecallJournal?: boolean
  exportMediaUrl?: string
  exportMediaType?: 'image' | 'video' | 'sticker'
  exportShowAvatar?: boolean
  exportMediaError?: string
  exportAvatarUrl?: string
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
type ShareContent = {
  type: 'share'
  title: string
  des?: string
  url: string
  appname?: string
  typeVal?: string
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
type UnknownContent = { type: 'unknown'; raw: string }

export type ParsedContent =
  | TextContent
  | VoiceContent
  | LocationContent
  | CardContent
  | ShareContent
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
