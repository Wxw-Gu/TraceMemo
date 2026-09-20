import React from 'react'
import { useKnowledgeStatus } from './hooks/useKnowledgeStatus'
import {
  formatBytes,
  formatIndexDate,
  formatKnowledgeProcessed,
  knowledgeIsStale,
  knowledgeStateLabel
} from './searchFormatters'
import {
  IndexStatusBadge,
  type IndexStatusTone
} from '../../features/settings/components/IndexStatusBadge'
import { Button } from '../ui'

interface KnowledgeIndexCardProps {
  dbReady: boolean
  onNotice: (message: string) => void
}

/**
 * 「聊天记录索引」卡片 —— 问问微信背后那份索引。
 *
 * 布局与服务端语义分得很开：
 * - 数据全部来自 `useKnowledgeStatus`（与问问微信页**同一个 hook**，不存在第二套状态源）；
 * - 文案全部来自 `searchFormatters`（那边的词汇表有约束：区分「正在追新」与「正在补齐历史」、
 *   不可查询时吃掉「可用」前缀、禁止笼统的「已同步」）；
 * - 这里只负责**信息层级**：标题 → 状态徽章 → 三个核心数字 → 操作。
 *
 * 状态刻意从标题里拆出来单独做成徽章：混在标题行里时既没有视觉权重差、也扫不到。
 */
export function KnowledgeIndexCard({
  dbReady,
  onNotice
}: KnowledgeIndexCardProps): React.ReactElement {
  const {
    knowledgeStatus,
    knowledgeSyncing,
    syncStarting,
    cancelRequested,
    startKnowledgeSync,
    cancelKnowledgeSync
  } = useKnowledgeStatus({ dbReady, onNotice })

  const indexed = knowledgeStatus?.indexedMessageCount ?? 0
  const usable = indexed > 0 || (knowledgeStatus?.indexedChunkCount ?? 0) > 0
  const stale = knowledgeIsStale(knowledgeStatus)
  const failed = knowledgeStatus?.state === 'error'

  /** 徽章色只用主题 token，不硬编码彩虹色。 */
  const tone: IndexStatusTone = failed
    ? 'error'
    : !usable
      ? 'idle'
      : stale || knowledgeSyncing
        ? 'warn'
        : 'ok'

  const cancellable = knowledgeStatus?.pass?.cancellable === true

  return (
    <section className="local-index-card" aria-label="聊天记录索引状态">
      <header className="local-index-card-head">
        <div className="local-index-card-title">
          <h3>聊天记录索引</h3>
          <p>用于搜索、问问微信和群聊统计</p>
        </div>
        <IndexStatusBadge label={knowledgeStateLabel(knowledgeStatus)} tone={tone} />
      </header>

      {usable ? (
        <div className="local-index-stats">
          <div className="local-index-stat">
            <strong className="local-index-stat-value">{indexed.toLocaleString()}</strong>
            <span className="local-index-stat-label">已收录消息</span>
          </div>
          <div className="local-index-stat">
            <strong className="local-index-stat-value">
              {formatBytes(knowledgeStatus?.databaseBytes ?? 0)}
            </strong>
            <span className="local-index-stat-label">占用空间</span>
          </div>
          <div className="local-index-stat">
            <strong className="local-index-stat-value">
              {knowledgeStatus?.indexLatestAt
                ? formatIndexDate(knowledgeStatus.indexLatestAt)
                : '—'}
            </strong>
            <span className="local-index-stat-label">最后更新</span>
          </div>
        </div>
      ) : (
        <p className="local-index-note">
          还没有建立索引。建立后「问问微信」才能跨会话检索历史消息。
        </p>
      )}

      {failed && knowledgeStatus?.lastError ? (
        <p className="local-index-note is-error">{knowledgeStatus.lastError}</p>
      ) : null}

      {!dbReady ? (
        <p className="local-index-note is-error">请先连接微信数据，然后再建立聊天记录索引。</p>
      ) : null}

      {/* footer：左侧状态说明，右侧操作。按钮不再悬浮在 stats 右下角。 */}
      <div className="local-index-footer">
        <p className="local-index-note">
          {knowledgeSyncing && knowledgeStatus?.pass
            ? formatKnowledgeProcessed(knowledgeStatus)
            : failed
              ? '上次同步没有完成，可以重新同步。'
              : stale
                ? '有较新的聊天记录尚未入索引，点「同步最新记录」追平。'
                : '索引数据仅保存在本机，可随时重新建立。'}
        </p>
        <div className="local-index-actions">
          {knowledgeSyncing && cancellable ? (
            <Button
              size="sm"
              variant="outline"
              disabled={cancelRequested}
              onClick={() => void cancelKnowledgeSync()}
            >
              {cancelRequested ? '正在取消…' : '取消同步'}
            </Button>
          ) : null}
          {/* 用项目 `Button` 而不是自写 `<button>` + 自己的主色样式：
            `hsl(var(--tm-primary))` 在这套主题变量下不生效（实测背景回退成了浏览器默认灰），
            而复用组件同时还省掉了一套与全站不一致的按钮外观。 */}
          <Button
            size="sm"
            disabled={!dbReady || syncStarting || (knowledgeSyncing && !cancellable)}
            onClick={() => void startKnowledgeSync()}
          >
            {knowledgeSyncing ? '同步中…' : usable ? '同步最新记录' : '建立索引'}
          </Button>
        </div>
      </div>
    </section>
  )
}
