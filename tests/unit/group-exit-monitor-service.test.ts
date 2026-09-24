import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readJsonSync,
  rmSync,
  writeFileSync,
  writeJsonSync
} from 'fs-extra'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  userData: '',
  chat: {
    getChatDb: vi.fn(),
    getCurrentAccountRoot: vi.fn(() => 'fixture-account'),
    isReady: vi.fn(() => true),
    getGroupNamesAsync: vi.fn(async () => ({})),
    isGroupMemberIdsBatchAvailable: vi.fn(() => true),
    getGroupMemberIdsBatchAsync: vi.fn(),
    getGroupMemberIdsAsync: vi.fn(),
    getGroupSnapshotAsync: vi.fn()
  },
  capability: {
    getPersonalWechatSendCapability: vi.fn()
  },
  sender: {
    send: vi.fn()
  }
}))

vi.mock('electron', () => ({
  app: { getPath: () => mocks.userData },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../../src/main/services/chat-service', () => mocks.chat)
vi.mock('../../src/main/services/personal-wechat-capability-service', () => ({
  personalWechatCapabilityService: mocks.capability
}))
vi.mock('../../src/main/services/personal-wechat-send-service', () => ({
  personalWechatSendService: mocks.sender
}))

import { GroupExitMonitorService } from '../../src/main/services/group-exit-monitor-service'
import type { GroupMemberExitedEvent } from '../../src/shared/group-exit-event'

const member = { wxid: 'wxid_member', wechatNickname: '微信名', groupNickname: '群内名' }
const otherMember = { wxid: 'wxid_other', wechatNickname: '另一个人' }

function installGroupDb(): void {
  const client = {
    md5: vi.fn((roomId: string) => `${roomId}-md5`),
    invalidateGroupNicknameCache: vi.fn()
  }
  mocks.chat.getChatDb.mockReturnValue({ getWcdb4Client: () => client })
}

/** 写真实形态的 append-only 事件文件：一行一条，文件顺序即传入顺序。 */
function writePersistedEvents(detectedAtList: number[]): void {
  writeFileSync(
    join(mocks.userData, 'group-exit-monitor-events.jsonl'),
    detectedAtList
      .map((detectedAt, index) => `${JSON.stringify(persistedEvent(index, detectedAt))}\n`)
      .join(''),
    'utf8'
  )
}

/** 一条能通过 normalizeEvents 校验的持久化事件（人数必须是净减少）。 */
function persistedEvent(index: number, detectedAt: number): Record<string, unknown> {
  return {
    id: `room@chatroom:wxid_member_${index}:${detectedAt}:${index}`,
    contactId: 'room@chatroom-md5',
    roomId: 'room@chatroom',
    groupName: '测试群',
    memberWxid: `wxid_member_${index}`,
    memberName: `成员${index}`,
    wechatName: `成员${index}`,
    groupRemark: '',
    contactRemark: '',
    previousCount: 40 + index,
    currentCount: 39 + index,
    delta: -1,
    message: `成员${index}退出了测试群`,
    detectedAt
  }
}

function writeBaseline(
  snapshots: Array<{
    roomId: string
    groupName: string
    members: Array<{ wxid: string; [key: string]: string }>
  }>
): void {
  writeJsonSync(join(mocks.userData, 'group-exit-monitor.json'), {
    accountRoot: 'fixture-account',
    events: [],
    monitoredRoomIds: snapshots.map((snapshot) => snapshot.roomId),
    snapshots: snapshots.map((snapshot) => ({
      contactId: `${snapshot.roomId}-md5`,
      roomId: snapshot.roomId,
      groupName: snapshot.groupName,
      capturedAt: Date.now() - 1_000,
      members: snapshot.members
    }))
  })
}

describe('GroupExitMonitorService', () => {
  const temporaryDirectories: string[] = []

  beforeEach(() => {
    mocks.userData = mkdtempSync(join(tmpdir(), 'tracememo-group-monitor-'))
    temporaryDirectories.push(mocks.userData)
    mocks.chat.getChatDb.mockReset()
    mocks.chat.getCurrentAccountRoot.mockReset().mockReturnValue('fixture-account')
    mocks.chat.isReady.mockReset().mockReturnValue(true)
    mocks.chat.getGroupNamesAsync.mockReset().mockResolvedValue({})
    mocks.chat.isGroupMemberIdsBatchAvailable.mockReset().mockReturnValue(true)
    mocks.chat.getGroupMemberIdsBatchAsync.mockReset()
    mocks.chat.getGroupMemberIdsAsync.mockReset()
    mocks.chat.getGroupSnapshotAsync.mockReset().mockResolvedValue(null)
    mocks.capability.getPersonalWechatSendCapability.mockReset()
    mocks.sender.send.mockReset()
  })

  afterEach(() => {
    while (temporaryDirectories.length) {
      rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
    }
  })

  /*
   * 模板相关的用例（保存 / 归一化 / 渲染）**已随迁移移出本文件**：
   * 模板现在属于自动化规则，由 `leave-notification-*` 那组测试覆盖。
   * 退群监控不再持有模板，所以这里没有任何模板可测。
   */

  it('persists OFF without checking contact changes or deleting configuration', async () => {
    vi.useFakeTimers()
    installGroupDb()
    writeBaseline([{ roomId: 'room@chatroom', groupName: '测试群', members: [member, otherMember] }])
    const service = new GroupExitMonitorService()
    await service.setEnabled(false)
    await service.start(true)
    service.notifyDatabaseChanged('{"table":"contact","action":"update"}')
    await vi.advanceTimersByTimeAsync(500)

    expect(mocks.chat.getGroupMemberIdsBatchAsync).not.toHaveBeenCalled()
    expect(service.getState()).toMatchObject({ enabled: false, running: false })
    const stored = readJsonSync(join(mocks.userData, 'group-exit-monitor.json'))
    expect(stored).toMatchObject({
      enabled: false,
      monitoredRoomIds: ['room@chatroom']
    })
    expect(stored.snapshots[0].members).toEqual([member, otherMember])
    vi.useRealTimers()
  })

  it('rebuilds the current baseline when re-enabled without reporting paused exits', async () => {
    installGroupDb()
    writeBaseline(
      [{ roomId: 'room@chatroom', groupName: '测试群', members: [member, otherMember] }]
    )
    const service = new GroupExitMonitorService()
    await service.setEnabled(false)
    await service.start(true)
    mocks.chat.getGroupMemberIdsBatchAsync.mockResolvedValue([
      { roomId: 'room@chatroom', status: 'ok', memberIds: [member.wxid] }
    ])

    const nextState = await service.setEnabled(true)

    expect(nextState).toMatchObject({ enabled: true, running: true, events: [] })
    expect(mocks.chat.getGroupMemberIdsBatchAsync).toHaveBeenCalledOnce()
    expect(mocks.sender.send).not.toHaveBeenCalled()
    const stored = readJsonSync(join(mocks.userData, 'group-exit-monitor.json'))
    expect(stored.enabled).toBe(true)
    expect(stored.snapshots[0].members).toEqual([{ wxid: member.wxid }])
  })

  it('uses the Session nickname when establishing a new group baseline', async () => {
    installGroupDb()
    const callOrder: string[] = []
    mocks.chat.getGroupNamesAsync.mockImplementation(async () => {
      callOrder.push('names')
      return { 'A@chatroom': '测试群A' }
    })
    mocks.chat.getGroupMemberIdsBatchAsync.mockImplementation(async () => {
      callOrder.push('batch')
      return [{ roomId: 'A@chatroom', status: 'ok', memberIds: [member.wxid] }]
    })
    mocks.chat.getGroupSnapshotAsync.mockImplementation(async () => {
      callOrder.push('hydration')
      return null
    })
    const service = new GroupExitMonitorService()
    await service.setMonitoredRoomIds(['A@chatroom'])
    await service.start(true)

    const stored = readJsonSync(join(mocks.userData, 'group-exit-monitor.json'))
    expect(stored.snapshots[0]).toMatchObject({ roomId: 'A@chatroom', groupName: '测试群A' })
    expect(callOrder.indexOf('batch')).toBeGreaterThan(callOrder.indexOf('names'))
    expect(callOrder.indexOf('hydration')).toBeGreaterThan(callOrder.indexOf('batch'))
  })

  it('preserves existing member metadata during a Batch membership refresh', async () => {
    installGroupDb()
    const richMember = {
      wxid: 'wxid_rich',
      nickname: 'Shinven',
      groupNickname: '群内 Shinven',
      wechatNickname: 'Shinven',
      remark: '小号',
      avatar: 'data:image/png;base64,known'
    }
    writeBaseline([{ roomId: 'A@chatroom', groupName: '测试群A', members: [richMember] }])
    mocks.chat.getGroupMemberIdsBatchAsync.mockResolvedValue([
      { roomId: 'A@chatroom', status: 'ok', memberIds: [richMember.wxid] }
    ])
    const service = new GroupExitMonitorService()

    await service.start(true)

    expect(
      readJsonSync(join(mocks.userData, 'group-exit-monitor.json')).snapshots[0].members
    ).toEqual([richMember])
  })

  it('keeps hydrated member metadata across the next Batch refresh', async () => {
    installGroupDb()
    writeBaseline([
      { roomId: 'A@chatroom', groupName: '测试群A', members: [{ wxid: 'wxid_rich' }] }
    ])
    mocks.chat.getGroupMemberIdsBatchAsync.mockResolvedValue([
      { roomId: 'A@chatroom', status: 'ok', memberIds: ['wxid_rich'] }
    ])
    mocks.chat.getGroupSnapshotAsync.mockResolvedValue({
      roomId: 'A@chatroom',
      groupName: '测试群A',
      members: [
        {
          wxid: 'wxid_rich',
          nickname: 'Shinven',
          groupNickname: '群内 Shinven',
          wechatNickname: 'Shinven',
          remark: '小号',
          avatar: ''
        }
      ]
    })
    const service = new GroupExitMonitorService()
    await service.start(true)
    await vi.waitFor(() => {
      expect(
        readJsonSync(join(mocks.userData, 'group-exit-monitor.json')).snapshots[0].members[0]
      ).toMatchObject({ wxid: 'wxid_rich', nickname: 'Shinven', remark: '小号' })
    })

    await service.checkNow()

    expect(
      readJsonSync(join(mocks.userData, 'group-exit-monitor.json')).snapshots[0].members[0]
    ).toMatchObject({ wxid: 'wxid_rich', nickname: 'Shinven', remark: '小号' })
  })

  it('preserves old member metadata while allowing a new member to start wxid-only', async () => {
    installGroupDb()
    const existing = { wxid: 'wxid_existing', nickname: 'Shinven', remark: '小号' }
    writeBaseline([{ roomId: 'A@chatroom', groupName: '测试群A', members: [existing] }])
    mocks.chat.getGroupMemberIdsBatchAsync.mockResolvedValue([
      { roomId: 'A@chatroom', status: 'ok', memberIds: [existing.wxid, 'wxid_new'] }
    ])
    mocks.chat.getGroupSnapshotAsync.mockResolvedValue({
      roomId: 'A@chatroom',
      groupName: '测试群A',
      members: [{ wxid: existing.wxid }, { wxid: 'wxid_new', nickname: '新成员' }]
    })
    const service = new GroupExitMonitorService()

    await service.start(true)

    await vi.waitFor(() => {
      expect(
        readJsonSync(join(mocks.userData, 'group-exit-monitor.json')).snapshots[0].members
      ).toEqual([existing, { wxid: 'wxid_new', nickname: '新成员' }])
    })
  })

  it('repairs a persisted room id fallback when Session metadata becomes available', async () => {
    installGroupDb()
    writeBaseline([{ roomId: 'A@chatroom', groupName: 'A@chatroom', members: [member] }])
    mocks.chat.getGroupNamesAsync.mockResolvedValue({ 'A@chatroom': '测试群A' })
    mocks.chat.getGroupMemberIdsBatchAsync.mockResolvedValue([
      { roomId: 'A@chatroom', status: 'ok', memberIds: [member.wxid] }
    ])
    const service = new GroupExitMonitorService()
    await service.start(true)

    expect(
      readJsonSync(join(mocks.userData, 'group-exit-monitor.json')).snapshots[0]
    ).toMatchObject({ roomId: 'A@chatroom', groupName: '测试群A' })
  })

  it('keeps the previous resolved group name when Session metadata is temporarily unavailable', async () => {
    installGroupDb()
    writeBaseline([{ roomId: 'A@chatroom', groupName: '测试群A', members: [member] }])
    mocks.chat.getGroupNamesAsync.mockResolvedValue({})
    mocks.chat.getGroupMemberIdsBatchAsync.mockResolvedValue([
      { roomId: 'A@chatroom', status: 'ok', memberIds: [member.wxid] }
    ])
    const service = new GroupExitMonitorService()
    await service.start(true)

    expect(
      readJsonSync(join(mocks.userData, 'group-exit-monitor.json')).snapshots[0]
    ).toMatchObject({ roomId: 'A@chatroom', groupName: '测试群A' })
  })

  it('uses one resolved group name for both 3-to-1 events and the emitted leave events', async () => {
    installGroupDb()
    const departed = { wxid: 'wxid_departed', groupNickname: '离群一' }
    const secondDeparted = { wxid: 'wxid_second_departed', groupNickname: '离群二' }
    writeBaseline([
      {
        roomId: 'A@chatroom',
        groupName: 'A@chatroom',
        members: [member, departed, secondDeparted]
      }
    ])
    mocks.chat.getGroupNamesAsync.mockResolvedValue({ 'A@chatroom': '测试群A' })
    mocks.chat.getGroupMemberIdsBatchAsync.mockResolvedValue([
      { roomId: 'A@chatroom', status: 'ok', memberIds: [member.wxid] }
    ])
    const emitted: GroupMemberExitedEvent[] = []
    const service = new GroupExitMonitorService()
    service.setGroupExitHandler((event) => {
      emitted.push(event)
    })

    await service.start(true)

    expect(service.getState().events).toHaveLength(2)
    expect(service.getState().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memberWxid: departed.wxid,
          groupName: '测试群A',
          message: '离群一退出了测试群A',
          previousCount: 3,
          currentCount: 1
        }),
        expect.objectContaining({
          memberWxid: secondDeparted.wxid,
          groupName: '测试群A',
          message: '离群二退出了测试群A',
          previousCount: 3,
          currentCount: 1
        })
      ])
    )
    // 事件里的群名与存储里的一致 —— 通知目标要显示的就是这个名字。
    expect(emitted).toHaveLength(2)
    expect(emitted.every((event) => event.groupName === '测试群A')).toBe(true)
    expect(emitted.every((event) => event.conversationId === 'A@chatroom')).toBe(true)
    expect(mocks.chat.getGroupSnapshotAsync).not.toHaveBeenCalled()
  })

  it('persists a compact last good snapshot and recovers offline exits after restart', async () => {
    installGroupDb()
    const departed = {
      wxid: 'wxid_departed',
      nickname: '旧昵称',
      wechatNickname: '离群成员',
      groupNickname: '群内昵称',
      remark: '通讯录备注',
      avatar: 'data:image/png;base64,not-persisted'
    }
    const secondDeparted = {
      wxid: 'wxid_second_departed',
      nickname: '另一个旧昵称',
      wechatNickname: '第二位离群成员',
      groupNickname: '第二位群内昵称',
      remark: '第二位通讯录备注'
    }
    mocks.chat.getGroupSnapshotAsync.mockResolvedValueOnce({
      roomId: 'room@chatroom',
      members: [member, departed, secondDeparted]
    })
    mocks.chat.getGroupMemberIdsBatchAsync
      .mockResolvedValueOnce([
        {
          roomId: 'room@chatroom',
          status: 'ok',
          memberIds: [member.wxid, departed.wxid, secondDeparted.wxid]
        }
      ])
      .mockResolvedValue([{ roomId: 'room@chatroom', status: 'ok', memberIds: [member.wxid] }])
    const service = new GroupExitMonitorService()
    service.setMonitoredRoomIds(['room@chatroom'])
    await service.start(true)

    const statePath = join(mocks.userData, 'group-exit-monitor.json')
    const eventsPath = join(mocks.userData, 'group-exit-monitor-events.jsonl')
    await vi.waitFor(() => {
      expect(readJsonSync(statePath).snapshots[0].members[1]).toMatchObject({
        wxid: departed.wxid,
        wechatNickname: departed.wechatNickname
      })
    })
    const baseline = readJsonSync(statePath)
    // 事件**不再写在状态文件里**（它们走 append-only 的 JSONL），
    // 所以这里断言的是「两条存储都没有事件」，而不是只看状态文件。
    expect(baseline.events).toBeUndefined()
    expect(existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8').trim() : '').toBe('')
    expect(baseline.snapshots).toEqual([
      expect.objectContaining({
        roomId: 'room@chatroom',
        groupName: 'room@chatroom',
        capturedAt: expect.any(Number),
        members: [
          member,
          expect.objectContaining({ wxid: 'wxid_departed' }),
          expect.objectContaining({ wxid: 'wxid_second_departed' })
        ]
      })
    ])
    expect(baseline.snapshots[0].members[1]).toHaveProperty('avatar', departed.avatar)

    service.stop()
    const restarted = new GroupExitMonitorService()
    await restarted.start(true)

    expect(restarted.getState().events).toHaveLength(2)
    expect(restarted.getState().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memberWxid: 'wxid_departed',
          memberName: departed.groupNickname,
          previousCount: 3,
          currentCount: 1
        }),
        expect.objectContaining({
          memberWxid: 'wxid_second_departed',
          memberName: secondDeparted.groupNickname,
          previousCount: 3,
          currentCount: 1
        })
      ])
    )
    expect(mocks.chat.getGroupMemberIdsBatchAsync).toHaveBeenCalledTimes(2)
    expect(mocks.chat.getGroupMemberIdsAsync).not.toHaveBeenCalled()
    expect(readJsonSync(statePath).snapshots[0].members).toEqual([member])

    await restarted.start(true)
    expect(restarted.getState().events).toHaveLength(2)

    restarted.clearEvents()
    expect(readJsonSync(statePath).snapshots[0].members).toEqual([member])
  })

  it('keeps every previous baseline when a batch result is invalid or incomplete', async () => {
    installGroupDb()
    writeBaseline([
      { roomId: 'room@chatroom', groupName: '测试群', members: [member] },
      { roomId: 'other@chatroom', groupName: '其他群', members: [otherMember] }
    ])
    mocks.chat.getGroupMemberIdsBatchAsync.mockResolvedValue(null)
    const service = new GroupExitMonitorService()
    await service.start(true)
    const state = service.getState()

    expect(state.events).toEqual([])
    expect(state.monitoredGroupCount).toBe(2)
    expect(readJsonSync(join(mocks.userData, 'group-exit-monitor.json')).snapshots).toEqual([
      expect.objectContaining({ roomId: 'room@chatroom', members: [member] }),
      expect.objectContaining({ roomId: 'other@chatroom', members: [otherMember] })
    ])
  })

  it('treats not_found as unavailable and preserves the last good snapshot', async () => {
    installGroupDb()
    writeBaseline([
      { roomId: 'room@chatroom', groupName: '测试群', members: [member, otherMember] }
    ])
    mocks.chat.getGroupMemberIdsBatchAsync.mockResolvedValue([
      { roomId: 'room@chatroom', status: 'not_found', memberIds: [] }
    ])
    const service = new GroupExitMonitorService()

    await service.start(true)

    expect(service.getState().events).toEqual([])
    expect(
      readJsonSync(join(mocks.userData, 'group-exit-monitor.json')).snapshots[0].members
    ).toEqual([member, otherMember])
  })

  it('uses the legacy member reader only when the batch symbol is unavailable', async () => {
    installGroupDb()
    writeBaseline([
      { roomId: 'room@chatroom', groupName: '测试群', members: [member, otherMember] },
      {
        roomId: 'other@chatroom',
        groupName: '其他群',
        members: [{ wxid: 'wxid_stays', nickname: '保留成员' }]
      }
    ])
    mocks.chat.isGroupMemberIdsBatchAvailable.mockReturnValue(false)
    mocks.chat.getGroupMemberIdsAsync.mockImplementation(async (roomId: string) => ({
      roomId,
      memberIds: roomId === 'room@chatroom' ? [member.wxid] : ['wxid_stays']
    }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const service = new GroupExitMonitorService()

    await service.start(true)
    await service.checkNow()

    expect(service.getState().events).toHaveLength(1)
    expect(mocks.chat.getGroupMemberIdsBatchAsync).not.toHaveBeenCalled()
    expect(mocks.chat.getGroupMemberIdsAsync).toHaveBeenCalledTimes(4)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      '[GroupMonitor] batch membership unavailable; using legacy fallback'
    )
    warn.mockRestore()
  })

  it('keeps snapshots when the monitor scope is re-saved', async () => {
    writeBaseline([{ roomId: 'room@chatroom', groupName: '测试群', members: [member] }])
    const service = new GroupExitMonitorService()
    service.getState()

    await service.setMonitoredRoomIds(['room@chatroom'])

    const stored = readJsonSync(join(mocks.userData, 'group-exit-monitor.json'))
    expect(stored.monitoredRoomIds).toEqual(['room@chatroom'])
    // 通知配置已经不在这个文件里了 —— 迁到自动化规则后不允许双写。
    expect(stored.notificationRoomIds).toBeUndefined()
    expect(stored.notificationTemplate).toBeUndefined()
    expect(stored.snapshots).toHaveLength(1)
    expect(stored.snapshots[0].members).toEqual([member])
  })

  it('retains existing baselines and only establishes a baseline for a newly monitored group', async () => {
    installGroupDb()
    writeBaseline([{ roomId: 'room@chatroom', groupName: '测试群', members: [member] }])
    const service = new GroupExitMonitorService()
    await service.setMonitoredRoomIds(['room@chatroom', 'new-room@chatroom'])
    mocks.chat.getGroupMemberIdsBatchAsync.mockResolvedValue([
      { roomId: 'room@chatroom', status: 'ok', memberIds: [member.wxid] },
      { roomId: 'new-room@chatroom', status: 'ok', memberIds: ['wxid_new_group_member'] }
    ])
    await service.start(true)

    expect(service.getState().events).toEqual([])
    const stored = readJsonSync(join(mocks.userData, 'group-exit-monitor.json'))
    expect(stored.snapshots.map((snapshot: { roomId: string }) => snapshot.roomId).sort()).toEqual([
      'new-room@chatroom',
      'room@chatroom'
    ])
  })

  it('does not diff persisted snapshots across account roots', async () => {
    installGroupDb()
    writeBaseline([
      {
        roomId: 'room@chatroom',
        groupName: '测试群',
        members: [member, { wxid: 'wxid_account_a_member' }]
      }
    ])

    mocks.chat.getCurrentAccountRoot.mockReturnValue('different-account')
    const switched = new GroupExitMonitorService()
    await switched.start(true)

    expect(switched.getState().events).toEqual([])
    const stored = readJsonSync(join(mocks.userData, 'group-exit-monitor.json'))
    expect(stored.accountRoot).toBe('different-account')
    expect(stored.snapshots).toEqual([])
  })

  it('returns from scope saving before the background baseline read completes', async () => {
    installGroupDb()
    writeBaseline([{ roomId: 'room@chatroom', groupName: '测试群', members: [member] }])
    mocks.chat.getGroupMemberIdsBatchAsync.mockResolvedValueOnce([
      { roomId: 'room@chatroom', status: 'ok', memberIds: [member.wxid] }
    ])
    const service = new GroupExitMonitorService()
    await service.start(true)

    let release!: (snapshot: unknown) => void
    mocks.chat.getGroupMemberIdsBatchAsync.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      })
    )
    const startedAt = Date.now()
    const state = await service.setMonitoredRoomIds(['room@chatroom'])

    expect(Date.now() - startedAt).toBeLessThan(250)
    expect(state.monitoredRoomIds).toEqual(['room@chatroom'])
    release([{ roomId: 'room@chatroom', status: 'ok', memberIds: [member.wxid] }])
  })

  it('detects a removed member across multiple groups without full snapshot hydration', async () => {
    installGroupDb()
    const departed = {
      wxid: 'wxid_departed',
      wechatNickname: 'Previous Snapshot 姓名',
      groupNickname: 'Previous Snapshot 群昵称',
      remark: 'Previous Snapshot 备注'
    }
    writeBaseline([
      { roomId: 'room@chatroom', groupName: '目标群', members: [member, departed] },
      {
        roomId: 'other-1@chatroom',
        groupName: '其他群 1',
        members: [{ wxid: 'wxid_other_1', nickname: '成员 1' }]
      },
      {
        roomId: 'other-2@chatroom',
        groupName: '其他群 2',
        members: [{ wxid: 'wxid_other_2', nickname: '成员 2' }]
      }
    ])
    mocks.chat.getGroupMemberIdsBatchAsync.mockResolvedValue([
      { roomId: 'room@chatroom', status: 'ok', memberIds: [member.wxid] },
      { roomId: 'other-1@chatroom', status: 'ok', memberIds: ['wxid_other_1'] },
      { roomId: 'other-2@chatroom', status: 'ok', memberIds: ['wxid_other_2'] }
    ])

    const service = new GroupExitMonitorService()
    await service.start(true)

    expect(service.getState().events[0]).toMatchObject({
      memberWxid: departed.wxid,
      memberName: departed.groupNickname,
      wechatName: departed.wechatNickname,
      groupRemark: departed.groupNickname,
      contactRemark: departed.remark
    })
    expect(mocks.chat.getGroupMemberIdsBatchAsync).toHaveBeenCalledOnce()
    expect(mocks.chat.getGroupMemberIdsBatchAsync).toHaveBeenCalledWith([
      'room@chatroom',
      'other-1@chatroom',
      'other-2@chatroom'
    ])
    expect(mocks.chat.getGroupMemberIdsAsync).not.toHaveBeenCalled()
    expect(mocks.chat.getGroupSnapshotAsync).not.toHaveBeenCalled()
  })

  it('logs one summary for a membership check and one for a hydration batch', async () => {
    installGroupDb()
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    mocks.chat.getGroupMemberIdsBatchAsync.mockResolvedValue([
      { roomId: 'room@chatroom', status: 'ok', memberIds: [member.wxid] }
    ])
    mocks.chat.getGroupSnapshotAsync.mockResolvedValue({
      roomId: 'room@chatroom',
      members: [member]
    })
    const service = new GroupExitMonitorService()
    service.setMonitoredRoomIds(['room@chatroom'])

    await service.start(true)
    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(/^\[GroupMonitor\] hydration groups=1 costMs=\d+$/)
      )
    })

    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[GroupMonitor\] check mode=batch groups=1 membershipCostMs=\d+ changedGroups=1 totalCostMs=\d+$/
      )
    )
    log.mockRestore()
  })

  it('pauses queued hydration as soon as a contact change is pending', async () => {
    vi.useFakeTimers()
    installGroupDb()
    let membershipCalls = 0
    let finishPriorityCheck!: () => void
    const priorityCheckFinished = new Promise<void>((resolve) => {
      finishPriorityCheck = resolve
    })
    mocks.chat.getGroupMemberIdsBatchAsync.mockImplementation(async (roomIds: string[]) => {
      membershipCalls += 1
      if (membershipCalls === 2) finishPriorityCheck()
      return roomIds.map((roomId) => ({
        roomId,
        status: 'ok',
        memberIds: [roomId === 'room@chatroom' ? 'wxid_room' : 'wxid_other']
      }))
    })
    let finishFirstHydration!: (snapshot: unknown) => void
    mocks.chat.getGroupSnapshotAsync
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishFirstHydration = resolve
        })
      )
      .mockReturnValue(new Promise(() => undefined))
    const service = new GroupExitMonitorService()
    service.setMonitoredRoomIds(['room@chatroom', 'other@chatroom'])
    await service.start(true)
    expect(mocks.chat.getGroupSnapshotAsync).toHaveBeenCalledOnce()

    service.notifyDatabaseChanged('{"table":"contact","action":"update"}')
    finishFirstHydration({
      roomId: 'room@chatroom',
      members: [{ wxid: 'wxid_room', nickname: '成员 1' }]
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(mocks.chat.getGroupSnapshotAsync).toHaveBeenCalledOnce()
    expect(mocks.chat.getGroupMemberIdsBatchAsync).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(350)
    await priorityCheckFinished
    expect(mocks.chat.getGroupMemberIdsBatchAsync).toHaveBeenCalledTimes(2)
    service.stop()
    vi.useRealTimers()
  })

  /**
   * 迁移后的分工：**退群监控只产生事件，发送完全归自动化**。
   *
   * 它不再读发送能力、不再调 `WechatActionGateway`、也不在事件上记发送状态。
   */
  it('hands the exit event to automation and never touches the send path itself', async () => {
    installGroupDb()
    writeBaseline([
      { roomId: 'room@chatroom', groupName: '测试群', members: [member, otherMember] }
    ])
    mocks.chat.getGroupMemberIdsBatchAsync.mockResolvedValue([
      { roomId: 'room@chatroom', status: 'ok', memberIds: [member.wxid] }
    ])
    const emitted: GroupMemberExitedEvent[] = []
    const service = new GroupExitMonitorService()
    service.setGroupExitHandler((event) => {
      emitted.push(event)
    })
    await service.start(true)
    const state = service.getState()

    expect(state.events[0]).toMatchObject({ memberWxid: 'wxid_other' })
    // 事件上不再有发送状态字段（发送结果归自动化执行日志）。
    expect(state.events[0]).not.toHaveProperty('notificationStatus')
    expect(state.events[0]).not.toHaveProperty('notification')
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({
      eventId: state.events[0].id,
      conversationId: 'room@chatroom',
      memberId: 'wxid_other',
      previousCount: 2,
      currentCount: 1
    })
    // 监控自己不发送、也不去问发送能力。
    expect(mocks.sender.send).not.toHaveBeenCalled()
    expect(mocks.capability.getPersonalWechatSendCapability).not.toHaveBeenCalled()
  })

  /*
   * 处理器抛错**不能**污染监控循环：退群事实已经落盘，
   * 通知失败是自动化那边的事（§「退群事实已检测成功 ≠ 通知发送成功」）。
   * 未捕获的 rejection 也会让整个 diff 循环挂掉。
   */
  it('keeps recording exits when the automation handler rejects', async () => {
    installGroupDb()
    writeBaseline([
      { roomId: 'room@chatroom', groupName: '测试群', members: [member, otherMember] }
    ])
    mocks.chat.getGroupMemberIdsBatchAsync.mockResolvedValue([
      { roomId: 'room@chatroom', status: 'ok', memberIds: [member.wxid] }
    ])
    const service = new GroupExitMonitorService()
    service.setGroupExitHandler(async () => {
      throw new Error('通知发送失败')
    })

    await service.start(true)
    // 让 handler 的 rejection 落地。
    await Promise.resolve()

    const state = service.getState()
    expect(state.events).toHaveLength(1)
    expect(state.events[0]).toMatchObject({ memberWxid: 'wxid_other' })
    expect(state.lastCheckedAt).toBeDefined()
  })

  it('does not re-emit the same snapshot diff when checked again', async () => {
    installGroupDb()
    writeBaseline([
      { roomId: 'room@chatroom', groupName: '测试群', members: [member, otherMember] }
    ])
    mocks.chat.getGroupMemberIdsBatchAsync.mockResolvedValue([
      { roomId: 'room@chatroom', status: 'ok', memberIds: [member.wxid] }
    ])
    const emitted: GroupMemberExitedEvent[] = []
    const service = new GroupExitMonitorService()
    service.setGroupExitHandler((event) => {
      emitted.push(event)
    })
    await service.start(true)
    await service.checkNow()
    await service.checkNow()

    // 快照已更新 ⇒ 后续检查没有新的 diff，也就不会重复投递事件。
    expect(emitted).toHaveLength(1)
    expect(service.getState().events).toHaveLength(1)
  })

  /*
   * 回归：append-only 文件的物理行序不保证时间有序 —— 迁移写入的一段是倒序
   * （新 → 旧），之后 append 的新事件是正序。内存必须显式重建「新在前」，
   * 否则列表顶部恒为最旧的一批（实测：09-20 的事件一直占第一条，
   * 09-21~09-23 的 46 条被排到第 211 位之后，看起来像「新事件全丢了」）。
   */
  it('returns newest events first even when the append-only file mixes both directions', () => {
    const base = Date.parse('2026-09-20T19:00:00+08:00')
    // 迁移段：倒序（新 → 旧）
    const migrated = [base, base - 60_000, base - 120_000]
    // 追加段：正序（旧 → 新）
    const appended = [base + 86_400_000, base + 172_800_000]
    writeBaseline([])
    writePersistedEvents([...migrated, ...appended])

    const state = new GroupExitMonitorService().getState()

    expect(state.events.map((event) => event.detectedAt)).toEqual(
      [...migrated, ...appended].sort((left, right) => right - left)
    )
    // 修复前这里会是迁移段的首条（base），正是用户看到的「顶部恒为 09-20」。
    expect(state.events[0].detectedAt).toBe(base + 172_800_000)
  })

  /*
   * 回归：state 回传上限必须截「最新」而不是「最旧」。
   * 磁盘是 append-only，新事件在文件末尾；未排序时 slice(0, 500) 会恰好把
   * 最新的事件全部挡在界面之外（按 11 条/天估算约 2026-10-16 触发）。
   */
  it('keeps the newest events when history exceeds the state payload limit', () => {
    const base = Date.parse('2026-09-20T00:00:00+08:00')
    const total = 520
    writeBaseline([])
    writePersistedEvents(Array.from({ length: total }, (_, index) => base + index * 60_000))

    const state = new GroupExitMonitorService().getState()

    expect(state.totalEventCount).toBe(total)
    expect(state.events).toHaveLength(500)
    expect(state.events[0].detectedAt).toBe(base + (total - 1) * 60_000)
    expect(state.events[state.events.length - 1].detectedAt).toBe(base + (total - 500) * 60_000)
  })
})
