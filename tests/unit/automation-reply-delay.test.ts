import { describe, expect, it } from 'vitest'

import {
  AUTOMATION_REPLY_DELAY_DEFAULT_SECONDS,
  AUTOMATION_REPLY_DELAY_MAX_SECONDS,
  createDefaultDailyReportRule,
  normalizeReplyDelaySeconds,
  normalizeRuleDraft
} from '../../src/shared/automation'

/**
 * 「回复前等待」的口径：它是**规则自己的一项执行参数**（`replyDelaySeconds`，秒），
 * 与 `cooldownSeconds` 同口径 —— 界面上是秒、落盘也是秒，只有 runner 换算成毫秒。
 *
 * 核心契约：**填错了不该静默变成「不等待」**。默认 2 秒、0 是合法值、
 * 垃圾输入回落默认、超限截断。
 */
describe('normalizeReplyDelaySeconds', () => {
  it('缺省 / 空串 / null 都回落到默认 2 秒', () => {
    for (const value of [undefined, null, '']) {
      expect(normalizeReplyDelaySeconds(value)).toBe(AUTOMATION_REPLY_DELAY_DEFAULT_SECONDS)
    }
    expect(AUTOMATION_REPLY_DELAY_DEFAULT_SECONDS).toBe(2)
  })

  it('非法输入回落到默认值，而不是 0', () => {
    for (const value of ['abc', NaN, Infinity, -Infinity, '两秒', {}]) {
      expect(normalizeReplyDelaySeconds(value)).toBe(AUTOMATION_REPLY_DELAY_DEFAULT_SECONDS)
    }
  })

  it('0 与负数都收敛成「不等待」，但两者语义不同 —— 0 是显式合法值', () => {
    expect(normalizeReplyDelaySeconds(0)).toBe(0)
    expect(normalizeReplyDelaySeconds('0')).toBe(0)
    expect(normalizeReplyDelaySeconds(-1)).toBe(0)
  })

  it('正常值取整保留，超过上限按上限截断', () => {
    expect(normalizeReplyDelaySeconds(5)).toBe(5)
    expect(normalizeReplyDelaySeconds('30')).toBe(30)
    expect(normalizeReplyDelaySeconds(4.6)).toBe(5)
    expect(normalizeReplyDelaySeconds(AUTOMATION_REPLY_DELAY_MAX_SECONDS + 1)).toBe(
      AUTOMATION_REPLY_DELAY_MAX_SECONDS
    )
    expect(normalizeReplyDelaySeconds(99_999)).toBe(AUTOMATION_REPLY_DELAY_MAX_SECONDS)
  })
})

describe('规则里的回复前等待', () => {
  it('内置「@我生成日报」默认 2 秒', () => {
    expect(createDefaultDailyReportRule(0).replyDelaySeconds).toBe(
      AUTOMATION_REPLY_DELAY_DEFAULT_SECONDS
    )
  })

  it('草稿归一化会带上这个字段（否则编辑页拿不到值）', () => {
    const draft = normalizeRuleDraft({
      name: '测试',
      replyDelaySeconds: 7,
      actions: [{ type: 'replyText', enabled: true, text: '收到' }]
    })
    expect(draft.replyDelaySeconds).toBe(7)
  })

  it('旧版 rules.json 里的规则没有这个字段 → 读出来是默认 2 秒，不是 undefined', () => {
    const draft = normalizeRuleDraft({
      name: '旧规则',
      actions: [{ type: 'replyText', enabled: true, text: '收到' }]
    })
    expect(draft.replyDelaySeconds).toBe(AUTOMATION_REPLY_DELAY_DEFAULT_SECONDS)
  })

  it('草稿里的脏值同样被收敛', () => {
    expect(
      normalizeRuleDraft({ name: 'x', replyDelaySeconds: -3, actions: [] }).replyDelaySeconds
    ).toBe(0)
    expect(
      normalizeRuleDraft({ name: 'x', replyDelaySeconds: 'abc', actions: [] }).replyDelaySeconds
    ).toBe(AUTOMATION_REPLY_DELAY_DEFAULT_SECONDS)
    expect(
      normalizeRuleDraft({ name: 'x', replyDelaySeconds: 1e9, actions: [] }).replyDelaySeconds
    ).toBe(AUTOMATION_REPLY_DELAY_MAX_SECONDS)
  })
})
