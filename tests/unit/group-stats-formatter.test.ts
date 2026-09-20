import { describe, expect, it } from 'vitest'
import {
  formatActiveMemberStats,
  formatSilentMemberStats,
  formatStatsDate,
  formatStatsDateTime,
  resolveGroupStatsRangeStart,
  type GroupMemberStatsResult
} from '../../src/shared/group-stats'

/** 用本地时区构造时间，避免测试受运行机器时区影响。 */
const at = (year: number, month: number, day: number, hour = 0): number =>
  new Date(year, month - 1, day, hour).getTime()

const base = (overrides: Partial<GroupMemberStatsResult> = {}): GroupMemberStatsResult => ({
  conversationId: 'c'.repeat(32),
  startTime: at(2026, 6, 15),
  endTime: at(2026, 9, 4),
  freshness: 'fresh',
  complete: true,
  memberCount: 48,
  activeMemberCount: 45,
  silentMemberCount: 3,
  activeMembers: [],
  silentMembers: [],
  unattributedMessages: 0,
  excludedSystemMessages: 0,
  firstMessageTime: at(2026, 6, 15),
  limitations: [],
  ...overrides
})

describe('GroupStats formatter', () => {
  it('未发言模板按编号列出，并带区间与人数前缀', () => {
    const text = formatSilentMemberStats(
      base({
        silentMembers: [
          { senderId: 'wxid_1', displayName: '轩轩', groupNickname: '' },
          { senderId: 'wxid_2', displayName: '十二', groupNickname: '' },
          { senderId: 'wxid_3', displayName: '湘江中路', groupNickname: '' }
        ]
      })
    )

    expect(text).toContain('未发言统计')
    expect(text).toContain('2026-06-15 至 2026-09-04')
    expect(text).toContain('1. 轩轩')
    expect(text).toContain('2. 十二')
    expect(text).toContain('3. 湘江中路')
    // 纯文本：不能出现 Markdown 标记
    expect(text).not.toContain('**')
    expect(text).not.toContain('##')
  })

  it('未发言模板保留 limitation 文案', () => {
    const text = formatSilentMemberStats(
      base({
        silentMembers: [{ senderId: 'wxid_1', displayName: '轩轩', groupNickname: '' }],
        limitations: ['统计基于当前群成员名单与本地已归档消息。']
      })
    )
    expect(text).toContain('注：统计基于当前群成员名单与本地已归档消息。')
  })

  it('未发言为空时给出明确文案而不是空白', () => {
    const text = formatSilentMemberStats(base())
    expect(text).toContain('（无）')
  })

  it('未发言模板支持 limit 并说明省略人数', () => {
    const silentMembers = Array.from({ length: 5 }, (_, index) => ({
      senderId: `wxid_${index}`,
      displayName: `成员${index}`,
      groupNickname: ''
    }))
    const text = formatSilentMemberStats(base({ silentMembers }), { limit: 2 })
    expect(text).toContain('1. 成员0')
    expect(text).toContain('2. 成员1')
    expect(text).not.toContain('3. 成员2')
    expect(text).toContain('其余 3 人未列出')
  })

  it('活跃模板带条数', () => {
    const text = formatActiveMemberStats(
      base({
        activeMembers: [
          {
            senderId: 'wxid_1',
            displayName: '张三',
            groupNickname: '',
            messageCount: 328,
            lastMessageTime: at(2026, 9, 20, 12)
          },
          {
            senderId: 'wxid_2',
            displayName: '李四',
            groupNickname: '',
            messageCount: 217,
            lastMessageTime: at(2026, 9, 19, 12)
          }
        ]
      })
    )

    expect(text).toContain('群聊活跃统计')
    expect(text).toContain('统计时间：2026-06-15 至 2026-09-04')
    expect(text).toContain('1. 张三 328 条')
    expect(text).toContain('2. 李四 217 条')
  })

  it('群昵称与主名不同时显示成「微信名（群昵称）」', () => {
    const text = formatSilentMemberStats(
      base({
        silentMembers: [
          { senderId: 'wxid_1', displayName: '张三', groupNickname: '老张' },
          // 两者相同时不重复展示，避免噪声
          { senderId: 'wxid_2', displayName: '李四', groupNickname: '李四' },
          // 没有群昵称时只显示主名
          { senderId: 'wxid_3', displayName: '王五', groupNickname: '' }
        ]
      })
    )

    expect(text).toContain('1. 张三（老张）')
    expect(text).toContain('2. 李四')
    expect(text).not.toContain('李四（李四）')
    expect(text).toContain('3. 王五')
  })

  it('日期格式化使用本地时区且补零', () => {
    expect(formatStatsDate(at(2026, 1, 5))).toBe('2026-01-05')
    expect(formatStatsDateTime(at(2026, 1, 5, 9))).toBe('2026-01-05 09:00')
  })

  it('快捷范围按滑动窗口折算起点', () => {
    const end = at(2026, 9, 20)
    expect(resolveGroupStatsRangeStart('7d', end)).toBe(end - 7 * 24 * 60 * 60 * 1000)
    expect(resolveGroupStatsRangeStart('30d', end)).toBe(end - 30 * 24 * 60 * 60 * 1000)
    expect(resolveGroupStatsRangeStart('90d', end)).toBe(end - 90 * 24 * 60 * 60 * 1000)
  })

  it('「全部」不放下界（startTime = 0）', () => {
    expect(resolveGroupStatsRangeStart('all', at(2026, 9, 20))).toBe(0)
  })

  it('选「全部」时区间文案用本机第一条消息的真实日期，而不是 1970-01-01', () => {
    const text = formatSilentMemberStats(
      base({
        startTime: 0,
        firstMessageTime: at(2020, 2, 2),
        endTime: at(2026, 9, 20),
        silentMembers: [{ senderId: 'wxid_1', displayName: '轩轩', groupNickname: '' }]
      })
    )
    expect(text).toContain('2020-02-02 至 2026-09-20')
    expect(text).not.toContain('1970')
    expect(text).not.toContain('全部历史')
  })

  it('选「全部」但取不到第一条消息时，退化成「全部历史」且不假装从 1970 开始', () => {
    const text = formatSilentMemberStats(
      base({
        startTime: 0,
        firstMessageTime: null,
        endTime: at(2026, 9, 20),
        silentMembers: [{ senderId: 'wxid_1', displayName: '轩轩', groupNickname: '' }]
      })
    )
    expect(text).toContain('全部历史')
    expect(text).not.toContain('1970')
  })
})
