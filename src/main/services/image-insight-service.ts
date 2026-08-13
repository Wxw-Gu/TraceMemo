// src/main/services/image-insight-service.ts
// TraceMemo AI 图片理解基础设施
//
// 设计原则:
// 1. base64 不走 IPC,只在 main 内部流转(renderer 只看到 ImageInsight 结构化结果)
// 2. 同图(imageHash)在 10 分钟内走缓存,过期后重新调 AI
// 3. 失败不抛,日志记录 + 返回原状(不阻塞日报)
// 4. 日报最多识别 3 张达到热点门槛的图片；缓存命中即返回,未命中并发调 AI

import crypto from 'crypto'
import { randomUUID } from 'crypto'
import { imageInsightsStore } from '../db/image-insights-store'
import {
  buildImageAnalysisUserText,
  IMAGE_ANALYSIS_SYSTEM_PROMPT,
  parseImageAnalysisResponse
} from './image-insight-prompt'
import type {
  ImageAnalysisRequest,
  ImageAnalysisResponse,
  ImageCandidate,
  ImageCandidateQuery,
  ImageInsight
} from '../../shared/image-insight'
import {
  calculateImageHeatScore,
  isFreshImageInsight,
  isHotImageCandidate
} from '../../shared/image-insight'

/**
 * 单张图片的最小信息(由 renderer 从已加载的 messages 中提取并传入 main)。
 * 这样可以避免 ImageInsightService 自己重新查询消息,且参数语义清晰。
 */
export interface ImageCandidateInput {
  messageId: string
  md5?: string
  datName?: string
  sessionId: string
  sender: string
  sentAt: number
  /** 图片发出后 8 条消息内、不同发言人的回复数(由 renderer 计算) */
  responseCount: number
  /** 表情/语音互动条数 */
  interactionCount: number
}

interface ProviderServiceLike {
  list(): ProviderSummaryLike
  getVisionRuntimeConfig(): {
    providerId?: string
    providerName: string
    model: string
    modelName: string
    configured: boolean
  }
  analyzeImage(
    messages: Array<{
      role: string
      content: string | Array<{ type: 'text'; text: string } | { type: 'image'; dataUrl: string }>
    }>,
    options?: { providerId?: string; modelId?: string }
  ): Promise<{
    success: boolean
    data?: string
    error?: string
  }>
}

interface DecryptServiceLike {
  findImageFile(
    md5?: string,
    imageDatName?: string,
    options?: { allowThumbnail?: boolean }
  ): string | null
  decryptImageToBase64(datPath: string): string | null
}

interface ProviderSummaryLike {
  providers: Array<{
    id: string
    isDefault: boolean
    defaultModel: string
    models: Array<{ id: string; capabilities: { vision: boolean; ocr: boolean } }>
  }>
  defaultProviderId?: string
}

class ImageInsightService {
  private providerService: ProviderServiceLike | null = null
  private decryptService: DecryptServiceLike | null = null
  /** 最近一次实际使用的视觉 provider/model，仅用于写入分析元数据 */
  private runtimeProviderId: string | undefined = undefined
  private runtimeModelId: string | undefined = undefined

  /** 注入依赖(由 main/index.ts 在 app ready 后调用) */
  bind(deps: {
    providerService: ProviderServiceLike & { list(): ProviderSummaryLike }
    decryptService: DecryptServiceLike
  }): void {
    this.providerService = deps.providerService
    this.decryptService = deps.decryptService
    console.log(
      '[ImageInsightService] bind ok, default provider=%s model=%s',
      this.runtimeProviderId,
      this.runtimeModelId
    )
    // 读取当前视觉 provider/model(后续 analyze 时仍会刷新，避免配置变化后继续用旧模型)
    try {
      const runtime = deps.providerService.getVisionRuntimeConfig()
      this.runtimeProviderId = runtime.providerId
      this.runtimeModelId = runtime.model || undefined
      console.log(
        '[ImageInsightService] bind loaded default provider=%s model=%s',
        this.runtimeProviderId,
        this.runtimeModelId
      )
    } catch (error) {
      console.warn('[ImageInsightService] bind list failed:', error)
    }
  }

  /**
   * 计算图片缓存 key:imageHash。
   * 策略:优先微信原始 md5,无 md5 才用 sha256(rawBytes).slice(0, 32)
   */
  private async computeImageHash(
    md5: string | undefined,
    datName: string | undefined
  ): Promise<string | null> {
    if (md5 && md5.trim()) return md5.trim().toLowerCase()
    if (!this.decryptService) return null
    const filePath = this.decryptService.findImageFile(undefined, datName, { allowThumbnail: true })
    if (!filePath) return null
    // 一次性读盘 + sha256(只在没有 md5 时才付出 IO)
    try {
      const fs = await import('fs-extra')
      const buf = await fs.readFile(filePath)
      const sha = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32)
      return `sha256:${sha}`
    } catch (error) {
      console.warn('[ImageInsightService] computeImageHash failed:', error)
      return null
    }
  }

  /** 通过 hash 拿 Insight(只读缓存,无 AI 调用) */
  getInsight(imageHash: string): ImageInsight | null {
    return imageInsightsStore.getByHash(imageHash)
  }

  /**
   * 主入口:分析一张图片。
   * 1. 通过 imageHash 查 10 分钟缓存,新鲜则返回
   * 2. 未命中:解密图片 → 调 AI → 解析响应 → 落库 → 返回
   * 3. 任意步骤失败:记录日志,返回 success=false,**不抛**
   */
  async analyze(request: ImageAnalysisRequest): Promise<ImageAnalysisResponse> {
    try {
      if (!request.force) {
        const cached = imageInsightsStore.getByHash(request.imageHash)
        if (isFreshImageInsight(cached)) {
          return { success: true, insight: cached || undefined, fromCache: true }
        }
        if (cached) {
          console.log(
            '[ImageInsightService] cache expired hash=%s ageMs=%d',
            request.imageHash,
            Date.now() - Number(cached.updatedAt || 0)
          )
        }
      }

      if (!this.providerService) {
        return { success: false, error: 'AI Provider 未初始化' }
      }

      const messages = [
        {
          role: 'system',
          content: IMAGE_ANALYSIS_SYSTEM_PROMPT
        },
        {
          role: 'user',
          content: [
            {
              type: 'text' as const,
              text: buildImageAnalysisUserText({
                sender: request.sender,
                sentAt: request.sentAt,
                contextBefore: [],
                contextAfter: []
              })
            },
            { type: 'image' as const, dataUrl: request.imageDataUrl }
          ]
        }
      ]

      const runtime =
        request.providerId && request.modelId
          ? {
              providerId: request.providerId,
              model: request.modelId,
              configured: true
            }
          : this.providerService.getVisionRuntimeConfig()
      if (!runtime.configured || !runtime.providerId || !runtime.model) {
        return { success: false, error: '尚未配置或验证支持图片理解的 AI 模型' }
      }
      this.runtimeProviderId = runtime.providerId
      this.runtimeModelId = runtime.model
      console.log(
        '[ImageInsightService] analyze using vision provider=%s model=%s',
        this.runtimeProviderId,
        this.runtimeModelId
      )
      const result = await this.providerService.analyzeImage(messages, {
        providerId: this.runtimeProviderId,
        modelId: this.runtimeModelId
      })
      if (!result.success || !result.data) {
        console.warn('[ImageInsightService] analyze vision failed: %s', result.error || 'no data')
        return { success: false, error: result.error || 'AI 未返回内容' }
      }
      console.log('[ImageInsightService] analyze ok, description=%s', result.data.slice(0, 80))

      const parsed = parseImageAnalysisResponse(result.data)
      const insight: ImageInsight = {
        id: randomUUID(),
        messageId: request.messageId,
        imageHash: request.imageHash,
        md5: undefined,
        datName: undefined,
        description: parsed.description,
        ocrText: parsed.ocrText || undefined,
        tags: parsed.tags,
        category: parsed.category,
        importance: parsed.importance,
        provider: this.runtimeProviderId || '',
        model: this.runtimeModelId || '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sender: request.sender,
        sentAt: request.sentAt,
        sessionId: request.sessionId
      }
      imageInsightsStore.upsert(insight)
      return { success: true, insight, fromCache: false }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[ImageInsightService] analyze failed:', message)
      return { success: false, error: message }
    }
  }

  /**
   * 日报入口:从 renderer 传入的图片消息候选中挑 Top N + 命中缓存的 Insight。
   *
   * 设计:不自己查 chat-service(参数语义不清),而是由 renderer 从已加载的 messages 中
   * 提取图片消息 + 计算热度后传入。这样既复用现有数据,又避免 userMd5/sessionId 混淆。
   */
  async listTopHotImages(
    query: ImageCandidateQuery,
    inputs: ImageCandidateInput[] = []
  ): Promise<ImageCandidate[]> {
    const limit = Math.min(3, Math.max(0, query.limit ?? 3))
    const candidates: ImageCandidate[] = []
    console.log('[ImageInsightService] listTopHotImages received %d inputs', inputs.length)
    for (const input of inputs) {
      const hash = await this.computeImageHash(input.md5, input.datName)
      if (!hash) {
        console.log(
          '[ImageInsightService] skip %s: hash empty (md5=%s datName=%s)',
          input.messageId,
          input.md5,
          input.datName
        )
        continue
      }
      if (!isHotImageCandidate(input)) {
        console.log(
          '[ImageInsightService] skip %s: not hot (responses=%d interactions=%d)',
          input.messageId,
          input.responseCount,
          input.interactionCount
        )
        continue
      }
      const heatScore = calculateImageHeatScore(input)
      const candidate: ImageCandidate = {
        messageId: input.messageId,
        imageHash: hash,
        md5: input.md5,
        datName: input.datName,
        sessionId: input.sessionId,
        sender: input.sender,
        sentAt: input.sentAt,
        heatScore
      }
      const cached = imageInsightsStore.getByHash(hash)
      if (isFreshImageInsight(cached) && cached) candidate.insight = cached
      candidates.push(candidate)
    }
    candidates.sort((a, b) => b.heatScore - a.heatScore)
    return candidates.slice(0, limit)
  }

  /**
   * 列出会话所有 insights(按时间倒序,供未来 UI 复用)
   */
  listBySession(sessionId: string, limit?: number): ImageInsight[] {
    return imageInsightsStore.listBySession(sessionId, limit)
  }
}

export const imageInsightService = new ImageInsightService()
