import { app, BrowserWindow } from 'electron'
import fs from 'fs-extra'
import path from 'path'
import * as chat from './chat-service'
import { personalWechatCapabilityService } from './personal-wechat-capability-service'
import { personalWechatSendService } from './personal-wechat-send-service'
import {
  findRemovedGroupMembers,
  groupExitMemberName,
  normalizeGroupExitNotificationTemplate,
  renderGroupExitMonitorNotification,
  validateGroupExitNotificationTemplate,
  type GroupExitMonitorEvent,
  type GroupExitMonitorMember,
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
}

type GroupSnapshotRecord = {
  contactId: string
  roomId: string
  groupName: string
  members: GroupExitMonitorMember[]
  /** 查询失败时保留旧快照。 */
  membersValid?: boolean
}

const DB_CHANGE_DEBOUNCE_MS = 350
const GROUP_READ_CONCURRENCY = 8
const DUPLICATE_WINDOW_MS = 2 * 60 * 1000
const MAX_EVENTS = 500

class GroupExitMonitorService {
  private active = false
  private nativeMonitorActive = false
  private snapshots = new Map<string, GroupSnapshotRecord>()
  private changeTimer: NodeJS.Timeout | null = null
  private checking = false
  private checkQueued = false
  private initializing = false
  private lastCheckedAt: number | undefined
  private lastReadAt = 0
  private events: GroupExitMonitorEvent[] = []
  private monitorSelectionConfigured = true
  private monitoredRoomIds = new Set<string>()
  private notificationRoomIds = new Set<string>()
  private loaded = false
  private accountRoot = ''
  private eventSequence = 0
  private scopeGeneration = 0
  private notificationTemplate = normalizeGroupExitNotificationTemplate(undefined)

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
    if (
      currentRoot &&
      this.accountRoot &&
      path.resolve(currentRoot) !== path.resolve(this.accountRoot)
    ) {
      this.events = []
      this.lastReadAt = 0
      this.monitorSelectionConfigured = true
      this.monitoredRoomIds.clear()
      this.notificationRoomIds.clear()
    }
    if (currentRoot) this.accountRoot = currentRoot
    this.active = true
    this.nativeMonitorActive = nativeMonitorActive
    this.snapshots.clear()
    this.checkQueued = false
    this.initializing = true
    const scopeGeneration = ++this.scopeGeneration
    const generation = this.eventSequence + 1
    this.eventSequence = generation
    try {
      const groups = await this.readGroups()
      if (
        !this.active ||
        this.eventSequence !== generation ||
        this.scopeGeneration !== scopeGeneration
      )
        return
      if (groups) this.replaceSnapshots(groups)
      this.save()
      this.broadcast()
    } finally {
      this.initializing = false
      if (this.checkQueued && this.active) {
        this.checkQueued = false
        void this.check()
      }
    }
  }

  stop(): void {
    this.active = false
    this.nativeMonitorActive = false
    this.eventSequence += 1
    this.scopeGeneration += 1
    this.snapshots.clear()
    this.checkQueued = false
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
    this.monitoredRoomIds = normalizeRoomIds(roomIds)
    const requestedNotifications = normalizeRoomIds(notificationRoomIds)
    this.notificationRoomIds = new Set(
      Array.from(requestedNotifications).filter((roomId) => this.monitoredRoomIds.has(roomId))
    )
    // 更换监控范围后重新建基线，避免旧快照误报。
    this.snapshots.clear()
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
    if (!this.active || !chat.isReady()) return
    if (this.initializing) {
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
      const groups = await this.readGroups()
      if (!groups || !this.active || scopeGeneration !== this.scopeGeneration) return

      const currentRoomIds = new Set(groups.map((group) => group.roomId))
      for (const roomId of this.snapshots.keys()) {
        if (!currentRoomIds.has(roomId)) this.snapshots.delete(roomId)
      }

      for (const next of groups) {
        if (scopeGeneration !== this.scopeGeneration) return
        if (next.membersValid === false) continue
        const previous = this.snapshots.get(next.roomId)
        if (previous?.membersValid === false) {
          this.snapshots.set(next.roomId, next)
          continue
        }
        // 空数组可能是查询失败，先保留旧基线，避免误报。
        if (previous && previous.members.length > 0 && next.members.length === 0) continue

        this.snapshots.set(next.roomId, next)
        if (!previous) continue

        // 只有群人数下降才记录退群。
        if (next.members.length >= previous.members.length) continue

        const removed = findRemovedGroupMembers(previous.members, next.members)
        for (const member of removed) {
          const event = this.recordExit(next, member, previous.members.length, next.members.length)
          if (event && this.notificationRoomIds.has(next.roomId)) {
            void this.notifyGroup(next, event)
          }
        }
      }
      this.lastCheckedAt = Date.now()
      this.save()
      this.broadcast()
    } finally {
      this.checking = false
      if (this.checkQueued && this.active) {
        this.checkQueued = false
        void this.check()
      }
    }
  }

  private async readGroups(): Promise<GroupSnapshotRecord[] | null> {
    const database = chat.getChatDb()
    if (!database) return null
    try {
      const client = database.getWcdb4Client()
      const rawSessions = await client.getSessionsAsync({ hydrateDisplayNames: true })
      const sessions = Array.isArray(rawSessions) ? rawSessions : []
      const groups = sessions.filter(
        (session) =>
          session.username?.endsWith('@chatroom') === true &&
          (!this.monitorSelectionConfigured || this.monitoredRoomIds.has(session.username))
      )
      const records: Array<GroupSnapshotRecord | null> = new Array(groups.length).fill(null)
      let nextIndex = 0
      const workerCount = Math.min(GROUP_READ_CONCURRENCY, groups.length)
      await Promise.all(
        Array.from({ length: workerCount }, async () => {
          while (true) {
            const index = nextIndex++
            if (index >= groups.length) return
            const session = groups[index]
            const contactId = client.md5(session.username)
            try {
              const snapshot = await chat.getGroupSnapshotAsync(contactId)
              const groupName = cleanGroupName(session.nickname, session.username)
              if (!snapshot || snapshot.roomId !== session.username) {
                records[index] = {
                  contactId,
                  roomId: session.username,
                  groupName,
                  members: [],
                  membersValid: false
                }
                continue
              }
              const rawMembers = (snapshot as { members?: unknown }).members
              if (!Array.isArray(rawMembers)) {
                console.warn(
                  `[GroupMonitor] 群成员快照不是数组 roomId=${session.username}; 保留上一份基线`
                )
                records[index] = {
                  contactId,
                  roomId: session.username,
                  groupName,
                  members: [],
                  membersValid: false
                }
                continue
              }
              records[index] = {
                contactId,
                roomId: snapshot.roomId,
                groupName: cleanGroupName(session.nickname, snapshot.roomId),
                members: rawMembers
                  .filter((member) => member?.wxid)
                  .map((member) => ({
                    wxid: member.wxid,
                    nickname: member.nickname,
                    groupNickname: member.groupNickname,
                    wechatNickname: member.wechatNickname,
                    remark: member.remark,
                    avatar: member.avatar
                  })),
                membersValid: true
              }
            } catch (error) {
              console.warn(`[GroupMonitor] 读取群成员失败 roomId=${session.username}:`, error)
              records[index] = {
                contactId,
                roomId: session.username,
                groupName: cleanGroupName(session.nickname, session.username),
                members: [],
                membersValid: false
              }
            }
          }
        })
      )
      return records.filter((record): record is GroupSnapshotRecord => Boolean(record))
    } catch (error) {
      console.warn('[GroupMonitor] 读取群成员快照失败:', error)
      return null
    }
  }

  private replaceSnapshots(groups: GroupSnapshotRecord[]): void {
    this.snapshots = new Map(
      groups.filter((group) => group.membersValid !== false).map((group) => [group.roomId, group])
    )
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
    try {
      const capability = await personalWechatCapabilityService.getPersonalWechatSendCapability()
      if (!capability.ready || !capability.capabilities.text) {
        console.warn(`[GroupMonitor] 跳过群聊通知 roomId=${group.roomId}: ${capability.message}`)
        return
      }
      // 具体传输方式由发送服务按平台处理。
      const result = await personalWechatSendService.send({
        type: 'text',
        to: group.roomId,
        isGroup: true,
        text: renderGroupExitMonitorNotification(event, this.notificationTemplate)
      })
      if (!result.success) {
        console.warn(
          `[GroupMonitor] 群聊通知发送失败 roomId=${group.roomId}: ${result.error || ''}`
        )
      }
    } catch (error) {
      console.warn(
        `[GroupMonitor] 群聊通知异常 roomId=${group.roomId}:`,
        error instanceof Error ? error.message : String(error)
      )
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
    } catch {
      // 首次启动或文件损坏时从空记录开始。
      this.events = []
      this.lastReadAt = 0
      this.monitorSelectionConfigured = true
      this.monitoredRoomIds.clear()
      this.notificationRoomIds.clear()
      this.notificationTemplate = normalizeGroupExitNotificationTemplate(undefined)
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
          notificationTemplate: this.notificationTemplate
        },
        { spaces: 2 }
      )
    } catch (error) {
      console.warn('[GroupMonitor] 保存事件失败:', error)
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
    if (normalized.length >= MAX_EVENTS) break
  }
  return normalized
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
