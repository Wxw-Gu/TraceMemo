import { mkdtempSync, readJsonSync, rmSync, writeJsonSync } from 'fs-extra'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  userData: '',
  chat: {
    getChatDb: vi.fn(),
    getCurrentAccountRoot: vi.fn(() => 'fixture-account'),
    isReady: vi.fn(() => true),
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
import { GROUP_EXIT_NOTIFICATION_TEMPLATE } from '../../src/shared/group-exit-monitor'

const member = { wxid: 'wxid_member', wechatNickname: '微信名', groupNickname: '群内名' }

function installGroupDb(): void {
  const client = {
    getSessionsAsync: vi
      .fn()
      .mockResolvedValue([{ username: 'room@chatroom', nickname: '测试群' }]),
    md5: vi.fn(() => 'room-md5')
  }
  mocks.chat.getChatDb.mockReturnValue({ getWcdb4Client: () => client })
}

describe('GroupExitMonitorService', () => {
  const temporaryDirectories: string[] = []

  beforeEach(() => {
    mocks.userData = mkdtempSync(join(tmpdir(), 'tracememo-group-monitor-'))
    temporaryDirectories.push(mocks.userData)
    mocks.chat.getChatDb.mockReset()
    mocks.chat.getCurrentAccountRoot.mockReset().mockReturnValue('fixture-account')
    mocks.chat.isReady.mockReset().mockReturnValue(true)
    mocks.chat.getGroupSnapshotAsync.mockReset()
    mocks.capability.getPersonalWechatSendCapability.mockReset()
    mocks.sender.send.mockReset()
  })

  afterEach(() => {
    while (temporaryDirectories.length) {
      rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
    }
  })

  it('persists a validated custom template in the monitor state file', () => {
    const service = new GroupExitMonitorService()
    const template = '[退群监测]\n用户: {user}'

    const state = service.setNotificationTemplate(template)
    expect(state.notificationTemplate).toBe(template)
    expect(readJsonSync(join(mocks.userData, 'group-exit-monitor.json')).notificationTemplate).toBe(
      template
    )
    expect(() => service.setNotificationTemplate('用户: {unknown}')).toThrow('不支持的占位符')
  })

  it('migrates the previous default notification template', () => {
    writeJsonSync(join(mocks.userData, 'group-exit-monitor.json'), {
      notificationTemplate:
        '[退群监测]\n\n用户: {user}\n\n群备注: {groupRemark}\n\n微信号: {wxid}\n\n退群时间: {time}'
    })

    const service = new GroupExitMonitorService()

    expect(service.getState().notificationTemplate).toBe(GROUP_EXIT_NOTIFICATION_TEMPLATE)
  })

  it('keeps the previous baseline when a native snapshot contains null members', async () => {
    installGroupDb()
    mocks.chat.getGroupSnapshotAsync.mockResolvedValueOnce({
      roomId: 'room@chatroom',
      members: [member]
    })
    const service = new GroupExitMonitorService()
    service.setMonitoredRoomIds(['room@chatroom'])
    await service.start(true)

    mocks.chat.getGroupSnapshotAsync.mockResolvedValueOnce({
      roomId: 'room@chatroom',
      members: null
    })
    const state = await service.checkNow()

    expect(state.events).toEqual([])
    expect(state.monitoredGroupCount).toBe(1)
  })

  it('returns from scope saving before the background baseline read completes', async () => {
    installGroupDb()
    mocks.chat.getGroupSnapshotAsync.mockResolvedValueOnce({
      roomId: 'room@chatroom',
      members: [member]
    })
    const service = new GroupExitMonitorService()
    service.setMonitoredRoomIds(['room@chatroom'])
    await service.start(true)

    let release!: (snapshot: unknown) => void
    mocks.chat.getGroupSnapshotAsync.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      })
    )
    const startedAt = Date.now()
    const state = await service.setMonitoredRoomIds(['room@chatroom'])

    expect(Date.now() - startedAt).toBeLessThan(250)
    expect(state.monitoredRoomIds).toEqual(['room@chatroom'])
    release({ roomId: 'room@chatroom', members: [member] })
  })

  it('renders the saved template before sending a group notification', async () => {
    installGroupDb()
    mocks.capability.getPersonalWechatSendCapability.mockResolvedValue({
      ready: true,
      capabilities: { text: true }
    })
    mocks.sender.send.mockResolvedValue({ success: true })
    mocks.chat.getGroupSnapshotAsync
      .mockResolvedValueOnce({
        roomId: 'room@chatroom',
        members: [member, { wxid: 'wxid_other', wechatNickname: '另一个人' }]
      })
      .mockResolvedValueOnce({ roomId: 'room@chatroom', members: [member] })
    const service = new GroupExitMonitorService()
    service.setNotificationTemplate('退群: {user}/{groupRemark}/{wxid}')
    service.setMonitoredRoomIds(['room@chatroom'], ['room@chatroom'])
    await service.start(true)
    await service.checkNow()

    expect(mocks.sender.send).toHaveBeenCalledWith({
      type: 'text',
      to: 'room@chatroom',
      isGroup: true,
      text: '退群: 另一个人/未设置/wxid_other'
    })
  })
})
