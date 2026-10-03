import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  root: `/tmp/tracememo-agent-api-phase2-${process.pid}`,
  contacts: [
    {
      m_nsUsrName: 'room@chatroom',
      m_nsNickName: '产品群',
      md5: 'room-md5',
      type: 'group' as const
    },
    {
      m_nsUsrName: 'wxid_friend',
      m_nsNickName: 'Alice',
      md5: 'friend-md5',
      type: 'user' as const,
      wxid: 'wxid_friend'
    }
  ],
  state: {
    enabled: true,
    running: true,
    nativeMonitorActive: true,
    monitoredRoomIds: ['room@chatroom'],
    monitoredGroupCount: 1,
    monitorSelectionConfigured: true,
    totalEventCount: 2,
    lastCheckedAt: 1_728_000_000_000,
    lastReadAt: 1_727_000_000_000,
    unreadCount: 1
  },
  events: [
    {
      id: 'event-2',
      contactId: 'room-md5',
      roomId: 'room@chatroom',
      groupName: '产品群',
      memberWxid: 'wxid_b',
      memberName: '乙',
      wechatName: '乙',
      groupRemark: '群乙',
      contactRemark: '',
      previousCount: 3,
      currentCount: 2,
      delta: -1,
      message: '乙退出了产品群',
      detectedAt: 1_728_000_000_000
    },
    {
      id: 'event-1',
      contactId: 'room-md5',
      roomId: 'room@chatroom',
      groupName: '产品群',
      memberWxid: 'wxid_a',
      memberName: '甲',
      wechatName: '甲',
      groupRemark: '',
      contactRemark: '',
      previousCount: 4,
      currentCount: 3,
      delta: -1,
      message: '甲退出了产品群',
      detectedAt: 1_727_000_000_000
    }
  ]
}))

vi.mock('electron', () => ({
  app: { getPath: () => fixture.root, getVersion: () => 'test-version' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

vi.mock('../../src/main/services/chat-service', () => ({
  isReady: () => true,
  listContacts: () => fixture.contacts,
  listContactsAsync: async () => fixture.contacts,
  listMessages: () => [],
  getGroupSnapshot: () => null,
  listRecentChat: () => [],
  resolveMd5: () => null
}))
vi.mock('../../src/main/group-report-service', () => ({ exportGroupReport: vi.fn() }))
vi.mock('../../src/main/services/agent-group-report-service', () => ({
  generateAgentGroupReport: vi.fn()
}))
vi.mock('../../src/main/services/agent-hub-service', () => ({
  agentHubService: { getStatus: () => ({ connector: 'offline' }) }
}))

import { LocalAgentApiService } from '../../src/main/services/local-agent-api-service'
import { startHttpServer, type HttpServerHandle } from '../../src/main/http-server'
import type { GroupMemberStatsResult } from '../../src/shared/group-stats'

const TOKEN = 'T'.repeat(43)
const handles: HttpServerHandle[] = []

function createApi(): LocalAgentApiService {
  const monitorState = fixture.state
  return new LocalAgentApiService({
    automationRuleStore: {
      listRules: () => [],
      getRule: () => undefined,
      createRule: () => { throw new Error('not used') },
      updateRule: () => undefined,
      deleteRule: () => false,
      setRuleEnabled: () => undefined
    } as never,
    automationExecutionLogService: { list: () => [] } as never,
    listContacts: async () => fixture.contacts,
    isDatabaseReady: () => true,
    getVersion: () => 'test-version',
    getPersonalWechatCapability: async () => ({
      supported: true,
      ready: false,
      status: 'needs_binding',
      capabilities: { text: false, image: false, voice: false }
    } as never),
    getAgentHubStatus: () => ({ connector: 'offline' }),
    getGroupExitMonitorState: () => ({ ...monitorState }),
    configureGroupExitMonitor: async (configuration) => {
      if (configuration.monitoredRoomIds !== undefined) {
        monitorState.monitoredRoomIds = [...configuration.monitoredRoomIds]
        monitorState.monitoredGroupCount = monitorState.monitoredRoomIds.length
      }
      if (configuration.enabled !== undefined) monitorState.enabled = configuration.enabled
      monitorState.running = monitorState.enabled
      return { ...monitorState }
    },
    listGroupExitMonitorEvents: ({ roomId, sinceMs, untilMs, limit }) =>
      fixture.events
        .filter((event) => !roomId || event.roomId === roomId)
        .filter((event) => sinceMs === undefined || event.detectedAt >= sinceMs)
        .filter((event) => untilMs === undefined || event.detectedAt <= untilMs)
        .sort((left, right) => left.detectedAt - right.detectedAt)
        .slice(-limit!),
    getGroupMemberStats: async (query): Promise<GroupMemberStatsResult> => ({
      conversationId: query.userMd5,
      startTime: query.startTime,
      endTime: query.endTime,
      freshness: 'stale',
      complete: false,
      memberCount: 2,
      activeMemberCount: 1,
      silentMemberCount: 1,
      activeMembers: [{
        senderId: 'wxid_a',
        displayName: '甲',
        groupNickname: '群甲',
        messageCount: 3,
        lastMessageTime: 1_728_000_000_000
      }],
      silentMembers: [{ senderId: 'wxid_b', displayName: '乙', groupNickname: '' }],
      unattributedMessages: 4,
      excludedSystemMessages: 5,
      firstMessageTime: 1_727_000_000_000,
      limitations: ['本地索引尚未完全同步，以下结果可能不完整。']
    })
  })
}

async function startServer(): Promise<HttpServerHandle> {
  const handle = await startHttpServer('127.0.0.1', 0, {
    tokenProvider: () => TOKEN,
    agentApiService: createApi()
  })
  handles.push(handle)
  return handle
}

async function request(
  handle: HttpServerHandle,
  pathname: string,
  method = 'GET',
  body?: unknown
): Promise<Response> {
  return fetch(`http://${handle.host}:${handle.port}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
}

describe('Agent API Phase 2', () => {
  afterEach(async () => {
    await Promise.all(handles.splice(0).map((handle) => handle.close()))
  })

  afterAll(async () => {
    await Promise.all(handles.splice(0).map((handle) => handle.close()))
  })

  it('advertises only the Phase 2 monitor and stats operations', async () => {
    const handle = await startServer()
    const response = await request(handle, '/api/v1/capabilities')
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.groupExitMonitor.operations).toEqual([
      'read_state',
      'configure_scope',
      'enable',
      'disable',
      'list_events'
    ])
    expect(body.groupStats.operations).toEqual(['member_stats'])
  })

  it('validates the complete monitor patch before changing scope', async () => {
    const handle = await startServer()
    const invalid = await request(handle, '/api/v1/monitors/group-exits', 'PATCH', {
      enabled: false,
      monitoredConversationIds: ['room@chatroom', 'missing@chatroom']
    })

    expect(invalid.status).toBe(422)
    expect(fixture.state.enabled).toBe(true)
    expect(fixture.state.monitoredRoomIds).toEqual(['room@chatroom'])

    const updated = await request(handle, '/api/v1/monitors/group-exits', 'PATCH', {
      enabled: false,
      monitoredConversationIds: []
    })
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({
      enabled: false,
      monitoredConversationIds: [],
      eventCount: 2
    })
  })

  it('returns stable event DTOs with time filters and ascending order', async () => {
    const handle = await startServer()
    const response = await request(
      handle,
      '/api/v1/monitors/group-exits/events?conversationId=room%40chatroom&since=2024-10-01T00%3A00%3A00%2B07%3A00&limit=1'
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ count: 1 })
    expect(body.events[0]).toMatchObject({
      eventId: 'event-2',
      conversationId: 'room@chatroom',
      memberId: 'wxid_b',
      detectedAt: new Date(1_728_000_000_000).toISOString()
    })
    expect(body.events[0].read).toBeUndefined()
  })

  it('adapts stable group IDs and preserves stats freshness diagnostics', async () => {
    const handle = await startServer()
    const response = await request(
      handle,
      '/api/v1/groups/room%40chatroom/member-stats?start=2026-10-01T00%3A00%3A00%2B07%3A00&end=2026-10-02T00%3A00%3A00%2B07%3A00'
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      conversation: { id: 'room@chatroom', name: '产品群' },
      conversationId: 'room@chatroom',
      freshness: 'stale',
      complete: false,
      unattributedMessages: 4,
      excludedSystemMessages: 5,
      firstMessageAt: new Date(1_727_000_000_000).toISOString()
    })
    expect(body.activeMembers[0]).toMatchObject({
      memberId: 'wxid_a',
      lastMessageAt: new Date(1_728_000_000_000).toISOString()
    })

    const direct = await request(
      handle,
      '/api/v1/groups/wxid_friend/member-stats?start=2026-10-01T00%3A00%3A00%2B07%3A00&end=2026-10-02T00%3A00%3A00%2B07%3A00'
    )
    expect(direct.status).toBe(422)
    expect((await direct.json()).error.code).toBe('NOT_GROUP_CONVERSATION')
  })
})
