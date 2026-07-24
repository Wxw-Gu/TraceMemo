export interface Contact {
  m_nsUsrName: string
  m_nsNickName: string
  md5: string
  type: 'user' | 'group'
  avatar?: string
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
type VoipContent = { type: 'voip'; duration?: number; status: string; roomType?: number }
type ImageContent = {
  type: 'image'
  md5?: string
  datName?: string
  aeskey?: string
  encrypVer?: number
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
}
type SystemContent = {
  type: 'system'
  content: string
  raw?: string
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
  | VoipContent
  | ImageContent
  | StickerContent
  | QuoteContent
  | SystemContent
  | UnknownContent

export interface ChatTable {
  name: string
  db_number: string
}
