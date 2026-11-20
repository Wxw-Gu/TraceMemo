/** `measuredAt` 是 epoch ms；`count: null` 是「未知」，调用方不得当成 0。 */
export interface ConversationMessageCountEntry {
  conversationId: string
  /** `null` = 未知（统计失败，或尚未统计）。 */
  count: number | null
  /**
   * 分片时间范围存在重叠时为 true：重叠区可能有迁移留下的重复行，
   * 此时 `count` 是上限而不是精确条数，UI 必须显示为估算。
   */
  approximate: boolean
  /** 统计完成时间（epoch ms）；`0` 表示尚未统计。 */
  measuredAt: number
}

export interface ConversationMessageCountSnapshot {
  entries: ConversationMessageCountEntry[]
}

export const EMPTY_CONVERSATION_MESSAGE_COUNT: Omit<ConversationMessageCountEntry, 'conversationId'> =
  {
    count: null,
    approximate: false,
    measuredAt: 0
  }
