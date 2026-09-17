/**
 * 回答规则的语义断言。
 *
 * 这几条是**产品契约**，不是措辞偏好 —— 换行、改写都可以，但实质约束不能丢：
 *
 * 1. 当前是单次检索回答，没有自动连续的多轮工具执行；
 * 2. 因此禁止任何"下一步还能帮你继续"的邀约（那是能力幻觉）；
 * 3. 多条命中结果不能用 Markdown 表格承载（结果栏放不下，会错位）。
 *
 * 这里只断言关键语义片段，不做巨型 snapshot —— 措辞会调整，语义不会。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

import { ANSWER_RULES } from '../../src/main/services/query-agent-service'

describe('Query Agent 回答规则', () => {
  it('明确当前是单次检索回答，没有连续多轮执行', () => {
    expect(ANSWER_RULES).toContain('单次检索回答')
    expect(ANSWER_RULES).toContain('没有自动连续的多轮工具执行')
  })

  it('禁止续问邀约，并点名常见的错误句式', () => {
    expect(ANSWER_RULES).toContain('禁止')
    for (const phrase of ['如果你需要，我可以', '要不要我继续', '我还可以帮你进一步', '需要的话我再查']) {
      expect(ANSWER_RULES).toContain(phrase)
    }
  })

  it('禁止用 Markdown 表格承载多条命中结果', () => {
    expect(ANSWER_RULES).toContain('不要用 Markdown 表格')
  })

  it('派生内容要自报来源，不伪装成原始聊天文本', () => {
    expect(ANSWER_RULES).toContain('图片 OCR')
    expect(ANSWER_RULES).toContain('语音转写')
    expect(ANSWER_RULES).toContain('派生内容')
  })

  it('范围说明按需给，不机械复读', () => {
    expect(ANSWER_RULES).toContain('范围说明只在确有必要时给')
    expect(ANSWER_RULES).toContain('不要')
  })

  it('没有同一性证据时不把"疑似同图"写成确定事实', () => {
    expect(ANSWER_RULES).toContain('内容高度相似')
  })
})
