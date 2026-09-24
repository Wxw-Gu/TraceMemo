import React from 'react'
import {
  Button,
  Checkbox,
  EmptyState,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '../../components/ui'
import type { Contact } from '../../../../shared/types'
import {
  GROUP_EXIT_NOTIFICATION_TEMPLATE,
  renderGroupExitMonitorNotification,
  type GroupExitMonitorEvent,
  type GroupExitMonitorState
} from '../../../../shared/group-exit-monitor'
import { BUILTIN_LEAVE_NOTIFICATION_RULE_ID } from '../../../../shared/automation'
import type { PersonalWechatSendCapability } from '../../../../shared/personal-wechat'
import { LeaveMonitorAutomationEntry } from './LeaveMonitorAutomationEntry'

type GroupSelectionFilter = 'all' | 'selected' | 'unselected'

/** 从「自动化 → 退群通知」跳回来时直接打开哪一页。 */
export interface GroupExitMonitorOpenViewRequest {
  view: 'events' | 'manage'
  requestId: number
}

interface GroupExitMonitorWorkspaceProps {
  dbReady: boolean
  contacts?: Contact[]
  onOpenSendSettings?: () => void
  /** 深链请求：直接落到「退群监控 → 管理群聊」。 */
  openViewRequest?: GroupExitMonitorOpenViewRequest | null
  /** 「退群通知自动化 →」：跳到自动化里对应的规则类型（纯导航）。 */
  onOpenLeaveNotificationAutomation?: () => void
}

const EMPTY_STATE: GroupExitMonitorState = {
  events: [],
  enabled: true,
  running: false,
  nativeMonitorActive: false,
  monitoredGroupCount: 0,
  monitorSelectionConfigured: true,
  monitoredRoomIds: [],
  lastReadAt: 0,
  unreadCount: 0
}

const formatDetectedAt = (timestamp: number): string =>
  new Date(timestamp).toLocaleString('zh-CN', { hour12: false })

const dayStart = (timestamp: number): number => {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

const formatLastChecked = (timestamp?: number): string => {
  if (!timestamp) return '尚未检查'
  const elapsed = Math.max(0, Date.now() - timestamp)
  if (elapsed < 60_000) return '刚刚'
  if (elapsed < 60 * 60_000) return `${Math.max(1, Math.floor(elapsed / 60_000))} 分钟前`
  return formatDetectedAt(timestamp)
}

const contactDisplayName = (contact: Contact): string =>
  contact.m_nsNickName?.trim() || contact.remark?.trim() || contact.m_nsUsrName || '未命名群聊'

const isGroupContact = (contact: Contact): boolean =>
  contact.type === 'group' || contact.m_nsUsrName?.trim().endsWith('@chatroom') === true

const contactRoomId = (contact: Contact): string => contact.m_nsUsrName.trim()

const sendCapabilityLabel = (capability: PersonalWechatSendCapability | null): string => {
  if (!capability) return '发送能力检查中'
  if (capability.ready && capability.capabilities.text) return '发送能力已就绪'
  if (capability.status === 'unsupported') return '发送能力不可用'
  return '发送能力未就绪'
}

const sendCapabilityTone = (capability: PersonalWechatSendCapability | null): string =>
  capability?.ready && capability.capabilities.text ? 'ready' : 'unready'

function SendCapabilityStatus({
  capability,
  className = ''
}: {
  capability: PersonalWechatSendCapability | null
  className?: string
}): React.ReactElement {
  const label = sendCapabilityLabel(capability)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={`exit-monitor-send-status ${sendCapabilityTone(capability)} ${className}`}
          tabIndex={0}
          aria-label={label}
        >
          <span className="exit-monitor-status-dot" aria-hidden="true" />
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{capability?.message || '正在读取微信发送能力'}</TooltipContent>
    </Tooltip>
  )
}

/*
 * 「退群监测模板」编辑入口**已从这里移除**。
 *
 * 模板的唯一编辑处现在是「自动化 → 规则 → 退群通知 → 3 · 通知内容」。
 * 退群监控只产生退群事实，不再持有通知模板 —— 两处可编辑必然漂移。
 */

function GroupAvatar({ contact }: { contact: Contact }): React.ReactElement {
  const name = contactDisplayName(contact)
  const initial = name.charAt(0) || '?'
  return (
    <span className="exit-monitor-group-avatar">
      {contact.avatar ? <img src={contact.avatar} alt="" aria-hidden="true" /> : initial}
    </span>
  )
}

interface ManageGroupsProps {
  groups: Contact[]
  selectedRoomIds: Set<string>
  sendCapability: PersonalWechatSendCapability | null
  keyword: string
  listFilter: GroupSelectionFilter
  saving: boolean
  dbReady: boolean
  onKeywordChange: (keyword: string) => void
  onListFilterChange: (filter: GroupSelectionFilter) => void
  onToggle: (roomId: string) => void
  onToggleAll: () => void
  onSave: () => void
  onCancel: () => void
}

function ManageGroups({
  groups,
  selectedRoomIds,
  sendCapability,
  keyword,
  listFilter,
  saving,
  dbReady,
  onKeywordChange,
  onListFilterChange,
  onToggle,
  onToggleAll,
  onSave,
  onCancel
}: ManageGroupsProps): React.ReactElement {
  const lowerKeyword = keyword.trim().toLowerCase()
  const filteredGroups = React.useMemo(() => {
    const keywordGroups = lowerKeyword
      ? groups.filter((contact) =>
          [contactDisplayName(contact), contactRoomId(contact), contact.remark].some((value) =>
            value?.toLowerCase().includes(lowerKeyword)
          )
        )
      : groups
    return keywordGroups.filter((group) => {
      const selected = selectedRoomIds.has(contactRoomId(group))
      return listFilter === 'all' || (listFilter === 'selected' ? selected : !selected)
    })
  }, [groups, listFilter, lowerKeyword, selectedRoomIds])
  const allGroupsSelected =
    groups.length > 0 && groups.every((group) => selectedRoomIds.has(contactRoomId(group)))

  return (
    <div className="exit-monitor-manage-page">
      <header className="exit-monitor-manage-header">
        <div>
          <button type="button" className="exit-monitor-back" onClick={onCancel}>
            <span aria-hidden="true">‹</span>
            返回退群监控
          </button>
          <span className="exit-monitor-eyebrow">监控范围</span>
          <h1>管理群聊</h1>
          <p>选择需要持续关注成员变化的群聊，保存后会重新建立成员快照。</p>
        </div>
        <div className="exit-monitor-manage-header-status">
          <SendCapabilityStatus capability={sendCapability} />
          <div className="exit-monitor-manage-count" aria-live="polite">
            已选择 <strong>{selectedRoomIds.size}</strong> 个群聊
          </div>
        </div>
      </header>

      <section
        className="exit-monitor-manage-section"
        aria-labelledby="exit-monitor-manage-list-title"
      >
        <div className="exit-monitor-manage-toolbar">
          <div>
            <span className="exit-monitor-eyebrow">群聊列表</span>
            <h2 id="exit-monitor-manage-list-title">选择监控群聊</h2>
          </div>
          <div className="exit-monitor-manage-tools">
            <Select
              value={listFilter}
              onValueChange={(value) => onListFilterChange(value as GroupSelectionFilter)}
            >
              <SelectTrigger aria-label="筛选群聊状态" className="exit-monitor-group-filter">
                <SelectValue placeholder="筛选状态" />
              </SelectTrigger>
              <SelectContent className="z-modal">
                <SelectItem value="all">全部</SelectItem>
                <SelectItem value="selected">已选择</SelectItem>
                <SelectItem value="unselected">未选择</SelectItem>
              </SelectContent>
            </Select>
            <label className="sr-only" htmlFor="exit-monitor-group-search">
              搜索群聊
            </label>
            <Input
              id="exit-monitor-group-search"
              value={keyword}
              onChange={(event) => onKeywordChange(event.target.value)}
              placeholder="搜索群聊"
              className="exit-monitor-group-search"
            />
            <Button variant="ghost" size="sm" onClick={onToggleAll} disabled={!groups.length}>
              {allGroupsSelected ? '取消全选' : '全选'}
            </Button>
          </div>
        </div>

        {!dbReady || !groups.length ? (
          <EmptyState
            className="exit-monitor-manage-empty"
            title={dbReady ? '没有可监控的群聊' : '数据库未连接'}
            description={
              dbReady
                ? '当前账号没有读取到群聊，会话列表刷新后可以重新尝试。'
                : '连接微信数据库后才能选择监控群聊。'
            }
          />
        ) : filteredGroups.length ? (
          <div className="exit-monitor-group-list">
            {filteredGroups.map((contact) => {
              const roomId = contactRoomId(contact)
              const name = contactDisplayName(contact)
              const checked = selectedRoomIds.has(roomId)
              return (
                <div key={roomId} className={`exit-monitor-group-row ${checked ? 'selected' : ''}`}>
                  <Checkbox
                    checked={checked}
                    onCheckedChange={() => onToggle(roomId)}
                    aria-label={`监控${name}`}
                  />
                  <GroupAvatar contact={contact} />
                  <span className="exit-monitor-group-row-body">
                    <strong>{name}</strong>
                    <span>
                      {contact.remark && contact.remark !== name ? contact.remark : roomId}
                    </span>
                  </span>
                  <span className="exit-monitor-group-row-status">
                    {checked ? '监控中' : '未选择'}
                  </span>
                </div>
              )
            })}
          </div>
        ) : (
          <EmptyState
            className="exit-monitor-manage-empty"
            title="没有匹配的群聊"
            description="换个关键词试试，或清空搜索条件查看全部群聊。"
          />
        )}
      </section>

      <footer className="exit-monitor-manage-footer">
        <span>
          保存后将从新的成员快照开始记录退群动态；退群通知发到哪里，请在「自动化 → 退群通知」里配置。
        </span>
        <div>
          <Button variant="ghost" onClick={onCancel} disabled={saving}>
            取消
          </Button>
          <Button onClick={onSave} disabled={!dbReady || saving}>
            {saving ? '保存中...' : '保存监控群聊'}
          </Button>
        </div>
      </footer>
    </div>
  )
}

export function GroupExitMonitorWorkspace({
  dbReady,
  contacts = [],
  onOpenSendSettings,
  openViewRequest,
  onOpenLeaveNotificationAutomation
}: GroupExitMonitorWorkspaceProps): React.ReactElement {
  const [state, setState] = React.useState<GroupExitMonitorState>(EMPTY_STATE)
  const [checking, setChecking] = React.useState(false)
  const [togglingEnabled, setTogglingEnabled] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState('')
  const [sendCapability, setSendCapability] = React.useState<PersonalWechatSendCapability | null>(
    null
  )
  const [selectedRoomId, setSelectedRoomId] = React.useState('all')
  const [view, setView] = React.useState<'events' | 'manage'>('events')
  const [copiedEventId, setCopiedEventId] = React.useState('')
  /**
   * 「复制退群信息」用的模板。
   *
   * 已迁到自动化规则；这里只是把它读回来给剪贴板用（见下面的 effect）。
   */
  const [copyNoticeTemplate, setCopyNoticeTemplate] = React.useState(
    GROUP_EXIT_NOTIFICATION_TEMPLATE
  )
  const copyResetTimer = React.useRef<number | null>(null)
  const [manageKeyword, setManageKeyword] = React.useState('')
  const [manageFilter, setManageFilter] = React.useState<GroupSelectionFilter>('all')
  const [selectedManageRoomIds, setSelectedManageRoomIds] = React.useState<Set<string>>(
    () => new Set()
  )

  const groups = React.useMemo(() => {
    const seen = new Set<string>()
    return contacts.filter(isGroupContact).filter((contact) => {
      const roomId = contactRoomId(contact)
      if (!roomId || seen.has(roomId)) return false
      seen.add(roomId)
      return true
    })
  }, [contacts])

  React.useEffect(() => {
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (!api || typeof api.getGroupExitMonitorState !== 'function') return
    let disposed = false
    const update = (next: GroupExitMonitorState): void => {
      if (!disposed) setState(next)
    }
    void api
      .getGroupExitMonitorState()
      .then(update)
      .catch((reason) => {
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason))
      })
    const unsubscribe =
      typeof api.onGroupExitMonitorState === 'function' ? api.onGroupExitMonitorState(update) : null
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [])

  React.useEffect(() => {
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (!api || typeof api.getPersonalWechatSendCapability !== 'function') return
    let disposed = false
    void api
      .getPersonalWechatSendCapability()
      .then((capability) => {
        if (!disposed) setSendCapability(capability)
      })
      .catch(() => {
        if (!disposed) setSendCapability(null)
      })
    return () => {
      disposed = true
    }
  }, [])

  // 「自动化 → 退群通知 → 管理监控群聊」深链过来时，直接落到管理群聊页。
  React.useEffect(() => {
    if (!openViewRequest) return
    setView(openViewRequest.view)
  }, [openViewRequest])

  /**
   * 「复制退群信息」用的模板。
   *
   * 模板**唯一来源**是「自动化 → 退群通知」规则 —— 退群监控自己不再持有模板。
   * 读不到就回落默认模板（复制功能本身不依赖自动化是否启用）。
   */
  React.useEffect(() => {
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (!api || typeof api.listAutomationRules !== 'function') return
    let disposed = false
    void api
      .listAutomationRules()
      .then((rules) => {
        if (disposed) return
        const rule = rules.find((item) => item.id === BUILTIN_LEAVE_NOTIFICATION_RULE_ID)
        const template = rule?.leaveNotification?.template?.trim()
        setCopyNoticeTemplate(template || GROUP_EXIT_NOTIFICATION_TEMPLATE)
      })
      .catch(() => undefined)
    return () => {
      disposed = true
    }
  }, [])

  React.useEffect(
    () => () => {
      if (copyResetTimer.current !== null) window.clearTimeout(copyResetTimer.current)
    },
    []
  )

  const groupOptions = React.useMemo(() => {
    const optionMap = new Map<string, { roomId: string; groupName: string; count: number }>()
    for (const event of state.events) {
      const roomId = event.roomId.trim()
      if (!roomId) continue
      const existing = optionMap.get(roomId)
      if (existing) {
        existing.count += 1
      } else {
        optionMap.set(roomId, {
          roomId,
          groupName: event.groupName || roomId,
          count: 1
        })
      }
    }
    return Array.from(optionMap.values()).sort((left, right) =>
      left.groupName.localeCompare(right.groupName, 'zh-CN')
    )
  }, [state.events])

  React.useEffect(() => {
    if (selectedRoomId === 'all') return
    if (!groupOptions.some((group) => group.roomId === selectedRoomId)) setSelectedRoomId('all')
  }, [groupOptions, selectedRoomId])

  const visibleEvents = React.useMemo(
    () =>
      selectedRoomId === 'all'
        ? state.events
        : state.events.filter((event) => event.roomId === selectedRoomId),
    [selectedRoomId, state.events]
  )
  const todayExitCount = React.useMemo(() => {
    const start = dayStart(Date.now())
    return state.events.filter((event) => event.detectedAt >= start).length
  }, [state.events])
  const setupEmpty =
    state.monitorSelectionConfigured === true && !(state.monitoredRoomIds || []).length

  const openManage = (): void => {
    const availableRoomIds = new Set(groups.map(contactRoomId))
    const defaultIds = state.monitorSelectionConfigured ? state.monitoredRoomIds || [] : []
    const selectedIds = new Set(defaultIds.filter((roomId) => availableRoomIds.has(roomId)))
    setSelectedManageRoomIds(selectedIds)
    setManageKeyword('')
    setManageFilter('all')
    setError('')
    setView('manage')
  }

  const checkNow = async (): Promise<void> => {
    const api = window.api
    if (checking || !dbReady || typeof api.checkGroupExitMonitorNow !== 'function') return
    setChecking(true)
    setError('')
    try {
      setState(await api.checkGroupExitMonitorNow())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setChecking(false)
    }
  }

  const clearEvents = async (): Promise<void> => {
    const api = window.api
    if (!state.events.length || typeof api.clearGroupExitMonitorEvents !== 'function') return
    setError('')
    try {
      setState(await api.clearGroupExitMonitorEvents())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  /**
   * 手动复制退群信息：按「自动化 → 退群通知」里的模板拼接当前事件，只写系统剪贴板，
   * 不触发任何微信发送，用户自行决定粘贴到哪里。
   *
   * 发送与重发**都不在这里** —— 通知由自动化执行，重发走执行日志。
   */
  const copyEventNotification = async (event: GroupExitMonitorEvent): Promise<void> => {
    const api = typeof window !== 'undefined' ? window.api : undefined
    const text = renderGroupExitMonitorNotification(event, copyNoticeTemplate)
    setError('')
    try {
      const result = api && typeof api.copyText === 'function' ? await api.copyText(text) : null
      if (!result?.success) throw new Error(result?.error || '复制失败，请重试')
      setCopiedEventId(event.id)
      if (copyResetTimer.current !== null) window.clearTimeout(copyResetTimer.current)
      copyResetTimer.current = window.setTimeout(() => {
        copyResetTimer.current = null
        setCopiedEventId('')
      }, 2_000)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const saveGroups = async (): Promise<void> => {
    const api = window.api
    if (saving || !dbReady || typeof api.setGroupExitMonitorGroups !== 'function') return
    setSaving(true)
    setError('')
    try {
      // 只保存**监控范围**：通知配置属于自动化，不从这一页写。
      const selectedIds = groups
        .map(contactRoomId)
        .filter((roomId) => selectedManageRoomIds.has(roomId))
      const nextState = await api.setGroupExitMonitorGroups(selectedIds)
      setState(nextState)
      setView('events')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  const setMonitorEnabled = async (enabled: boolean): Promise<void> => {
    const api = window.api
    if (togglingEnabled || typeof api.setGroupExitMonitorEnabled !== 'function') return
    setTogglingEnabled(true)
    setError('')
    try {
      setState(await api.setGroupExitMonitorEnabled(enabled))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setTogglingEnabled(false)
    }
  }

  const toggleManageGroup = (roomId: string): void => {
    setSelectedManageRoomIds((current) => {
      const next = new Set(current)
      if (next.has(roomId)) next.delete(roomId)
      else next.add(roomId)
      return next
    })
  }

  const toggleAllManageGroups = (): void => {
    const allRoomIds = groups.map(contactRoomId)
    const shouldSelect = allRoomIds.some((roomId) => !selectedManageRoomIds.has(roomId))
    setSelectedManageRoomIds((current) => {
      const next = new Set(current)
      allRoomIds.forEach((roomId) => {
        if (shouldSelect) next.add(roomId)
        else next.delete(roomId)
      })
      return next
    })
  }

  if (view === 'manage') {
    return (
      <ManageGroups
        groups={groups}
        selectedRoomIds={selectedManageRoomIds}
        sendCapability={sendCapability}
        keyword={manageKeyword}
        listFilter={manageFilter}
        saving={saving}
        dbReady={dbReady}
        onKeywordChange={setManageKeyword}
        onListFilterChange={setManageFilter}
        onToggle={toggleManageGroup}
        onToggleAll={toggleAllManageGroups}
        onSave={() => void saveGroups()}
        onCancel={() => setView('events')}
      />
    )
  }

  const statusLabel = !dbReady
    ? '数据库未连接'
    : !state.enabled
      ? '监控已暂停'
    : state.running && state.nativeMonitorActive
      ? '实时监听已启用'
      : state.running
        ? '已连接，等待原生监听'
        : '等待启动'

  return (
    <div className="exit-monitor-page">
      <header className="exit-monitor-header">
        <div>
          <span className="exit-monitor-eyebrow">群成员变化</span>
          <h1>退群监控</h1>
          <p>实时关注微信群成员变化，成员数量减少时自动留下退群动态。</p>
        </div>
        <div className="exit-monitor-header-actions">
          <label className="flex items-center gap-2 text-sm font-medium">
            <span>退群监控</span>
            <Switch
              checked={state.enabled}
              disabled={togglingEnabled}
              onCheckedChange={(checked) => void setMonitorEnabled(checked)}
              aria-label="退群监控总开关"
            />
          </label>
          <span className={`exit-monitor-status ${state.running ? 'running' : ''}`}>
            <span className="exit-monitor-status-dot" aria-hidden="true" />
            {statusLabel}
          </span>
          <SendCapabilityStatus capability={sendCapability} />
          {/*
            发送能力不完整时给一个可操作的去处。
            §「规则仍然可以保存」：这里只提示，不阻断任何编辑。
          */}
          {sendCapability &&
          !(sendCapability.ready && sendCapability.capabilities?.text) &&
          onOpenSendSettings ? (
            <Button variant="link" size="sm" onClick={onOpenSendSettings}>
              去设置发送能力
            </Button>
          ) : null}
          {/* 检测到退群之后做什么，归自动化管；这里只是个入口。 */}
          <LeaveMonitorAutomationEntry onOpen={onOpenLeaveNotificationAutomation} />
          <Button variant="outline" size="sm" onClick={openManage}>
            管理群聊
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void checkNow()}
            disabled={!dbReady || !state.enabled || checking}
          >
            {checking ? '检查中...' : '立即检查'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void clearEvents()}
            disabled={!state.events.length}
          >
            清空记录
          </Button>
        </div>
      </header>

      {setupEmpty ? (
        <section className="exit-monitor-setup-empty" aria-labelledby="exit-monitor-setup-title">
          <div className="exit-monitor-setup-icon" aria-hidden="true">
            <svg viewBox="0 0 48 48" focusable="false">
              <path d="M10 13.5h28v22H10z" />
              <path d="M16 20h16M16 26h10" />
              <path d="M34 9v9M29.5 13.5h9" />
            </svg>
          </div>
          <h2 id="exit-monitor-setup-title">还没有设置监控群聊</h2>
          <p>选择需要关注的群聊，TraceMemo 会在成员数量变化时及时提醒你。</p>
          <Button onClick={openManage}>选择群聊</Button>
        </section>
      ) : (
        <>
          <div className="exit-monitor-summary" aria-label="监控状态">
            <div>
              <strong>
                {state.monitorSelectionConfigured
                  ? (state.monitoredRoomIds || []).length
                  : state.monitoredGroupCount}
              </strong>
              <span>已监控群聊</span>
            </div>
            <div>
              <strong>{todayExitCount}</strong>
              <span>今日退群</span>
            </div>
            <div>
              <strong>{formatLastChecked(state.lastCheckedAt)}</strong>
              <span>最近检查</span>
            </div>
          </div>

          {error ? <p className="exit-monitor-error">{error}</p> : null}

          <section className="exit-monitor-events" aria-labelledby="exit-monitor-events-title">
            <div className="exit-monitor-section-heading">
              <div>
                <span className="exit-monitor-eyebrow">实时事件</span>
                <h2 id="exit-monitor-events-title">退群动态</h2>
              </div>
              <div className="exit-monitor-section-tools">
                {state.unreadCount > 0 ? (
                  <span className="exit-monitor-unread">{state.unreadCount} 条未读</span>
                ) : null}
                <Select
                  value={selectedRoomId}
                  onValueChange={setSelectedRoomId}
                  disabled={!groupOptions.length}
                >
                  <SelectTrigger aria-label="筛选退群群聊" className="exit-monitor-filter-trigger">
                    <SelectValue placeholder="筛选群聊" />
                  </SelectTrigger>
                  <SelectContent className="z-modal">
                    <SelectItem value="all">全部有退群记录的群聊</SelectItem>
                    {groupOptions.map((group) => (
                      <SelectItem key={group.roomId} value={group.roomId}>
                        {group.groupName}（{group.count} 条）
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="exit-monitor-event-list">
              {visibleEvents.length ? (
                visibleEvents.map((event) => (
                  <article key={event.id} className="exit-monitor-event">
                    <span className="exit-monitor-event-dot" aria-hidden="true" />
                    <div className="exit-monitor-event-body">
                      <div className="exit-monitor-event-heading">
                        <strong>{event.message}</strong>
                        <div className="exit-monitor-event-side">
                          <time dateTime={new Date(event.detectedAt).toISOString()}>
                            {formatDetectedAt(event.detectedAt)}
                          </time>
                          <Button
                            variant="link"
                            size="sm"
                            className="exit-monitor-event-copy"
                            onClick={() => void copyEventNotification(event)}
                            aria-label={`复制退群信息：${event.message}`}
                          >
                            {copiedEventId === event.id ? '已复制' : '复制退群信息'}
                          </Button>
                        </div>
                      </div>
                      {event.previousCount > event.currentCount ? (
                        <p className="exit-monitor-event-count">
                          群人数 {event.previousCount} 人 → {event.currentCount} 人
                        </p>
                      ) : null}
                      {/*
                        这里**不再显示通知状态**：发送结果归「自动化 → 执行日志」。
                        退群监控只对"谁、哪个群、什么时候、人数怎么变"负责。
                      */}
                      <dl className="exit-monitor-event-details">
                        <div>
                          <dt>微信名</dt>
                          <dd>{event.wechatName || '未读取到'}</dd>
                        </div>
                        <div>
                          <dt>群备注</dt>
                          <dd>{event.groupRemark || '未设置'}</dd>
                        </div>
                        {event.contactRemark ? (
                          <div>
                            <dt>通讯录备注</dt>
                            <dd>{event.contactRemark}</dd>
                          </div>
                        ) : null}
                        <div>
                          <dt>微信号</dt>
                          <dd>{event.memberWxid || '未读取到'}</dd>
                        </div>
                        <div>
                          <dt>退群时间</dt>
                          <dd>{formatDetectedAt(event.detectedAt)}</dd>
                        </div>
                      </dl>
                    </div>
                  </article>
                ))
              ) : (
                <EmptyState
                  className="exit-monitor-events-empty"
                  title={state.events.length ? '该群暂无退群记录' : '暂无退群记录'}
                  description={
                    state.events.length && selectedRoomId !== 'all'
                      ? '请选择其他有退群记录的群聊。'
                      : dbReady
                        ? '成员数量减少后，退群动态会自动显示在这里。'
                        : '连接微信数据库后，退群事件会显示在这里。'
                  }
                  action={
                    !state.events.length && dbReady && state.enabled ? (
                      <Button variant="outline" size="sm" onClick={() => void checkNow()}>
                        立即检查
                      </Button>
                    ) : undefined
                  }
                />
              )}
            </div>
          </section>
        </>
      )}
    </div>
  )
}
