import { isKnowledgeFresh } from '../../shared/knowledge'
import {
  GROUP_STATS_LIMITATION,
  GROUP_STATS_STALE_LIMITATION,
  type GroupMemberStatsActiveMember,
  type GroupMemberStatsQuery,
  type GroupMemberStatsResult,
  type GroupMemberStatsSilentMember,
  type GroupStatsFreshness
} from '../../shared/group-stats'
import type { KnowledgeSearchService } from '../knowledge/knowledge-search-service'
import * as chat from './chat-service'

/**
 * 触发一次追赶同步的最小间隔。
 *
 * 面板是可以反复开关的交互入口，而追赶同步跑的是真实增量 pass（会读 WCDB）。
 * 没有这个节流，连续点击就等于连续触发索引。
 */
const CATCH_UP_MIN_INTERVAL_MS = 30_000

/**
 * 追赶的有界等待预算。
 *
 * 与 Query 侧同一取舍：全量追赶可能以分钟计，交互查询绝不能无限等。
 * 预算用完之后**如实**把结果标成不完整，而不是假装完整。
 */
const FRESHNESS_WAIT_BUDGET_MS = 2_000

/**
 * 群员统计。
 *
 * 数据两路来源，职责严格分开：
 * - **当前成员名单** 走 WCDB 的轻路径（只取 wxid + 显示名，**不** hydrate 头像）；
 * - **发言聚合** 走 Knowledge 派生库的 `GROUP BY sender_id`，不读 WCDB 原始消息。
 *
 * 「未发言」= 当前成员 ∖ 窗口内有发言的 sender。这个定义**不能**简化成
 * 「整段窗口都没说话」—— 入群/退群时间在源头就不存在（整个 DB 没有该字段），
 * 所以结论必须带上 limitation。
 */
export class GroupStatsService {
  constructor(private readonly knowledge: KnowledgeSearchService) {}

  async getMemberStats(query: GroupMemberStatsQuery): Promise<GroupMemberStatsResult> {
    const { userMd5, startTime, endTime } = query
    const limitations = [GROUP_STATS_LIMITATION]

    const roomId = chat.resolveGroupRoomId(userMd5)
    if (!roomId) {
      // 不是群 / md5 解析不到：如实返回空，不编造统计。
      return this.build({
        userMd5,
        startTime,
        endTime,
        freshness: 'unknown',
        limitations,
        members: [],
        activeMembers: [],
        silentMembers: [],
        unattributedMessages: 0,
        excludedSystemMessages: 0,
        firstMessageTime: null
      })
    }

    // 1) 当前群成员 —— 轻路径。只取 wxid，再按需解析显示名；绝不走
    //    `getGroupSnapshotAsync`（它会 materialize 整群并 hydrate 头像，实测 8 群 ≈ 42s）。
    const membership = await chat.getGroupMemberIdsAsync(roomId)
    const memberIds = membership?.memberIds ?? []
    const members = await chat.getGroupMemberNamesAsync(userMd5, memberIds)

    // 2) 发言聚合（只统计当前群；系统消息在 SQL 层就被排除）
    let { result, sourceLatestAt } = await this.knowledge.memberStats({
      conversationId: userMd5,
      startTime,
      endTime
    })
    let freshness = judgeFreshness(result?.indexLatestAt ?? null, sourceLatestAt)

    // 3) 索引没追平 → 有界追赶一次再判。追不上就如实标 stale，
    //    **不允许**把落后索引算出来的「未发言」包装成完整结论。
    if (freshness !== 'fresh') {
      this.knowledge.requestCatchUp(CATCH_UP_MIN_INTERVAL_MS)
      const settled = await this.knowledge.waitForIndexingComplete(FRESHNESS_WAIT_BUDGET_MS)
      if (settled) {
        const retried = await this.knowledge.memberStats({
          conversationId: userMd5,
          startTime,
          endTime
        })
        result = retried.result
        sourceLatestAt = retried.sourceLatestAt
        freshness = judgeFreshness(result?.indexLatestAt ?? null, sourceLatestAt)
      }
    }

    // 4) 差集：当前成员 × 窗口内发言
    const statBySender = new Map<string, { messageCount: number; lastMessageTime: number }>()
    for (const row of result?.senders ?? []) {
      if (row.senderId) statBySender.set(row.senderId, row)
    }

    const knownSenderIds = new Set<string>()
    const activeMembers: GroupMemberStatsActiveMember[] = []
    const silentMembers: GroupMemberStatsSilentMember[] = []

    for (const member of members) {
      const wxid = String(member.wxid || '').trim()
      if (!wxid) continue
      knownSenderIds.add(wxid)
      // 与 Knowledge 的 Join key 必须是 wxid，不是昵称 —— 昵称会变。
      // 显示名沿用项目既有优先级（nickname 已内含 `wechatNickname || groupNickname || username`）。
      const displayName = member.nickname || member.remark || wxid
      const groupNickname = member.groupNickname || ''
      const stat = statBySender.get(wxid)
      if (stat && stat.messageCount > 0) {
        activeMembers.push({
          senderId: wxid,
          displayName,
          groupNickname,
          messageCount: stat.messageCount,
          lastMessageTime: stat.lastMessageTime
        })
      } else {
        silentMembers.push({ senderId: wxid, displayName, groupNickname })
      }
    }

    // 窗口内有发言、但已不在当前成员名单里的人（退群者）。
    // 默认**不**进活跃榜：那份名单读作「当前群成员」，混入已退群的人会误导。
    let formerSenderCount = 0
    for (const senderId of statBySender.keys()) {
      if (!knownSenderIds.has(senderId)) formerSenderCount += 1
    }

    activeMembers.sort(
      (a, b) => b.messageCount - a.messageCount || b.lastMessageTime - a.lastMessageTime
    )
    silentMembers.sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-Hans-CN'))

    if (freshness !== 'fresh') limitations.push(GROUP_STATS_STALE_LIMITATION)
    if (formerSenderCount > 0) {
      limitations.push(
        `另有 ${formerSenderCount} 位窗口内发言者已不在当前群成员名单中，未计入活跃榜。`
      )
    }

    return this.build({
      userMd5,
      startTime,
      endTime,
      freshness,
      limitations,
      members,
      activeMembers,
      silentMembers,
      unattributedMessages: result?.unattributedMessages ?? 0,
      excludedSystemMessages: result?.excludedSystemMessages ?? 0,
      firstMessageTime: result?.earliestMessageTime ?? null
    })
  }

  private build(input: {
    userMd5: string
    startTime: number
    endTime: number
    freshness: GroupStatsFreshness
    limitations: string[]
    members: Array<{ wxid: string }>
    activeMembers: GroupMemberStatsActiveMember[]
    silentMembers: GroupMemberStatsSilentMember[]
    unattributedMessages: number
    excludedSystemMessages: number
    firstMessageTime: number | null
  }): GroupMemberStatsResult {
    return {
      conversationId: input.userMd5,
      startTime: input.startTime,
      endTime: input.endTime,
      freshness: input.freshness,
      // 只有索引确实追平，才允许调用方把「未发言」当作完整结论。
      complete: input.freshness === 'fresh',
      memberCount: input.members.length,
      activeMemberCount: input.activeMembers.length,
      silentMemberCount: input.silentMembers.length,
      activeMembers: input.activeMembers,
      silentMembers: input.silentMembers,
      unattributedMessages: input.unattributedMessages,
      excludedSystemMessages: input.excludedSystemMessages,
      firstMessageTime: input.firstMessageTime,
      limitations: input.limitations
    }
  }
}

/**
 * `isKnowledgeFresh` 返回 `boolean | null`（任一侧口径缺失即 null）。
 * 三态都要能表达：`null` 绝不能当成「新鲜」。
 */
function judgeFreshness(
  indexLatestAt: number | null,
  sourceLatestAt: number | null
): GroupStatsFreshness {
  const fresh = isKnowledgeFresh({ indexLatestAt, sourceLatestAt })
  if (fresh === true) return 'fresh'
  if (fresh === false) return 'stale'
  return 'unknown'
}
