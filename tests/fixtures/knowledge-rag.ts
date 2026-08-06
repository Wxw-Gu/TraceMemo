import type { KnowledgeConversationInput, KnowledgeSourceMessage } from '../../src/shared/knowledge'

export type KnowledgeBenchmarkCategory = 'fact' | 'person' | 'time' | 'decision' | 'semantic'

export interface KnowledgeBenchmarkCase {
  id: string
  category: KnowledgeBenchmarkCategory
  question: string
  oldSearchTerms: string[]
  expectedMessageIds: string[]
}

export const FIXTURE_ACCOUNT_A = 'fixture-account-alpha'
export const FIXTURE_ACCOUNT_B = 'fixture-account-beta'

function message(
  id: string,
  conversationId: string,
  createTime: number,
  text: string,
  extra: Partial<KnowledgeSourceMessage> = {}
): KnowledgeSourceMessage {
  return {
    accountId: extra.accountId || FIXTURE_ACCOUNT_A,
    conversationId,
    messageId: id,
    createTime,
    senderId: extra.senderId || 'fixture-sender',
    senderName: extra.senderName || '脱敏成员',
    kind: extra.kind || 'text',
    text,
    attachment: extra.attachment,
    voiceTranscript: extra.voiceTranscript
  }
}

/** Deterministic and fully synthetic: no wxid, file path, secret, or real chat text. */
export function createKnowledgeBenchmarkFixture(): {
  conversations: KnowledgeConversationInput[]
  cases: KnowledgeBenchmarkCase[]
} {
  const messages: KnowledgeSourceMessage[] = []
  const cases: KnowledgeBenchmarkCase[] = []
  const base = Date.UTC(2025, 0, 1)
  const add = (
    category: KnowledgeBenchmarkCategory,
    index: number,
    text: string,
    question: string,
    oldSearchTerms: string[],
    extra: Partial<KnowledgeSourceMessage> = {}
  ): void => {
    const conversationId = `fixture-${category}-${index % 5}`
    const id = `fixture-${category}-${index}-evidence`
    messages.push(message(id, conversationId, base + (cases.length + 1) * 60_000, text, extra))
    messages.push(
      message(
        `fixture-${category}-${index}-context`,
        conversationId,
        base + (cases.length + 1) * 60_000 + 20_000,
        `脱敏上下文 ${index}：确认后续会回到原始消息核对。`,
        { senderId: 'fixture-context', senderName: '脱敏同事' }
      )
    )
    cases.push({
      id: `question-${category}-${index}`,
      category,
      question,
      oldSearchTerms,
      expectedMessageIds: [id]
    })
  }
  for (let index = 1; index <= 20; index += 1) {
    add(
      'fact',
      index,
      `资料编号 FACT-${index} 的部署地址是 https://example.invalid/fact-${index}，附件名称是 runbook-${index}.pdf。`,
      `第 ${index} 项部署资料在哪里？`,
      [`FACT-${index}`, `runbook-${index}.pdf`],
      { attachment: { name: `runbook-${index}.pdf`, kind: 'file' } }
    )
    add(
      'person',
      index,
      `成员 代号成员${index} 负责发布检查，并说明本周会完成验证清单。`,
      `代号成员${index} 最近负责什么？`,
      [`代号成员${index}`, '发布检查']
    )
    add(
      'time',
      index,
      `日期标记 TIME-${index}：在第 ${index} 次周会讨论了回归安排和验收顺序。`,
      `TIME-${index} 当天讨论了什么？`,
      [`TIME-${index}`, '回归安排']
    )
    add(
      'decision',
      index,
      `决策 DECISION-${index}：最终选择方案蓝图${index}，原因是可追溯、可回滚且维护成本更低。`,
      `为什么第 ${index} 个决策选择方案蓝图${index}？`,
      [`DECISION-${index}`, `方案蓝图${index}`]
    )
    add(
      'semantic',
      index,
      `语义样本 ${index}：把分散的讨论归档，方便以后重新查看和核对当时的上下文。`,
      `哪里提到把内容收起来以后查看？第 ${index} 条。`,
      [`内容收起来${index}`],
      { kind: 'voice', voiceTranscript: `请将分散讨论集中保存，便于之后重新查看，第 ${index} 条。` }
    )
  }
  const grouped = new Map<string, KnowledgeSourceMessage[]>()
  for (const item of messages) {
    const current = grouped.get(item.conversationId) || []
    current.push(item)
    grouped.set(item.conversationId, current)
  }
  return {
    conversations: Array.from(grouped.entries()).map(([conversationId, source]) => ({
      conversationId,
      completeSnapshot: true,
      messages: source
    })),
    cases
  }
}

export function createSyntheticConversation(
  accountId: string,
  conversationId: string,
  startIndex: number,
  count: number,
  distribution: 'short' | 'mixed' | 'long'
): KnowledgeConversationInput {
  const base = Date.UTC(2025, 0, 1) + startIndex * 1000
  const messages: KnowledgeSourceMessage[] = []
  const shortText = '脱敏短消息：已确认。'
  const mixedText = '脱敏普通消息：讨论本地知识库、索引状态、证据回跳和增量恢复。'
  const longText = `脱敏长文本/语音转写：${'用于容量测试的可检索上下文。'.repeat(12)}`
  for (let offset = 0; offset < count; offset += 1) {
    const index = startIndex + offset
    const text = distribution === 'short' ? shortText : distribution === 'mixed' ? mixedText : longText
    messages.push({
      accountId,
      conversationId,
      messageId: `synthetic-${distribution}-${index}`,
      createTime: base + offset * 60_000,
      senderId: `fixture-member-${index % 8}`,
      senderName: `脱敏成员${index % 8}`,
      kind: distribution === 'long' && index % 4 === 0 ? 'voice' : 'text',
      text,
      voiceTranscript: distribution === 'long' && index % 4 === 0 ? longText : undefined,
      attachment:
        index % 97 === 0 ? { name: `fixture-${index}.txt`, kind: 'file', sizeBytes: 2048 } : undefined
    })
  }
  return { conversationId, completeSnapshot: true, messages }
}
