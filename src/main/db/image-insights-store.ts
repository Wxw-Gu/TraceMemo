// src/main/db/image-insights-store.ts
// 持久化 ImageInsight 到 JSON 文件(userData/image-insights.json)
// 跟项目现有风格一致(ai-provider-service 用 ai-providers.json)

import { app } from 'electron'
import fs from 'fs-extra'
import path from 'path'
import type { ImageInsight } from '../../shared/image-insight'

interface ImageInsightsFile {
  version: 1
  /** imageHash -> ImageInsight 索引(缓存查询 O(1)) */
  byHash: Record<string, ImageInsight>
  /** messageId -> imageHash 反向索引(防止同一 message 重复入库) */
  byMessageId: Record<string, string>
}

const EMPTY_FILE: ImageInsightsFile = {
  version: 1,
  byHash: {},
  byMessageId: {}
}

class ImageInsightsStore {
  private cache: ImageInsightsFile | null = null

  private get filePath(): string {
    return path.join(app.getPath('userData'), 'image-insights.json')
  }

  private ensureLoaded(): ImageInsightsFile {
    if (this.cache) return this.cache
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readJsonSync(this.filePath) as Partial<ImageInsightsFile>
        this.cache = {
          version: 1,
          byHash: raw.byHash || {},
          byMessageId: raw.byMessageId || {}
        }
        return this.cache
      }
    } catch (error) {
      console.warn('[ImageInsightsStore] failed to load, fallback to empty:', error)
    }
    this.cache = { ...EMPTY_FILE }
    return this.cache
  }

  private persist(): void {
    if (!this.cache) return
    try {
      fs.ensureDirSync(path.dirname(this.filePath))
      fs.writeJsonSync(this.filePath, this.cache, { spaces: 2 })
    } catch (error) {
      console.error('[ImageInsightsStore] failed to persist:', error)
    }
  }

  /** 通过 imageHash 查询缓存 */
  getByHash(imageHash: string): ImageInsight | null {
    return this.ensureLoaded().byHash[imageHash] || null
  }

  /** 列出某会话的所有 insights(按时间倒序) */
  listBySession(sessionId: string, limit?: number): ImageInsight[] {
    const data = this.ensureLoaded()
    const items = Object.values(data.byHash)
      .filter((it) => it.sessionId === sessionId)
      .sort((a, b) => b.sentAt - a.sentAt)
    return typeof limit === 'number' ? items.slice(0, limit) : items
  }

  /**
   * 写入或更新 Insight。
   * - 同 imageHash 已存在:更新 description/ocrText/tags/category/importance/provider/model/updatedAt(保留 createdAt)
   * - 新 hash:插入
   * 同步维护 byMessageId 反向索引。
   */
  upsert(insight: ImageInsight): void {
    const data = this.ensureLoaded()
    const existing = data.byHash[insight.imageHash]
    const now = Date.now()
    if (existing) {
      data.byHash[insight.imageHash] = {
        ...existing,
        ...insight,
        id: existing.id, // 保留 id
        createdAt: existing.createdAt, // 保留首次分析时间
        updatedAt: now
      }
    } else {
      data.byHash[insight.imageHash] = { ...insight, createdAt: now, updatedAt: now }
      data.byMessageId[insight.messageId] = insight.imageHash
    }
    this.persist()
  }

}

export const imageInsightsStore = new ImageInsightsStore()
