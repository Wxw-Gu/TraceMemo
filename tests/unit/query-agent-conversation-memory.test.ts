import { describe, expect, it } from 'vitest'
import {
  CONVERSATION_MEMORY_ANSWER_MAX_CHARS,
  CONVERSATION_MEMORY_MAX_TURNS,
  CONVERSATION_MEMORY_QUESTION_MAX_CHARS,
  CONVERSATION_MEMORY_TTL_MS,
  QueryAgentConversationMemory
} from '../../src/main/services/query-agent-conversation-memory'

describe('QueryAgentConversationMemory', () => {
  it('只保留最近 N 轮，且有明确长度边界', () => {
    const memory = new QueryAgentConversationMemory()
    memory.record('k', 'q1', 'a1')
    memory.record('k', 'q2', 'a2')
    memory.record('k', 'q3', 'a3')

    const history = memory.history('k')
    expect(history).toHaveLength(CONVERSATION_MEMORY_MAX_TURNS)
    expect(history.map((turn) => turn.question)).toEqual(['q2', 'q3'])
  })

  it('超长问题与回答会被截断', () => {
    const memory = new QueryAgentConversationMemory()
    memory.record('k', 'q'.repeat(500), 'a'.repeat(2000))

    const [turn] = memory.history('k')
    expect(turn.question.length).toBe(CONVERSATION_MEMORY_QUESTION_MAX_CHARS + 1)
    expect(turn.answer.length).toBe(CONVERSATION_MEMORY_ANSWER_MAX_CHARS + 1)
  })

  it('超过 TTL 后自动失效', () => {
    let now = 1_000
    const memory = new QueryAgentConversationMemory(() => now)
    memory.record('k', 'q', 'a')
    expect(memory.history('k')).toHaveLength(1)

    now += CONVERSATION_MEMORY_TTL_MS + 1
    expect(memory.history('k')).toEqual([])
  })

  it('按会话隔离，forget 只清目标会话', () => {
    const memory = new QueryAgentConversationMemory()
    memory.record('a', 'q-a', 'a-a')
    memory.record('b', 'q-b', 'a-b')

    memory.forget('a')
    expect(memory.history('a')).toEqual([])
    expect(memory.history('b')).toHaveLength(1)

    memory.forget()
    expect(memory.history('b')).toEqual([])
  })

  it('空白内容不进入记忆', () => {
    const memory = new QueryAgentConversationMemory()
    memory.record('k', '   ', 'a')
    memory.record('k', 'q', '   ')
    expect(memory.history('k')).toEqual([])
  })
})
