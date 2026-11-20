import * as React from 'react'
import type { KnowledgeIndexScope } from '../../../../../shared/knowledge'
import { DEFAULT_KNOWLEDGE_INDEX_SCOPE } from '../../../../../shared/knowledge'
import {
  ConversationMultiSelect,
  summarizeSelection
} from '../../../components/search/ConversationMultiSelect'
import { useConversationOptions } from '../../../components/search/hooks/useConversationOptions'
import { Button } from '../../../components/ui'

interface KnowledgeScopeCardProps {
  dbReady: boolean
  onNotice: (message: string) => void
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const set = new Set(left)
  return right.every((id) => set.has(id))
}

function sameScope(left: KnowledgeIndexScope, right: KnowledgeIndexScope): boolean {
  // `selected` + 空数组是「不索引任何会话」，与 `all` 必须区分开。
  return left.mode === right.mode && sameIds(left.conversationIds, right.conversationIds)
}

/** 长期索引范围，按账号持久化；与「问问微信」的一次性范围是两件事。 */
export function KnowledgeScopeCard({
  dbReady,
  onNotice
}: KnowledgeScopeCardProps): React.ReactElement {
  const { options, loading } = useConversationOptions(true)
  const [saved, setSaved] = React.useState<KnowledgeIndexScope>(DEFAULT_KNOWLEDGE_INDEX_SCOPE)
  const [draft, setDraft] = React.useState<KnowledgeIndexScope>(DEFAULT_KNOWLEDGE_INDEX_SCOPE)
  const [ready, setReady] = React.useState(false)
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    let disposed = false
    // 旧 preload 没有这个通道时退化成「全部会话」，不阻塞页面渲染。
    const request = window.api.getKnowledgeIndexScope?.()
    if (!request) {
      setReady(true)
      return
    }
    void request
      .then((scope) => {
        if (disposed) return
        setSaved(scope)
        setDraft(scope)
      })
      .finally(() => {
        if (!disposed) setReady(true)
      })
    return () => {
      disposed = true
    }
  }, [])

  const dirty = ready && !sameScope(saved, draft)
  const summary = summarizeSelection(options, draft.conversationIds)

  const apply = async (): Promise<void> => {
    setSaving(true)
    try {
      const next = (await window.api.setKnowledgeIndexScope?.(draft)) ?? draft
      setSaved(next)
      setDraft(next)
      onNotice('索引范围已更新')
    } catch {
      onNotice('索引范围保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="local-index-card knowledge-scope-card" aria-label="索引范围">
      <header className="local-index-card-head">
        <div className="local-index-card-title">
          <h3>索引范围</h3>
          <p>决定哪些会话会被自动建立和更新索引</p>
        </div>
      </header>

      <div className="scope-mode-list">
        <label
          className="scope-mode-option"
          data-active={draft.mode === 'all' ? 'true' : undefined}
        >
          <input
            type="radio"
            name="knowledge-scope-mode"
            checked={draft.mode === 'all'}
            disabled={!ready || saving}
            onChange={() => setDraft({ mode: 'all', conversationIds: [] })}
          />
          <span className="scope-mode-text">
            <span className="scope-mode-title">全部会话</span>
            <span className="scope-mode-hint">
              所有聊天记录都会建立索引。会话很多时首次同步会比较久。
            </span>
          </span>
        </label>

        <label
          className="scope-mode-option"
          data-active={draft.mode === 'selected' ? 'true' : undefined}
        >
          <input
            type="radio"
            name="knowledge-scope-mode"
            checked={draft.mode === 'selected'}
            disabled={!ready || saving}
            onChange={() => setDraft({ ...draft, mode: 'selected' })}
          />
          <span className="scope-mode-text">
            <span className="scope-mode-title">仅索引我选择的会话</span>
            <span className="scope-mode-hint">
              只处理勾选的群聊或联系人；未勾选的会话不会被回填，也不会被增量同步。
            </span>
          </span>
        </label>
      </div>

      {draft.mode === 'selected' ? (
        <div className="scope-selection">
          <ConversationMultiSelect
            options={options}
            selectedIds={draft.conversationIds}
            disabled={!ready || saving}
            triggerLabel="选择要建立索引的会话"
            emptyHint={loading ? '正在读取会话列表…' : '没有匹配的会话'}
            onChange={(conversationIds) => setDraft({ mode: 'selected', conversationIds })}
          />
          <p className="scope-selection-summary">
            {summary.conversations === 0
              ? '还没有选择任何会话。这种状态下不会索引任何群聊，也与「全部会话」不同。'
              : `已选 ${summary.conversations} 个会话 · ${
                  summary.unknownCount ? '至少 ' : ''
                }${summary.messages.toLocaleString()} 条消息${
                  summary.unknownCount ? `（${summary.unknownCount} 个会话数量未知）` : ''
                }`}
          </p>
        </div>
      ) : null}

      {!dbReady ? (
        <p className="local-index-note is-error">请先连接微信数据，然后再设置索引范围。</p>
      ) : null}

      <div className="scope-actions">
        <p className="scope-warning">
          {dirty
            ? '应用后，正在进行的同步会先在安全边界停止，再按新范围重新开始。已建立的索引不会被删除。'
            : '已有索引不会被自动清理；要删除请使用缓存清理。'}
        </p>
        <Button size="sm" disabled={!dirty || saving || !dbReady} onClick={() => void apply()}>
          {saving ? '正在应用…' : '应用范围'}
        </Button>
      </div>
    </section>
  )
}
