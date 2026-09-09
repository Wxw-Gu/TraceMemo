import { mkdtempSync } from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildLocalAiSearchPlan, parseAiQueryUnderstanding } from '../../src/shared/ai-search'
import { DEFAULT_KNOWLEDGE_CHUNKER, type KnowledgeFtsConfig } from '../../src/shared/knowledge'
import { KnowledgeStore } from '../../src/main/knowledge/knowledge-store'

const roots: string[] = []
const fts: KnowledgeFtsConfig = {
  profileId: 'boundary-test', tokenizer: 'trigram', contentMode: 'external', detail: 'full', columnsize: 1
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('conversation boundary query planning', () => {
  it('validates the AI query understanding contract without accepting unsafe fields', () => {
    expect(parseAiQueryUnderstanding(JSON.stringify({
      intent: 'conversation_boundary', contactQuery: '小史', topicQuery: null,
      boundary: 'first', confidence: 0.98, requiresClarification: false
    }))).toMatchObject({ intent: 'conversation_boundary', contactQuery: '小史', boundary: 'first' })
    expect(parseAiQueryUnderstanding('```json\n{"intent":"conversation_boundary"}\n```')).toBeNull()
    expect(parseAiQueryUnderstanding('{"intent":"conversation_boundary"}{"intent":"general"}')).toBeNull()
    expect(parseAiQueryUnderstanding(JSON.stringify({ intent: 'deep_research', confidence: 1, requiresClarification: false }))).toBeNull()
    expect(parseAiQueryUnderstanding(JSON.stringify({ intent: 'conversation_boundary', contactQuery: '张三', boundary: 'middle', confidence: 1, requiresClarification: false }))).toBeNull()
    expect(parseAiQueryUnderstanding(JSON.stringify({ intent: 'conversation_boundary', contactQuery: '张三'.repeat(33), boundary: 'first', confidence: 1, requiresClarification: false }))).toBeNull()
    expect(parseAiQueryUnderstanding(JSON.stringify({ intent: 'conversation_boundary', contactQuery: '张三', confidence: 1, requiresClarification: false }))).toBeNull()
    expect(parseAiQueryUnderstanding(JSON.stringify({ intent: 'conversation_boundary', contactQuery: '张三', topicQuery: '装修', boundary: 'first', confidence: 1, requiresClarification: false }))).toBeNull()
    expect(parseAiQueryUnderstanding(JSON.stringify({ intent: 'conversation_recall', contactQuery: '张三', boundary: 'first', confidence: 1, requiresClarification: false }))).toBeNull()
    expect(parseAiQueryUnderstanding(JSON.stringify({
      intent: 'conversation_boundary', contactQuery: '张三', boundary: 'first', projection: 'content',
      confidence: 1, requiresClarification: false
    }))).toMatchObject({ projection: 'content' })
    expect(parseAiQueryUnderstanding(JSON.stringify({
      intent: 'conversation_boundary', contactQuery: '张三', boundary: 'first', projection: 'middle',
      confidence: 1, requiresClarification: false
    }))).toBeNull()
    expect(parseAiQueryUnderstanding(JSON.stringify({
      intent: 'conversation_recall', contactQuery: '张三', projection: 'content',
      confidence: 1, requiresClarification: false
    }))).toBeNull()
    expect(parseAiQueryUnderstanding(JSON.stringify({
      mode: 'semantic', intent: 'general', targetQuery: 'BOBO',
      semanticQuery: '双方关系开始明显变熟、互动增加或开始更深入交流',
      queryVariants: ['开始熟起来', '关系变熟'], answerMode: 'synthesis',
      confidence: 0.95, requiresClarification: false
    }))).toMatchObject({ mode: 'semantic', targetQuery: 'BOBO', answerMode: 'synthesis', queryVariants: ['开始熟起来', '关系变熟'] })
    expect(parseAiQueryUnderstanding(JSON.stringify({
      mode: 'semantic', intent: 'general', semanticQuery: '关系变熟',
      queryVariants: ['一', '二', '三', '四', '五'], confidence: 1, requiresClarification: false
    }))).toBeNull()
    expect(parseAiQueryUnderstanding(JSON.stringify({
      mode: 'semantic', intent: 'general', semanticQuery: '关系变熟', sql: 'SELECT 1',
      confidence: 1, requiresClarification: false
    }))).toBeNull()
  })

  it.each([
    'conversationId', 'wxid', 'messageId', 'sql', 'databasePath', 'filePath',
    'startTime', 'endTime', 'evidenceId', 'tool', 'provider'
  ])('%s is rejected as an unknown trusted field', (field) => {
    expect(parseAiQueryUnderstanding(JSON.stringify({
      intent: 'conversation_boundary', contactQuery: '张三', boundary: 'first',
      confidence: 1, requiresClarification: false, [field]: 'unsafe'
    }))).toBeNull()
  })

  it.each([
    ['我和张三第一次聊天是什么时候？', '张三', 'first'],
    ['我和【张三】第一次说话是什么时候？', '张三', 'first'],
    ['我最早什么时候和张三聊过？', '张三', 'first'],
    ['我和张三最后一次聊天是什么时候？', '张三', 'last'],
    ['我最近一次和张三说话是什么时候？', '张三', 'last']
  ])('%s -> %s boundary', (query, contactQuery, boundary) => {
    expect(buildLocalAiSearchPlan(query)).toMatchObject({
      intent: 'conversation_boundary', contactQuery, boundary
    })
  })

  it('keeps ordinary conversation recall separate', () => {
    expect(buildLocalAiSearchPlan('我和张三最近聊了什么')).toMatchObject({
      intent: 'conversation_recall', contactQuery: '张三'
    })
  })

  it.each([
    '我和BOBO第一次讲话说的什么',
    '我和BOBO第一次聊天说了什么，是什么时候',
    '我最后一次跟BOBO说了什么'
  ])('routes content boundary wording to suspicious fallback: %s', (query) => {
    const plan = buildLocalAiSearchPlan(query)
    expect(plan.intent).not.toBe('conversation_boundary')
  })
})

describe('KnowledgeStore conversation boundary', () => {
  it('uses the indexed time order and skips system messages', async () => {
    const root = mkdtempSync(join(tmpdir(), 'trace-boundary-'))
    roots.push(root)
    const store = new KnowledgeStore(root, 'account', fts)
    await store.index({
      chunker: DEFAULT_KNOWLEDGE_CHUNKER,
      conversations: [{
        conversationId: 'conversation', completeSnapshot: true,
        messages: [
          { accountId: 'account', conversationId: 'conversation', messageId: 'system', createTime: 1, kind: 'system', text: '已添加联系人' },
          { accountId: 'account', conversationId: 'conversation', messageId: 'first', createTime: 2, kind: 'text', text: '你好', senderName: '我' },
          { accountId: 'account', conversationId: 'conversation', messageId: 'last', createTime: 3, kind: 'voice', voiceTranscript: '晚安', senderName: '张三' }
        ]
      }]
    })
    expect(store.search({ accountId: 'account', text: '', terms: [], limit: 1, conversationIds: ['conversation'], conversationBoundary: 'first' })[0]).toMatchObject({ messageId: 'first' })
    expect(store.search({ accountId: 'account', text: '', terms: [], limit: 1, conversationIds: ['conversation'], conversationBoundary: 'last' })[0]).toMatchObject({ messageId: 'last', sourceKind: 'voice' })
    store.close()
  })
})
