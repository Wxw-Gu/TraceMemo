import * as React from 'react'
import {
  BUILTIN_DAILY_REPORT_RULE_ID,
  BUILTIN_LEAVE_NOTIFICATION_RULE_ID,
  type AutomationExecution,
  type AutomationRule,
  type AutomationRuleDraft,
  type AutomationRuleType,
  type AutomationStatusSummary
} from '../../../../shared/automation'
import {
  Button,
  SegmentedControl,
  SegmentedControlItem,
  Spinner,
  useToast
} from '../../components/ui'
import { RuleListPanel } from './RuleListPanel'
import { RuleEditorPanel } from './RuleEditorPanel'
import { ExecutionLogPanel } from './ExecutionLogPanel'
import { ExecutionDetailDrawer } from './ExecutionDetailDrawer'
import { AutomationRuleTypeTabs } from './AutomationRuleTypeTabs'
import {
  LeaveNotificationEditor,
  type LeaveNotificationSaveInput
} from './LeaveNotificationEditor'
import type { LeaveNotificationContactOption } from './LeaveNotificationTargetPicker'
import { UNAVAILABLE_STATUS, automationApi, isAutomationApiAvailable, type AutomationGroupOption } from './model/api'

/**
 * AutomationWorkspace —— 自动化一级菜单。
 *
 * 两个 tab：规则 / 执行日志。顶部三块状态（监听 / 发送能力 / 今日执行）
 * **全部来自 main 的真实能力**，渲染层不做任何平台猜测 ——
 * 粗平台判断在这里是错的：装了 macOS 但没绑定个人微信，照样发不出去。
 *
 * 「规则」内部再分一层**规则类型**：@我生成日报 / 退群通知。
 * 两种类型现在都是**真实规则**，保存都会落盘。
 */

type AutomationTab = 'rules' | 'logs'

/** 由「退群监控」深链过来时的请求：直接打开指定规则类型。 */
export interface AutomationOpenRuleRequest {
  ruleType: AutomationRuleType
  /** 每次点击都要能重新触发，所以带一个自增/时间戳。 */
  requestId: number
}

export interface AutomationWorkspaceProps {
  dbReady: boolean
  /** 发送能力不可用时，引导用户去设置页。 */
  onOpenSendSettings?: () => void
  /** 「管理监控群聊 →」：跳到退群监控的管理群聊页（纯导航）。 */
  onOpenExitMonitorGroups?: () => void
  /** 深链请求（来自退群监控页的「退群通知自动化」入口）。 */
  openRuleRequest?: AutomationOpenRuleRequest | null
}

interface EditorState {
  mode: 'create' | 'edit'
  rule: AutomationRule | null
  ruleType: AutomationRuleType
}

export function AutomationWorkspace({
  dbReady,
  onOpenSendSettings,
  onOpenExitMonitorGroups,
  openRuleRequest
}: AutomationWorkspaceProps): React.ReactElement {
  const { toast } = useToast()
  const apiAvailable = React.useMemo(() => isAutomationApiAvailable(), [])

  const [tab, setTab] = React.useState<AutomationTab>('rules')
  const [status, setStatus] = React.useState<AutomationStatusSummary>(UNAVAILABLE_STATUS)
  const [rules, setRules] = React.useState<AutomationRule[]>([])
  const [groups, setGroups] = React.useState<AutomationGroupOption[]>([])
  const [executions, setExecutions] = React.useState<AutomationExecution[]>([])
  const [sendableContacts, setSendableContacts] = React.useState<LeaveNotificationContactOption[]>([])
  const [monitoredGroupCount, setMonitoredGroupCount] = React.useState(0)
  const [loading, setLoading] = React.useState(true)
  const [clearing, setClearing] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [busyRuleId, setBusyRuleId] = React.useState<string | null>(null)
  const [editor, setEditor] = React.useState<EditorState | null>(null)
  const [selectedExecution, setSelectedExecution] = React.useState<AutomationExecution | null>(null)
  const [pendingDelete, setPendingDelete] = React.useState<AutomationRule | null>(null)

  const reload = React.useCallback(async (): Promise<void> => {
    const [nextStatus, nextRules, nextGroups, nextExecutions, nextContacts, nextMonitored] =
      await Promise.all([
        automationApi.getStatus(),
        automationApi.listRules(),
        automationApi.listGroups(),
        automationApi.listExecutions(100),
        // 「指定好友」候选与已监控群聊数量：都来自既有能力，不在自动化里另存一份。
        automationApi.listSendableContacts(),
        automationApi.getMonitoredGroupCount()
      ])
    setStatus(nextStatus)
    setRules(nextRules)
    setGroups(nextGroups)
    setExecutions(nextExecutions)
    setSendableContacts(nextContacts)
    setMonitoredGroupCount(nextMonitored)
  }, [])

  React.useEffect(() => {
    let disposed = false
    setLoading(true)
    void reload().finally(() => {
      if (!disposed) setLoading(false)
    })
    return () => {
      disposed = true
    }
  }, [reload])

  // 切到日志 tab 时刷新一次：规则跑完后台不会主动推事件给渲染层，
  // 用户点进来看到的是上一次加载的快照才是真的误导。
  React.useEffect(() => {
    if (tab !== 'logs') return
    void reload()
  }, [tab, reload])

  /**
   * 「退群监控 → 退群通知自动化」的深链。
   *
   * 落到「规则 → 退群通知」这一层，而不是只跳到自动化首页 ——
   * 否则用户还得自己再找一次。请求对象本身在父层是稳定的，
   * 所以依赖整个对象；requestId 变化就代表又点了一次。
   */
  React.useEffect(() => {
    if (!openRuleRequest) return
    setTab('rules')
    setEditor({ mode: 'edit', rule: null, ruleType: openRuleRequest.ruleType })
  }, [openRuleRequest])

  /**
   * 当前编辑目标（日报）—— **UI 显示与保存共用这一个**。
   *
   * 这里保留"回落到内置日报"的兜底，但它同时驱动下面的「正在编辑：X」，
   * 所以即使回落发生，用户也能看到真实目标，不会再出现"以为在改 A、实际改了 B"。
   */
  const dailyReportTarget =
    editor?.ruleType === 'daily_report'
      ? (editor.rule ?? rules.find((item) => item.id === BUILTIN_DAILY_REPORT_RULE_ID) ?? null)
      : null

  /** 退群通知是 singleton 规则，永远从规则表里取（不存在则由 main 侧播种）。 */
  const leaveNotificationRule =
    rules.find((item) => item.id === BUILTIN_LEAVE_NOTIFICATION_RULE_ID) ?? null

  /** 「正在编辑」显示的名字（与保存目标同源）。 */
  const editorTargetName = React.useMemo((): string => {
    if (!editor) return ''
    if (editor.ruleType === 'leave_notification') return leaveNotificationRule?.name ?? '退群通知'
    return dailyReportTarget?.name ?? '新建自动化'
  }, [editor, leaveNotificationRule, dailyReportTarget])

  /** 「指定好友」目标的显示名（首页卡片用；拿不到时留空，不伪造）。 */
  const leaveContactName = React.useMemo((): string => {
    const target = leaveNotificationRule?.leaveNotification?.target
    if (!target || target.type !== 'contact') return ''
    return sendableContacts.find((contact) => contact.id === target.contactId)?.name ?? ''
  }, [leaveNotificationRule, sendableContacts])

  /**
   * 记住"上一次在日报这一类里编辑的那条"。
   *
   * 切类型只是换一类规则来编辑，切回来时应当回到刚才那条 ——
   * 否则用户从"某条日报"切走再切回，会被悄悄带到内置日报上。
   */
  const lastDailyTargetRef = React.useRef<AutomationRule | null>(null)

  /** 切到「@我生成日报」时的编辑目标：上次那条 → 内置日报 → 新建。 */
  const resolveDailyTarget = React.useCallback((): AutomationRule | null => {
    return (
      lastDailyTargetRef.current ??
      rules.find((item) => item.id === BUILTIN_DAILY_REPORT_RULE_ID) ??
      null
    )
  }, [rules])

  const handleToggle = async (rule: AutomationRule, enabled: boolean): Promise<void> => {
    setBusyRuleId(rule.id)
    const updated = await automationApi.setRuleEnabled(rule.id, enabled)
    setBusyRuleId(null)
    if (!updated) {
      toast({ description: '切换失败，规则状态未改变', variant: 'destructive', duration: 3200 })
      return
    }
    setRules((current) => current.map((item) => (item.id === updated.id ? updated : item)))
    void automationApi.getStatus().then(setStatus)
  }

  const handleSave = async (draft: AutomationRuleDraft): Promise<void> => {
    if (!editor) return

    const target = editor.ruleType === 'daily_report' ? dailyReportTarget : editor.rule

    /*
     * 编辑态但目标不存在 ⇒ **报错，绝不许静默新建**。
     *
     * 这里以前写的是 `editor.mode === 'create' || !target ? createRule : updateRule` ——
     * 把"没有目标"当成了"新建"，于是用户以为在改 A、实际多出一条新规则。
     * 新建只能由 `mode === 'create'` 决定；`edit` 且无目标是不可恢复的状态，必须说出来。
     */
    if (editor.mode === 'edit' && !target) {
      toast({
        description: '要编辑的规则已不存在，请返回列表重新打开',
        variant: 'destructive',
        duration: 3600
      })
      return
    }

    setSaving(true)
    let saved: AutomationRule | null = null
    if (editor.mode === 'create') {
      saved = await automationApi.createRule(draft)
    } else if (target) {
      saved = await automationApi.updateRule(target.id, draft)
    }
    setSaving(false)
    if (!saved) {
      toast({ description: '保存失败，请稍后重试', variant: 'destructive', duration: 3200 })
      return
    }
    setRules((current) => {
      const exists = current.some((item) => item.id === saved.id)
      return exists
        ? current.map((item) => (item.id === saved.id ? saved : item))
        : [...current, saved]
    })
    setEditor(null)
    toast({
      description: editor.mode === 'create' ? `已创建「${saved.name}」` : `已保存「${saved.name}」`,
      duration: 2800
    })
    void automationApi.getStatus().then(setStatus)
  }

  /**
   * 保存「退群通知」规则。
   *
   * 走独立的 singleton upsert 通道：这条规则 id 固定，保存永远不会多出一条。
   * 保存成功后清掉迁移遗留的 `targetNeedsReview`（用户已经做过选择）。
   */
  const handleLeaveNotificationSave = async (
    input: LeaveNotificationSaveInput
  ): Promise<void> => {
    // 静默 return 会让"点保存没反应"变成用户眼里的坏掉，必须说出来。
    if (!leaveNotificationRule) {
      toast({
        description: '退群通知规则已不存在，请返回列表重新打开',
        variant: 'destructive',
        duration: 3600
      })
      return
    }
    setSaving(true)
    const saved = await automationApi.saveLeaveNotificationRule({
      ...leaveNotificationRule,
      enabled: input.enabled,
      leaveNotification: input.config
    })
    setSaving(false)
    if (!saved) {
      toast({ description: '保存失败，请稍后重试', variant: 'destructive', duration: 3200 })
      return
    }
    setRules((current) =>
      current.some((item) => item.id === saved.id)
        ? current.map((item) => (item.id === saved.id ? saved : item))
        : [...current, saved]
    )
    setEditor(null)
    toast({ description: `已保存「${saved.name}」`, duration: 2800 })
    void automationApi.getStatus().then(setStatus)
  }

  const confirmDelete = async (): Promise<void> => {
    if (!pendingDelete) return
    const target = pendingDelete
    setPendingDelete(null)
    setBusyRuleId(target.id)
    const removed = await automationApi.deleteRule(target.id)
    setBusyRuleId(null)
    if (!removed) {
      toast({ description: '删除失败，规则仍然存在', variant: 'destructive', duration: 3200 })
      return
    }
    setRules((current) => current.filter((item) => item.id !== target.id))
    toast({ description: `已删除「${target.name}」`, duration: 2800 })
  }

  const handleClearExecutions = async (): Promise<void> => {
    setClearing(true)
    const cleared = await automationApi.clearExecutions()
    setClearing(false)
    if (!cleared) {
      toast({ description: '清空失败，请稍后重试', variant: 'destructive', duration: 3200 })
      return
    }
    setExecutions([])
    void automationApi.getStatus().then(setStatus)
  }

  const capability = status.sendCapability
  const capabilityReady = capability.ready && capability.canSendText && capability.canSendImage
  const showEditor = tab === 'rules' && editor !== null

  return (
    <div className="automation-page">
      <header className="automation-page-header">
        <div>
          <h1>自动化</h1>
          <p>当群里出现符合条件的消息时，TraceMemo 会自动执行你配置的动作。</p>
        </div>
        {tab === 'rules' && !showEditor ? (
          <Button
            onClick={() => {
              lastDailyTargetRef.current = null
              setEditor({ mode: 'create', rule: null, ruleType: 'daily_report' })
            }}
          >
            新建自动化
          </Button>
        ) : null}
      </header>

      {!apiAvailable ? (
        <p className="automation-notice warning">
          自动化接口尚未就绪（可能正在启动或版本不匹配）。下面的数据可能不是最新的。
        </p>
      ) : null}
      {!dbReady ? (
        <p className="automation-notice warning">
          微信数据库尚未连接，规则可以编辑，但无法读取群列表，也不会触发。
        </p>
      ) : null}

      <section className="automation-status-bar" aria-label="自动化状态">
        <div className="automation-status-card">
          <span className="automation-status-label">消息监听</span>
          <span className={`automation-status-value ${status.listening ? 'ok' : 'off'}`}>
            {status.listening ? '运行中' : '未在监听'}
          </span>
        </div>

        <div className="automation-status-card">
          <span className="automation-status-label">发送能力</span>
          <span className={`automation-status-value ${capabilityReady ? 'ok' : 'warn'}`}>
            {capabilityReady ? '可以发送文字和图片' : capability.ready ? '发送能力不完整' : '尚未就绪'}
          </span>
          <small className="automation-status-note">{capability.message}</small>
          {!capabilityReady && onOpenSendSettings ? (
            <Button variant="link" size="sm" onClick={onOpenSendSettings}>
              去设置发送能力
            </Button>
          ) : null}
        </div>

        <div className="automation-status-card">
          <span className="automation-status-label">今日执行</span>
          <span className="automation-status-value">
            {status.todaySuccesses} / {status.todayExecutions}
          </span>
          <small className="automation-status-note">成功 / 总计</small>
        </div>
      </section>

      {!showEditor ? (
        <SegmentedControl
          value={tab}
          onValueChange={(value) => setTab(value as AutomationTab)}
          aria-label="自动化视图"
        >
          <SegmentedControlItem value="rules">规则</SegmentedControlItem>
          <SegmentedControlItem value="logs">执行日志</SegmentedControlItem>
        </SegmentedControl>
      ) : null}

      {showEditor && editor ? (
        <div className="automation-rule-type-shell">
          {/*
            切类型 = **换一条规则来编辑**，不是"把这条规则改成另一类"。

            以前这里只改 `ruleType`，把上个类型的 `mode`/`rule` 一起带过来，
            于是"从退群通知切到日报"会留下 `mode='edit' + rule=null` 的中间态，
            保存时再隐式回落到内置日报 —— 用户以为在改退群通知，实际改掉了日报。
            现在切换时**显式重算编辑目标**，并把当前目标名显示出来。
          */}
          <AutomationRuleTypeTabs
            value={editor.ruleType}
            onValueChange={(next) => {
              if (next === editor.ruleType) return
              if (next === 'leave_notification') {
                // 退群通知是 singleton：编辑目标就是它自己，不依赖规则列表。
                setEditor({ mode: 'edit', rule: null, ruleType: 'leave_notification' })
                return
              }
              // 日报可以有多条：目标必须是**具体某一条**或"新建"，
              // 绝不允许留下 mode='edit' 却没有目标的状态。
              const target = resolveDailyTarget()
              lastDailyTargetRef.current = target
              setEditor(
                target
                  ? { mode: 'edit', rule: target, ruleType: 'daily_report' }
                  : { mode: 'create', rule: null, ruleType: 'daily_report' }
              )
            }}
          />

          {/*
            编辑目标必须**可见**。
            保存的目标与这里显示的名字来自**同一个变量** —— 不允许 UI 显示一个、保存改另一个。
          */}
          <p className="automation-editing-target" data-testid="automation-editing-target">
            正在编辑：<strong>{editorTargetName}</strong>
          </p>

          {editor.ruleType === 'daily_report' ? (
            /*
             * 编辑态却没有目标（规则被删/列表刷新后消失）—— 不能让用户对着一个
             * 标题写着「编辑自动化」的空表单填半天，最后保存时报错。
             */
            editor.mode === 'edit' && !dailyReportTarget ? (
              <div className="automation-notice warning automation-notice-stack">
                <p>要编辑的规则已不存在（可能已被删除）。</p>
                <Button variant="outline" size="sm" onClick={() => setEditor(null)}>
                  返回规则列表
                </Button>
              </div>
            ) : (
              <RuleEditorPanel
                mode={editor.mode}
                rule={dailyReportTarget}
                groups={groups}
                saving={saving}
                onCancel={() => setEditor(null)}
                onSave={(draft) => void handleSave(draft)}
              />
            )
          ) : leaveNotificationRule ? (
            <LeaveNotificationEditor
              rule={leaveNotificationRule}
              contacts={sendableContacts}
              monitoredCount={monitoredGroupCount}
              saving={saving}
              {...(capabilityReady
                ? {}
                : {
                    // §「规则仍然可以保存」：只提示，不阻断编辑。
                    sendCapabilityWarning:
                      '当前发送能力未就绪：退群事件仍会被记录，但通知发送会失败。'
                  })}
              onOpenMonitoredGroups={onOpenExitMonitorGroups}
              onCancel={() => setEditor(null)}
              onSave={(input) => void handleLeaveNotificationSave(input)}
            />
          ) : loading ? (
            /*
             * **正在读，不是"没有"。**
             *
             * 从「退群监控 → 退群通知自动化」深链进来时，编辑器是同步打开的，
             * 而规则列表还在 IPC 回来的路上 —— 这一帧必然还没有规则。
             * 旧写法在这里直接渲染「尚未就绪 / 版本不匹配」，把最正常的一种
             * 加载状态说成了故障，必须区分开。
             */
            <div className="automation-loading">
              <Spinner />
              <span>正在读取退群通知规则…</span>
            </div>
          ) : (
            /*
             * 读完了**确实没有**这条规则。
             *
             * `builtin-leave-notification` 由主进程 `AutomationRuleStore` 首次加载时自动播种，
             * 所以走到这里通常意味着：跑着的主进程还是迁移前的旧构建
             * （渲染层已经升级，`out/main` 没有）。如实说明并给一个重试入口。
             */
            <div className="automation-notice warning automation-notice-stack">
              <p>没有找到内置的退群通知规则。</p>
              <small>
                这条规则应由主进程在首次启动时自动创建。如果你刚更新过版本，
                请重启 TraceMemo —— 已经跑起来的主进程不会自动换成新代码。
              </small>
              <Button
                variant="outline"
                size="sm"
                disabled={loading}
                onClick={() => {
                  setLoading(true)
                  void reload().finally(() => setLoading(false))
                }}
              >
                重新加载
              </Button>
            </div>
          )}
        </div>
      ) : tab === 'rules' ? (
        <RuleListPanel
          rules={rules}
          groups={groups}
          loading={loading}
          busyRuleId={busyRuleId}
          leaveNotification={
            leaveNotificationRule
              ? {
                  rule: leaveNotificationRule,
                  monitoredCount: monitoredGroupCount,
                  contactName: leaveContactName
                }
              : null
          }
          onToggle={(rule, enabled) => void handleToggle(rule, enabled)}
          onEdit={(rule) => {
            // 记住这条，切类型回来时能恢复 —— 不记住就会被悄悄换成内置日报。
            lastDailyTargetRef.current = rule
            setEditor({ mode: 'edit', rule, ruleType: rule.ruleType ?? 'daily_report' })
          }}
          onDelete={(rule) => setPendingDelete(rule)}
          onCreate={() => {
            // 新建是"还没有对象"，所以不记住任何规则。
            lastDailyTargetRef.current = null
            setEditor({ mode: 'create', rule: null, ruleType: 'daily_report' })
          }}
          onEditLeaveNotification={() =>
            setEditor({ mode: 'edit', rule: null, ruleType: 'leave_notification' })
          }
        />
      ) : (
        <ExecutionLogPanel
          executions={executions}
          loading={loading}
          clearing={clearing}
          onSelect={setSelectedExecution}
          onClear={() => void handleClearExecutions()}
        />
      )}

      <ExecutionDetailDrawer
        execution={selectedExecution}
        onClose={() => setSelectedExecution(null)}
      />

      {pendingDelete ? (
        <div className="automation-confirm-layer" role="presentation" onClick={() => setPendingDelete(null)}>
          <div
            className="automation-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-label="删除自动化"
            onClick={(event) => event.stopPropagation()}
          >
            <h2>删除「{pendingDelete.name}」？</h2>
            <p>删除后不会再触发，已有的执行记录会保留。</p>
            <div className="automation-confirm-actions">
              <Button variant="ghost" onClick={() => setPendingDelete(null)}>
                取消
              </Button>
              <Button variant="destructive" onClick={() => void confirmDelete()}>
                删除
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
