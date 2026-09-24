import {
  matchKeyword,
  type AutomationMessageScope,
  type AutomationRule
} from './automation'

/**
 * TriggerMatcher —— 判断「这条消息是否命中这条规则」。
 *
 * **纯函数**，放在 shared 而不是 main，理由是它有两个消费方：
 * 1. 真实执行链路（AutomationService）；
 * 2. 规则编辑页的「效果模拟预览」。
 *
 * 如果预览自己写一套判断，界面演示和真实行为必然逐渐分叉 ——
 * 那种分叉用户看不出来，但会导致"预览能过、实际不触发"。
 */

/**
 * 判定所需的**最小**消息输入。
 *
 * 刻意不直接依赖 main 侧的 `NormalizedIncomingMessage`：shared 不允许反向依赖 main。
 * 结构化的类型让 main 侧可以直接把那个 DTO 传进来。
 */
export interface AutomationMatchInput {
  content?: string
  /** **真 @ 目标**（由 `source → <atuserlist>` 解析，不是正文里的 `@昵称`）。 */
  mentionTargets: string[]
  isSelf: boolean
  isGroup: boolean
  /** 会话标识（群 md5）。 */
  conversationId: string
}

export type AutomationMatchFailure =
  | 'rule_type'
  | 'disabled'
  | 'self'
  | 'scope'
  | 'conversation'
  | 'mention'
  | 'keyword'

export interface AutomationMatchResult {
  matched: boolean
  /** 未命中的原因。仅用于内部日志与调优，不展示给用户。 */
  reason?: AutomationMatchFailure
}

/** 判定顺序：越靠前的越便宜，且都是「一票否决」。 */
export function matchAutomationRule(
  rule: AutomationRule,
  input: AutomationMatchInput,
  /** 自己的 username 候选集（`getMyUsernameCandidates()`）。 */
  selfUsernames: readonly string[]
): AutomationMatchResult {
  // **规则类型闸门放在最前面。**
  //
  // 「退群通知」的空关键词 + 不要求 @我，会让它命中**每一条群消息** ——
  // 那是最坏的一类 bug：用户什么都没配，规则却开始乱跑。
  // 类型分派必须在这里一处解决，预览与真实执行才会一致。
  if (rule.ruleType === 'leave_notification') {
    return { matched: false, reason: 'rule_type' }
  }

  if (!rule.enabled) return { matched: false, reason: 'disabled' }

  // 防死循环第一道闸：自己发的消息默认不触发。
  // TraceMemo 回复的那句「收到，正在生成今日日报」会被 MessageListener 再次读到，
  // 没有这道闸就会自己触发自己。
  if (rule.conditions.ignoreSelf !== false && input.isSelf) {
    return { matched: false, reason: 'self' }
  }

  const scope: AutomationMessageScope = rule.scope
  if (scope === 'group' && !input.isGroup) return { matched: false, reason: 'scope' }
  if (scope === 'direct' && input.isGroup) return { matched: false, reason: 'scope' }

  // 生效范围：**空数组 = 不限会话**。
  const conversationIds = rule.conditions.conversationIds ?? []
  if (conversationIds.length && !conversationIds.includes(input.conversationId)) {
    return { matched: false, reason: 'conversation' }
  }

  // 真 @ 判定：只认 `source → atuserlist` 解析出的 username，
  // 与自己的候选 username 做**精确匹配**。
  //
  // 三条禁止的做法（Spike 已实证）：
  // - `content.includes('@我的昵称')` —— 正文里的 @ 是纯文本，与真 @ 无关；
  // - 昵称匹配 —— 昵称会改；
  // - `target.startsWith('wxid_')` —— 自己的 username 可能压根不是这个前缀。
  if (rule.conditions.requireMentionMe) {
    const self = new Set(selfUsernames.filter(Boolean))
    const mentioned = input.mentionTargets.some((target) => self.has(target))
    if (!mentioned) return { matched: false, reason: 'mention' }
  }

  if (!matchKeyword(input.content, rule.conditions.keyword, rule.conditions.keywordMatchMode)) {
    return { matched: false, reason: 'keyword' }
  }

  return { matched: true }
}
