/**
 * WeChat iLink 协议类型与常量。
 *
 * 与官方客户端（channel_version 2.4.6 基线）对齐，字段名以官方协议为准。
 * 这里只描述协议本身，不引入任何 Electron 概念，便于将来被 Tauri 或其他宿主复用。
 */

/** 业务入口固定地址；登录与业务 API 都从这里开始。 */
export const ILINK_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'

/** CDN 上传/下载基地址。 */
export const ILINK_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

/** base_info.channel_version 上报值。 */
export const ILINK_CHANNEL_VERSION = '2.4.6'

/** iLink-App-Id 固定值。 */
export const ILINK_APP_ID = 'bot'

/** iLink-App-ClientVersion 编码为 (major << 16) | (minor << 8) | patch，2.4.6 => 132102。 */
export const ILINK_APP_CLIENT_VERSION = String((2 << 16) | (4 << 8) | 6)

/** base_info.bot_agent 默认值；仅用于服务端观测聚合，不参与鉴权。 */
export const ILINK_DEFAULT_BOT_AGENT = 'TraceMemo/1.0.0'

/** 长轮询默认与上限。 */
export const ILINK_LONG_POLL_TIMEOUT_MS = 35_000
export const ILINK_LONG_POLL_MAX_TIMEOUT_MS = 120_000
export const ILINK_QR_STATUS_TIMEOUT_MS = 35_000
export const ILINK_SEND_TIMEOUT_MS = 15_000
export const ILINK_CONFIG_TIMEOUT_MS = 10_000

/** bot token 失效（官方 2.4.5 起把内部命名从 session expired 改为 stale token）。 */
export const ILINK_STALE_TOKEN_CODE = -14

/** message_type */
export const ILINK_MESSAGE_TYPE_BOT = 2

/** message_state */
export const ILINK_MESSAGE_STATE_FINISH = 2

/** item type */
export const ILINK_ITEM_TYPE_TEXT = 1
export const ILINK_ITEM_TYPE_IMAGE = 2
export const ILINK_ITEM_TYPE_VOICE = 3
export const ILINK_ITEM_TYPE_FILE = 4
export const ILINK_ITEM_TYPE_VIDEO = 5

/** CDN media_type */
export const ILINK_CDN_MEDIA_TYPE_IMAGE = 1
export const ILINK_CDN_MEDIA_TYPE_VIDEO = 2
export const ILINK_CDN_MEDIA_TYPE_FILE = 3

/** sendtyping 的输入状态值。 */
export const ILINK_TYPING_STATUS_TYPING = 1
export const ILINK_TYPING_STATUS_CANCEL = 2

/**
 * 长任务期间维持"正在输入"心跳的间隔。
 *
 * 协议文档只定义了 status=1/2 两个状态、没有规定间隔；但微信客户端的输入指示
 * 会自行消失，所以长任务必须周期性重发 status=1 才能一直亮着。
 * 官方客户端按约 5 秒维持，这里沿用同一节奏。
 */
export const ILINK_TYPING_KEEPALIVE_MS = 5_000

/**
 * typing_ticket 的缓存有效期。
 * 官方按「账号 + 对端用户」缓存、首次取一次；这里用 24 小时兜底，
 * 遇到服务端报错会立即失效并在下次需要时重取。
 */
export const ILINK_TYPING_TICKET_TTL_MS = 24 * 60 * 60 * 1000

/** 二维码登录状态机。 */
export type ILinkQrStatus =
  | 'wait'
  | 'scaned'
  | 'confirmed'
  | 'expired'
  | 'need_verifycode'
  | 'verify_code_blocked'
  | 'scaned_but_redirect'
  | 'binded_redirect'
  | (string & {})

export interface ILinkBaseInfo {
  channel_version: string
  bot_agent: string
}

export interface ILinkQrCodeResponse {
  qrcode: string
  qrcode_img_content: string
  ret?: number
  errmsg?: string
}

export interface ILinkQrStatusResponse {
  status: ILinkQrStatus
  bot_token?: string
  ilink_bot_id?: string
  ilink_user_id?: string
  baseurl?: string
  redirect_host?: string
  ret?: number
  errcode?: number
  errmsg?: string
}

/** 持久化到 ~/.tracememo/wechat-connector/accounts/<id>.json 的凭据。 */
export interface ILinkCredentials {
  bot_token: string
  ilink_bot_id: string
  baseurl: string
  ilink_user_id: string
}

export interface ILinkTextItem {
  text: string
}

export interface ILinkMediaInfo {
  encrypt_query_param: string
  aes_key: string
  encrypt_type: number
}

export interface ILinkImageItem {
  url?: string
  media?: ILinkMediaInfo
  mid_size?: number
}

export interface ILinkVideoItem {
  media?: ILinkMediaInfo
  video_size?: number
}

export interface ILinkFileItem {
  media?: ILinkMediaInfo
  file_name?: string
  len?: string
}

export interface ILinkVoiceItem {
  media?: ILinkMediaInfo
  voice_size?: number
  encode_type?: number
  playtime?: number
  text?: string
}

export interface ILinkMessageItem {
  type: number
  text_item?: ILinkTextItem
  image_item?: ILinkImageItem
  voice_item?: ILinkVoiceItem
  video_item?: ILinkVideoItem
  file_item?: ILinkFileItem
}

export interface ILinkWeixinMessage {
  seq?: number
  message_id?: number
  from_user_id?: string
  to_user_id?: string
  message_type?: number
  message_state?: number
  item_list?: ILinkMessageItem[]
  context_token?: string
  session_id?: string
  group_id?: string
}

export interface ILinkGetUpdatesResponse {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: ILinkWeixinMessage[]
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}

export interface ILinkSendMessageRequest {
  msg: {
    from_user_id: string
    to_user_id: string
    client_id: string
    message_type: number
    message_state: number
    item_list: ILinkMessageItem[]
    context_token: string
    run_id?: string
  }
  base_info: ILinkBaseInfo
}

export interface ILinkSendMessageResponse {
  ret?: number
  errmsg?: string
}

export interface ILinkGetUploadUrlRequest {
  filekey: string
  media_type: number
  to_user_id: string
  rawsize: number
  rawfilemd5: string
  filesize: number
  no_need_thumb: boolean
  aeskey: string
  base_info: ILinkBaseInfo
}

export interface ILinkGetUploadUrlResponse {
  ret?: number
  errmsg?: string
  upload_param?: string
  upload_full_url?: string
}

export interface ILinkGetConfigResponse {
  ret?: number
  errcode?: number
  errmsg?: string
  typing_ticket?: string
}

export interface ILinkSendTypingRequest {
  ilink_user_id: string
  typing_ticket: string
  status: number
  base_info: ILinkBaseInfo
}

export interface ILinkSendTypingResponse {
  ret?: number
  errcode?: number
  errmsg?: string
}

/**
 * 归一化后的入站消息。Agent Hub 只消费这个形状，
 * 不直接依赖协议原始字段，方便将来替换 transport。
 */
export interface WechatInboundItem {
  type: number
  text?: string
}

export interface WechatInboundMessage {
  accountId: string
  fromUserId: string
  messageId: string
  seq?: number
  sessionId?: string
  groupId?: string
  messageType: number
  /** 会话上下文令牌：回复必须原样回传，不得用于其他会话，也不得写入普通日志。 */
  contextToken?: string
  items: WechatInboundItem[]
  receivedAt: number
}

/** 账号摘要（供 UI 账号列表使用）。 */
export interface WechatConnectorAccount {
  accountId: string
  wechatUserId: string
}

/** 登录过程中向宿主上报的事件。 */
export type WechatLoginEvent =
  | { status: 'qrcode'; qrCodeDataUrl: string }
  | { status: 'wait' | 'scaned' | 'need_verifycode' | 'verify_code_blocked' | 'expired' }
  | { status: 'confirmed' }
  | { status: 'active'; accountId: string; wechatUserId: string }

/** 连接器对外暴露的运行态。 */
export type WechatConnectorPhase = 'stopped' | 'starting' | 'polling' | 'stale_token' | 'error'
