import * as React from 'react'
import type { ReportModelChoice } from '../../../../shared/ai-provider'
import { CHATGPT_PLAN_PROVIDER_PREFIX } from '../../../../shared/chatgpt-plan'
import { loadScheduledReportModels, scheduledModelKey } from './model/scheduled-report-models'

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
  DEFAULT_REPORT_IMAGE_POSTFIX_TEXT,
  SCHEDULED_REPORT_MEMBER_NAME_OPTIONS,
  SCHEDULED_REPORT_POSTFIX_MAX_LENGTH,
  SCHEDULED_REPORT_RANGE_OPTIONS,
  SCHEDULED_REPORT_TARGET_OPTIONS,
  SCHEDULED_REPORT_TEMPLATE_SELECT_OPTIONS,
  composeScheduleTime,
  formatScheduledSlot,
  parseScheduleTime,
  resolveGroupDisplayName,
  type ScheduledReportDraft,
  type ScheduledReportTargetType
} from './model/scheduled-report-model'
import { LeaveNotificationTargetPicker } from './LeaveNotificationTargetPicker'

/**
 * ScheduledReportEditor —— 「自动化 → 规则 → 定时日报」的编辑器。
 *
 * 三段：什么时候触发 / 生成什么日报 / 生成后发送到哪里。
 *
 * Section 2 承载完整的日报配置（纳入的消息类型 / 日报内容 / 模型配置 /
 * 日报模板 / 成员名称 / 生成超时），字段全部来自真实模型 —— 不发明，也不删减。
 *
 * 草稿仍然是 renderer local state，但**保存是真的落盘**（父层调 `automation:*`）。
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
  /**
   * 迁移遗留的旧目标原文（只作展示）。
   *
   * 有值时说明这条规则是迁移过来的、当时的目标无法自动对应 ——
   * 界面必须让用户**看见原来的目标是什么**再重选。
   */
  legacyTarget?: string
  /** 微信异常通知的入口（底部一块，与退群通知同一套开关组件）。 */
  notificationSlot?: React.ReactNode
}

export function ScheduledReportEditor({
  initialDraft,
  groups,
  sendableContacts,
  saving,
  onBack,
  onCancel,
  onSave,
  onOpenModelSettings,
  legacyTarget,
  notificationSlot
}: ScheduledReportEditorProps): React.ReactElement {
  const [draft, setDraft] = React.useState<ScheduledReportDraft>(initialDraft)
  const [groupFilter, setGroupFilter] = React.useState('')
  const [models, setModels] = React.useState<ReportModelChoice[]>([])
  const [modelsLoading, setModelsLoading] = React.useState(true)
  const [modelsError, setModelsError] = React.useState('')
  const [defaultModelConfigured, setDefaultModelConfigured] = React.useState(false)
  const [modelsRevision, refreshModels] = React.useReducer((value: number) => value + 1, 0)

  React.useEffect(() => {
    let active = true
    setModelsLoading(true)
    void loadScheduledReportModels()
      .then((result) => {
        if (!active) return
        setModels(result.choices)
        setDefaultModelConfigured(result.defaultConfigured)
        setModelsError(result.error || '')
        setModelsLoading(false)
      })
      .catch(() => {
        if (!active) return
        setModels([])
        setDefaultModelConfigured(false)
        setModelsError('模型加载失败，请检查连接后刷新。')
        setModelsLoading(false)
      })
    return () => {
      active = false
    }
  }, [modelsRevision])

  const patch = (next: Partial<ScheduledReportDraft>): void =>
    setDraft((current) => {
      const changesInput = (
        ['group', 'providerId', 'model', 'reportRange', 'messageTypes', 'memberNameMode'] as const
      ).some((key) => key in next && next[key] !== current[key])
      return { ...current, ...next, ...(changesInput ? { chatgptConsent: false } : {}) }
    })
  const usesSubscription = draft.providerId.startsWith(CHATGPT_PLAN_PROVIDER_PREFIX)
  const selectedModel = models.find(
    (item) => item.providerId === draft.providerId && item.model === draft.model
  )
  const unavailableModel = Boolean(draft.providerId) && !modelsLoading && !selectedModel

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
   * 候选群 = 自动化现有的群列表 **并上** 当前规则已在用的来源群。
   *
   * ⚠️ `value` 一律是**稳定会话 id**（`xxx@chatroom`），不是群名 ——
   * 群名会改，把群名当 id 存下来的规则改一次名就发错群。
   * 迁移过来的老规则里可能仍是群名 / md5，这时作为"额外候选项"补进列表，
   * 界面上用可读名展示，**绝不把裸标识印给用户**。
   */
  const groupOptions = React.useMemo(() => {
    const known = new Set(groups.map((group) => group.id))
    const extras = Array.from(
      new Set([initialDraft.group].filter((value) => Boolean(value) && !known.has(value)))
    ).map((value) => ({ id: value, name: resolveGroupDisplayName(value, groups) }))
    return [...groups, ...extras]
  }, [groups, initialDraft.group])

  const visibleGroups = React.useMemo(() => {
    const needle = groupFilter.trim().toLowerCase()
    if (!needle) return groupOptions
    return groupOptions.filter(
      (group) =>
        group.name.toLowerCase().includes(needle) || group.id.toLowerCase().includes(needle)
    )
  }, [groupOptions, groupFilter])

  /**
   * 保存前置校验。
   *
   * 不允许存一条跑不起来的规则：没有名称 / 没有来源群 / 选了「指定好友」
   * 却没选人，这三种在运行期必然失败，与其让用户过几天在日志里发现，不如现在说清。
   */
  const saveBlocker = !draft.name.trim()
    ? '请填写任务名称'
    : !draft.group
      ? '请选择日报来源群'
      : draft.deliveryMode === 'wechat' && draft.targetType === 'contact' && !draft.targetContactId
        ? '请选择要发送的指定好友'
        : draft.enabled && usesSubscription && !draft.chatgptConsent
          ? '请确认允许此规则定时使用 ChatGPT 订阅处理所选群聊'
          : draft.enabled && modelsLoading
            ? '正在确认所选模型，请稍候'
            : draft.enabled && !draft.providerId && !defaultModelConfigured
              ? '默认 API 模型未配置或暂不可用，请配置模型或选择已连接的 ChatGPT 订阅'
              : draft.enabled && unavailableModel
                ? '所选模型暂不可用，请连接对应账号或重新选择模型'
                : ''

  const selectTargetType = (next: ScheduledReportTargetType): void => {
    // 切换目标类型时清空已选联系人，避免看起来"已经选好了"却发不出去。
    patch({
      targetType: next,
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
          <p>按设定时间自动生成日报，可保存本地或发送到微信。</p>
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
          <Button
            onClick={() => onSave(draft)}
            disabled={saving || Boolean(saveBlocker)}
            title={saveBlocker || undefined}
          >
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </header>

      {saveBlocker ? (
        <p className="automation-notice warning" role="status" data-testid="scheduled-save-blocker">
          {saveBlocker}
        </p>
      ) : null}

      {legacyTarget && draft.deliveryMode === 'wechat' ? (
        <p
          className="automation-notice warning"
          role="status"
          data-testid="scheduled-legacy-target"
        >
          这条规则是升级前创建的，当时的发送目标（{legacyTarget}）无法自动对应到新的选项。
          请重新选择发送目标后再保存。
        </p>
      ) : null}

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
                <small>按本机时区每天执行一次。请保持 TraceMemo 运行、电脑唤醒并连接网络。</small>
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
                onValueChange={(value) => patch({ group: value })}
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
                        <RadioGroupItem value={group.id} id={`scheduled-source-${group.id}`} />
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

            <div className="automation-field">
              <span className="automation-field-label">模型配置</span>
              <Select
                value={scheduledModelKey(draft.providerId, draft.model)}
                onValueChange={(value) => {
                  const choice = models.find(
                    (item) => scheduledModelKey(item.providerId, item.model) === value
                  )
                  patch({ providerId: choice?.providerId ?? '', model: choice?.model ?? '' })
                }}
                disabled={saving || modelsLoading}
              >
                <SelectTrigger aria-label="定时日报模型">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">当前默认 API 模型</SelectItem>
                  {models.map((choice) => (
                    <SelectItem
                      key={scheduledModelKey(choice.providerId, choice.model)}
                      value={scheduledModelKey(choice.providerId, choice.model)}
                    >
                      {choice.providerName} · {choice.modelName}
                    </SelectItem>
                  ))}
                  {draft.providerId && !selectedModel ? (
                    <SelectItem value={scheduledModelKey(draft.providerId, draft.model)} disabled>
                      {usesSubscription ? 'ChatGPT 订阅' : '已保存模型'} · {draft.model || '未选择'}
                      （{modelsLoading ? '加载中' : '暂不可用'}）
                    </SelectItem>
                  ) : null}
                </SelectContent>
              </Select>
              <small>此选择仅用于这条规则。ChatGPT 订阅与 API 用量分别计费。</small>
              <div className="automation-inline-row">
                <Button variant="link" size="sm" disabled={modelsLoading} onClick={refreshModels}>
                  刷新模型
                </Button>
                {onOpenModelSettings ? (
                  <Button variant="link" size="sm" onClick={onOpenModelSettings}>
                    更改模型
                  </Button>
                ) : null}
              </div>
              {modelsError ? <small role="status">{modelsError}</small> : null}
              {usesSubscription ? (
                <label className="automation-leave-radio option">
                  <input
                    type="checkbox"
                    checked={draft.chatgptConsent}
                    onChange={(event) => patch({ chatgptConsent: event.target.checked })}
                    disabled={saving}
                  />
                  <span>
                    允许此规则按设定时间将所选群聊的消息、转录文字和成员名称发送给 OpenAI，使用所选
                    ChatGPT 订阅生成日报。
                  </span>
                </label>
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
              <h3>3 · 生成后如何保存</h3>
            </div>
            <RadioGroup
              value={draft.deliveryMode}
              onValueChange={(value) =>
                patch({ deliveryMode: value as ScheduledReportDraft['deliveryMode'] })
              }
              aria-label="日报保存方式"
              className="automation-leave-targets"
            >
              <div className="automation-leave-radio option">
                <RadioGroupItem value="local_only" id="scheduled-delivery-local" />
                <label htmlFor="scheduled-delivery-local">仅保存本地</label>
              </div>
              <div className="automation-leave-radio option">
                <RadioGroupItem value="wechat" id="scheduled-delivery-wechat" />
                <label htmlFor="scheduled-delivery-wechat">发送到微信</label>
              </div>
            </RadioGroup>
            {draft.deliveryMode === 'local_only' ? (
              <p className="automation-section-lead">
                生成结果保存在「日报」历史中，可查看 HTML 和 PNG。无需微信发送组件。
              </p>
            ) : (
              <>
                <p className="automation-section-lead">
                  生成后保存日报历史，并通过已配置的微信发送能力投递。
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

                {/* 后置词：从「手动发送日报图片」那个输入框原样搬运过来，只是改成按规则存。 */}
                <div className="automation-field">
                  <span className="automation-field-label">发送后置词</span>
                  <Input
                    aria-label="发送后置词"
                    value={draft.postfixText}
                    maxLength={SCHEDULED_REPORT_POSTFIX_MAX_LENGTH}
                    placeholder={DEFAULT_REPORT_IMAGE_POSTFIX_TEXT}
                    disabled={saving}
                    onChange={(event) => patch({ postfixText: event.target.value })}
                  />
                  <small>图片确认发送成功后，会发送一条文本消息；留空则只发图片。</small>
                </div>
              </>
            )}
            <p className="automation-editor-footnote">
              微信数据库和聊天记录从本机读取。所选内容将发送至所选模型服务进行处理，生成的日报会保存在本机。
            </p>
          </section>
        </div>

        <aside className="automation-editor-side">{notificationSlot}</aside>
      </div>
    </div>
  )
}
