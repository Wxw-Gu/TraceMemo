import { useCallback, useEffect, useState } from 'react'
import type { CacheSummary } from '../../../../../shared/cache'

const SEARCH_CACHE_KEYS = ['wxe_ai_search_cache_v8', 'wxe_ai_search_history_v1', 'wxe_export_tasks']

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`
}

export function CacheCleanupPage({
  onNotice
}: {
  onNotice: (message: string) => void
}): React.ReactElement {
  const [summary, setSummary] = useState<CacheSummary | null>(null)
  const [busyScope, setBusyScope] = useState<
    'bootstrap' | 'electron' | 'knowledge' | 'knowledge-directory' | 'all' | 'local' | null
  >(null)

  const refresh = useCallback(async (): Promise<void> => {
    setSummary(await window.api.getCacheSummary())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const clearLocal = (): void => {
    setBusyScope('local')
    for (const key of SEARCH_CACHE_KEYS) localStorage.removeItem(key)
    setBusyScope(null)
    onNotice('已清理检索和导出本地缓存')
  }

  const clear = async (scope: 'bootstrap' | 'electron' | 'knowledge' | 'all'): Promise<void> => {
    setBusyScope(scope)
    try {
      setSummary(await window.api.clearCache(scope))
      if (scope === 'all') {
        for (const key of SEARCH_CACHE_KEYS) localStorage.removeItem(key)
      }
      onNotice(
        scope === 'knowledge'
          ? '已清理所有账号的本地知识库索引，需要时可在问问微信中重新建立'
          : scope === 'all'
            ? '已清理全部可恢复缓存和检索记录'
            : '缓存已清理'
      )
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '清理缓存失败')
    } finally {
      setBusyScope(null)
    }
  }

  const openKnowledge = async (): Promise<void> => {
    setBusyScope('knowledge-directory')
    try {
      const result = await window.api.openKnowledgeDirectory()
      if (!result.success) throw new Error(result.error || '无法打开知识库文件夹')
      onNotice('已打开知识库文件夹')
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '无法打开知识库文件夹')
    } finally {
      setBusyScope(null)
    }
  }

  return (
    <div className="settings-page">
      <header className="settings-page-header">
        <div>
          <h1>缓存与清理</h1>
          <p>管理本地加速数据，不会删除微信原始聊天记录或数据库密钥。</p>
        </div>
        <button type="button" className="settings-header-action" onClick={() => void refresh()}>
          刷新占用
        </button>
      </header>
      <div className="settings-page-scroll">
        <div className="settings-page-content">
          <section className="settings-card cache-overview-card">
            <div>
              <span className="settings-card-kicker">可恢复缓存</span>
              <strong>{formatBytes(summary?.totalBytes || 0)}</strong>
              <small>清理后首次打开档案可能需要重新读取。</small>
            </div>
            <button
              type="button"
              className="settings-danger-button"
              disabled={busyScope !== null}
              onClick={() => void clear('all')}
            >
              {busyScope === 'all' ? '清理中...' : '清理全部'}
            </button>
          </section>

          <h2 className="settings-section-heading">缓存分类</h2>
          <div className="settings-cache-list">
            {summary?.items.map((item) => (
              <section className="settings-card settings-cache-item" key={item.id}>
                <div>
                  <h3>{item.label}</h3>
                  <p>{item.description}</p>
                  <small>
                    {formatBytes(item.sizeBytes)} · {item.fileCount} 个文件
                  </small>
                </div>
                <div className="settings-cache-actions">
                  {item.id === 'knowledge' && (
                    <button
                      type="button"
                      disabled={busyScope !== null}
                      onClick={() => void openKnowledge()}
                    >
                      {busyScope === 'knowledge-directory' ? '打开中...' : '打开文件夹'}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busyScope !== null}
                    onClick={() => void clear(item.id)}
                  >
                    {busyScope === item.id ? '清理中...' : '清理'}
                  </button>
                </div>
              </section>
            ))}
            <section className="settings-card settings-cache-item">
              <div>
                <h3>检索与导出记录</h3>
                <p>清理最近提问、检索结果和导出任务列表，不影响聊天数据库。</p>
                <small>浏览器本地缓存</small>
              </div>
              <button type="button" disabled={busyScope !== null} onClick={clearLocal}>
                {busyScope === 'local' ? '清理中...' : '清理'}
              </button>
            </section>
          </div>

          <div className="settings-inline-note">
            <strong>说明</strong>
            <span>
              缓存没有过期时间，只有在这里手动清理，或应用检测到格式需要迁移时才会被替换。
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
