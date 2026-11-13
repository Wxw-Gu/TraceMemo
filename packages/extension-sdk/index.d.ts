/**
 * TraceMemo 扩展 SDK v1 —— 仅类型定义。
 *
 * 运行期没有这个包：宿主在后台子进程里注入全局 `tm`，扩展入口只需要
 * `module.exports = function activate(tm: TraceMemoApi) {}`。
 * 把本文件放进扩展仓库即可获得补全与类型检查。
 */

export type ExtensionMessageType =
  | 'text'
  | 'image'
  | 'voice'
  | 'video'
  | 'sticker'
  | 'file'
  | 'link'
  | 'system'
  | 'other'

export interface TraceMemoMessageEvent {
  /** 同一条微信消息稳定不变：`message:<sha1(sessionId:localId)>`。 */
  eventId: string
  accountId: string
  conversationId: string
  messageId: string
  senderId?: string
  senderName?: string
  isGroup: boolean
  isSelf: boolean
  type: ExtensionMessageType
  text?: string
  /** 真正 @ 到当前登录账号，不是正文里的 `@昵称`。 */
  mentionsMe: boolean
  /** epoch 毫秒。 */
  timestamp: number
}

export interface TraceMemoQueriedMessage {
  messageId: string
  conversationId: string
  senderId?: string
  senderName?: string
  isSelf: boolean
  type: string
  text?: string
  /** epoch 毫秒。 */
  timestamp: number
}

export interface TraceMemoSendTextRequest {
  /** 缺省为 text。 */
  type?: 'text'
  /** 群为 `xxx@chatroom`，私聊为 wxid。 */
  to: string
  text: string
  at?: Record<string, string>
  /** 相同键的重复请求会被 Gateway 审计短路。 */
  dedupeKey?: string
}

/**
 * 图片发送。
 */
export interface TraceMemoSendImageRequest {
  type: 'image'
  to: string
  path: string
  dedupeKey?: string
}

/**
 * 视频发送。原生 Host 以 `{toWxid, type:'video', msg:<路径>}` 提交。
 * 路径必须位于扩展数据目录或系统临时目录。
 */
export interface TraceMemoSendVideoRequest {
  type: 'video'
  to: string
  path: string
  dedupeKey?: string
}

export type TraceMemoSendRequest =
  | TraceMemoSendTextRequest
  | TraceMemoSendImageRequest
  | TraceMemoSendVideoRequest

export interface TraceMemoAutomationActionDefinition {
  id: string
  title: string
  description?: string
  inputSchema?: {
    type: 'object'
    properties?: Record<string, { type?: 'string' | 'number' | 'boolean'; description?: string }>
    required?: string[]
  }
  handler: (input: Record<string, unknown>) => unknown | Promise<unknown>
}

export interface TraceMemoAutomationActionOutput {
  success: boolean
  output?: Record<string, unknown>
  /** 宿主经 Gateway 发回原会话；扩展自己不发消息。 */
  reply?: { type: 'text'; text: string; at?: Record<string, string> }
  error?: string
}

export interface TraceMemoCapabilities {
  extensionId: string
  enabled: boolean
  permissions: string[]
  platform: string
  databaseReady: boolean
  send: {
    supported: boolean
    ready: boolean
    canSendText: boolean
    canSendImage: boolean
    canSendVideo: boolean
    licensed: boolean
    message: string
  }
  ai: { configured: boolean; modelName: string }
}

export interface TraceMemoApi {
  extension: {
    readonly id: string
    /** 扩展私有数据目录；下载与生成的文件应放在这里。 */
    readonly dataDir: string
    readonly permissions: string[]
  }
  events: {
    on(
      name: 'message.received',
      handler: (event: TraceMemoMessageEvent) => void | Promise<void>
    ): () => void
    off(
      name: 'message.received',
      handler: (event: TraceMemoMessageEvent) => void | Promise<void>
    ): void
  }
  messages: {
    query(request: {
      conversationId: string
      /** epoch 毫秒；默认最近 24 小时。 */
      startTime?: number
      /** epoch 毫秒；默认现在。 */
      endTime?: number
      limit?: number
    }): Promise<{ messages: TraceMemoQueriedMessage[] }>
  }
  wechat: {
    send(request: TraceMemoSendRequest): Promise<{ actionId: string; status: 'sent' }>
  }
  ai: {
    chat(messages: Array<{ role: string; content: string }>): Promise<{ text: string }>
  }
  storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
    remove(key: string): Promise<boolean>
    list(): Promise<Array<{ key: string; value: unknown }>>
  }
  automation: {
    registerAction(definition: TraceMemoAutomationActionDefinition): void
  }
  capabilities: {
    get(): Promise<TraceMemoCapabilities>
  }
  log: {
    info(message: unknown): void
    warn(message: unknown): void
    error(message: unknown): void
  }
}

/**
 * 后台入口签名。
 *
 * ```js
 * module.exports = function activate(tm) { ... }
 * ```
 */
export type TraceMemoActivate = (tm: TraceMemoApi) => void | Promise<void>

declare global {
  var tm: TraceMemoApi
}
