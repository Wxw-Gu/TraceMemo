import { describe, expect, it } from 'vitest'
import {
  QUERY_AGENT_PROGRESS_STEPS,
  queryAgentProgressLabel,
  queryAgentProgressStepIndex,
  type QueryAgentProgressState
} from '../../src/renderer/src/components/search/hooks/useQueryAgentProgress'

const state = (patch: Partial<QueryAgentProgressState> = {}): QueryAgentProgressState => ({
  stage: 'understanding',
  elapsedMs: 0,
  modelCallCount: 1,
  toolCallCount: 0,
  ...patch
})

/**
 * 进度文案必须来自**真实 Runtime 生命周期**，而且要说清"卡在哪一步"：
 * 静态 N 步文案加一个计时器，用户什么都判断不出来。
 */
describe('queryAgentProgressLabel', () => {
  it('maps every real lifecycle stage to a user-readable sentence', () => {
    expect(queryAgentProgressLabel(null, true)).toBe('正在准备查询')
    expect(queryAgentProgressLabel(state({ stage: 'understanding' }), true)).toBe(
      '正在理解你的问题'
    )
    expect(
      queryAgentProgressLabel(state({ stage: 'understanding', modelCallCount: 2 }), true)
    ).toBe('正在重新理解你的问题')
    expect(queryAgentProgressLabel(state({ stage: 'organizing_evidence' }), true)).toBe(
      '正在整理找到的聊天记录'
    )
    expect(queryAgentProgressLabel(state({ stage: 'generating_answer' }), true)).toBe(
      '正在生成回答'
    )
    expect(queryAgentProgressLabel(state({ stage: 'completed' }), true)).toBe('已完成')
  })

  it('explains the wider scope during the Tool phase instead of silently hanging', () => {
    // 跨会话检索是另一个量级的耗时；提前说清楚范围，用户才不会被"突然要好几十秒"劝退。
    expect(queryAgentProgressLabel(state({ stage: 'searching' }), true)).toBe(
      '正在搜索较大范围的聊天记录…'
    )
    expect(queryAgentProgressLabel(state({ stage: 'searching' }), false)).toBe(
      '正在搜索聊天记录…'
    )
  })

  it('never leaks internal tool names, SQL, FTS or ids', () => {
    const stages: QueryAgentProgressState['stage'][] = [
      'understanding',
      'searching',
      'organizing_evidence',
      'generating_answer',
      'completed'
    ]
    for (const stage of stages) {
      for (const wide of [true, false]) {
        const label = queryAgentProgressLabel(state({ stage, toolName: 'search_messages' }), wide)
        expect(label).not.toMatch(/query_messages|search_messages|message_context|overview/)
        expect(label).not.toMatch(/SELECT|FTS|fts|knowledge_|local:|[0-9a-f]{16,}/)
      }
    }
  })

  it('keeps the declared step list aligned with the runtime lifecycle', () => {
    expect(QUERY_AGENT_PROGRESS_STEPS.map((step) => step.stage)).toEqual([
      'understanding',
      'searching',
      'organizing_evidence',
      'generating_answer'
    ])
  })
})

describe('queryAgentProgressStepIndex', () => {
  it('advances monotonically with the lifecycle and completes at the end', () => {
    expect(queryAgentProgressStepIndex(null)).toBe(0)
    expect(queryAgentProgressStepIndex(state({ stage: 'understanding' }))).toBe(0)
    expect(queryAgentProgressStepIndex(state({ stage: 'searching' }))).toBe(1)
    expect(queryAgentProgressStepIndex(state({ stage: 'organizing_evidence' }))).toBe(2)
    expect(queryAgentProgressStepIndex(state({ stage: 'generating_answer' }))).toBe(3)
    expect(queryAgentProgressStepIndex(state({ stage: 'completed' }))).toBe(
      QUERY_AGENT_PROGRESS_STEPS.length
    )
  })
})
