import * as React from 'react'
import type { Contact } from '../../../../shared/types'
import type { PersonalWechatSendCapability } from '../../../../shared/personal-wechat'
import type {
  ScheduledReportCreateInput,
  ScheduledReportExecution,
  ScheduledReportMessageType,
  ScheduledReportMemberNameMode,
  ScheduledReportRange,
  ScheduledReportTask
} from '../../../../shared/scheduled-report'
import type { SelectableReportTemplateId } from '../../../../shared/report-templates'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  Checkbox,
  SegmentedControl,
  SegmentedControlItem
} from '../ui'
import { contactDisplayName } from './types'
import {
  SUMMARY_DATE_OPTIONS,
  SUMMARY_TYPE_OPTIONS,
  getSummaryDateRange,
  type SummaryDateRange
} from '../../utils/group-report'
import { REPORT_TEMPLATES, DEFAULT_REPORT_TEMPLATE } from '../../../../shared/report-templates'

type ReportDialogMode = 'create' | 'edit'

interface ScheduledReportsWorkspaceProps {
  contacts: Contact[]
  platformSupported?: boolean
  onOpenWechatSettings: () => void
  onOpenModelSettings?: () => void
  onNotice: (message: string, variant?: 'default' | 'success' | 'warning' | 'destructive') => void
}

const rangeLabel = (range: ScheduledReportRange): string =>
  range === 'recent24h'
    ? '最近24小时'
    : range === '7days'
      ? '近 7 天'
      : range === 'today'
        ? '今天'
        : '昨天'

const isScheduledReportRange = (value: unknown): value is ScheduledReportRange =>
  value === 'today' || value === 'yesterday' || value === '7days' || value === 'recent24h'

const allMessageTypes: ScheduledReportMessageType[] = SUMMARY_TYPE_OPTIONS.map(
  (option) => option.value
)

const reportRangeForUi = (range: ScheduledReportRange): SummaryDateRange =>
  range === '7days' || range === 'yesterday' ? range : 'today'

const messageTypeCounts = (
  messages: Array<{ type: string }>
): Record<ScheduledReportMessageType, number> => {
  const counts = Object.fromEntries(allMessageTypes.map((type) => [type, 0])) as Record<
    ScheduledReportMessageType,
    number
  >
  for (const message of messages) {
    const option = SUMMARY_TYPE_OPTIONS.find((item) => item.messageTypes.includes(message.type))
    if (option) counts[option.value] += 1
  }
  return counts
}

const formatDateTime = (value?: string): string => {
  if (!value) return '尚未执行'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未知'
  const now = new Date()
  const dayLabel =
    date.toDateString() === now.toDateString() ? '今天' : date.toLocaleDateString('zh-CN')
  return `${dayLabel} ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
}

const capabilityCopy = (capability: PersonalWechatSendCapability | null): string => {
  if (!capability) return '正在检查微信发送能力…'
  switch (capability.status) {
    case 'ready':
      return '✓ 微信发送能力已就绪'
    case 'unsupported':
      return '微信消息发送目前仅支持 macOS'
    case 'needs_binding':
    case 'unconfigured':
      return '请先绑定个人微信'
    case 'needs_verification':
      return '请先完成微信消息能力检测'
    default:
      return '微信发送能力异常'
  }
}

const capabilityTone = (capability: PersonalWechatSendCapability | null): string => {
  if (!capability) return 'border-border-subtle bg-muted/30 text-muted-foreground'
  if (capability.status === 'ready') return 'border-border-subtle bg-muted/20 text-foreground'
  return 'border-border-subtle bg-muted/20 text-muted-foreground'
}

const readableError = (error?: string): string => {
  const value = String(error || '')
  if (value.includes('wechat_not_ready') || value.includes('仅支持 macOS')) {
    if (value.includes('unsupported') || value.includes('仅支持'))
      return '微信消息发送目前仅支持 macOS'
    if (value.includes('needs_binding') || value.includes('unconfigured')) return '请先绑定个人微信'
    if (value.includes('needs_verification')) return '请先完成微信消息能力检测'
    return '微信发送能力不可用，请检查微信连接。'
  }
  if (value.includes('wechat_send_failed')) return '微信发送失败，请检查微信连接。'
  if (value.includes('report_generation_failed')) return '日报生成失败，请稍后重试。'
  return value || '操作失败，请稍后重试。'
}

const executionLabel = (execution: ScheduledReportExecution): string => {
  if (execution.status === 'running') return '生成中 · 待发送'
  if (execution.status === 'success') return '已生成并发送'
  if (execution.error?.includes('report_generation_failed')) return '日报生成失败'
  if (execution.error?.includes('wechat_not_ready')) return '微信发送能力不可用'
  return '微信发送失败'
}

function GroupAvatar({ contact }: { contact: Contact }): React.ReactElement {
  const name = contactDisplayName(contact)
  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-primary/10 text-sm font-semibold text-primary">
      {contact.avatar ? (
        <img
          src={contact.avatar}
          alt={name}
          className="h-full w-full object-cover"
          referrerPolicy="no-referrer"
        />
      ) : (
        name.slice(0, 1)
      )}
    </span>
  )
}

function ScheduledReportDialog({
  open,
  mode,
  task,
  contacts,
  busy,
  onOpenModelSettings,
  onOpenChange,
  onSubmit
}: {
  open: boolean
  mode: ReportDialogMode
  task: ScheduledReportTask | null
  contacts: Contact[]
  busy: boolean
  onOpenModelSettings?: () => void
  onOpenChange: (open: boolean) => void
  onSubmit: (input: ScheduledReportCreateInput, taskId?: string) => Promise<void>
}): React.ReactElement {
  const groups = React.useMemo(
    () => contacts.filter((contact) => contact.type === 'group'),
    [contacts]
  )
  const [keyword, setKeyword] = React.useState('')
  const [selectedId, setSelectedId] = React.useState('')
  const [name, setName] = React.useState('')
  const [scheduleTime, setScheduleTime] = React.useState('09:00')
  const [reportRange, setReportRange] = React.useState<ScheduledReportRange>('yesterday')
  const [selectedMessageTypes, setSelectedMessageTypes] =
    React.useState<ScheduledReportMessageType[]>(allMessageTypes)
  const [templateId, setTemplateId] = React.useState<SelectableReportTemplateId>('v1')
  const [memberNameMode, setMemberNameMode] =
    React.useState<ScheduledReportMemberNameMode>('groupNickname')
  const [timeoutSeconds, setTimeoutSeconds] = React.useState(300)
  const [rangeMessages, setRangeMessages] = React.useState<Array<{ type: string }>>([])
  const [rangeLoading, setRangeLoading] = React.useState(false)
  const [memberCount, setMemberCount] = React.useState<number | null>(null)
  const [memberCountAvailable, setMemberCountAvailable] = React.useState(true)
  const selected = groups.find(
    (contact) => contact.md5 === selectedId || contact.m_nsUsrName === selectedId
  )

  React.useEffect(() => {
    if (!open) return
    setKeyword('')
    setSelectedId(task?.target || task?.group || groups[0]?.md5 || '')
    setName(task?.name || '')
    setScheduleTime(task?.scheduleTime || '09:00')
    const persistedRange = task?.reportRange
    setReportRange(isScheduledReportRange(persistedRange) ? persistedRange : 'yesterday')
    setSelectedMessageTypes(task?.messageTypes?.length ? task.messageTypes : allMessageTypes)
    setTemplateId(task?.templateId || 'v1')
    setMemberNameMode(task?.memberNameMode || 'groupNickname')
    setTimeoutSeconds(task?.timeoutSeconds || 300)
    setRangeMessages([])
    setMemberCount(null)
    setMemberCountAvailable(true)
  }, [groups, open, task])

  React.useEffect(() => {
    if (!open || !selected) return
    setRangeLoading(true)
    const loadRange = async (): Promise<void> => {
      try {
        const range =
          reportRange === 'recent24h' ? null : getSummaryDateRange(reportRangeForUi(reportRange))
        const now = Math.floor(Date.now() / 1000)
        const messages = await window.api.getMessages(
          selected.md5,
          range?.startTime ?? now - 86400,
          range?.endTime ?? now
        )
        setRangeMessages(messages)
      } catch {
        setRangeMessages([])
      } finally {
        setRangeLoading(false)
      }
    }
    void loadRange()
  }, [open, reportRange, selected])

  React.useEffect(() => {
    if (!open || !selected) return
    const getGroupSnapshot = window.api.getGroupSnapshot
    if (typeof getGroupSnapshot !== 'function') {
      setMemberCountAvailable(false)
      return
    }
    let cancelled = false
    void getGroupSnapshot(selected.md5)
      .then((snapshot) => {
        if (cancelled) return
        setMemberCount(snapshot?.memberCount ?? snapshot?.members?.length ?? null)
      })
      .catch(() => {
        if (!cancelled) setMemberCountAvailable(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, selected])

  const filteredGroups = React.useMemo(() => {
    const lower = keyword.trim().toLowerCase()
    if (!lower) return groups
    return groups.filter((contact) =>
      `${contactDisplayName(contact)} ${contact.m_nsUsrName}`.toLowerCase().includes(lower)
    )
  }, [groups, keyword])
  const submit = async (): Promise<void> => {
    if (!selected || !name.trim()) return
    await onSubmit(
      {
        name: name.trim(),
        group: selected.md5,
        target: selected.m_nsUsrName,
        scheduleTime,
        reportRange,
        messageTypes: selectedMessageTypes,
        templateId,
        memberNameMode,
        timeoutSeconds
      },
      task?.id
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? '新建定时日报' : '编辑定时日报'}</DialogTitle>
          <DialogDescription>每天自动生成群聊日报，并发送到指定微信群。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-5">
          <label className="grid gap-2 text-sm font-medium">
            任务名称
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：技术交流 · 每日日报"
            />
          </label>
          <div className="grid gap-2">
            <span className="text-sm font-medium">选择群聊</span>
            <Input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="搜索群聊"
            />
            <div className="h-44 overflow-y-auto rounded-lg border border-border-subtle bg-muted/10 p-1">
              {filteredGroups.length ? (
                filteredGroups.map((contact) => {
                  const selectedRow = selected?.md5 === contact.md5
                  return (
                    <button
                      type="button"
                      key={contact.md5}
                      onClick={() => {
                        setSelectedId(contact.md5)
                        if (!name.trim()) setName(`${contactDisplayName(contact)} · 每日日报`)
                      }}
                      className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors ${selectedRow ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-accent'}`}
                    >
                      <GroupAvatar contact={contact} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {contactDisplayName(contact)}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          微信群聊 ·{' '}
                          {selectedRow
                            ? memberCountAvailable
                              ? memberCount === null
                                ? '成员信息加载中…'
                                : `${memberCount} 名成员`
                              : '成员信息暂不可用'
                            : '选择后读取成员数'}
                        </span>
                      </span>
                      <span
                        aria-hidden
                        className={`h-4 w-4 rounded-full border ${selectedRow ? 'border-primary bg-primary' : 'border-border'}`}
                      >
                        {selectedRow && (
                          <span className="mx-auto mt-1 block h-1.5 w-1.5 rounded-full bg-primary-foreground" />
                        )}
                      </span>
                    </button>
                  )
                })
              ) : (
                <p className="px-3 py-5 text-center text-sm text-muted-foreground">
                  没有匹配的群聊
                </p>
              )}
            </div>
          </div>
          <div className="grid gap-2">
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-medium">总结范围</span>
              <span className="text-xs text-muted-foreground">
                {rangeLoading ? '正在计算' : `${rangeMessages.length} 条消息`}
              </span>
            </div>
            <SegmentedControl
              className="w-full"
              aria-label="总结范围"
              value={reportRange}
              onValueChange={(value) => setReportRange(value as ScheduledReportRange)}
            >
              {SUMMARY_DATE_OPTIONS.map((option) => (
                <SegmentedControlItem
                  key={option.value}
                  value={option.value}
                  className="min-h-9 flex-1"
                >
                  {option.label}
                </SegmentedControlItem>
              ))}
              <SegmentedControlItem value="recent24h" className="min-h-9 flex-1">
                最近24小时
              </SegmentedControlItem>
              <span
                aria-disabled="true"
                title="当前业务尚未支持自定义时间"
                className="inline-flex min-h-8 min-w-0 flex-1 cursor-not-allowed items-center justify-center rounded-sm px-3 text-xs font-medium text-disabled-foreground opacity-100"
              >
                自定义 <small>即将支持</small>
              </span>
            </SegmentedControl>
          </div>
          <div className="grid gap-2">
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-medium">纳入的消息类型</span>
              <span className="text-xs text-muted-foreground">至少选择一种</span>
            </div>
            <div className="grid gap-1 rounded-lg border border-border-subtle p-2">
              {SUMMARY_TYPE_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className="flex items-start gap-2 rounded-md px-2 py-2 hover:bg-accent"
                >
                  <Checkbox
                    aria-label={option.label}
                    checked={selectedMessageTypes.includes(option.value)}
                    disabled={
                      selectedMessageTypes.length === 1 &&
                      selectedMessageTypes.includes(option.value)
                    }
                    onCheckedChange={() => {
                      setSelectedMessageTypes((current) =>
                        current.includes(option.value)
                          ? current.filter((item) => item !== option.value)
                          : [...current, option.value]
                      )
                    }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{option.label}</span>
                    <span className="block text-xs text-muted-foreground">
                      {option.description}
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {messageTypeCounts(rangeMessages)[option.value]}
                  </span>
                </label>
              ))}
            </div>
          </div>
          <div className="grid gap-2">
            <span className="text-sm font-medium">日报内容</span>
            <p className="text-xs text-muted-foreground">
              与普通日报相同，固定生成今日话题、重要消息、问题与解答、实用资源、精彩对话、活跃成员、活跃时间分布、关键词和内容密度。
            </p>
          </div>
          <div className="rounded-lg border border-border-subtle bg-muted/20 px-3 py-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <span className="font-medium">模型配置</span>
                <p className="mt-1 text-xs text-muted-foreground">
                  使用当前日报默认的文字总结和图片理解模型。
                </p>
              </div>
              {onOpenModelSettings && (
                <Button variant="link" size="sm" onClick={onOpenModelSettings}>
                  更改模型
                </Button>
              )}
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="grid gap-2 text-sm font-medium">
              日报模板
              <Select
                value={templateId}
                onValueChange={(value) => setTemplateId(value as SelectableReportTemplateId)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="z-modal">
                  <SelectItem value={DEFAULT_REPORT_TEMPLATE.id}>
                    {DEFAULT_REPORT_TEMPLATE.name}
                  </SelectItem>
                  {REPORT_TEMPLATES.map((template) => (
                    <SelectItem key={template.id} value={template.id}>
                      {template.label} · {template.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="grid gap-2 text-sm font-medium">
              成员名称
              <Select
                value={memberNameMode}
                onValueChange={(value) => setMemberNameMode(value as ScheduledReportMemberNameMode)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="z-modal">
                  <SelectItem value="groupNickname">群昵称</SelectItem>
                  <SelectItem value="wechatNickname">微信昵称</SelectItem>
                  <SelectItem value="remark">通讯录备注</SelectItem>
                </SelectContent>
              </Select>
            </label>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="grid gap-2 text-sm font-medium">
              执行时间
              <Input
                type="time"
                value={scheduleTime}
                onChange={(event) => setScheduleTime(event.target.value)}
              />
            </label>
            <label className="grid gap-2 text-sm font-medium">
              日报生成超时
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={30}
                  max={1800}
                  step={30}
                  value={timeoutSeconds}
                  onChange={(event) => setTimeoutSeconds(Number(event.target.value) || 300)}
                />
                <span className="text-sm text-muted-foreground">秒</span>
              </div>
            </label>
          </div>
          <div className="rounded-lg border border-border-subtle bg-muted/20 px-3 py-3 text-sm">
            <span className="text-muted-foreground">发送到</span>
            <span className="ml-2 font-medium">
              {selected ? contactDisplayName(selected) : '请选择微信群'}
            </span>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            微信数据库和聊天记录默认从本机读取。所选内容将发送至你配置的模型服务进行处理，TraceMemo
            本身不额外保存或转发内容。
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={busy || !selected || !name.trim() || !scheduleTime}
          >
            {busy ? '保存中…' : mode === 'create' ? '创建定时日报' : '保存修改'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ScheduledReportsWorkspace({
  contacts,
  platformSupported = true,
  onOpenWechatSettings,
  onOpenModelSettings,
  onNotice
}: ScheduledReportsWorkspaceProps): React.ReactElement {
  const [capability, setCapability] = React.useState<PersonalWechatSendCapability | null>(null)
  const [capabilityError, setCapabilityError] = React.useState(false)
  const [tasks, setTasks] = React.useState<ScheduledReportTask[]>([])
  const [executions, setExecutions] = React.useState<ScheduledReportExecution[]>([])
  const [loading, setLoading] = React.useState(true)
  const [listError, setListError] = React.useState(false)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [dialogMode, setDialogMode] = React.useState<ReportDialogMode>('create')
  const [editingTask, setEditingTask] = React.useState<ScheduledReportTask | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [deletingTask, setDeletingTask] = React.useState<ScheduledReportTask | null>(null)
  const [busyTaskId, setBusyTaskId] = React.useState<string | null>(null)

  const load = React.useCallback(async (): Promise<void> => {
    setLoading(true)
    setListError(false)
    if (!platformSupported) {
      setCapability({
        supported: false,
        ready: false,
        status: 'unsupported',
        capabilities: { text: false, image: false, voice: false },
        senderStatus: {} as PersonalWechatSendCapability['senderStatus'],
        message: '微信消息发送目前仅支持 macOS'
      })
      setTasks([])
      setExecutions([])
      setLoading(false)
      return
    }
    const [taskResult, executionResult, capabilityResult] = await Promise.allSettled([
      window.api.listScheduledReports(),
      window.api.listScheduledReportExecutions(),
      window.api.getPersonalWechatSendCapability()
    ])
    if (taskResult.status === 'fulfilled') setTasks(taskResult.value)
    else setListError(true)
    if (executionResult.status === 'fulfilled') setExecutions(executionResult.value)
    if (capabilityResult.status === 'fulfilled') {
      setCapability(capabilityResult.value)
      setCapabilityError(false)
    } else {
      setCapabilityError(true)
    }
    setLoading(false)
  }, [platformSupported])

  React.useEffect(() => {
    void load()
  }, [load])

  const refreshTasks = React.useCallback(async (): Promise<void> => {
    const [nextTasks, nextExecutions] = await Promise.all([
      window.api.listScheduledReports(),
      window.api.listScheduledReportExecutions()
    ])
    setTasks(nextTasks)
    setExecutions(nextExecutions)
  }, [])

  React.useEffect(() => {
    const timer = window.setInterval(() => {
      if (dialogOpen) return
      void refreshTasks().catch(() => undefined)
      void window.api
        .getPersonalWechatSendCapability()
        .then((nextCapability) => {
          setCapability(nextCapability)
          setCapabilityError(false)
        })
        .catch(() => setCapabilityError(true))
    }, 15_000)
    return () => window.clearInterval(timer)
  }, [dialogOpen, refreshTasks])

  const submit = async (input: ScheduledReportCreateInput, taskId?: string): Promise<void> => {
    setSaving(true)
    try {
      const result = taskId
        ? await window.api.updateScheduledReport(taskId, input)
        : await window.api.createScheduledReport(input)
      if (!result.success) {
        onNotice(readableError(result.error), 'destructive')
        return
      }
      setDialogOpen(false)
      await refreshTasks()
      onNotice(taskId ? '定时日报已更新' : '定时日报已创建', 'success')
    } catch (error) {
      onNotice(readableError(error instanceof Error ? error.message : String(error)), 'destructive')
    } finally {
      setSaving(false)
    }
  }

  const setEnabled = async (task: ScheduledReportTask, enabled: boolean): Promise<void> => {
    setBusyTaskId(task.id)
    try {
      const result = await window.api.setScheduledReportEnabled(task.id, enabled)
      if (!result.success) onNotice(readableError(result.error), 'destructive')
      else await refreshTasks()
    } catch (error) {
      onNotice(readableError(error instanceof Error ? error.message : String(error)), 'destructive')
    } finally {
      setBusyTaskId(null)
    }
  }

  const runNow = async (task: ScheduledReportTask): Promise<void> => {
    setBusyTaskId(task.id)
    try {
      const result = await window.api.runScheduledReportNow(task.id)
      await refreshTasks()
      if (!result.success)
        onNotice(readableError(result.error || result.data?.error), 'destructive')
      else onNotice('日报已生成并发送', 'success')
    } catch (error) {
      onNotice(readableError(error instanceof Error ? error.message : String(error)), 'destructive')
    } finally {
      setBusyTaskId(null)
    }
  }

  const confirmDelete = async (): Promise<void> => {
    if (!deletingTask) return
    setBusyTaskId(deletingTask.id)
    try {
      const result = await window.api.deleteScheduledReport(deletingTask.id)
      if (!result.success) onNotice(readableError(result.error), 'destructive')
      else {
        setDeletingTask(null)
        await refreshTasks()
        onNotice('定时日报已删除', 'success')
      }
    } catch (error) {
      onNotice(readableError(error instanceof Error ? error.message : String(error)), 'destructive')
    } finally {
      setBusyTaskId(null)
    }
  }

  const openCreate = (): void => {
    setDialogMode('create')
    setEditingTask(null)
    setDialogOpen(true)
  }

  const groupsById = React.useMemo(
    () => new Map(contacts.map((contact) => [contact.md5, contact])),
    [contacts]
  )
  const sortedExecutions = React.useMemo(
    () =>
      [...executions]
        .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
        .slice(0, 8),
    [executions]
  )
  const canCreate = capability?.status === 'ready'

  return (
    <div className="report-scheduled-page">
      <div className="report-scheduled-header">
        <div>
          <h1>定时日报</h1>
          <p>每天自动生成群聊日报，并发送到指定微信群。</p>
        </div>
        <Button onClick={openCreate} disabled={!canCreate}>
          <span aria-hidden>＋</span> 新建定时日报
        </Button>
      </div>
      <div className={`report-wechat-capability ${capabilityTone(capability)}`}>
        <span className="font-medium">微信发送能力</span>
        <span
          aria-hidden
          className={`ml-3 h-2 w-2 rounded-full ${capability?.status === 'ready' ? 'bg-success' : capability?.status === 'unsupported' ? 'bg-muted-foreground/50' : 'bg-warning'}`}
        />
        <span className="ml-3">
          {capabilityError ? '微信发送能力加载失败' : capabilityCopy(capability)}
        </span>
        {(capability?.status === 'needs_binding' ||
          capability?.status === 'unconfigured' ||
          capability?.status === 'needs_verification' ||
          capability?.status === 'error' ||
          capabilityError) && (
          <Button variant="link" size="sm" className="ml-auto" onClick={onOpenWechatSettings}>
            {capability?.status === 'needs_verification' ? '去检测' : '去配置'}
          </Button>
        )}
      </div>
      {listError && (
        <div className="flex items-center justify-between rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <span>加载定时日报失败，请重试。</span>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            重试
          </Button>
        </div>
      )}
      {loading ? (
        <div className="grid gap-3">
          {[0, 1, 2].map((item) => (
            <Skeleton key={item} className="h-24 w-full" />
          ))}
        </div>
      ) : tasks.length ? (
        <div className="overflow-x-auto rounded-xl border border-border-subtle bg-surface">
          <div className="min-w-[760px]">
            <div className="grid grid-cols-[1.5fr_.8fr_1fr_1fr_.8fr_1fr_190px] gap-3 border-b border-border-subtle px-5 py-3 text-xs font-medium text-muted-foreground">
              <span>任务名称</span>
              <span>执行时间</span>
              <span>日报范围</span>
              <span>发送目标</span>
              <span>状态</span>
              <span>下次执行</span>
              <span className="text-right">操作</span>
            </div>
            {tasks.map((task) => {
              const group = groupsById.get(task.group)
              const label = group ? contactDisplayName(group) : task.target || task.group
              const running = busyTaskId === task.id
              return (
                <div
                  key={task.id}
                  className="grid grid-cols-[1.5fr_.8fr_1fr_1fr_.8fr_1fr_190px] items-center gap-3 border-b border-border-subtle px-5 py-4 last:border-b-0"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    {group && <GroupAvatar contact={group} />}
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{task.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{label}</p>
                    </div>
                  </div>
                  <span className="text-sm">每天 {task.scheduleTime}</span>
                  <span className="text-sm text-muted-foreground">
                    {rangeLabel(task.reportRange)}
                  </span>
                  <span className="truncate text-sm text-muted-foreground">{label}</span>
                  <div className="flex items-center gap-2 text-xs">
                    <Switch
                      aria-label={`${task.name} ${task.enabled ? '已启用' : '已暂停'}`}
                      checked={task.enabled}
                      disabled={running}
                      onCheckedChange={(value) => void setEnabled(task, value)}
                    />
                    <span className={task.enabled ? 'text-success' : 'text-muted-foreground'}>
                      {task.enabled ? '已启用' : '已暂停'}
                    </span>
                  </div>
                  <span className="text-sm text-muted-foreground">
                    {task.enabled ? formatDateTime(task.nextRunAt) : '已暂停'}
                  </span>
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void runNow(task)}
                      disabled={running}
                    >
                      {running ? '生成中…' : '立即执行'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setDialogMode('edit')
                        setEditingTask(task)
                        setDialogOpen(true)
                      }}
                      disabled={running}
                    >
                      编辑
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setDeletingTask(task)}
                      disabled={running}
                    >
                      删除
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ) : (
        <div className="report-scheduled-empty">
          <div
            className="grid h-12 w-12 place-items-center rounded-xl bg-primary/10 text-2xl text-primary"
            aria-hidden
          >
            ◷
          </div>
          <h2>还没有定时日报</h2>
          <p>创建一个任务，让 TraceMemo 每天自动生成群聊日报并发送到微信。</p>
          <Button onClick={openCreate} disabled={!canCreate}>
            <span aria-hidden>＋</span> 新建定时日报
          </Button>
        </div>
      )}
      <section className="report-scheduled-executions">
        <div className="mb-3 flex items-end justify-between">
          <div>
            <h2>执行记录</h2>
            <p>最近几次定时日报执行结果</p>
          </div>
        </div>
        {sortedExecutions.length ? (
          <div className="grid gap-2">
            {sortedExecutions.map((execution) => {
              const task = tasks.find((item) => item.id === execution.taskId)
              const success = execution.status === 'success'
              return (
                <div
                  key={execution.id}
                  className="flex items-center gap-3 rounded-lg border border-border-subtle bg-surface px-4 py-3"
                >
                  <span
                    className={`text-lg ${success ? 'text-success' : execution.status === 'running' ? 'text-warning' : 'text-destructive'}`}
                    aria-hidden
                  >
                    {success ? '✓' : execution.status === 'running' ? '…' : '×'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{task?.name || '定时日报'}</p>
                    <p className="text-xs text-muted-foreground">{executionLabel(execution)}</p>
                  </div>
                  <time className="text-xs text-muted-foreground">
                    {formatDateTime(execution.finishedAt || execution.startedAt)}
                  </time>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-border-subtle px-4 py-6 text-center text-sm text-muted-foreground">
            暂无执行记录
          </p>
        )}
      </section>
      <ScheduledReportDialog
        open={dialogOpen}
        mode={dialogMode}
        task={editingTask}
        contacts={contacts}
        busy={saving}
        onOpenModelSettings={onOpenModelSettings}
        onOpenChange={setDialogOpen}
        onSubmit={submit}
      />
      <AlertDialog
        open={Boolean(deletingTask)}
        onOpenChange={(open) => !open && setDeletingTask(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除定时日报？</AlertDialogTitle>
            <AlertDialogDescription>删除后不会再自动生成和发送该日报。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(busyTaskId)}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault()
                void confirmDelete()
              }}
              disabled={Boolean(busyTaskId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
