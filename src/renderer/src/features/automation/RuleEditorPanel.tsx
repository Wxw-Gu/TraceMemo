import * as React from 'react'
import {
  DEFAULT_REPLY_TEXT,
  KEYWORD_MATCH_MODE_LABELS,
  createDefaultDailyReportRule,
  normalizeRuleDraft,
  type AutomationActionType,
  type AutomationRule,
  type AutomationRuleDraft,
  type KeywordMatchMode
} from '../../../../shared/automation'
import { Button, Input, SegmentedControl, SegmentedControlItem, Switch } from '../../components/ui'
import { EffectPreview } from './EffectPreview'
import type { AutomationGroupOption } from './model/api'

/**
 * RuleEditorPanel —— 规则编辑页（对应 Stitch 设计稿 1）。
 *
 * 结构固定五段：什么时候触发 → 在哪些聊天生效 → 触发后执行 → 高级设置 → 效果预览。
 *
 * 刻意**不出现**工程词：没有 dedup / idempotency / watermark / regex，
 * 用户看到的只有「同一消息只执行一次」这类人话。
 */

const KEYWORD_MODES: KeywordMatchMode[] = ['contains', 'exact', 'prefix']

const ACTION_META: Array<{
  type: AutomationActionType
  title: string
  description: string
}> = [
  {
    type: 'replyText',
    title: '回复确认',
    description: '先在群里回一句，告诉对方已经收到'
  },
  {
    type: 'generateReport',
    title: '生成日报',
    description: '用当前群的今日消息生成日报'
  },
  {
    type: 'sendReportImage',
    title: '发送日报图片',
    description: '把生成的日报图片发回触发消息所在的群'
  }
]

function draftFromRule(rule: AutomationRule | null): AutomationRuleDraft {
  const base = rule ?? createDefaultDailyReportRule(Date.now())
  return normalizeRuleDraft({
    name: base.name,
    enabled: base.enabled,
    scope: base.scope,
    conditions: base.conditions,
    actions: base.actions,
    cooldownSeconds: base.cooldownSeconds
  })
}

export interface RuleEditorPanelProps {
  mode: 'create' | 'edit'
  rule: AutomationRule | null
  groups: AutomationGroupOption[]
  saving: boolean
  onCancel: () => void
  onSave: (draft: AutomationRuleDraft) => void
}

export function RuleEditorPanel({
  mode,
  rule,
  groups,
  saving,
  onCancel,
  onSave
}: RuleEditorPanelProps): React.ReactElement {
  const [draft, setDraft] = React.useState<AutomationRuleDraft>(() => draftFromRule(rule))
  const [groupFilter, setGroupFilter] = React.useState('')
  const [validationError, setValidationError] = React.useState('')

  // 切换编辑对象时重建草稿，避免把上一条规则的修改带过去。
  React.useEffect(() => {
    setDraft(draftFromRule(rule))
    setValidationError('')
  }, [rule])

  const patchConditions = (patch: Partial<AutomationRuleDraft['conditions']>): void => {
    setDraft((current) => ({ ...current, conditions: { ...current.conditions, ...patch } }))
  }

  const patchAction = (type: AutomationActionType, patch: { enabled?: boolean; text?: string }): void => {
    setDraft((current) => ({
      ...current,
      actions: current.actions.map((action) =>
        action.type === type ? { ...action, ...patch } : action
      )
    }))
  }

  const actionOf = (type: AutomationActionType): { enabled: boolean; text?: string } =>
    draft.actions.find((action) => action.type === type) ?? { enabled: false }

  const toggleGroup = (id: string): void => {
    setDraft((current) => {
      const selected = new Set(current.conditions.conversationIds)
      if (selected.has(id)) selected.delete(id)
      else selected.add(id)
      return {
        ...current,
        conditions: { ...current.conditions, conversationIds: Array.from(selected) }
      }
    })
  }

  const visibleGroups = React.useMemo(() => {
    const needle = groupFilter.trim().toLowerCase()
    if (!needle) return groups
    return groups.filter(
      (group) =>
        group.name.toLowerCase().includes(needle) || group.id.toLowerCase().includes(needle)
    )
  }, [groups, groupFilter])

  const handleSave = (): void => {
    if (!draft.name.trim()) {
      setValidationError('请填写自动化名称')
      return
    }
    if (!draft.actions.some((action) => action.enabled)) {
      setValidationError('至少要启用一个执行动作，否则规则命中后什么也不会发生')
      return
    }
    setValidationError('')
    onSave(draft)
  }

  return (
    <div className="automation-editor">
      <header className="automation-editor-header">
        <div>
          <h2>{mode === 'create' ? '新建自动化' : '编辑自动化'}</h2>
          <p>命中条件后，TraceMemo 会按下面的顺序依次执行。</p>
        </div>
        <div className="automation-editor-actions">
          <Button variant="ghost" onClick={onCancel} disabled={saving}>
            取消
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </header>

      {validationError ? <p className="automation-form-error">{validationError}</p> : null}

      <div className="automation-editor-body">
        <div className="automation-editor-form">
          <section className="automation-section">
            <div className="automation-section-heading">
              <h3>1 · 什么时候触发</h3>
            </div>
            <div className="automation-field">
              <label htmlFor="automation-name">名称</label>
              <Input
                id="automation-name"
                value={draft.name}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, name: event.target.value }))
                }
                placeholder="给这条自动化起个名字"
              />
            </div>
            <div className="automation-inline-row">
              <span className="automation-field-label">触发方式</span>
              <span className="automation-static-value">收到消息</span>
            </div>
            <div className="automation-switch-row">
              <div>
                <span className="automation-field-label">必须真正 @我</span>
                <small>根据微信底层 @ 元数据判断，不依赖普通昵称纯文本</small>
              </div>
              <Switch
                checked={draft.conditions.requireMentionMe}
                onCheckedChange={(checked) => patchConditions({ requireMentionMe: checked })}
              />
            </div>
            <div className="automation-switch-row">
              <div>
                <span className="automation-field-label">启用这条自动化</span>
                <small>关闭后规则会保留，但不会触发</small>
              </div>
              <Switch
                checked={draft.enabled}
                onCheckedChange={(checked) =>
                  setDraft((current) => ({ ...current, enabled: checked }))
                }
              />
            </div>
            <div className="automation-field">
              <label htmlFor="automation-keyword">关键词</label>
              <Input
                id="automation-keyword"
                value={draft.conditions.keyword}
                onChange={(event) => patchConditions({ keyword: event.target.value })}
                placeholder="例如：日报（留空表示不限关键词）"
              />
            </div>
            <div className="automation-field">
              <span className="automation-field-label">匹配方式</span>
              <SegmentedControl
                value={draft.conditions.keywordMatchMode}
                onValueChange={(value) =>
                  patchConditions({ keywordMatchMode: value as KeywordMatchMode })
                }
                aria-label="关键词匹配方式"
              >
                {KEYWORD_MODES.map((mode) => (
                  <SegmentedControlItem key={mode} value={mode}>
                    {KEYWORD_MATCH_MODE_LABELS[mode]}
                  </SegmentedControlItem>
                ))}
              </SegmentedControl>
            </div>
          </section>

          <section className="automation-section">
            <div className="automation-section-heading">
              <h3>2 · 在哪些聊天生效</h3>
              <span className="automation-section-note">
                {draft.conditions.conversationIds.length
                  ? `已选 ${draft.conditions.conversationIds.length} 个群`
                  : '未选择时对所有群聊生效'}
              </span>
            </div>
            <Input
              value={groupFilter}
              onChange={(event) => setGroupFilter(event.target.value)}
              placeholder="搜索群聊"
              aria-label="搜索群聊"
            />
            <div className="automation-group-list" role="group" aria-label="生效群聊">
              {groups.length === 0 ? (
                <p className="automation-group-empty">
                  还没有读取到群聊。请先在「档案」中连接并解锁微信数据库。
                </p>
              ) : visibleGroups.length === 0 ? (
                <p className="automation-group-empty">没有匹配「{groupFilter}」的群聊</p>
              ) : (
                visibleGroups.map((group) => {
                  const checked = draft.conditions.conversationIds.includes(group.id)
                  return (
                    <label
                      key={group.id}
                      className={`automation-group-option ${checked ? 'selected' : ''}`}
                    >
                      <input type="checkbox" checked={checked} onChange={() => toggleGroup(group.id)} />
                      <span>{group.name}</span>
                    </label>
                  )
                })
              )}
            </div>
          </section>

          <section className="automation-section">
            <div className="automation-section-heading">
              <h3>3 · 触发后执行</h3>
              <span className="automation-section-note">按下列顺序执行</span>
            </div>
            {ACTION_META.map((meta) => {
              const action = actionOf(meta.type)
              return (
                <div key={meta.type} className="automation-action-row">
                  <div className="automation-action-main">
                    <div className="automation-switch-row compact">
                      <div>
                        <span className="automation-field-label">{meta.title}</span>
                        <small>{meta.description}</small>
                      </div>
                      <Switch
                        checked={action.enabled}
                        onCheckedChange={(checked) => patchAction(meta.type, { enabled: checked })}
                      />
                    </div>
                    {meta.type === 'replyText' && action.enabled ? (
                      <Input
                        value={action.text ?? ''}
                        onChange={(event) => patchAction(meta.type, { text: event.target.value })}
                        placeholder={DEFAULT_REPLY_TEXT}
                        aria-label="回复内容"
                      />
                    ) : null}
                  </div>
                </div>
              )
            })}
          </section>

          <section className="automation-section">
            <div className="automation-section-heading">
              <h3>4 · 高级设置</h3>
            </div>
            <div className="automation-inline-row">
              <div>
                <span className="automation-field-label">触发间隔（秒）</span>
                <small>同一个群里，两次触发之间至少间隔这么久，避免刷屏</small>
              </div>
              <Input
                type="number"
                min={0}
                value={String(draft.cooldownSeconds)}
                onChange={(event) => {
                  const next = Number(event.target.value)
                  setDraft((current) => ({
                    ...current,
                    cooldownSeconds: Number.isFinite(next) ? Math.max(0, Math.floor(next)) : 0
                  }))
                }}
                className="automation-number-input"
                aria-label="触发间隔秒数"
              />
            </div>
            <div className="automation-switch-row">
              <div>
                <span className="automation-field-label">忽略自己发送的消息</span>
                <small>
                  {draft.conditions.ignoreSelf
                    ? '推荐保持开启，可避免自动回复被再次触发'
                    : '关闭后可能形成自动回复循环，请确认你知道后果'}
                </small>
              </div>
              <Switch
                checked={draft.conditions.ignoreSelf}
                onCheckedChange={(checked) => patchConditions({ ignoreSelf: checked })}
              />
            </div>
            <p className="automation-static-note">同一消息只执行一次。</p>
          </section>
        </div>

        <EffectPreview draft={draft} />
      </div>
    </div>
  )
}
