// src/shared/image-insight.ts
// ImageInsight:微信图片的 AI 理解结果持久化数据结构
// 与 TraceMemo 整体 AI 知识平台定位一致 — 图片理解结果可索引、可缓存、可复用。

export type ImageCategory =
  | 'screenshot' // 截图
  | 'photo' // 实拍照片
  | 'meme' // 表情包
  | 'document' // 文档/合同/票据
  | 'chart' // 图表/数据
  | 'other'

export type ImageImportance = 'low' | 'medium' | 'high'

/** 日报图片理解结果最多复用 10 分钟；旧记录保留在磁盘，仅不再作为缓存命中。 */
export const IMAGE_INSIGHT_CACHE_TTL_MS = 10 * 60 * 1000

export const isFreshImageInsight = (
  insight: Pick<ImageInsight, 'updatedAt'> | null | undefined,
  now = Date.now()
): boolean =>
  Boolean(
    insight &&
    Number.isFinite(insight.updatedAt) &&
    insight.updatedAt > 0 &&
    now >= insight.updatedAt &&
    now - insight.updatedAt < IMAGE_INSIGHT_CACHE_TTL_MS
  )

/**
 * 单张微信图片的 AI 理解结果(持久化到 image-insights.json)
 *
 * imageHash 缓存 key 策略:
 *   优先用微信原始 md5(已存在,不强制计算)
 *   无 md5 才用 sha256(rawBytes).slice(0, 32)
 */
export interface ImageInsight {
  id: string // UUID
  messageId: string // 微信消息 ID(用于追溯)
  imageHash: string // 缓存 key:微信 md5 优先,无 md5 才用 sha256
  md5?: string // 微信图片 md5
  datName?: string // .dat 文件名

  /** AI 输出 */
  description: string // 1-2 句中文描述
  ocrText?: string // OCR 提取的文字(vision 模型一并返回)
  tags: string[] // 关键词标签
  category: ImageCategory
  importance: ImageImportance

  /** 元数据 */
  provider: string // AI provider ID
  model: string // AI model ID
  createdAt: number // 首次分析时间戳
  updatedAt: number // 最近更新时间

  /** 关联消息信息 */
  sender: string
  sentAt: number
  sessionId: string
}

/**
 * 图片理解请求(main 进程内部使用)
 */
export interface ImageAnalysisRequest {
  /** 必传,缓存 key */
  imageHash: string
  /** base64 dataURL,仅 main 内部使用 */
  imageDataUrl: string
  messageId: string
  sender: string
  sentAt: number
  sessionId: string
  /** 日报局部选择的图片理解模型；未传时仍使用自动视觉路由。 */
  providerId?: string
  modelId?: string
  /** 强制重新分析(忽略缓存) */
  force?: boolean
}

/**
 * 图片理解响应
 */
export interface ImageAnalysisResponse {
  success: boolean
  insight?: ImageInsight
  /** 是否来自缓存 */
  fromCache?: boolean
  error?: string
}

/**
 * 图片候选(日报使用)
 * 主进程根据消息列表计算热度,返回 Top N + 已缓存的 Insight
 */
export interface ImageCandidate {
  messageId: string
  imageHash: string
  md5?: string
  datName?: string
  sessionId: string
  sender: string
  sentAt: number
  /** 热度分数 */
  heatScore: number
  /** 命中缓存时附带 */
  insight?: ImageInsight
}

export interface ImageCandidateQuery {
  sessionId: string
  startTime: number
  endTime: number
  /** 最多取 N 张,默认 3；服务端会将其限制在 0–3 */
  limit?: number
  /** 由 renderer 从已加载消息中提取的图片候选(包含热度信息) */
  inputs?: Array<{
    messageId: string
    md5?: string
    datName?: string
    sessionId: string
    sender: string
    sentAt: number
    responseCount: number
    interactionCount: number
  }>
}

/**
 * A picture is considered hot only when it has observable follow-up activity.
 * A bare image message (or a single passive reply) is not enough to enter the
 * daily report's AI image selection. This keeps the "top 3" value an upper
 * bound rather than a quota that fills every available slot.
 */
export const isHotImageCandidate = (input: {
  responseCount: number
  interactionCount: number
}): boolean => input.responseCount >= 2 || (input.responseCount >= 1 && input.interactionCount >= 1)

export const calculateImageHeatScore = (input: {
  responseCount: number
  interactionCount: number
}): number => input.responseCount * 3 + input.interactionCount * 2 + 1
