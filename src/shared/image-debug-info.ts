/**
 * 图片调试定位信息。
 *
 * 只用于把「用户点中的那一条图片消息」精确交给本地排查工具，
 * 不承载任何密钥、完整 XML 或图片内容。
 *
 * 所有消息 ID 一律用字符串：serverId 是 64 位整数，
 * 经 Number 转换会在 2^53 以上丢精度，届时定位会指向另一条消息。
 *
 * 字段即契约：结构里只保留消费方实际使用的定位/验收字段；
 * 拿不到的字段（如表名、宽高）直接不出现，不要加 null 占位。
 */
export const IMAGE_DEBUG_KIND = 'tracememo.image-debug' as const

export type ImageDebugQuality = 'thumbnail' | 'normal' | 'original' | 'unknown'

export interface ImageDebugMessage {
  /** 本机账号定位标识；取不到时为 null。 */
  accountId: string | null
  conversationId: string | null
  localId: string | null
  /** 消息唯一键；跨库定位一律用它，不要依赖 localId。 */
  serverId: string | null
  /** 消息创建时间，单位：秒（epoch seconds），不是毫秒。 */
  createTimeSeconds: number | null
}

export interface ImageDebugPayload {
  kind: typeof IMAGE_DEBUG_KIND
  message: ImageDebugMessage
  image: {
    md5: string | null
    datName: string | null
  }
  display: {
    quality: ImageDebugQuality
    /** 已有的质量判定依据（如命中的候选文件名）。 */
    evidence: string | null
    /** 相对账号根目录的资源路径；取不到时为 null。 */
    path: string | null
  }
}

/** 渲染进程 → 主进程的查询入参。 */
export interface ImageDebugInfoRequest {
  sessionId?: string
  localId?: number
  serverId?: string
  createTime?: number
  imageMd5?: string
  imageDatName?: string
}

export interface ImageDebugInfoResult {
  success: boolean
  payload?: ImageDebugPayload
  error?: string
}
