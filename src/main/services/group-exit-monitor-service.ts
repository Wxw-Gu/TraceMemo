import { app, BrowserWindow } from 'electron'
import fs from 'fs-extra'
import path from 'path'
import * as chat from './chat-service'
import {
  findRemovedGroupMembers,
  groupExitMemberName,
  type GroupExitMonitorEvent,
  type GroupExitMonitorMember,
  type GroupExitMonitorState
} from '../../shared/group-exit-monitor'
import {
  toGroupMemberExitedEvent,
  type GroupMemberExitedEvent
} from '../../shared/group-exit-event'

type StoredState = {
  enabled?: boolean
  accountRoot?: string
  events?: Partial<GroupExitMonitorEvent>[]
  lastReadAt?: number
  monitorSelectionConfigured?: boolean
  monitoredRoomIds?: string[]
  snapshots?: Partial<StoredGroupSnapshot>[]
  /*
   * 历史遗留字段（`notificationRoomIds` / `notificationTemplate`）**刻意不再声明**。
   *
   * 它们已经迁到「自动化 → 退群通知」规则里，本服务运行期不再读、不再写。
   * 旧状态文件原样保留在磁盘上（迁移时另有一份 backup），只是没有任何读取方 ——
   * 这是"不双读"的落地方式。迁移逻辑在 `automation-rule-store.ts`。
   */
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
/**
 * **只约束「一次状态回传带多少条」**，不是存储上限。
 *
 * 事件现在写在 append-only 的 JSONL 里（`eventsPath()`），**永久保留、不做截断**。
 * 之所以必须把「存储」和「回传」分开：状态文件是整体重写的（`save()`），
 * 事件留在里面时每来一条新事件都要重写整个文件 —— 越写越慢。
 * 而 `getState()` 每次都把结果推过 IPC，也不能无上限。
 */
const MAX_EVENTS = 500

/**
 * 退群事件处理器。
 *
 * 由主进程注入成 `automationService.handleGroupExit` —— 本服务**不再自己发送**。
 * 契约：**必须自己吞掉异常**（实现方负责），本服务也会再兜一层。
 */
export type GroupExitEventHandler = (event: GroupMemberExitedEvent) => void | Promise<void>

export interface GroupExitMonitorServiceDependencies {
  onGroupExit?: GroupExitEventHandler
}

class GroupExitMonitorService {
  private onGroupExit: GroupExitEventHandler | undefined
  private active = false
  private enabled = true
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
  private loaded = false
  private accountRoot = ''
  private groupNamesByRoomId = new Map<string, string>()
  private groupNamesRefreshPending = true
  private eventSequence = 0
  private scopeGeneration = 0
  private legacyFallbackLogged = false

  constructor(deps: GroupExitMonitorServiceDependencies = {}) {
    this.onGroupExit = deps.onGroupExit
  }

  /**
   * 注入退群事件处理器（主进程在 AutomationService 初始化后调用）。
   *
   * 用 setter 而不是构造参数：AutomationService 依赖 `Wcdb4Client`，
   * 要等数据库解锁后才存在，而本服务是模块级单例。
   */
  setGroupExitHandler(handler: GroupExitEventHandler | undefined): void {
    this.onGroupExit = handler
  }

  getState(): GroupExitMonitorState {
    this.ensureLoaded()
    return {
      // this.events 恒为「新在前」，所以这里取到的就是**最新**的 MAX_EVENTS 条。
      events: this.events.slice(0, MAX_EVENTS),
      /** 永久保留的事件总数（`events` 只是最新的一批）。 */
      totalEventCount: this.events.length,
      enabled: this.enabled,
      running: this.enabled && this.active && chat.isReady(),
      nativeMonitorActive: this.nativeMonitorActive,
      monitoredGroupCount: this.snapshots.size,
      monitorSelectionConfigured: this.monitorSelectionConfigured,
      monitoredRoomIds: Array.from(this.monitoredRoomIds),
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
      this.events = []
      this.rewriteEventsToDisk([])
      this.lastReadAt = 0
      this.monitorSelectionConfigured = true
      this.monitoredRoomIds.clear()
      this.snapshots.clear()
      this.groupNamesByRoomId.clear()
    }
    this.accountRoot = currentRoot
    this.groupNamesRefreshPending = true
    this.active = true
    this.nativeMonitorActive = nativeMonitorActive
    this.checkQueued = false
    if (!this.enabled) {
      this.save()
      this.broadcast()
      return
    }
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
    if (!this.enabled || !this.active || !isContactEvent(rawPayload)) return
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
    this.ensureLoaded()
    if (!this.enabled) return this.getState()
    if (!this.active && chat.isReady()) await this.start(false)
    await this.check()
    return this.getState()
  }

  /**
   * 保存**监控范围**。
   *
   * 参数只剩监控目标 —— 旧版第二个参数（通知群聊）已经迁到自动化规则里，
   * 本服务不再持有任何通知配置。
   */
  async setMonitoredRoomIds(roomIds: string[]): Promise<GroupExitMonitorState> {
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
    this.lastCheckedAt = undefined
    this.save()
    this.broadcast()
    // 建立基线放到后台，保存配置可以立即返回。
    if (this.enabled && this.active) void this.check()
    return this.getState()
  }

  async setEnabled(enabled: boolean): Promise<GroupExitMonitorState> {
    this.ensureLoaded()
    if (this.enabled === enabled) return this.getState()

    this.enabled = enabled
    this.eventSequence += 1
    this.scopeGeneration += 1
    this.checkQueued = false
    this.hydrationQueue.clear()
    if (this.changeTimer) clearTimeout(this.changeTimer)
    this.changeTimer = null

    if (enabled) {
      // 用户主动暂停期间的成员变化不补报；重新开启后从当前状态建立新基线。
      this.snapshots.clear()
      this.lastCheckedAt = undefined
      this.groupNamesRefreshPending = true
    }
    this.save()
    this.broadcast()
    if (enabled && this.active && chat.isReady()) await this.check()
    return this.getState()
  }

  /**
   * 按群 / 时间范围查退群事件（档案合并展示用）。
   *
   * 与 `getState()` 的分工：后者只带回最近 `MAX_EVENTS` 条、且是**给管理页**看的概览；
   * 档案要的是「某个群在这段时间里的全部事件」，所以单独开一个查询入口，
   * 直接打在内存里的完整历史上（事件是永久保留的）。
   *
   * 返回**按时间升序**（旧 → 新），与档案消息流的顺序一致。
   */
  listEvents(
    query: { roomId?: string; sinceMs?: number; untilMs?: number; limit?: number } = {}
  ): GroupExitMonitorEvent[] {
    this.ensureLoaded()
    const roomId = String(query.roomId || '').trim()
    const since = Number(query.sinceMs)
    const until = Number(query.untilMs)
    const limit = Number(query.limit)

    // this.events 是倒序（新在前）。
    let result = [...this.events].reverse()
    if (roomId) result = result.filter((event) => event.roomId === roomId)
    if (Number.isFinite(since)) result = result.filter((event) => event.detectedAt >= since)
    if (Number.isFinite(until)) result = result.filter((event) => event.detectedAt <= until)
    // 超量时保留**最近**的一批（尾部即最新）。
    if (Number.isFinite(limit) && limit > 0 && result.length > limit) {
      result = result.slice(-limit)
    }
    return result
  }

  clearEvents(): GroupExitMonitorState {
    this.ensureLoaded()
    this.events = []
    // 磁盘上的 append-only 历史也要清掉，否则下次启动又读回来了。
    this.rewriteEventsToDisk([])
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
      !this.enabled ||
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
    if (result.groups && this.enabled && this.active && scopeGeneration === this.scopeGeneration) {
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
    const exits: GroupExitMonitorEvent[] = []
    let changedGroups = 0
    for (const membership of groups) {
      if (!this.enabled || !this.active || scopeGeneration !== this.scopeGeneration) {
        return changedGroups
      }
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
          // 一人一条事件、一条通知 —— 保持既有产品语义，不聚合。
          const event = this.recordExit(next, member, previous.members.length, next.members.length)
          if (event) exits.push(event)
        }
      }

      // Last Good Snapshot 必须在 Diff 完成后才能替换。
      this.snapshots.set(next.roomId, next)
      if (next.members.some((member) => !hasMemberMetadata(member))) {
        this.hydrationQueue.add(next.roomId)
      }
    }

    if (!this.enabled || !this.active || scopeGeneration !== this.scopeGeneration) {
      return changedGroups
    }
    this.lastCheckedAt = Date.now()
    // 先把事件和新基线作为同一检查点落盘，再交给自动化。
    // 「退群事实已记录」与「通知发送成功」是两件独立的事。
    this.save()
    this.broadcast()
    for (const event of exits) this.emitGroupExit(event)
    return changedGroups
  }

  private startNextSnapshotHydration(): void {
    if (!this.enabled || !this.active) {
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
      detectedAt
    }
    // 内存按时间倒序（新事件在前）；磁盘**只追加这一条**，不重写历史。
    // 这里不再有 `.slice(0, MAX_EVENTS)` —— 事件是永久保留的。
    this.events = [event, ...this.events]
    this.appendEventsToDisk([event])
    console.log(
      `[GroupMonitor] detected member exit roomId=${group.roomId} member=${member.wxid} ${previousCount}->${currentCount}`
    )
    return event
  }

  /**
   * 把退群事件交给自动化 —— **不等待**。
   *
   * 三条约束：
   * 1. **绝不 await**：快照扫描与成员 diff 不能被微信发送耗时拖住；
   * 2. **异常必须被捕获**：`void promise` 漏掉 `.catch` 会变成 unhandled rejection；
   * 3. **不影响退群事实**：事件与快照在同一检查点已经先落盘，通知失败不回滚记录。
   */
  private emitGroupExit(event: GroupExitMonitorEvent): void {
    const handler = this.onGroupExit
    if (!handler) return
    try {
      void Promise.resolve(
        handler(toGroupMemberExitedEvent(event))
      ).catch((error) => {
        console.warn(
          `[GroupMonitor] 退群通知处理失败 eventId=${event.id}: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      })
    } catch (error) {
      // handler 同步抛出的情况（`handleGroupExit` 本身不抛，这里是防御性兜底）。
      console.warn(
        `[GroupMonitor] 退群通知处理异常 eventId=${event.id}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  private filePath(): string {
    return path.join(app.getPath('userData'), 'group-exit-monitor.json')
  }

  /**
   * 退群事件的 append-only 存储（每行一条 JSON）。
   *
   * 与状态文件分开，因为两者的写入模式完全不同：
   * - **状态**（开关 / 监控范围 / 快照 / 模板）小、且总是整体重写；
   * - **事件**只增不改，且要求**永久保留**。
   * 混在一个文件里时，每来一条事件都要把整部历史重新序列化写一遍 —— 越写越慢。
   */
  private eventsPath(): string {
    return path.join(app.getPath('userData'), 'group-exit-monitor-events.jsonl')
  }

  /** 读全量历史事件。单行损坏只跳过该行，不让整部历史读不出来。 */
  private readEventsFromDisk(): GroupExitMonitorEvent[] {
    let raw = ''
    try {
      raw = fs.readFileSync(this.eventsPath(), 'utf8')
    } catch {
      return []
    }
    const events: GroupExitMonitorEvent[] = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        events.push(JSON.parse(trimmed) as GroupExitMonitorEvent)
      } catch {
        // 跳过坏行
      }
    }
    return events
  }

  /** 只追加新增的那几行，不重写历史。 */
  private appendEventsToDisk(events: GroupExitMonitorEvent[]): void {
    if (!events.length) return
    try {
      fs.ensureDirSync(path.dirname(this.eventsPath()))
      const payload = events.map((event) => `${JSON.stringify(event)}\n`).join('')
      fs.appendFileSync(this.eventsPath(), payload, 'utf8')
    } catch (error) {
      console.warn('[GroupMonitor] 追加退群事件失败:', error)
    }
  }

  /** 整体重写事件文件（清空、切换账号、老数据迁移时使用）。 */
  private rewriteEventsToDisk(events: GroupExitMonitorEvent[]): void {
    try {
      fs.ensureDirSync(path.dirname(this.eventsPath()))
      const payload = events.map((event) => `${JSON.stringify(event)}\n`).join('')
      fs.writeFileSync(this.eventsPath(), payload, 'utf8')
    } catch (error) {
      console.warn('[GroupMonitor] 重写退群事件失败:', error)
    }
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const stored = fs.readJsonSync(this.filePath()) as StoredState
      this.enabled = stored.enabled !== false
      // 事件从 append-only 文件读；状态文件不再承载它们。
      const fromDisk = this.readEventsFromDisk()
      const legacy = normalizeEvents(stored.events)
      if (legacy.length && !fromDisk.length) {
        // 老版本把事件塞在状态文件里 —— 一次性迁移过去，避免这批历史丢失。
        // 落盘按时间**升序**（旧 → 新），与之后 append 的方向一致，避免在
        // append-only 文件开头留下一段方向相反的旧历史（历史行序错乱的来源）。
        this.rewriteEventsToDisk(
          [...legacy].sort((left, right) => left.detectedAt - right.detectedAt)
        )
        this.events = sortEventsNewestFirst(legacy)
      } else {
        // 磁盘行序不保证时间有序（迁移段与追加段方向相反），读回后必须显式重建
        // 「新在前」这个内存不变量，否则列表顶部会恒为最旧的一批。
        this.events = sortEventsNewestFirst(normalizeEvents(fromDisk))
      }
      this.lastReadAt = Number(stored.lastReadAt) || 0
      this.accountRoot = String(stored.accountRoot || '')
      // 没有显式范围时按空范围处理，保留已有选择。
      this.monitorSelectionConfigured = true
      this.monitoredRoomIds = normalizeRoomIds(stored.monitoredRoomIds || [])
      this.snapshots = normalizeSnapshots(stored.snapshots, this.monitoredRoomIds)
    } catch {
      // 首次启动或状态文件损坏时从空记录开始 —— 但事件在独立文件里，
      // 不该被状态文件的问题连累，仍然读回来。
      this.events = sortEventsNewestFirst(normalizeEvents(this.readEventsFromDisk()))
      this.enabled = true
      this.lastReadAt = 0
      this.monitorSelectionConfigured = true
      this.monitoredRoomIds.clear()
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
          enabled: this.enabled,
          // 事件**不在这里**：它们走 append-only 的 JSONL（见 `eventsPath()`）。
          // 放进状态文件会让每新增一条事件都把整部历史重写一遍。
          lastReadAt: this.lastReadAt,
          monitorSelectionConfigured: this.monitorSelectionConfigured,
          monitoredRoomIds: Array.from(this.monitoredRoomIds),
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
      detectedAt
    })
    // 不再按 MAX_EVENTS 截断：事件是永久保留的，截在这里等于每次启动都丢掉历史。
    // 历史上的 `notificationStatus` / `notification` 字段被**丢弃**：
    // 通知状态已归 Automation 执行日志，退群监控不再持有它。
  }
  return normalized
}

/**
 * 事件在内存里恒定保持「**新在前**」。
 *
 * 这个不变量有三个依赖方：`recordExit` 的 `[event, ...this.events]` 写入方向、
 * `listEvents()` 的 `.reverse()`（它假定内存是倒序，反转后得到升序）、
 * 以及 `getState()` 的 `slice(0, MAX_EVENTS)`（要求取到的是**最新**的一批）。
 *
 * 必须显式重建它：磁盘是 append-only，行序由「迁移写入的历史 + 之后追加的新事件」
 * 决定，两段方向相反，整体不保证时间有序。直接信任文件行序会让列表顶部恒为最旧的
 * 一批，并让 `slice(0, MAX_EVENTS)` 恰好把最新的事件截掉。
 */
function sortEventsNewestFirst(events: GroupExitMonitorEvent[]): GroupExitMonitorEvent[] {
  return [...events].sort((left, right) => right.detectedAt - left.detectedAt)
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
