import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 群员统计服务的差集 / freshness 行为。
 *
 * 依赖全部 mock：这一层要证明的是**编排规则**（谁进活跃榜、谁算未发言、
 * 什么情况下结论不完整），不是 SQL 正确性 —— 后者由
 * `knowledge-store-member-stats.test.ts` 用真实 SQLite 覆盖。
 */

const chatMock = vi.hoisted(() => ({
  resolveGroupRoomId: vi.fn(),
  getGroupMemberIdsAsync: vi.fn(),
  getGroupMemberNamesAsync: vi.fn()
}))

vi.mock('../../src/main/services/chat-service', () => chatMock)

import { GroupStatsService } from '../../src/main/services/group-stats-service'
import {
  GROUP_STATS_LIMITATION,
  GROUP_STATS_STALE_LIMITATION
} from '../../src/shared/group-stats'
import type { KnowledgeSearchService } from '../../src/main/knowledge/knowledge-search-service'
import type { KnowledgeMemberStatsResult } from '../../src/shared/knowledge'

const USER_MD5 = 'a'.repeat(32)
const ROOM_ID = 'room@chatroom'
const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

type Member = {
  wxid: string
  nickname: string
  groupNickname: string
  wechatNickname: string
  remark: string
  avatar: string
}

const member = (wxid: string, nickname: string): Member => ({
  wxid,
  nickname,
  groupNickname: '',
  wechatNickname: '',
  remark: '',
  avatar: ''
})

const statsResult = (
  overrides: Partial<KnowledgeMemberStatsResult> = {}
): KnowledgeMemberStatsResult => ({
  conversationId: USER_MD5,
  totalMessages: 0,
  senders: [],
  unattributedMessages: 0,
  excludedSystemMessages: 0,
  earliestMessageTime: NOW - 30 * DAY,
  indexLatestAt: NOW,
  ...overrides
})

function makeKnowledge(options: {
  result?: KnowledgeMemberStatsResult | null
  sourceLatestAt?: number | null
  retryResult?: KnowledgeMemberStatsResult | null
} = {}): KnowledgeSearchService {
  const first = options.result === undefined ? statsResult() : options.result
  const retry = options.retryResult === undefined ? first : options.retryResult
  let call = 0
  return {
    memberStats: vi.fn(async () => {
      call += 1
      return {
        result: call === 1 ? first : retry,
        sourceLatestAt: options.sourceLatestAt === undefined ? NOW : options.sourceLatestAt
      }
    }),
    requestCatchUp: vi.fn(() => ({ triggered: true, inProgress: true })),
    waitForIndexingComplete: vi.fn(async () => true)
  } as unknown as KnowledgeSearchService
}

const run = (
  knowledge: KnowledgeSearchService,
  startTime = NOW - 30 * DAY,
  endTime = NOW
) => new GroupStatsService(knowledge).getMemberStats({ userMd5: USER_MD5, startTime, endTime })

beforeEach(() => {
  chatMock.resolveGroupRoomId.mockReset().mockReturnValue(ROOM_ID)
  chatMock.getGroupMemberIdsAsync.mockReset().mockResolvedValue({
    roomId: ROOM_ID,
    memberIds: []
  })
  chatMock.getGroupMemberNamesAsync.mockReset().mockResolvedValue([])
})

describe('GroupStatsService · 差集', () => {
  it('5 名成员里 3 人有发言、2 人未发言', async () => {
    chatMock.getGroupMemberNamesAsync.mockResolvedValue([
      member('wxid_a', '阿一'),
      member('wxid_b', '阿二'),
      member('wxid_c', '阿三'),
      member('wxid_d', '阿四'),
      member('wxid_e', '阿五')
    ])
    const knowledge = makeKnowledge({
      result: statsResult({
        totalMessages: 16,
        senders: [
          { senderId: 'wxid_a', messageCount: 10, lastMessageTime: NOW - 1000 },
          { senderId: 'wxid_b', messageCount: 5, lastMessageTime: NOW - 2000 },
          { senderId: 'wxid_c', messageCount: 1, lastMessageTime: NOW - 3000 }
        ]
      })
    })

    const result = await run(knowledge)

    expect(result.memberCount).toBe(5)
    expect(result.activeMemberCount).toBe(3)
    expect(result.silentMemberCount).toBe(2)
    expect(result.activeMembers.map((item) => item.senderId)).toEqual([
      'wxid_a',
      'wxid_b',
      'wxid_c'
    ])
    expect(result.silentMembers.map((item) => item.senderId).sort()).toEqual([
      'wxid_d',
      'wxid_e'
    ])
  })

  it('历史消息的 sender 已退群时，不进当前成员活跃榜，并留下 limitation', async () => {
    chatMock.getGroupMemberNamesAsync.mockResolvedValue([member('wxid_a', '阿一')])
    const knowledge = makeKnowledge({
      result: statsResult({
        senders: [
          { senderId: 'wxid_a', messageCount: 5, lastMessageTime: NOW - 1000 },
          { senderId: 'wxid_left', messageCount: 3, lastMessageTime: NOW - 2000 }
        ]
      })
    })

    const result = await run(knowledge)

    expect(result.activeMembers.map((item) => item.senderId)).toEqual(['wxid_a'])
    expect(result.activeMemberCount).toBe(1)
    expect(result.limitations.some((text) => text.includes('已不在当前群成员名单中'))).toBe(true)
  })

  it('成员改昵称不影响统计：join 用 wxid，展示用当前昵称', async () => {
    chatMock.getGroupMemberNamesAsync.mockResolvedValue([member('wxid_a', '改过的名字')])
    const knowledge = makeKnowledge({
      result: statsResult({
        senders: [{ senderId: 'wxid_a', messageCount: 7, lastMessageTime: NOW - 500 }]
      })
    })

    const result = await run(knowledge)

    expect(result.activeMembers).toHaveLength(1)
    expect(result.activeMembers[0].displayName).toBe('改过的名字')
    expect(result.activeMembers[0].senderId).toBe('wxid_a')
    expect(result.silentMemberCount).toBe(0)
  })

  it('sender 缺失的消息只计入诊断，不硬映射给任何成员', async () => {
    chatMock.getGroupMemberNamesAsync.mockResolvedValue([
      member('wxid_a', '阿一'),
      member('wxid_b', '阿二')
    ])
    const knowledge = makeKnowledge({
      result: statsResult({
        senders: [{ senderId: 'wxid_a', messageCount: 4, lastMessageTime: NOW - 1000 }],
        unattributedMessages: 9
      })
    })

    const result = await run(knowledge)

    expect(result.unattributedMessages).toBe(9)
    // 未归属消息既不能把人抬进活跃榜，也不能把人踢进未发言名单之外。
    expect(result.activeMemberCount).toBe(1)
    expect(result.silentMemberCount).toBe(1)
    expect(result.activeMembers[0].senderId).toBe('wxid_a')
    expect(result.silentMembers[0].senderId).toBe('wxid_b')
  })

  it('活跃榜按条数降序，同数按最后发言时间降序', async () => {
    chatMock.getGroupMemberNamesAsync.mockResolvedValue([
      member('wxid_a', 'A'),
      member('wxid_b', 'B'),
      member('wxid_c', 'C')
    ])
    const knowledge = makeKnowledge({
      result: statsResult({
        senders: [
          { senderId: 'wxid_b', messageCount: 5, lastMessageTime: NOW - 9000 },
          { senderId: 'wxid_c', messageCount: 5, lastMessageTime: NOW - 1000 },
          { senderId: 'wxid_a', messageCount: 9, lastMessageTime: NOW - 5000 }
        ]
      })
    })

    const result = await run(knowledge)

    expect(result.activeMembers.map((item) => item.senderId)).toEqual([
      'wxid_a',
      'wxid_c',
      'wxid_b'
    ])
  })
})

describe('GroupStatsService · freshness', () => {
  it('索引追平时 complete = true', async () => {
    const result = await run(makeKnowledge({ sourceLatestAt: NOW }))
    expect(result.freshness).toBe('fresh')
    expect(result.complete).toBe(true)
    expect(result.limitations).not.toContain(GROUP_STATS_STALE_LIMITATION)
  })

  it('索引落后时 complete = false，绝不输出完整结论', async () => {
    const knowledge = makeKnowledge({
      result: statsResult({ indexLatestAt: NOW - 3 * DAY }),
      sourceLatestAt: NOW,
      // 追赶后仍然落后 —— 必须保持不完整。
      retryResult: statsResult({ indexLatestAt: NOW - 3 * DAY })
    })

    const result = await run(knowledge)

    expect(result.freshness).toBe('stale')
    expect(result.complete).toBe(false)
    expect(result.limitations).toContain(GROUP_STATS_STALE_LIMITATION)
  })

  it('落后时先触发有界追赶，追平后回到完整结论', async () => {
    const knowledge = makeKnowledge({
      result: statsResult({ indexLatestAt: NOW - 3 * DAY }),
      sourceLatestAt: NOW,
      retryResult: statsResult({ indexLatestAt: NOW })
    })

    const result = await run(knowledge)

    expect(knowledge.requestCatchUp).toHaveBeenCalled()
    expect(knowledge.waitForIndexingComplete).toHaveBeenCalled()
    expect(result.freshness).toBe('fresh')
    expect(result.complete).toBe(true)
  })

  it('口径缺失（indexLatestAt 为 null）按 unknown 处理，不得当作完整', async () => {
    const knowledge = makeKnowledge({
      result: statsResult({ indexLatestAt: null }),
      sourceLatestAt: null
    })

    const result = await run(knowledge)

    expect(result.freshness).toBe('unknown')
    expect(result.complete).toBe(false)
    expect(result.limitations).toContain(GROUP_STATS_STALE_LIMITATION)
  })

  it('结果里始终带边界说明', async () => {
    const result = await run(makeKnowledge())
    expect(result.limitations).toContain(GROUP_STATS_LIMITATION)
  })
})

describe('GroupStatsService · 异常输入', () => {
  it('不是群会话时返回空结果，不编造统计', async () => {
    chatMock.resolveGroupRoomId.mockReturnValue(null)

    const result = await run(makeKnowledge())

    expect(result.memberCount).toBe(0)
    expect(result.activeMemberCount).toBe(0)
    expect(result.silentMemberCount).toBe(0)
    expect(result.complete).toBe(false)
    expect(result.freshness).toBe('unknown')
    expect(chatMock.getGroupMemberIdsAsync).not.toHaveBeenCalled()
  })

  it('Knowledge 返回 null（派生库不可用）时不崩溃，且不完整', async () => {
    chatMock.getGroupMemberNamesAsync.mockResolvedValue([member('wxid_a', '阿一')])

    const result = await run(makeKnowledge({ result: null, sourceLatestAt: null }))

    expect(result.memberCount).toBe(1)
    expect(result.silentMemberCount).toBe(1)
    expect(result.complete).toBe(false)
  })
})
