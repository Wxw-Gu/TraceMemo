import { useCallback, useEffect, useState } from 'react'
import type { CacheSummary, CacheClearScope } from '../../../../../shared/cache'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button
} from '../../../components/ui'

const SEARCH_CACHE_KEYS = [
  'wxe_ai_search_cache_v8',
  'wxe_ai_search_cache_v9',
  'wxe_ai_search_cache_v10',
  'wxe_ai_search_cache_v11',
  'wxe_ai_search_cache_v12',
  'wxe_ai_search_history_v1',
  'wxe_export_tasks'
]

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
  const [busyScope, setBusyScope] = useState<CacheClearScope | 'knowledge-directory' | 'local' | null>(null)
  /** 需要二次确认的清理范围（目前只有图片文字索引）。 */
  const [confirmingScope, setConfirmingScope] = useState<CacheClearScope | null>(null)

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

  const clear = async (scope: CacheClearScope): Promise<void> => {
    setBusyScope(scope)
    try {
      setSummary(await window.api.clearCache(scope))
      if (scope === 'all') {
        for (const key of SEARCH_CACHE_KEYS) localStorage.removeItem(key)
      }
      onNotice(
        scope === 'knowledge'
          ? '已清理所有账号的本地知识库索引，需要时可在问问微信中重新建立'
          : scope === 'image-text-index'
            ? '已清理图片文字索引，微信原始图片与聊天记录未受影响；需要时可在问问微信中重新建立'
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

  /**
   * 清理图片文字索引。两步各司其职，不能省成一步：
   *
   * 1. `clearImageTextIndex()` —— 主进程先停任务、折叠 WAL、关连接、删三件套，
   *    并**回验文件是否真的删掉**（Windows 上文件被占用时 rmSync 会静默失败）。
   * 2. `clearCache('image-text-index')` —— 再扫掉整个派生目录（含其它账号的派生库），
   *    并返回刷新后的占用摘要。
   *
   * 只要第 1 步回验失败，就必须如实报告，不能说"已清理"。
   */
  const clearImageTextIndex = async (): Promise<void> => {
    setBusyScope('image-text-index')
    try {
      const result = await window.api.clearImageTextIndex()
      setSummary(await window.api.clearCache('image-text-index'))
      onNotice(
        result.removed
          ? '已清理图片文字索引；微信原始图片、聊天记录和普通文字知识库都未受影响。需要时可在「问问微信」里重新建立'
          : '图片文字索引的数据文件仍被占用，没能完全删除。请重启 TraceMemo 后再试一次'
      )
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '清理图片文字索引失败')
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
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          刷新占用
        </Button>
      </header>
      <div className="settings-page-scroll">
        <div className="settings-page-content">
          <section className="settings-card cache-overview-card">
            <div>
              <span className="settings-card-kicker">可恢复缓存</span>
              <strong>{formatBytes(summary?.totalBytes || 0)}</strong>
              <small>清理后首次打开档案可能需要重新读取。</small>
            </div>
            <Button
              variant="destructive"
              size="sm"
              disabled={busyScope !== null}
              aria-busy={busyScope === 'all'}
              onClick={() => void clear('all')}
            >
              {busyScope === 'all' ? '清理中...' : '清理全部'}
            </Button>
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
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busyScope !== null}
                      aria-busy={busyScope === 'knowledge-directory'}
                      onClick={() => void openKnowledge()}
                    >
                      {busyScope === 'knowledge-directory' ? '打开中...' : '打开文件夹'}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid={`cache-clear-${item.id}`}
                    disabled={busyScope !== null}
                    aria-busy={busyScope === item.id}
                    onClick={() =>
                      item.id === 'image-text-index'
                        ? setConfirmingScope('image-text-index')
                        : void clear(item.id)
                    }
                  >
                    {busyScope === item.id ? '清理中...' : '清理'}
                  </Button>
                </div>
              </section>
            ))}
            <section className="settings-card settings-cache-item">
              <div>
                <h3>检索与导出记录</h3>
                <p>清理最近提问、检索结果和导出任务列表，不影响聊天数据库。</p>
                <small>浏览器本地缓存</small>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={busyScope !== null}
                aria-busy={busyScope === 'local'}
                onClick={clearLocal}
              >
                {busyScope === 'local' ? '清理中...' : '清理'}
              </Button>
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

      {/* 图片文字索引是「重新建立成本很高」的派生数据，必须二次确认并写清不可逆的范围。 */}
      <AlertDialog
        open={confirmingScope === 'image-text-index'}
        onOpenChange={(open) => setConfirmingScope(open ? 'image-text-index' : null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>清理图片文字索引？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除 TraceMemo 本地生成的图片 OCR 文本和对应搜索索引。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="settings-confirm-detail">
            <p>不会删除：</p>
            <ul>
              <li>微信原始图片</li>
              <li>微信聊天记录</li>
              <li>普通文字知识库</li>
              <li>微信数据库</li>
            </ul>
            <p>清理后，「问问微信」将无法搜索图片中的文字；之后可以重新建立。</p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              data-testid="cache-clear-image-text-index-confirm"
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void clearImageTextIndex()}
            >
              确认清理
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
