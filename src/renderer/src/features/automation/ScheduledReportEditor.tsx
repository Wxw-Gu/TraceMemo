import * as React from 'react'

import {
  Button,
  Input,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch
} from '../../components/ui'
import { MessageTypeSelector } from '../../components/reports/MessageTypeSelector'
import {
  SCHEDULED_REPORT_MEMBER_NAME_OPTIONS,
  SCHEDULED_REPORT_RANGE_OPTIONS,
  SCHEDULED_REPORT_TARGET_OPTIONS,
  SCHEDULED_REPORT_TEMPLATE_SELECT_OPTIONS,
  composeScheduleTime,
  formatScheduledSlot,
  parseScheduleTime,
  resolveGroupDisplayName,
  type ScheduledReportDraft,
  type ScheduledReportTargetType
} from './model/scheduled-report-preview'
import { LeaveNotificationTargetPicker } from './LeaveNotificationTargetPicker'
import { ScheduledReportPreview } from './ScheduledReportPreview'

/**
 * ScheduledReportEditor —— 「自动化 → 规则 → 定时日报」的编辑器。
 *
 * 三段：什么时候触发 / 生成什么日报 / 生成后发送到哪里。
 *
 * Section 2 承载完整的日报配置（纳入的消息类型 / 日报内容 / 模型配置 /
 * 日报模板 / 成员名称 / 生成超时），字段全部来自真实模型 —— 不发明，也不删减。
 *
 * 草稿只存在 renderer local state，保存不落盘（由父层提示）。
 */

export interface ScheduledReportEditorProps {
  initialDraft: ScheduledReportDraft
  /** 可选群聊（自动化既有的群列表，与其它规则类型同一来源）。 */
  groups: Array<{ id: string; name: string }>
  /** 「指定好友」的候选项（与退群通知共用同一个来源与组件）。 */
  sendableContacts: Array<{ id: string; name: string }>
  saving: boolean
  /** 返回「定时日报」规则列表（**不是**退回自动化首页）。 */
  onBack: () => void
  onCancel: () => void
  onSave: (draft: ScheduledReportDraft) => void
  /** 复用现有的模型配置入口。 */
  onOpenModelSettings?: () => void
}

export function ScheduledReportEditor({
  initialDraft,
  groups,
  sendableContacts,
  saving,
  onBack,
  onCancel,
  onSave,
  onOpenModelSettings
}: ScheduledReportEditorProps): React.ReactElement {
  const [draft, setDraft] = React.useState<ScheduledReportDraft>(initialDraft)
  const [groupFilter, setGroupFilter] = React.useState('')

  const patch = (next: Partial<ScheduledReportDraft>): void =>
    setDraft((current) => ({ ...current, ...next }))

  /*
   * 时间的两个输入框保留**本地文本态**。
   * 受控回写会在输入过程中把中间态规范化掉，用户就永远拼不出想要的数字；
   * 规范化推迟到失焦。
   */
  const [hourText, setHourText] = React.useState(() =>
    String(parseScheduleTime(initialDraft.scheduleTime)[0]).padStart(2, '0')
  )
  const [minuteText, setMinuteText] = React.useState(() =>
    String(parseScheduleTime(initialDraft.scheduleTime)[1]).padStart(2, '0')
  )

  const commitHour = (raw: string): void => {
    const digits = raw.replace(/\D/g, '').slice(0, 2)
    setHourText(digits)
    if (digits === '') return
    const value = Number(digits)
    if (Number.isNaN(value)) return
    patch({ scheduleTime: composeScheduleTime(value, parseScheduleTime(draft.scheduleTime)[1]) })
  }

  const commitMinute = (raw: string): void => {
    const digits = raw.replace(/\D/g, '').slice(0, 2)
    setMinuteText(digits)
    if (digits === '') return
    const value = Number(digits)
    if (Number.isNaN(value)) return
    patch({ scheduleTime: composeScheduleTime(parseScheduleTime(draft.scheduleTime)[0], value) })
  }

  /*
   * 候选群 = 自动化现有的群列表 **并上** 当前任务已在用的来源群。
   *
   * 任务里存的群标识与群列表是两个数据源，不保证一致；不并的话，
   * 编辑已有任务会出现"当前来源群在列表里找不到、于是没有任何一项被选中"。
   */
  const groupOptions = React.useMemo(() => {
    const known = new Set(groups.map((group) => group.name))
    // 去重：不去重会生成两条同 id 的候选项，React 重复 key 会让渲染错乱。
    const extras = Array.from(
      new Set(
        [initialDraft.group, initialDraft.target].filter(
          (value) => Boolean(value) && !known.has(value)
        )
      )
    ).map((value) => ({ id: `current:${value}`, name: value }))
    return [...groups, ...extras]
  }, [groups, initialDraft.group, initialDraft.target])

  const visibleGroups = React.useMemo(() => {
    const needle = groupFilter.trim().toLowerCase()
    if (!needle) return groupOptions
    return groupOptions.filter(
      (group) =>
        group.name.toLowerCase().includes(needle) || group.id.toLowerCase().includes(needle)
    )
  }, [groupOptions, groupFilter])

  const selectedContactName =
    sendableContacts.find((contact) => contact.id === draft.targetContactId)?.name ?? ''

  const selectTargetType = (next: ScheduledReportTargetType): void => {
    // 「发送到日报来源群」的目标跟随来源群；其余目标清空，避免看起来已经选好了。
    patch({
      targetType: next,
      target: next === 'source_chat' ? draft.group : '',
      targetContactId: next === 'contact' ? draft.targetContactId : ''
    })
  }

  return (
    <div className="automation-editor">
      <button type="button" className="automation-editor-back" onClick={onBack}>
        ← 返回定时日报
      </button>

      <header className="automation-editor-header">
        <div>
          <h2>{draft.name.trim() || '新建定时日报'}</h2>
          <p>按设定时间自动生成日报，并发送到指定微信会话。</p>
          <div className="automation-leave-status-row">
            <span className="automation-field-label">启用这条自动化</span>
            <Switch
              checked={draft.enabled}
              onCheckedChange={(checked) => patch({ enabled: checked })}
              aria-label="启用这条自动化"
            />
          </div>
        </div>
        <div className="automation-editor-actions">
          <Button variant="ghost" onClick={onCancel} disabled={saving}>
            取消
          </Button>
          <Button onClick={() => onSave(draft)} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </header>

      <div className="automation-editor-body">
        <div className="automation-editor-form">
          <section className="automation-section">
            <div className="automation-section-heading">
              <h3>1 · 什么时候触发</h3>
            </div>

            <div className="automation-inline-row">
              <div>
                <span className="automation-field-label">执行频率</span>
                <span className="automation-static-value">每天</span>
                <small>当前定时日报只支持每天执行一次。</small>
              </div>
            </div>

            <div className="automation-inline-row">
              <div>
                <span className="automation-field-label">执行时间</span>
                <div className="automation-scheduled-time">
                  <Input
                    aria-label="执行时间小时"
                    inputMode="numeric"
                    value={hourText}
                    onChange={(event) => commitHour(event.target.value)}
                    onBlur={() =>
                      setHourText(String(parseScheduleTime(draft.scheduleTime)[0]).padStart(2, '0'))
                    }
                  />
                  <span aria-hidden="true">:</span>
                  <Input
                    aria-label="执行时间分钟"
                    inputMode="numeric"
                    value={minuteText}
                    onChange={(event) => commitMinute(event.target.value)}
                    onBlur={() =>
                      setMinuteText(
                        String(parseScheduleTime(draft.scheduleTime)[1]).padStart(2, '0')
                      )
                    }
                  />
                </div>
              </div>
            </div>

            <div className="automation-inline-row">
              <div>
                <span className="automation-field-label">预计下次执行</span>
                <span className="automation-static-value" data-testid="scheduled-next-run">
                  {formatScheduledSlot(draft.scheduleTime)}
                </span>
              </div>
            </div>
          </section>

          {/* ---------- 2 · 完整日报配置（与旧「定时日报」对齐，一项不删）---------- */}
          <section className="automation-section">
            <div className="automation-section-heading">
              <h3>2 · 生成什么日报</h3>
            </div>

            <div className="automation-field">
              <span className="automation-field-label">任务名称</span>
              <Input
                aria-label="定时日报任务名称"
                value={draft.name}
                placeholder="例如：TraceMemo 每日晚报"
                onChange={(event) => patch({ name: event.target.value })}
              />
            </div>

            <div className="automation-field">
              <span className="automation-field-label">日报来源</span>
              <small>生成哪个群的日报。</small>
              <RadioGroup
                value={draft.group}
                onValueChange={(value) =>
                  patch({
                    group: value,
                    target: draft.targetType === 'source_chat' ? value : draft.target
                  })
                }
                aria-label="日报来源"
                className="automation-leave-contact-picker"
              >
                <Input
                  value={groupFilter}
                  onChange={(event) => setGroupFilter(event.target.value)}
                  placeholder="搜索群聊"
                  aria-label="搜索群聊"
                />
                <div className="automation-leave-contact-list">
                  {visibleGroups.length === 0 ? (
                    <p className="automation-group-empty">没有可选的群聊</p>
                  ) : (
                    visibleGroups.map((group) => (
                      <div key={group.id} className="automation-leave-radio option">
                        <RadioGroupItem value={group.name} id={`scheduled-source-${group.id}`} />
                        <label htmlFor={`scheduled-source-${group.id}`}>{group.name}</label>
                      </div>
                    ))
                  )}
                </div>
              </RadioGroup>
            </div>

            <div className="automation-field">
              <span className="automation-field-label">日报范围</span>
              <Select
                value={draft.reportRange}
                onValueChange={(value) =>
                  patch({ reportRange: value as ScheduledReportDraft['reportRange'] })
                }
              >
                <SelectTrigger aria-label="日报范围">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCHEDULED_REPORT_RANGE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* 复用旧日报页的 MessageTypeSelector：类型 / 说明 /「至少选择一种」都来自真实定义。 */}
            <MessageTypeSelector
              value={draft.messageTypes}
              disabled={saving}
              onChange={(next) => patch({ messageTypes: next })}
            />

            <div className="automation-field">
              <span className="automation-field-label">日报内容</span>
              <small>
                与普通日报相同，固定生成今日话题、重要消息、问题与解答、实用资源、精彩对话、
                活跃成员、活跃时间分布、关键词和内容密度。
              </small>
            </div>

            <div className="automation-inline-row automation-model-row">
              <div>
                <span className="automation-field-label">模型配置</span>
                <small>使用当前日报默认的文字总结和图片理解模型。</small>
              </div>
              {onOpenModelSettings ? (
                <Button variant="link" size="sm" onClick={onOpenModelSettings}>
                  更改模型
                </Button>
              ) : null}
            </div>

            <div className="automation-field">
              <span className="automation-field-label">日报模板</span>
              <Select
                value={draft.templateId}
                onValueChange={(value) =>
                  patch({ templateId: value as ScheduledReportDraft['templateId'] })
                }
              >
                <SelectTrigger aria-label="日报模板">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCHEDULED_REPORT_TEMPLATE_SELECT_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="automation-field">
              <span className="automation-field-label">成员名称</span>
              <Select
                value={draft.memberNameMode}
                onValueChange={(value) =>
                  patch({ memberNameMode: value as ScheduledReportDraft['memberNameMode'] })
                }
              >
                <SelectTrigger aria-label="成员名称">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCHEDULED_REPORT_MEMBER_NAME_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="automation-field">
              <span className="automation-field-label">日报生成超时</span>
              <div className="automation-scheduled-timeout">
                <Input
                  aria-label="日报生成超时"
                  inputMode="numeric"
                  value={String(draft.timeoutSeconds)}
                  onChange={(event) => {
                    const next = Number(event.target.value.replace(/\D/g, '').slice(0, 4))
                    patch({ timeoutSeconds: Number.isNaN(next) ? draft.timeoutSeconds : next })
                  }}
                />
                <span>秒</span>
              </div>
            </div>
          </section>

          {/* ---------- 3 · 发送目标四选一（不提供"指定其他群聊"）---------- */}
          <section className="automation-section">
            <div className="automation-section-heading">
              <h3>3 · 生成后发送到哪里</h3>
            </div>
            <p className="automation-section-lead">
              生成哪个群的日报，与把日报发到哪里，是两件事。
            </p>

            <RadioGroup
              value={draft.targetType}
              onValueChange={(value) => selectTargetType(value as ScheduledReportTargetType)}
              aria-label="生成后发送到哪里"
              className="automation-leave-targets"
            >
              {SCHEDULED_REPORT_TARGET_OPTIONS.map((option) => (
                <div key={option.type} className="automation-leave-radio option">
                  <RadioGroupItem value={option.type} id={`scheduled-target-${option.type}`} />
                  <div className="automation-leave-radio-body">
                    <label htmlFor={`scheduled-target-${option.type}`}>{option.label}</label>
                    <small>{option.description}</small>
                  </div>
                </div>
              ))}
            </RadioGroup>

            {draft.targetType === 'contact' ? (
              <div className="automation-field">
                <span className="automation-field-label">指定好友</span>
                <LeaveNotificationTargetPicker
                  contacts={sendableContacts}
                  selectedId={draft.targetContactId}
                  onSelect={(id) => patch({ targetContactId: id })}
                  ariaLabel="指定好友"
                  searchPlaceholder="搜索好友"
                  emptyText="没有可发送的联系人"
                />
              </div>
            ) : null}

            <p className="automation-editor-footnote">
              微信数据库和聊天记录默认从本机读取。所选内容将发送至你配置的模型服务进行处理，
              TraceMemo 本身不额外保存或转发内容。
            </p>
          </section>
        </div>

        <ScheduledReportPreview
          draft={draft}
          groupLabel={resolveGroupDisplayName(draft.group, groups)}
          contactName={selectedContactName}
        />
      </div>
    </div>
  )
}
