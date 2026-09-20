import { describe, expect, it } from 'vitest'
import {
  BUILTIN_DAILY_REPORT_RULE_ID,
  createDefaultDailyReportRule,
  matchKeyword,
  normalizeRuleDraft,
  type AutomationRule
} from '../../src/shared/automation'
import {
  matchAutomationRule,
  type AutomationMatchInput
} from '../../src/shared/automation-matcher'

/**
 * TriggerMatcher 的判定语义。
 *
 * 这些用例锁死的是 2026-09-20 真实环境 Spike 得出的**底层事实**，
 * 不是我们想要的语义 —— 尤其「正文里的 @昵称 不算真 @」这一条。
 */

/** 自己的微信 username。**刻意不带 `wxid_` 前缀** —— 前缀判断是 Spike 明确禁止的。 */
const SELF = 'my_account_9527'
const OTHER = 'zhangsan_1234'
const GROUP_ID = '12345678@chatroom'

function baseRule(overrides: Partial<AutomationRule> = {}): AutomationRule {
  return { ...createDefaultDailyReportRule(0), ...overrides }
}

function input(overrides: Partial<AutomationMatchInput> = {}): AutomationMatchInput {
  return {
    content: '今日日报',
    mentionTargets: [SELF],
    isSelf: false,
    isGroup: true,
    conversationId: GROUP_ID,
    ...overrides
  }
}

const match = (rule: AutomationRule, value: AutomationMatchInput): boolean =>
  matchAutomationRule(rule, value, [SELF]).matched

const reasonOf = (rule: AutomationRule, value: AutomationMatchInput): string | undefined =>
  matchAutomationRule(rule, value, [SELF]).reason

describe('TriggerMatcher', () => {
  it('内置规则命中：真正 @我 + 含关键词「日报」', () => {
    const rule = baseRule()
    expect(rule.id).toBe(BUILTIN_DAILY_REPORT_RULE_ID)
    expect(match(rule, input())).toBe(true)
  })

  it('假 @：正文里手打「@昵称」但底层没有 @ 元数据时不命中', () => {
    // 这正是 Spike 验证的核心事实：content 里的 @ 是纯文本，与真 @ 无关。
    expect(match(baseRule(), input({ content: '@我 今日日报', mentionTargets: [] }))).toBe(false)
    expect(reasonOf(baseRule(), input({ mentionTargets: [] }))).toBe('mention')
  })

  it('没有 @ 任何人时不命中', () => {
    expect(match(baseRule(), input({ mentionTargets: [] }))).toBe(false)
  })

  it('@ 的是别人（不是自己）时不命中', () => {
    expect(match(baseRule(), input({ mentionTargets: [OTHER] }))).toBe(false)
  })

  it('自己发送的消息不触发（防死循环第一道闸）', () => {
    // TraceMemo 回复的「收到，正在生成今日日报」含关键词「日报」，
    // 少了这道闸 MessageListener 再读到它就会自己触发自己。
    expect(match(baseRule(), input({ isSelf: true }))).toBe(false)
    expect(reasonOf(baseRule(), input({ isSelf: true }))).toBe('self')
  })

  it('ignoreSelf 被显式关掉时，自己的消息才会被判定为可触发', () => {
    const rule = baseRule()
    rule.conditions.ignoreSelf = false
    expect(match(rule, input({ isSelf: true }))).toBe(true)
  })

  it('停用的规则不命中', () => {
    expect(match(baseRule({ enabled: false }), input())).toBe(false)
    expect(reasonOf(baseRule({ enabled: false }), input())).toBe('disabled')
  })

  it('群范围规则收到私聊消息时不命中', () => {
    expect(match(baseRule(), input({ isGroup: false }))).toBe(false)
    expect(reasonOf(baseRule(), input({ isGroup: false }))).toBe('scope')
  })

  it('指定了生效群时，其它群不命中', () => {
    const rule = baseRule()
    rule.conditions.conversationIds = ['other@chatroom']
    expect(match(rule, input())).toBe(false)
    expect(reasonOf(rule, input())).toBe('conversation')
  })

  it('指定了生效群且命中该群时正常触发', () => {
    const rule = baseRule()
    rule.conditions.conversationIds = [GROUP_ID]
    expect(match(rule, input())).toBe(true)
  })

  it('空 conversationIds 表示不限会话', () => {
    const rule = baseRule()
    rule.conditions.conversationIds = []
    expect(match(rule, input({ conversationId: 'anyone@chatroom' }))).toBe(true)
  })

  it('关键词不匹配时不命中', () => {
    expect(match(baseRule(), input({ content: '今天的会议纪要' }))).toBe(false)
    expect(reasonOf(baseRule(), input({ content: '今天的会议纪要' }))).toBe('keyword')
  })

  it('关键词为空表示不限关键词', () => {
    const rule = baseRule()
    rule.conditions.keyword = ''
    expect(match(rule, input({ content: '随便说点什么' }))).toBe(true)
  })

  it('exact 模式要求整条消息等于关键词', () => {
    const rule = baseRule()
    rule.conditions.keywordMatchMode = 'exact'
    expect(match(rule, input({ content: '日报' }))).toBe(true)
    expect(match(rule, input({ content: '今天的日报' }))).toBe(false)
  })

  it('prefix 模式要求消息以关键词开头', () => {
    const rule = baseRule()
    rule.conditions.keywordMatchMode = 'prefix'
    expect(match(rule, input({ content: '日报 今天' }))).toBe(true)
    expect(match(rule, input({ content: '今天的日报' }))).toBe(false)
  })

  it('不假设自己的 username 以 wxid_ 开头', () => {
    // 把 selfUsernames 换成一个完全不符合 wxid_ 形态的值，依然要能精确匹配。
    const rule = baseRule()
    expect(
      matchAutomationRule(rule, input({ mentionTargets: ['plain_name'] }), ['plain_name']).matched
    ).toBe(true)
  })

  it('selfUsernames 为空时，任何 @ 都不算 @我', () => {
    expect(matchAutomationRule(baseRule(), input(), []).matched).toBe(false)
  })

  it('不需要 @我时，未 @ 也能因关键词命中', () => {
    const rule = baseRule()
    rule.conditions.requireMentionMe = false
    expect(match(rule, input({ mentionTargets: [], content: '今天的日报呢' }))).toBe(true)
  })
})

describe('matchKeyword', () => {
  it('大小写不敏感并忽略首尾空白', () => {
    expect(matchKeyword('  Today Daily Report ', 'daily report', 'contains')).toBe(true)
  })

  it('空关键词视为不限制', () => {
    expect(matchKeyword(undefined, '   ', 'contains')).toBe(true)
  })

  it('内容为空且关键词非空时不命中', () => {
    expect(matchKeyword(undefined, '日报', 'contains')).toBe(false)
  })
})

describe('normalizeRuleDraft', () => {
  it('把非法的匹配方式与范围收敛成安全默认值', () => {
    const draft = normalizeRuleDraft({
      name: '   ',
      scope: 'nonsense',
      conditions: { keywordMatchMode: 'regex', keyword: 'x', conversationIds: ['a', '', 'b'] },
      actions: [{ type: 'replyText', enabled: true }],
      cooldownSeconds: -5
    })
    expect(draft.name).toBe('未命名自动化')
    expect(draft.scope).toBe('group')
    expect(draft.conditions.keywordMatchMode).toBe('contains')
    expect(draft.conditions.conversationIds).toEqual(['a', 'b'])
    expect(draft.cooldownSeconds).toBe(0)
    // 默认必须是「忽略自己」+「必须 @我」—— 这两条是防循环的底线。
    expect(draft.conditions.ignoreSelf).toBe(true)
    expect(draft.conditions.requireMentionMe).toBe(true)
  })

  it('丢弃未知的 action 类型', () => {
    const draft = normalizeRuleDraft({
      name: 'x',
      conditions: {},
      actions: [{ type: 'generateReport', enabled: true }, { type: 'webhook', enabled: true }]
    })
    expect(draft.actions.map((action) => action.type)).toEqual(['generateReport'])
  })
})
