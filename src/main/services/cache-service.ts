import { app, session, shell } from 'electron'
import fs from 'fs-extra'
import path from 'path'
import { clearBootstrapCache } from './bootstrap-cache'
import type { CacheClearScope, CacheSummary, CacheSummaryItem } from '../../shared/cache'

export type { CacheClearScope } from '../../shared/cache'

const BOOTSTRAP_CACHE_DIR = path.join(app.getPath('userData'), 'cache', 'bootstrap')
const KNOWLEDGE_CACHE_DIR = path.join(app.getPath('userData'), 'knowledge')
const IMAGE_TEXT_INDEX_CACHE_DIR = path.join(app.getPath('userData'), 'image-text-index')

export interface CacheClearOptions {
  beforeClearKnowledge?: () => Promise<void>
  /** 清理图片文字索引前调用：停任务 + 关闭派生库句柄。 */
  beforeClearImageTextIndex?: () => Promise<void>
}

function inspectDirectory(directory: string): { sizeBytes: number; fileCount: number } {
  if (!fs.existsSync(directory)) return { sizeBytes: 0, fileCount: 0 }
  let sizeBytes = 0
  let fileCount = 0
  const visit = (current: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) {
        visit(target)
      } else if (entry.isFile()) {
        try {
          sizeBytes += fs.statSync(target).size
          fileCount += 1
        } catch {
          // A cache file can disappear while it is being inspected.
        }
      }
    }
  }
  visit(directory)
  return { sizeBytes, fileCount }
}

export function getCacheSummary(): CacheSummary {
  const bootstrap = inspectDirectory(BOOTSTRAP_CACHE_DIR)
  const electron = inspectDirectory(path.join(app.getPath('userData'), 'Cache'))
  const knowledge = inspectDirectory(KNOWLEDGE_CACHE_DIR)
  const imageTextIndex = inspectDirectory(IMAGE_TEXT_INDEX_CACHE_DIR)
  const items: CacheSummaryItem[] = [
    {
      id: 'bootstrap',
      label: '启动与聊天缓存',
      description: '联系人、头像、群成员和最近聊天记录的本地副本。',
      ...bootstrap
    },
    {
      id: 'electron',
      label: '应用临时缓存',
      description: 'Electron 页面资源缓存，清理后会自动重新生成。',
      ...electron
    },
    {
      id: 'knowledge',
      label: '本地知识库索引',
      description:
        '为问问微信建立的所有账号本地检索索引。清理后需手动重新建立，不影响微信原始数据。',
      ...knowledge
    },
    {
      id: 'image-text-index',
      label: '图片文字索引',
      description:
        '本机从微信图片里识别出的文字及其检索索引。清理后无法搜索图片中的文字，可重新建立；不影响微信原始图片与聊天记录。',
      ...imageTextIndex
    }
  ]
  return {
    items,
    totalBytes: items.reduce((total, item) => total + item.sizeBytes, 0),
    updatedAt: Date.now()
  }
}

export async function clearCache(
  scope: CacheClearScope,
  options: CacheClearOptions = {}
): Promise<CacheSummary> {
  if (scope === 'bootstrap' || scope === 'all') {
    clearBootstrapCache()
    await fs.remove(BOOTSTRAP_CACHE_DIR)
  }
  if (scope === 'electron' || scope === 'all') {
    await session.defaultSession.clearCache()
  }
  if (scope === 'knowledge' || scope === 'all') {
    await options.beforeClearKnowledge?.()
    await fs.remove(KNOWLEDGE_CACHE_DIR)
  }
  if (scope === 'image-text-index' || scope === 'all') {
    // 先停下任务再删库，避免"边写边删"。
    await options.beforeClearImageTextIndex?.()
    await fs.remove(IMAGE_TEXT_INDEX_CACHE_DIR)
  }
  return getCacheSummary()
}

export async function openKnowledgeDirectory(): Promise<{ success: boolean; error?: string }> {
  try {
    await fs.ensureDir(KNOWLEDGE_CACHE_DIR)
    const error = await shell.openPath(KNOWLEDGE_CACHE_DIR)
    return error ? { success: false, error } : { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
