import { app, BrowserWindow } from 'electron'
import fs from 'fs-extra'
import path from 'path'
import * as chat from './chat-service'
import { wechatActionGateway, type WechatActionGateway } from './wechat-action-gateway'
import {
  buildMemberLeftNotification,
  findRemovedGroupMembers,
  groupExitMemberName,
  normalizeGroupExitNotificationTemplate,
  validateGroupExitNotificationTemplate,
  type GroupExitMonitorEvent,
  type GroupExitMonitorMember,
  type GroupExitNotificationStatus,
  type GroupExitNotificationState,
  type GroupExitMonitorState
} from '../../shared/group-exit-monitor'

type StoredState = {
  accountRoot?: string
  events?: Partial<GroupExitMonitorEvent>[]
  lastReadAt?: number
  monitorSelectionConfigured?: boolean
  monitoredRoomIds?: string[]
  notificationRoomIds?: string[]
  notificationTemplate?: unknown
  snapshots?: Partial<StoredGroupSnapshot>[]
}

type GroupSnapshotRecord = {
  contactId: string
  roomId: string
  groupName: string
  capturedAt: number
  members: GroupExitMonitorMember[]
  /** 查询失败时保留旧快照。 */
  membersValid?: boolean
}

type GroupMembershipRecord = Omit<GroupSnapshotRecord, 'members'> & {
  memberIds: string[]
}

type MembershipMode = 'batch' | 'legacy'

type MembershipReadResult = {
  mode: MembershipMode
  groupCount: number
  groups: GroupMembershipRecord[] | null
}

type StoredGroupSnapshot = Pick<
  GroupSnapshotRecord,
  'contactId' | 'roomId' | 'groupName' | 'capturedAt' | 'members'
>

const DB_CHANGE_DEBOUNCE_MS = 350
const DUPLICATE_WINDOW_MS = 2 * 60 * 1000
const MAX_EVENTS = 500

export interface GroupExitMonitorServiceDependencies {
  actionGateway?: GroupExitActionGateway
}

type GroupExitActionGateway = Pick<WechatActionGateway, 'execute'> &
  Partial<
    Pick<WechatActionGateway, 'registerMemberEvent' | 'registerMemberEvents' | 'clearMemberEvents'>
  >

class GroupExitMonitorService {
  private readonly actionGateway: GroupExitActionGateway
  private active = false
  private nativeMonitorActive = false
  private snapshots = new Map<string, GroupSnapshotRecord>()
  private changeTimer: NodeJS.Timeout | null = null
  private checking = false
  private checkQueued = false
  private initializing = false
  private hydrating = false
  private hydrationQueue = new Set<string>()
  private hydrationBatchStartedAt: number | null = null
  private hydrationBatchGroups = 0
  private lastCheckedAt: number | undefined
  private lastReadAt = 0
  private events: GroupExitMonitorEvent[] = []
  private monitorSelectionConfigured = true
  private monitoredRoomIds = new Set<string>()
  private notificationRoomIds = new Set<string>()
  private loaded = false
  private accountRoot = ''
  private groupNamesByRoomId = new Map<string, string>()
  private groupNamesRefreshPending = true
  private eventSequence = 0
  private scopeGeneration = 0
  private legacyFallbackLogged = false
  private notificationTemplate = normalizeGroupExitNotificationTemplate(undefined)

  constructor(deps: GroupExitMonitorServiceDependencies = {}) {
    this.actionGateway = deps.actionGateway || wechatActionGateway
  }

  getState(): GroupExitMonitorState {
    this.ensureLoaded()
    return {
      events: [...this.events],
      running: this.active && chat.isReady(),
      nativeMonitorActive: this.nativeMonitorActive,
      monitoredGroupCount: this.snapshots.size,
      monitorSelectionConfigured: this.monitorSelectionConfigured,
      monitoredRoomIds: Array.from(this.monitoredRoomIds),
      notificationRoomIds: Array.from(this.notificationRoomIds),
      notificationTemplate: this.notificationTemplate,
      lastCheckedAt: this.lastCheckedAt,
      lastReadAt: this.lastReadAt,
      unreadCount: this.events.filter((event) => event.detectedAt > this.lastReadAt).length
    }
  }

  async start(nativeMonitorActive: boolean): Promise<void> {
    this.ensureLoaded()
    const currentRoot = chat.getCurrentAccountRoot()
    if (!currentRoot) {
      this.active = true
      this.nativeMonitorActive = nativeMonitorActive
      this.broadcast()
      return
    }
    if (
      (this.accountRoot && !sameAccountRoot(currentRoot, this.accountRoot)) ||
      (!this.accountRoot && this.snapshots.size > 0)
    ) {
      this.actionGateway.clearMemberEvents?.()
      this.events = []
      this.lastReadAt = 0
      this.monitorSelectionConfigured = true
      this.monitoredRoomIds.clear()
      this.notificationRoomIds.clear()
      this.snapshots.clear()
      this.groupNamesByRoomId.clear()
    }
    this.accountRoot = currentRoot
    this.groupNamesRefreshPending = true
    this.active = true
    this.nativeMonitorActive = nativeMonitorActive
    this.checkQueued = false
    this.initializing = true
    const scopeGeneration = ++this.scopeGeneration
    this.eventSequence += 1
    try {
      const checked = await this.runMembershipCheck(scopeGeneration)
      if (!this.active || this.scopeGeneration !== scopeGeneration) return
      if (!checked) {
        this.save()
        this.broadcast()
      }
    } finally {
      this.initializing = false
      if (this.checkQueued && this.active) {
        this.checkQueued = false
        void this.check()
      } else {
        this.startNextSnapshotHydration()
      }
    }
  }

  stop(): void {
    this.active = false
    this.nativeMonitorActive = false
    this.eventSequence += 1
    this.scopeGeneration += 1
    this.checkQueued = false
    this.hydrationQueue.clear()
    this.groupNamesRefreshPending = true
    if (this.changeTimer) clearTimeout(this.changeTimer)
    this.changeTimer = null
    this.broadcast()
  }

  notifyDatabaseChanged(rawPayload: string): void {
    if (!this.active || !isContactEvent(rawPayload)) return
    try {
      chat.getChatDb()?.getWcdb4Client().invalidateGroupNicknameCache()
    } catch {
      // 缓存清理失败时继续检查。
    }
    this.groupNamesRefreshPending = true
    if (this.changeTimer) clearTimeout(this.changeTimer)
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null
      void this.check()
    }, DB_CHANGE_DEBOUNCE_MS)
  }

  async checkNow(): Promise<GroupExitMonitorState> {
    if (!this.active && chat.isReady()) await this.start(false)
    await this.check()
    return this.getState()
  }

  async setMonitoredRoomIds(
    roomIds: string[],
    notificationRoomIds: string[] = []
  ): Promise<GroupExitMonitorState> {
    this.ensureLoaded()
    this.eventSequence += 1
    this.scopeGeneration += 1
    this.monitorSelectionConfigured = true
    const nextMonitoredRoomIds = normalizeRoomIds(roomIds)
    for (const roomId of this.snapshots.keys()) {
      if (!nextMonitoredRoomIds.has(roomId)) this.snapshots.delete(roomId)
    }
    for (const roomId of this.hydrationQueue) {
      if (!nextMonitoredRoomIds.has(roomId)) this.hydrationQueue.delete(roomId)
    }
    this.monitoredRoomIds = nextMonitoredRoomIds
    this.groupNamesRefreshPending = true
    const requestedNotifications = normalizeRoomIds(notificationRoomIds)
    this.notificationRoomIds = new Set(
      Array.from(requestedNotifications).filter((roomId) => this.monitoredRoomIds.has(roomId))
    )
    this.lastCheckedAt = undefined
    this.save()
    this.broadcast()
    // 建立基线放到后台，保存配置可以立即返回。
    if (this.active) void this.check()
    return this.getState()
  }

  setNotificationTemplate(value: unknown): GroupExitMonitorState {
    this.ensureLoaded()
    const result = validateGroupExitNotificationTemplate(value)
    if (!result.valid || !result.template) {
      throw new Error(result.error || '退群监测模板无效')
    }
    this.notificationTemplate = result.template
    this.save()
    this.broadcast()
    return this.getState()
  }

  clearEvents(): GroupExitMonitorState {
    this.ensureLoaded()
    this.events = []
    this.actionGateway.clearMemberEvents?.()
    this.lastReadAt = Date.now()
    this.save()
    this.broadcast()
    return this.getState()
  }

  markRead(readAt?: number): GroupExitMonitorState {
    this.ensureLoaded()
    this.lastReadAt = Math.max(this.lastReadAt, Number(readAt) || Date.now())
    this.save()
    this.broadcast()
    return this.getState()
  }

  private async check(): Promise<void> {
    const currentRoot = chat.getCurrentAccountRoot()
    if (
      !this.active ||
      !chat.isReady() ||
      !currentRoot ||
      !this.accountRoot ||
      !sameAccountRoot(currentRoot, this.accountRoot)
    )
      return
    if (this.initializing || this.hydrating) {
      this.checkQueued = true
      return
    }
    if (this.checking) {
      this.checkQueued = true
      return
    }

    this.checking = true
    const scopeGeneration = this.scopeGeneration
    try {
      await this.runMembershipCheck(scopeGeneration)
    } finally {
      this.checking = false
      if (this.checkQueued && this.active) {
        this.checkQueued = false
        void this.check()
      } else {
        this.startNextSnapshotHydration()
      }
    }
  }

  private async runMembershipCheck(scopeGeneration: number): Promise<boolean> {
    const startedAt = Date.now()
    const result = await this.readMemberships()
    const membershipCostMs = Date.now() - startedAt
    let changedGroups = 0
    if (result.groups && this.active && scopeGeneration === this.scopeGeneration) {
      changedGroups = await this.applyCurrentMemberships(result.groups, scopeGeneration)
    }
    console.log(
      `[GroupMonitor] check mode=${result.mode} groups=${result.groupCount} membershipCostMs=${membershipCostMs} changedGroups=${changedGroups} totalCostMs=${Date.now() - startedAt}`
    )
    return result.groups !== null
  }

  private async readMemberships(): Promise<MembershipReadResult> {
    await this.refreshGroupNamesIfNeeded()
    const database = chat.getChatDb()
    const roomIds = Array.from(this.monitoredRoomIds)
    const batchAvailable = chat.isGroupMemberIdsBatchAvailable()
    const mode: MembershipMode = batchAvailable ? 'batch' : 'legacy'
    if (!database) return { mode, groupCount: roomIds.length, groups: null }
    try {
      const client = database.getWcdb4Client()
      const capturedAt = Date.now()

      if (batchAvailable) {
        const snapshots = await chat.getGroupMemberIdsBatchAsync(roomIds)
        if (!snapshots) return { mode, groupCount: roomIds.length, groups: null }
        return {
          mode,
          groupCount: roomIds.length,
          groups: snapshots.map((snapshot) => {
            const previous = this.snapshots.get(snapshot.roomId)
            return {
              contactId: previous?.contactId || client.md5(snapshot.roomId),
              roomId: snapshot.roomId,
              groupName: resolveGroupName(snapshot.roomId, this.groupNamesByRoomId, previous),
              capturedAt,
              memberIds: normalizeMemberIds(snapshot.memberIds),
              membersValid: snapshot.status === 'ok'
            }
          })
        }
      }

      if (!this.legacyFallbackLogged) {
        this.legacyFallbackLogged = true
        console.warn('[GroupMonitor] batch membership unavailable; using legacy fallback')
      }
      const groups: GroupMembershipRecord[] = []
      for (const roomId of roomIds) {
        const previous = this.snapshots.get(roomId)
        const snapshot = await chat.getGroupMemberIdsAsync(roomId)
        groups.push({
          contactId: previous?.contactId || client.md5(roomId),
          roomId,
          groupName: resolveGroupName(roomId, this.groupNamesByRoomId, previous),
          capturedAt,
          memberIds: snapshot?.roomId === roomId ? normalizeMemberIds(snapshot.memberIds) : [],
          membersValid: snapshot?.roomId === roomId
        })
      }
      return { mode, groupCount: roomIds.length, groups }
    } catch (error) {
      console.warn('[GroupMonitor] 读取群成员状态失败:', error)
      return { mode, groupCount: roomIds.length, groups: null }
    }
  }

  private async applyCurrentMemberships(
    groups: GroupMembershipRecord[],
    scopeGeneration: number
  ): Promise<number> {
    const notifications: Array<{ group: GroupSnapshotRecord; event: GroupExitMonitorEvent }> = []
    let changedGroups = 0
    for (const membership of groups) {
      if (!this.active || scopeGeneration !== this.scopeGeneration) return changedGroups
      if (membership.membersValid === false) continue
      const previous = this.snapshots.get(membership.roomId)
      // 空数组可能是查询失败，先保留旧基线，避免误报和覆盖最后有效快照。
      if (previous && previous.members.length > 0 && membership.memberIds.length === 0) continue

      const previousMembers = new Map(previous?.members.map((member) => [member.wxid, member]))
      const next: GroupSnapshotRecord = {
        contactId: membership.contactId,
        roomId: membership.roomId,
        groupName:
          membership.groupName === membership.roomId && previous
            ? previous.groupName
            : membership.groupName,
        capturedAt: membership.capturedAt,
        members: membership.memberIds.map(
          (wxid) => previousMembers.get(wxid) || ({ wxid } satisfies GroupExitMonitorMember)
        ),
        membersValid: true
      }
      const membershipChanged = !previous || !sameMemberIds(previous.members, membership.memberIds)
      if (membershipChanged) changedGroups += 1

      if (previous && next.members.length < previous.members.length) {
        const removed = findRemovedGroupMembers(previous.members, next.members)
        for (const member of removed) {
          const event = this.recordExit(next, member, previous.members.length, next.members.length)
          if (event && this.notificationRoomIds.has(next.roomId)) {
            notifications.push({ group: next, event })
          }
        }
      }

      // Last Good Snapshot 必须在 Diff 完成后才能替换。
      this.snapshots.set(next.roomId, next)
      if (next.members.some((member) => !hasMemberMetadata(member))) {
        this.hydrationQueue.add(next.roomId)
      }
    }

    if (!this.active || scopeGeneration !== this.scopeGeneration) return changedGroups
    this.lastCheckedAt = Date.now()
    // 先把事件和新基线作为同一检查点落盘，再执行可失败的通知动作。
    this.save()
    this.broadcast()
    if (notifications.length) {
      await Promise.all(notifications.map(({ group, event }) => this.notifyGroup(group, event)))
    }
    return changedGroups
  }

  private startNextSnapshotHydration(): void {
    if (!this.active) {
      this.finishHydrationBatch()
      return
    }
    if (this.initializing || this.checking || this.hydrating) return
    if (this.checkQueued || this.changeTimer) {
      this.finishHydrationBatch()
      return
    }

    const roomId = this.hydrationQueue.values().next().value as string | undefined
    if (!roomId) {
      this.finishHydrationBatch()
      return
    }
    this.hydrationQueue.delete(roomId)
    const baseline = this.snapshots.get(roomId)
    if (!baseline || !this.monitoredRoomIds.has(roomId)) {
      this.startNextSnapshotHydration()
      return
    }

    this.hydrating = true
    if (this.hydrationBatchStartedAt === null) this.hydrationBatchStartedAt = Date.now()
    this.hydrationBatchGroups += 1
    const scopeGeneration = this.scopeGeneration
    void chat
      .getGroupSnapshotAsync(baseline.contactId)
      .then((snapshot) => {
        const current = this.snapshots.get(roomId)
        if (
          !snapshot ||
          snapshot.roomId !== roomId ||
          !this.active ||
          scopeGeneration !== this.scopeGeneration ||
          !current ||
          !sameMemberIds(
            current.members,
            snapshot.members.map((member) => member.wxid)
          )
        )
          return

        const hydrated = new Map(
          normalizeSnapshotMembers(snapshot.members).map((member) => [member.wxid, member])
        )
        this.snapshots.set(roomId, {
          ...current,
          groupName: resolveGroupName(roomId, this.groupNamesByRoomId, current, snapshot.groupName),
          members: current.members.map((member) => {
            const refreshed = hydrated.get(member.wxid)
            return refreshed ? { ...member, ...refreshed } : member
          })
        })
        this.hydrationQueue.delete(roomId)
        this.save()
        this.broadcast()
      })
      .catch(() => undefined)
      .finally(() => {
        this.hydrating = false
        if (this.checkQueued && this.active) {
          this.finishHydrationBatch()
          this.checkQueued = false
          void this.check()
        } else if (this.changeTimer) {
          this.finishHydrationBatch()
        } else {
          this.startNextSnapshotHydration()
        }
      })
  }

  private finishHydrationBatch(): void {
    if (this.hydrationBatchStartedAt === null || this.hydrationBatchGroups === 0) return
    console.log(
      `[GroupMonitor] hydration groups=${this.hydrationBatchGroups} costMs=${Date.now() - this.hydrationBatchStartedAt}`
    )
    this.hydrationBatchStartedAt = null
    this.hydrationBatchGroups = 0
  }

  private async refreshGroupNamesIfNeeded(): Promise<void> {
    if (!this.groupNamesRefreshPending) return
    this.groupNamesRefreshPending = false
    try {
      const names = await chat.getGroupNamesAsync()
      for (const [roomId, name] of Object.entries(names || {})) {
        const resolved = normalizeKnownGroupName(roomId, name)
        if (resolved) this.groupNamesByRoomId.set(roomId, resolved)
      }
    } catch {
      // Session 群名是展示信息；读取失败时继续使用快照中的已知群名。
    }
  }

  private recordExit(
    group: GroupSnapshotRecord,
    member: GroupExitMonitorMember,
    previousCount: number,
    currentCount: number
  ): GroupExitMonitorEvent | null {
    const memberName = groupExitMemberName(member)
    const wechatName = String(member.wechatNickname || '').trim()
    const groupRemark = String(member.groupNickname || '').trim()
    const contactRemark = String(member.remark || '').trim()
    const detectedAt = Date.now()
    const message = `${memberName}退出了${group.groupName}`
    const duplicate = this.events.some(
      (event) =>
        event.roomId === group.roomId &&
        event.memberWxid === member.wxid &&
        event.previousCount === previousCount &&
        event.currentCount === currentCount &&
        Math.abs(event.detectedAt - detectedAt) < DUPLICATE_WINDOW_MS
    )
    if (duplicate) return null
    const event: GroupExitMonitorEvent = {
      id: `${group.roomId}:${member.wxid}:${detectedAt}:${this.eventSequence++}`,
      contactId: group.contactId,
      roomId: group.roomId,
      groupName: group.groupName,
      memberWxid: member.wxid,
      memberName,
      wechatName,
      groupRemark,
      contactRemark,
      previousCount,
      currentCount,
      delta: currentCount - previousCount,
      message,
      detectedAt,
      notificationStatus: 'not_requested'
    }
    this.actionGateway.registerMemberEvent?.(event)
    this.events = [event, ...this.events].slice(0, MAX_EVENTS)
    console.log(
      `[GroupMonitor] detected member exit roomId=${group.roomId} member=${member.wxid} ${previousCount}->${currentCount}`
    )
    return event
  }

  private async notifyGroup(
    group: GroupSnapshotRecord,
    event: GroupExitMonitorEvent
  ): Promise<void> {
    event.notificationStatus = 'pending'
    event.notification = { status: 'pending' }
    this.save()
    this.broadcast()
    try {
      const result = await this.actionGateway.execute({
        idempotencyKey: `member_left_notification:${event.id}`,
        origin: 'member_monitor',
        purpose: 'member_left_notification',
        triggerType: 'automation',
        sourceId: event.id,
        recipient: {
          type: 'group',
          id: group.roomId,
          name: group.groupName
        },
        content: {
          type: 'text',
          text: buildMemberLeftNotification(event, this.notificationTemplate)
        },
        metadata: {
          memberId: event.memberWxid,
          memberName: event.memberName,
          detectedAt: event.detectedAt,
          eventType: 'member_left',
          eventRoomId: event.roomId
        }
      })
      const notification: GroupExitNotificationState = {
        status: result.status,
        actionId: result.actionId,
        decision: result.decision,
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
        startedAt: result.startedAt,
        finishedAt: result.finishedAt
      }
      event.notificationStatus = result.status
      event.notification = notification
      if (result.status !== 'sent') {
        console.warn(
          `[GroupMonitor] 群聊通知未发送 roomId=${group.roomId} status=${result.status} code=${result.errorCode || ''}`
        )
      }
    } catch (error) {
      event.notificationStatus = 'failed'
      event.notification = {
        status: 'failed',
        errorCode: 'UNKNOWN',
        reason: error instanceof Error ? error.message : String(error)
      }
      console.warn(
        `[GroupMonitor] 群聊通知异常 roomId=${group.roomId}:`,
        error instanceof Error ? error.message : String(error)
      )
    } finally {
      this.save()
      this.broadcast()
    }
  }

  private filePath(): string {
    return path.join(app.getPath('userData'), 'group-exit-monitor.json')
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const stored = fs.readJsonSync(this.filePath()) as StoredState
      this.events = normalizeEvents(stored.events)
      this.actionGateway.registerMemberEvents?.(this.events)
      this.lastReadAt = Number(stored.lastReadAt) || 0
      this.accountRoot = String(stored.accountRoot || '')
      // 没有显式范围时按空范围处理，保留已有选择。
      this.monitorSelectionConfigured = true
      this.monitoredRoomIds = normalizeRoomIds(stored.monitoredRoomIds || [])
      this.notificationRoomIds = new Set(
        Array.from(normalizeRoomIds(stored.notificationRoomIds || [])).filter((roomId) =>
          this.monitoredRoomIds.has(roomId)
        )
      )
      this.notificationTemplate = normalizeGroupExitNotificationTemplate(
        stored.notificationTemplate
      )
      this.snapshots = normalizeSnapshots(stored.snapshots, this.monitoredRoomIds)
    } catch {
      // 首次启动或文件损坏时从空记录开始。
      this.events = []
      this.lastReadAt = 0
      this.monitorSelectionConfigured = true
      this.monitoredRoomIds.clear()
      this.notificationRoomIds.clear()
      this.notificationTemplate = normalizeGroupExitNotificationTemplate(undefined)
      this.snapshots.clear()
    }
  }

  private save(): void {
    this.ensureLoaded()
    try {
      fs.ensureDirSync(path.dirname(this.filePath()))
      fs.writeJsonSync(
        this.filePath(),
        {
          accountRoot: this.accountRoot,
          events: this.events,
          lastReadAt: this.lastReadAt,
          monitorSelectionConfigured: this.monitorSelectionConfigured,
          monitoredRoomIds: Array.from(this.monitoredRoomIds),
          notificationRoomIds: Array.from(this.notificationRoomIds),
          notificationTemplate: this.notificationTemplate,
          snapshots: Array.from(this.snapshots.values(), toStoredSnapshot)
        },
        { spaces: 2 }
      )
    } catch (error) {
      console.warn('[GroupMonitor] 保存状态失败:', error)
    }
  }

  private broadcast(): void {
    const state = this.getState()
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('group-exit-monitor:state', state)
    }
  }
}

function normalizeRoomIds(roomIds: string[]): Set<string> {
  return new Set(
    (Array.isArray(roomIds) ? roomIds : [])
      .map((roomId) => String(roomId || '').trim())
      .filter((roomId) => roomId.endsWith('@chatroom'))
  )
}

function normalizeMemberIds(values: unknown[]): string[] {
  return Array.from(
    new Set(values.map((value) => String(value || '').trim()).filter((value) => Boolean(value)))
  )
}

function sameMemberIds(previous: GroupExitMonitorMember[], nextIds: string[]): boolean {
  if (previous.length !== nextIds.length) return false
  const previousIds = new Set(previous.map((member) => member.wxid))
  return nextIds.every((wxid) => previousIds.has(wxid))
}

function hasMemberMetadata(member: GroupExitMonitorMember): boolean {
  return Boolean(
    member.nickname?.trim() ||
    member.groupNickname?.trim() ||
    member.wechatNickname?.trim() ||
    member.remark?.trim()
  )
}

function sameAccountRoot(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return normalize(left) === normalize(right)
}

function normalizeSnapshots(
  values: Partial<StoredGroupSnapshot>[] | undefined,
  monitoredRoomIds: Set<string>
): Map<string, GroupSnapshotRecord> {
  const snapshots = new Map<string, GroupSnapshotRecord>()
  if (!Array.isArray(values)) return snapshots
  for (const value of values) {
    const roomId = String(value?.roomId || '').trim()
    const capturedAt = Number(value?.capturedAt)
    if (
      !roomId.endsWith('@chatroom') ||
      !monitoredRoomIds.has(roomId) ||
      !Number.isFinite(capturedAt) ||
      capturedAt <= 0 ||
      !Array.isArray(value?.members)
    ) {
      continue
    }
    snapshots.set(roomId, {
      contactId: String(value.contactId || ''),
      roomId,
      groupName: cleanGroupName(value.groupName, roomId),
      capturedAt,
      members: normalizeSnapshotMembers(value.members)
    })
  }
  return snapshots
}

function normalizeSnapshotMembers(values: GroupExitMonitorMember[]): GroupExitMonitorMember[] {
  const members: GroupExitMonitorMember[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const wxid = String(value?.wxid || '').trim()
    if (!wxid || seen.has(wxid)) continue
    seen.add(wxid)
    members.push({
      wxid,
      ...optionalMemberField('nickname', value.nickname),
      ...optionalMemberField('groupNickname', value.groupNickname),
      ...optionalMemberField('wechatNickname', value.wechatNickname),
      ...optionalMemberField('remark', value.remark),
      ...optionalMemberField('avatar', value.avatar)
    })
  }
  return members
}

function optionalMemberField<K extends keyof GroupExitMonitorMember>(
  key: K,
  value: unknown
): Partial<Pick<GroupExitMonitorMember, K>> {
  const normalized = String(value || '').trim()
  return normalized ? ({ [key]: normalized } as Pick<GroupExitMonitorMember, K>) : {}
}

function normalizeKnownGroupName(roomId: string, value: unknown): string {
  const name = String(value || '').trim()
  return name && name !== roomId && !name.endsWith('@chatroom') ? name : ''
}

function resolveGroupName(
  roomId: string,
  namesByRoomId: Map<string, string>,
  previous?: Pick<GroupSnapshotRecord, 'groupName'>,
  hydratedName?: unknown
): string {
  return (
    normalizeKnownGroupName(roomId, namesByRoomId.get(roomId)) ||
    normalizeKnownGroupName(roomId, previous?.groupName) ||
    normalizeKnownGroupName(roomId, hydratedName) ||
    roomId
  )
}

function toStoredSnapshot(snapshot: GroupSnapshotRecord): StoredGroupSnapshot {
  return {
    contactId: snapshot.contactId,
    roomId: snapshot.roomId,
    groupName: snapshot.groupName,
    capturedAt: snapshot.capturedAt,
    members: normalizeSnapshotMembers(snapshot.members)
  }
}

function cleanGroupName(value: string | undefined, roomId: string): string {
  const name = String(value || '').trim()
  return name && name !== roomId && !name.startsWith('wxid_') ? name : roomId
}

function normalizeEvents(
  values: Partial<GroupExitMonitorEvent>[] | undefined
): GroupExitMonitorEvent[] {
  if (!Array.isArray(values)) return []
  const normalized: GroupExitMonitorEvent[] = []
  for (const value of values) {
    const memberName = String(value.memberName || '').trim()
    const groupName = String(value.groupName || '').trim()
    const roomId = String(value.roomId || '').trim()
    const previousCount = Number(value.previousCount)
    const currentCount = Number(value.currentCount)
    const detectedAt = Number(value.detectedAt)
    // 旧记录没有人数变化，无法确认退群，直接忽略。
    if (
      !memberName ||
      !groupName ||
      !roomId ||
      !Number.isFinite(previousCount) ||
      !Number.isFinite(currentCount) ||
      previousCount <= currentCount ||
      previousCount <= 0 ||
      !Number.isFinite(detectedAt) ||
      detectedAt <= 0
    ) {
      continue
    }
    const memberWxid = String(value.memberWxid || '').trim()
    const duplicate = normalized.some(
      (event) =>
        event.roomId === roomId &&
        event.memberWxid === memberWxid &&
        event.previousCount === previousCount &&
        event.currentCount === currentCount &&
        Math.abs(event.detectedAt - detectedAt) < DUPLICATE_WINDOW_MS
    )
    if (duplicate) continue
    normalized.push({
      id: String(value.id || `${roomId}:${memberWxid || memberName}:${detectedAt}`),
      contactId: String(value.contactId || ''),
      roomId,
      groupName,
      memberWxid,
      memberName,
      wechatName: String(value.wechatName || '').trim(),
      groupRemark: String(value.groupRemark || '').trim(),
      contactRemark: String(value.contactRemark || '').trim(),
      previousCount,
      currentCount,
      delta: Number.isFinite(Number(value.delta))
        ? Number(value.delta)
        : currentCount - previousCount,
      message: String(value.message || `${memberName}退出了${groupName}`),
      detectedAt,
      ...(value.notificationStatus
        ? { notificationStatus: normalizeNotificationStatus(value.notificationStatus) }
        : {}),
      ...(value.notification && typeof value.notification === 'object'
        ? { notification: normalizeNotification(value.notification) }
        : {})
    })
    if (normalized.length >= MAX_EVENTS) break
  }
  return normalized
}

function normalizeNotificationStatus(value: unknown): GroupExitNotificationStatus {
  const status = String(value || '').trim()
  return status === 'pending' || status === 'sent' || status === 'blocked' || status === 'failed'
    ? status
    : 'not_requested'
}

function normalizeNotification(value: object): GroupExitNotificationState {
  const input = value as Partial<GroupExitNotificationState>
  return {
    status: normalizeNotificationStatus(input.status),
    ...(input.actionId ? { actionId: String(input.actionId) } : {}),
    ...(input.decision === 'allow' || input.decision === 'block'
      ? { decision: input.decision }
      : {}),
    ...(input.errorCode ? { errorCode: String(input.errorCode) } : {}),
    ...(input.reason ? { reason: String(input.reason) } : {}),
    ...(input.startedAt ? { startedAt: String(input.startedAt) } : {}),
    ...(input.finishedAt ? { finishedAt: String(input.finishedAt) } : {})
  }
}

function isContactEvent(rawPayload: string): boolean {
  const payload = String(rawPayload || '').trim()
  if (!payload) return false
  try {
    const parsed = JSON.parse(payload) as { table?: unknown }
    return String(parsed.table || '').toLowerCase() === 'contact'
  } catch {
    return /["']table["']\s*:\s*["']contact["']/i.test(payload)
  }
}

export const groupExitMonitorService = new GroupExitMonitorService()

export { GroupExitMonitorService }
