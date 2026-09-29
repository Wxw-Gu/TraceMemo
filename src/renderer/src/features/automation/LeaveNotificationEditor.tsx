import * as React from 'react'
import { Button, Input, RadioGroup, RadioGroupItem, Switch } from '../../components/ui'
import {
  LEAVE_NOTIFICATION_TARGET_OPTIONS,
  describeLeaveNotificationNotifyScope,
  normalizeLeaveNotificationConfig,
  type AutomationRule,
  type LeaveNotificationConfig,
  type LeaveNotificationNotifyScope,
  type LeaveNotificationTargetType
} from '../../../../shared/automation'
import { insertGroupNamePlaceholder } from '../../../../shared/group-exit-monitor'
import { LeaveNotificationPreview } from './LeaveNotificationPreview'
import type { AutomationGroupOption } from './model/api'
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
 * 职责边界在 UI 上一眼可见，是**两层**而不是一层：
 *   退群监控 = 监测哪些群有人退出（范围由它管）；
 *   本规则   = ① 这批群里**哪些要通知**（二次勾选）；② 通知**发到哪**。
 *
 * ① 就是旧版「退群监控 → 通知群聊」的那份逐群勾选。它曾在自动化迁移里被压成单值目标而丢失，
 * 导致"规则一启用就全量通知"；`notifyScope` 把它恢复回来，所以这里**有**勾选控件。
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
  /** 真实已监控群聊清单 —— 二次勾选的候选项，与 `monitoredCount` 同一次取数。 */
  monitoredGroups: AutomationGroupOption[]
  saving: boolean
  /** 发送能力不完整时的一句话提示；为 undefined 表示能力正常。 */
  sendCapabilityWarning?: string
  /** 「管理监控群聊 →」—— 跳退群监控的管理群聊页，纯导航。 */
  onOpenMonitoredGroups?: () => void
  onCancel: () => void
  onSave: (input: LeaveNotificationSaveInput) => void
}

/**
 * 草稿初值。
 *
 * 一律过一遍 `normalizeLeaveNotificationConfig`：它本来就负责"补齐缺失字段 +
 * 清掉互相矛盾的配置"，所以契约新增字段（例如 `notifyScope`）时这里不会漏。
 * 手拼字面量就会漏。
 */
function initialConfig(rule: AutomationRule): LeaveNotificationConfig {
  return normalizeLeaveNotificationConfig(rule.leaveNotification)
}

export function LeaveNotificationEditor({
  rule,
  contacts,
  monitoredCount,
  monitoredGroups,
  saving,
  sendCapabilityWarning,
  onOpenMonitoredGroups,
  onCancel,
  onSave
}: LeaveNotificationEditorProps): React.ReactElement {
  const [enabled, setEnabled] = React.useState(rule.enabled)
  const [config, setConfig] = React.useState<LeaveNotificationConfig>(() => initialConfig(rule))
  const [groupFilter, setGroupFilter] = React.useState('')

  // 切换编辑对象 / 保存后回填时重建草稿，避免把上一份改动带过来。
  React.useEffect(() => {
    setEnabled(rule.enabled)
    setConfig(initialConfig(rule))
    setGroupFilter('')
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

  /** 通知范围（二次勾选）。`config.notifyScope` 是唯一权威，这里只是取短名。 */
  const notifyScope: LeaveNotificationNotifyScope =
    config.notifyScope === 'selected' ? 'selected' : 'all'

  const selectedNotifyIds = React.useMemo(
    () => new Set(config.notifyRoomIds),
    [config.notifyRoomIds]
  )

  const visibleMonitoredGroups = React.useMemo(() => {
    const keyword = groupFilter.trim().toLowerCase()
    if (!keyword) return monitoredGroups
    return monitoredGroups.filter((group) => group.name.toLowerCase().includes(keyword))
  }, [monitoredGroups, groupFilter])

  const selectTarget = (next: LeaveNotificationTargetType): void => {
    setConfig((current) => ({
      ...current,
      // 换目标类型时清掉上一个类型才有的字段，避免存下互相矛盾的配置。
      // 同时**清除迁移遗留的「待重选」标记** —— 用户已经做了选择。
      target: next === 'contact' ? { type: next, contactId: current.target.contactId } : { type: next }
    }))
  }

  const selectNotifyScope = (next: LeaveNotificationNotifyScope): void => {
    setConfig((current) => ({ ...current, notifyScope: next }))
  }

  const toggleNotifyRoom = (roomId: string): void => {
    setConfig((current) => {
      const chosen = new Set(current.notifyRoomIds)
      if (chosen.has(roomId)) chosen.delete(roomId)
      else chosen.add(roomId)
      // 按候选项顺序落盘，勾选顺序不影响存下来的结果。
      const ordered = monitoredGroups
        .map((group) => group.id)
        .filter((id) => chosen.has(id))
      // 候选项还没加载出来时保留原样，避免把用户的勾选静默清空。
      return {
        ...current,
        notifyRoomIds: monitoredGroups.length ? ordered : current.notifyRoomIds
      }
    })
  }

  const handleSave = (): void => {
    onSave({
      enabled,
      config: {
        ...config,
        // 勾选集收敛到「当前已监控」这一集合内：否则监控范围缩小之后，
        // 会留下一批界面上看不见、且永远不可能命中的幽灵勾选。
        notifyRoomIds: monitoredGroups.length
          ? monitoredGroups.map((group) => group.id).filter((id) => selectedNotifyIds.has(id))
          : config.notifyRoomIds,
        targetNeedsReview: undefined
      }
    })
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
              第一层：只读的监控范围摘要 + 唯一入口。
              「哪些群被监控」完全由退群监控决定，本规则不重复维护一份。
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

            {/*
              第二层：在上面这批已监控群聊里**二次勾选**哪些要通知。
              这就是旧版「退群监控 → 通知群聊」的那份逐群勾选 ——
              没有它，规则一启用就等于给全部已监控群聊发通知。
            */}
            <div className="automation-inline-row">
              <div className="automation-leave-scope">
                <span className="automation-field-label">通知范围</span>
                <RadioGroup
                  value={notifyScope}
                  onValueChange={(value) =>
                    selectNotifyScope(value as LeaveNotificationNotifyScope)
                  }
                  aria-label="通知范围"
                  className="automation-leave-scope-options"
                >
                  <div className="automation-leave-radio option">
                    <RadioGroupItem value="all" id="leave-scope-all" />
                    <div className="automation-leave-radio-body">
                      <label htmlFor="leave-scope-all">全部已监控群聊</label>
                      <small>任一被监控的群有人退出都发通知。</small>
                    </div>
                  </div>
                  <div className="automation-leave-radio option">
                    <RadioGroupItem
                      value="selected"
                      id="leave-scope-selected"
                      disabled={!monitoredGroups.length}
                    />
                    <div className="automation-leave-radio-body">
                      <label htmlFor="leave-scope-selected">仅选中的群聊</label>
                      <small>只对下面勾选的群发通知。</small>
                    </div>
                  </div>
                </RadioGroup>
                <small className="automation-leave-scope-summary">
                  当前覆盖：{describeLeaveNotificationNotifyScope(config, monitoredCount)}
                </small>
              </div>
            </div>

            {notifyScope === 'selected' ? (
              monitoredGroups.length ? (
                <div className="automation-field">
                  <div className="automation-section-heading">
                    <span className="automation-field-label">勾选要通知的群聊</span>
                    <span className="automation-section-note">
                      {selectedNotifyIds.size ? `已选 ${selectedNotifyIds.size} 个` : '尚未勾选'}
                    </span>
                  </div>
                  <Input
                    value={groupFilter}
                    onChange={(event) => setGroupFilter(event.target.value)}
                    placeholder="搜索群聊"
                    aria-label="搜索群聊"
                  />
                  <div className="automation-group-list" role="group" aria-label="通知群聊">
                    {visibleMonitoredGroups.length === 0 ? (
                      <p className="automation-group-empty">没有匹配「{groupFilter}」的群聊</p>
                    ) : (
                      visibleMonitoredGroups.map((group) => {
                        const checked = selectedNotifyIds.has(group.id)
                        return (
                          <label
                            key={group.id}
                            className={`automation-group-option ${checked ? 'selected' : ''}`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleNotifyRoom(group.id)}
                            />
                            <span>{group.name}</span>
                          </label>
                        )
                      })
                    )}
                  </div>
                  {selectedNotifyIds.size === 0 ? (
                    <p className="automation-section-hint">
                      <span aria-hidden="true">ⓘ</span>
                      一个群都没勾选，这条规则不会发送任何通知。
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="automation-section-hint">
                  <span aria-hidden="true">ⓘ</span>
                  还没有设置监控范围。请先到「退群监控 → 管理群聊」选择要监控的群，
                  再回来勾选通知范围。
                </p>
              )
            ) : null}
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
