/**
 * 群员统计的跨层契约与文本渲染。
 *
 * 放在 `shared` 的理由：renderer 需要结果类型做展示、需要 formatter 生成「复制」内容，
 * 而 formatter 是**纯函数**（不依赖 Electron / Node），正好符合 shared 的约束 ——
 * 业务文本绝不能由 React 组件拼接，否则复制出来的内容和界面上看到的会各说各话。
 */

/** 窗口内有发言的成员。 */
export interface GroupMemberStatsActiveMember {
  senderId: string
  /** 主显示名（微信昵称优先，与项目既有优先级一致）。 */
  displayName: string
  /**
   * 群昵称（这个人在本群里显示的名字）。
   *
   * 与 `displayName` 相同或为空时不展示 —— 同一个人在不同群里叫不同名字，
   * 只给一个名字会让人对不上号，但两个名字一样时重复展示又是噪声。
   */
  groupNickname: string
  messageCount: number
  /** 该成员在窗口内最后一条消息的时间，Unix epoch 毫秒。 */
  lastMessageTime: number
}

/** 窗口内没有发言记录的**当前**群成员。 */
export interface GroupMemberStatsSilentMember {
  senderId: string
  displayName: string
  groupNickname: string
}

/**
 * 派生索引相对源数据的新鲜度。
 *
 * - `fresh`   索引已追到源数据最新，结果可以当作完整结论
 * - `stale`   索引落后于源数据，结果**必须**标注为可能不完整
 * - `unknown` 口径缺失（例如源侧无缓存），无法判定，同样不得当作完整结论
 */
export type GroupStatsFreshness = 'fresh' | 'stale' | 'unknown'

/**
 * 群员统计查询请求（IPC 契约）。
 *
 * 时间用 epoch **毫秒**：这一路完全走 Knowledge，而 Knowledge 的内部口径就是毫秒。
 * 不沿用聊天消息的秒级口径，是为了让 service 内部不存在秒/毫秒跨边界 ——
 * 单位换错是**静默读到 0 条**，不会抛错。
 */
export interface GroupMemberStatsQuery {
  /** 群会话 md5（= `md5(username)`），与 `getGroupSnapshot(userMd5)` 同口径。 */
  userMd5: string
  /** 统计窗口起（含），Unix epoch 毫秒。 */
  startTime: number
  /** 统计窗口止（含），Unix epoch 毫秒。 */
  endTime: number
}

export interface GroupMemberStatsResult {
  conversationId: string
  /** 统计窗口起（含），Unix epoch 毫秒。 */
  startTime: number
  /** 统计窗口止（含），Unix epoch 毫秒。 */
  endTime: number
  freshness: GroupStatsFreshness
  /**
   * 是否可作为完整结论使用。
   *
   * **只有 `freshness === 'fresh'` 时才为 true。** 界面不得把 stale 的「未发言」
   * 名单包装成完整结论 —— 那是会把实际发过言的人挂到群里的错误否定。
   */
  complete: boolean
  /** 当前群成员总数。 */
  memberCount: number
  activeMemberCount: number
  silentMemberCount: number
  /** 按 `messageCount` 降序；同数按最后发言时间降序。 */
  activeMembers: GroupMemberStatsActiveMember[]
  /** 按显示名排序，便于人眼核对。 */
  silentMembers: GroupMemberStatsSilentMember[]
  /**
   * 窗口内 `sender_id` 缺失、无法归属任何成员的消息数。
   *
   * 只用于诊断，不计入任何成员的条数 —— 硬塞给某个人会制造假的「有发言」。
   */
  unattributedMessages: number
  /** 窗口内被排除的系统消息数（微信侧 10000 / 10002 等）。 */
  excludedSystemMessages: number
  /**
   * 窗口内**最早一条消息**的时间（epoch ms）；null 表示窗口内没有消息。
   *
   * 选「全部」时用它显示真实起点 ——「本机这个群第一条消息是 2020-02-02」，
   * 比「全部历史」这种含糊说法有用得多。
   */
  firstMessageTime: number | null
  /** 必须展示给用户的边界说明；为空表示无需额外声明。 */
  limitations: string[]
}

/** 未发言统计必须附带的边界说明（**不要删掉这个含义**）。 */
export const GROUP_STATS_LIMITATION =
  '统计基于当前群成员名单与本地已归档消息。窗口期前入群、统计期间退群或加入的成员，以及未归档时段，可能影响结果，仅供参考。'

/** 索引未追平时必须展示的额外说明。 */
export const GROUP_STATS_STALE_LIMITATION =
  '本地索引尚未完全同步，以下结果可能不完整。'

/** 统计时间范围的快捷选项。 */
export type GroupStatsRangeKey = '7d' | '30d' | '90d' | 'all' | 'custom'

export const GROUP_STATS_RANGE_OPTIONS: Array<{ key: GroupStatsRangeKey; label: string }> = [
  { key: '7d', label: '近 7 天' },
  { key: '30d', label: '近 30 天' },
  { key: '90d', label: '近 90 天' },
  { key: 'all', label: '全部' },
  { key: 'custom', label: '自定义' }
]

const RANGE_DAYS: Record<'7d' | '30d' | '90d', number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90
}

/**
 * 由「结束时刻 + 快捷范围」推出起点（epoch ms）。
 *
 * 用固定 24h 天数而不是日历日：用户要的是「最近 30 天」这种滑动窗口，
 * 日历日会随月份长度漂移，滑窗不会。
 *
 * `all` 返回 0（Unix epoch 起点）—— 语义是「不放下界」，覆盖全部已归档历史。
 */
export function resolveGroupStatsRangeStart(
  key: Exclude<GroupStatsRangeKey, 'custom'>,
  endTime: number
): number {
  if (key === 'all') return 0
  return endTime - RANGE_DAYS[key] * 24 * 60 * 60 * 1000
}

const DIVIDER = '--------------------'

/**
 * 名单一行里的名字：`主名（群昵称）`。
 *
 * 同一个人在微信里和在这个群里可能叫两个名字，只给一个会让人对不上号；
 * 但两者相同时重复展示又是纯噪声，所以只在**真的不同**时才加括号。
 */
export function formatMemberLineName(member: {
  displayName: string
  groupNickname: string
}): string {
  if (member.groupNickname && member.groupNickname !== member.displayName) {
    return `${member.displayName}（${member.groupNickname}）`
  }
  return member.displayName
}

const pad2 = (value: number): string => String(value).padStart(2, '0')

/** 本地时区的 `YYYY-MM-DD`。 */
export function formatStatsDate(epochMs: number): string {
  const date = new Date(epochMs)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** 本地时区的 `YYYY-MM-DD HH:mm`。 */
export function formatStatsDateTime(epochMs: number): string {
  const date = new Date(epochMs)
  if (Number.isNaN(date.getTime())) return ''
  return `${formatStatsDate(epochMs)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/**
 * 区间的人类可读文案。
 *
 * 选「全部」时 `startTime === 0`（不放下界），此时用 `firstMessageTime`
 * 显示**本机这个群第一条消息**的真实日期 ——「2020-02-02 至 2026-09-20」比
 * 「全部历史」有用得多。两者都拿不到时才退化成「全部历史」，
 * 且绝不格式化成 1970-01-01 假装统计真的从那儿开始。
 */
const rangeLabel = (
  result: Pick<GroupMemberStatsResult, 'startTime' | 'endTime' | 'firstMessageTime'>
): string => {
  const start = result.startTime > 0 ? result.startTime : result.firstMessageTime
  if (start && start > 0) {
    return `${formatStatsDate(start)} 至 ${formatStatsDate(result.endTime)}`
  }
  return `全部历史（至 ${formatStatsDate(result.endTime)}）`
}

/**
 * 未发言名单的纯文本模板。
 *
 * 刻意使用纯文本而非 Markdown：这段文本的归宿是聊天窗口，任何富文本标记
 * 在微信里都会变成裸露的符号。
 */
export function formatSilentMemberStats(
  result: GroupMemberStatsResult,
  options: { limit?: number } = {}
): string {
  const limit = options.limit && options.limit > 0 ? options.limit : result.silentMembers.length
  const listed = result.silentMembers.slice(0, limit)

  const lines = [
    '未发言统计',
    `以下当前群成员在 ${rangeLabel(result)} 的本地已归档消息中无发言记录`,
    DIVIDER
  ]

  if (listed.length === 0) {
    lines.push('（无）')
  } else {
    listed.forEach((member, index) => {
      lines.push(`${index + 1}. ${formatMemberLineName(member)}`)
    })
    if (listed.length < result.silentMembers.length) {
      lines.push(`… 其余 ${result.silentMembers.length - listed.length} 人未列出`)
    }
  }

  const notes = [...result.limitations]
  if (notes.length) {
    lines.push('', `注：${notes.join(' ')}`)
  }
  return lines.join('\n')
}

/** 活跃榜的纯文本模板。 */
export function formatActiveMemberStats(
  result: GroupMemberStatsResult,
  options: { limit?: number } = {}
): string {
  const limit = options.limit && options.limit > 0 ? options.limit : result.activeMembers.length
  const listed = result.activeMembers.slice(0, limit)

  const lines = [
    '群聊活跃统计',
    `统计时间：${rangeLabel(result)}`,
    DIVIDER
  ]

  if (listed.length === 0) {
    lines.push('（无）')
  } else {
    listed.forEach((member, index) => {
      lines.push(`${index + 1}. ${formatMemberLineName(member)} ${member.messageCount} 条`)
    })
    if (listed.length < result.activeMembers.length) {
      lines.push(`… 其余 ${result.activeMembers.length - listed.length} 人未列出`)
    }
  }

  const notes = [...result.limitations]
  if (notes.length) {
    lines.push('', `注：${notes.join(' ')}`)
  }
  return lines.join('\n')
}
