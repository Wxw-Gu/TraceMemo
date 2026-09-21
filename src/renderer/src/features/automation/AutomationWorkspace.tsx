import * as React from 'react'
import type {
  AutomationExecution,
  AutomationRule,
  AutomationRuleDraft,
  AutomationStatusSummary
} from '../../../../shared/automation'
import {
  Button,
  SegmentedControl,
  SegmentedControlItem,
  useToast
} from '../../components/ui'
import { RuleListPanel } from './RuleListPanel'
import { RuleEditorPanel } from './RuleEditorPanel'
import { ExecutionLogPanel } from './ExecutionLogPanel'
import { ExecutionDetailDrawer } from './ExecutionDetailDrawer'
import { UNAVAILABLE_STATUS, automationApi, isAutomationApiAvailable, type AutomationGroupOption } from './model/api'

/**
 * AutomationWorkspace —— 自动化一级菜单。
 *
 * 两个 tab：规则 / 执行日志。顶部三块状态（监听 / 发送能力 / 今日执行）
 * **全部来自 main 的真实能力**，渲染层不做任何平台猜测 ——
 * 粗平台判断在这里是错的：装了 macOS 但没绑定个人微信，照样发不出去。
 */

type AutomationTab = 'rules' | 'logs'

export interface AutomationWorkspaceProps {
  dbReady: boolean
  /** 发送能力不可用时，引导用户去设置页。 */
  onOpenSendSettings?: () => void
}

interface EditorState {
  mode: 'create' | 'edit'
  rule: AutomationRule | null
}

export function AutomationWorkspace({
  dbReady,
  onOpenSendSettings
}: AutomationWorkspaceProps): React.ReactElement {
  const { toast } = useToast()
  const apiAvailable = React.useMemo(() => isAutomationApiAvailable(), [])

  const [tab, setTab] = React.useState<AutomationTab>('rules')
  const [status, setStatus] = React.useState<AutomationStatusSummary>(UNAVAILABLE_STATUS)
  const [rules, setRules] = React.useState<AutomationRule[]>([])
  const [groups, setGroups] = React.useState<AutomationGroupOption[]>([])
  const [executions, setExecutions] = React.useState<AutomationExecution[]>([])
  const [loading, setLoading] = React.useState(true)
  const [clearing, setClearing] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [busyRuleId, setBusyRuleId] = React.useState<string | null>(null)
  const [editor, setEditor] = React.useState<EditorState | null>(null)
  const [selectedExecution, setSelectedExecution] = React.useState<AutomationExecution | null>(null)
  const [pendingDelete, setPendingDelete] = React.useState<AutomationRule | null>(null)

  const reload = React.useCallback(async (): Promise<void> => {
    const [nextStatus, nextRules, nextGroups, nextExecutions] = await Promise.all([
      automationApi.getStatus(),
      automationApi.listRules(),
      automationApi.listGroups(),
      automationApi.listExecutions(100)
    ])
    setStatus(nextStatus)
    setRules(nextRules)
    setGroups(nextGroups)
    setExecutions(nextExecutions)
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
    setSaving(true)
    const saved =
      editor.mode === 'create'
        ? await automationApi.createRule(draft)
        : await automationApi.updateRule(editor.rule?.id ?? '', draft)
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
          <Button onClick={() => setEditor({ mode: 'create', rule: null })}>新建自动化</Button>
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
        <RuleEditorPanel
          mode={editor.mode}
          rule={editor.rule}
          groups={groups}
          saving={saving}
          onCancel={() => setEditor(null)}
          onSave={(draft) => void handleSave(draft)}
        />
      ) : tab === 'rules' ? (
        <RuleListPanel
          rules={rules}
          groups={groups}
          loading={loading}
          busyRuleId={busyRuleId}
          onToggle={(rule, enabled) => void handleToggle(rule, enabled)}
          onEdit={(rule) => setEditor({ mode: 'edit', rule })}
          onDelete={(rule) => setPendingDelete(rule)}
          onCreate={() => setEditor({ mode: 'create', rule: null })}
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
