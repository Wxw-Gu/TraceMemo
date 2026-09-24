import * as React from 'react'
import { Button, RadioGroup, RadioGroupItem, Switch } from '../../components/ui'
import {
  LEAVE_NOTIFICATION_TARGET_OPTIONS,
  createDefaultLeaveNotificationRule,
  type AutomationRule,
  type LeaveNotificationConfig,
  type LeaveNotificationTargetType
} from '../../../../shared/automation'
import { insertGroupNamePlaceholder } from '../../../../shared/group-exit-monitor'
import { LeaveNotificationPreview } from './LeaveNotificationPreview'
import {
  LeaveNotificationTargetPicker,
  type LeaveNotificationContactOption
} from './LeaveNotificationTargetPicker'
import { LeaveNotificationTemplateEditor } from './LeaveNotificationTemplateEditor'

/**
 * LeaveNotificationEditor —— 「自动化 → 规则 → 退群通知」。
 *
 * 这是**真实配置页**：保存会落盘成一条 singleton 规则（`builtin-leave-notification`），
 * 由 `AutomationService.handleGroupExit` 在退群事件到来时执行。
 *
 * 职责边界在 UI 上一眼可见：
 *   退群监控 = 监测哪些群有人退出（**范围完全由它管**）；自动化 = 检测到之后发到哪。
 * 所以这里**没有**「触发范围」二次筛选，规则级启停也**只有**顶部一处。
 */

export interface LeaveNotificationSaveInput {
  enabled: boolean
  config: LeaveNotificationConfig
}

export interface LeaveNotificationEditorProps {
  /** 已持久化的退群通知规则（singleton，永远存在）。 */
  rule: AutomationRule
  /** 「指定好友」的可选项（main 侧已过滤，只含可发送的个人联系人）。 */
  contacts: LeaveNotificationContactOption[]
  /** 真实已监控群聊数量（来自退群监控，自动化不维护副本）。 */
  monitoredCount: number
  saving: boolean
  /** 发送能力不完整时的一句话提示；为 undefined 表示能力正常。 */
  sendCapabilityWarning?: string
  /** 「管理监控群聊 →」—— 跳退群监控的管理群聊页，纯导航。 */
  onOpenMonitoredGroups?: () => void
  onCancel: () => void
  onSave: (input: LeaveNotificationSaveInput) => void
}

function initialConfig(rule: AutomationRule): LeaveNotificationConfig {
  return (
    rule.leaveNotification ??
    createDefaultLeaveNotificationRule(Date.now()).leaveNotification ?? {
      target: { type: 'file_transfer' },
      template: ''
    }
  )
}

export function LeaveNotificationEditor({
  rule,
  contacts,
  monitoredCount,
  saving,
  sendCapabilityWarning,
  onOpenMonitoredGroups,
  onCancel,
  onSave
}: LeaveNotificationEditorProps): React.ReactElement {
  const [enabled, setEnabled] = React.useState(rule.enabled)
  const [config, setConfig] = React.useState<LeaveNotificationConfig>(() => initialConfig(rule))

  // 切换编辑对象 / 保存后回填时重建草稿，避免把上一份改动带过来。
  React.useEffect(() => {
    setEnabled(rule.enabled)
    setConfig(initialConfig(rule))
  }, [rule])

  const targetType = config.target.type
  const selectedContactId = String(config.target.contactId || '')

  const selectedContactName = React.useMemo(
    () => contacts.find((contact) => contact.id === selectedContactId)?.name ?? '',
    [contacts, selectedContactId]
  )

  /** 选了「指定好友」但那个联系人已经不在了（被删 / 不可发送 / 找不到）。 */
  const contactMissing =
    targetType === 'contact' && Boolean(selectedContactId) && !selectedContactName

  /**
   * 通知不是发给「当前群聊」、但内容里又没有群名 → 收件人认不出是哪个群。
   *
   * 只在非「当前群聊」时要求：发给群内时，群名是冗余的。
   */
  const missingGroupName =
    targetType !== 'source_chat' && !config.template.includes('{groupName}')

  const selectTarget = (next: LeaveNotificationTargetType): void => {
    setConfig((current) => ({
      ...current,
      // 换目标类型时清掉上一个类型才有的字段，避免存下互相矛盾的配置。
      // 同时**清除迁移遗留的「待重选」标记** —— 用户已经做了选择。
      target: next === 'contact' ? { type: next, contactId: current.target.contactId } : { type: next }
    }))
  }

  const handleSave = (): void => {
    onSave({ enabled, config: { ...config, targetNeedsReview: undefined } })
  }

  return (
    <div className="automation-editor">
      <header className="automation-editor-header">
        <div>
          <h2>退群通知</h2>
          <p>当已监控群聊检测到成员退出时，自动发送通知。</p>
          <div className="automation-leave-status-row">
            <span className="automation-field-label">启用这条自动化</span>
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-label="启用这条自动化"
            />
          </div>
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

      {config.targetNeedsReview ? (
        <p className="automation-notice warning">
          旧版「通知群聊」是逐群配置的，无法无损转换成新的单一通知目标。已保留你的通知模板，
          但<strong>在你重新选择通知目标之前不会发送任何通知</strong>。
        </p>
      ) : null}
      {contactMissing ? (
        <p className="automation-notice warning">
          之前选择的联系人已不存在或当前无法发送，请重新选择通知目标。
        </p>
      ) : null}
      {sendCapabilityWarning ? (
        <p className="automation-notice warning">{sendCapabilityWarning}</p>
      ) : null}

      <div className="automation-editor-body">
        <div className="automation-editor-form">
          <section className="automation-section">
            <div className="automation-section-heading">
              <h3>1 · 什么时候触发</h3>
            </div>

            <div className="automation-inline-row">
              <div>
                <span className="automation-field-label">触发事件</span>
                <span className="automation-static-value">检测到群成员退出</span>
                <small>这是「退群监控」提供的事件，由本规则响应。</small>
              </div>
            </div>

            <div className="automation-inline-row">
              <div>
                <span className="automation-field-label">监控来源</span>
                <span className="automation-static-value">退群监控</span>
              </div>
            </div>

            {/*
              只读摘要 + 唯一入口。
              「哪些群被监控」完全由退群监控决定，本规则不做二次筛选 ——
              所以这里不给任何勾选控件，只把当前范围如实说出来。
            */}
            <div className="automation-leave-groups-card">
              <div>
                <span className="automation-field-label">已监控群聊</span>
                <strong>{monitoredCount} 个群聊</strong>
                <small>监控范围由「退群监控」管理</small>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={onOpenMonitoredGroups}
                disabled={!onOpenMonitoredGroups}
              >
                管理监控群聊 →
              </Button>
            </div>
          </section>

          <section className="automation-section">
            <div className="automation-section-heading">
              <h3>2 · 通知发送到哪里</h3>
            </div>

            <RadioGroup
              value={targetType}
              onValueChange={(value) => selectTarget(value as LeaveNotificationTargetType)}
              aria-label="通知发送到哪里"
              className="automation-leave-targets"
            >
              {LEAVE_NOTIFICATION_TARGET_OPTIONS.map((option) => (
                <div key={option.type} className="automation-leave-radio option">
                  <RadioGroupItem value={option.type} id={`leave-target-${option.type}`} />
                  <div className="automation-leave-radio-body">
                    <label htmlFor={`leave-target-${option.type}`}>{option.label}</label>
                    <small>{option.description}</small>
                  </div>
                </div>
              ))}
            </RadioGroup>

            {targetType === 'contact' ? (
              <div className="automation-field">
                <span className="automation-field-label">选择好友</span>
                <LeaveNotificationTargetPicker
                  contacts={contacts}
                  selectedId={selectedContactId}
                  onSelect={(id) =>
                    setConfig((current) => ({
                      ...current,
                      target: { type: 'contact', contactId: id },
                      targetNeedsReview: undefined
                    }))
                  }
                  ariaLabel="选择好友"
                  searchPlaceholder="搜索好友"
                  emptyText="没有可发送的联系人"
                />
              </div>
            ) : null}
          </section>

          <section className="automation-section">
            <div className="automation-section-heading">
              <h3>3 · 通知内容</h3>
            </div>

            {/*
              护栏：通知发给「别人」时，不带群名的通知等于「张三退群了」。
              主进程已替用户补过一次（一次性迁移），这里兜的是"用户后来主动删掉了"的情况 ——
              只提示 + 一键补上，不强行改用户文本。
            */}
            {missingGroupName ? (
              <div className="automation-notice warning automation-notice-stack">
                <p>这份内容里没有群聊名，收件人看不出是哪个群退的人。</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setConfig((current) => ({
                      ...current,
                      template: insertGroupNamePlaceholder(current.template)
                    }))
                  }
                >
                  补上群聊名
                </Button>
              </div>
            ) : null}

            <LeaveNotificationTemplateEditor
              template={config.template}
              onChange={(next) =>
                setConfig((current) => ({ ...current, template: next }))
              }
            />
          </section>
        </div>

        <LeaveNotificationPreview
          config={config}
          contactName={selectedContactName}
          monitoredCount={monitoredCount}
        />
      </div>
    </div>
  )
}
