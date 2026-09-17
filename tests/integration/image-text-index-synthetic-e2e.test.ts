/**
 * 图片 OCR 来源语义的 **deterministic synthetic E2E**。
 *
 * 硬要求是"不依赖真实线上 AI 模型也能 PASS"，所以这里把两个外部边界**确定性**地固定住：
 * - WCDB（chat-service）→ 用合成联系人 / 合成消息；
 * - Knowledge 检索 → 用 fake 直接返回合成证据（形状与真实 `KnowledgeEvidence` 一致，
 *   包括**未清理**的 `searchable_text`，用来验证内部前缀确实被剥掉）。
 *
 * 链路上真正的被测代码仍然是生产实现：
 *   LocalQueryApiService.search()  ← 真实 scope 解析 / 证据映射 / 前缀剥离
 *   createLocalQueryToolExecutor() ← 真实 Tool 执行
 *   QueryAgentService.run()        ← 真实 Agent 循环 / tool result 组装
 *
 * 断言的 10 项对应需求：FOUND=YES / sourceKind=image / derived source=image_ocr /
 * conversation scope=技术交流群 / Evidence messageRef=原始图片消息 /
 * Evidence UI=图片文字 / jump target=原始图片消息 / 不产生虚构 OCR 消息。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeMessageRef } from '../../src/shared/local-query-api'

process.env.TZ = 'Asia/Shanghai'

const GROUP_MD5 = 'md5-tech-group'
const GROUP_NAME = '技术交流群'
const IMAGE_MESSAGE_ID = 'local:9001'
const TEXT_MESSAGE_ID = 'local:9002'
const OCR_TEXT = 'OpenAI ChatGPT Plus $20 Pro $200'
/** Knowledge 侧的原始 searchable_text：带内部标签，绝不该出现在 Evidence 里。 */
const RAW_SEARCHABLE = `图片文字：${OCR_TEXT}`

const fixture = vi.hoisted(() => {
  const imageTimestamp = Date.parse('2026-09-03T14:32:00+08:00')
  const textTimestamp = Date.parse('2026-09-03T14:30:00+08:00')
  return {
    imageTimestamp,
    textTimestamp,
    contacts: [
      {
        m_nsUsrName: 'wxid-tech-group',
        m_nsNickName: '技术交流群',
        md5: 'md5-tech-group',
        type: 'group' as const
      }
    ],
    messages: [
      {
        id: '9002',
        localId: '9002',
        from: 'user',
        type: '文本',
        datetime: '2026/9/3 14:30:00',
        content: '今天正常讨论一下 API',
        isSender: false,
        name: '张三',
        createTime: Math.floor(textTimestamp / 1000)
      },
      {
        id: '9001',
        localId: '9001',
        from: 'user',
        type: '图片',
        datetime: '2026/9/3 14:32:00',
        content: '',
        contentData: { type: 'image', md5: 'image-md5-fixture', datName: 'dat-fixture' },
        isSender: false,
        name: '张三',
        createTime: Math.floor(imageTimestamp / 1000)
      }
    ]
  }
})

const IMAGE_TIMESTAMP = fixture.imageTimestamp

vi.mock('../../src/main/services/chat-service', () => ({
  isReady: () => true,
  listContactsAsync: vi.fn(async () => fixture.contacts),
  listMessagesAsync: vi.fn(async () => fixture.messages)
}))

import { LocalQueryApiService } from '../../src/main/services/local-query-api-service'
import { createLocalQueryToolExecutor } from '../../src/main/services/local-query-tool-executor'
import {
  QueryAgentService,
  type QueryAgentProvider
} from '../../src/main/services/query-agent-service'

/** 与真实 Knowledge 检索返回的证据形状一致（含原始未清理文本）。 */
function syntheticKnowledgeEvidence() {
  return [
    {
      chunkId: 'chunk-1',
      conversationId: GROUP_MD5,
      startTime: IMAGE_TIMESTAMP,
      endTime: IMAGE_TIMESTAMP,
      messageId: IMAGE_MESSAGE_ID,
      senderId: 'fixture-member',
      sender: '张三',
      timestamp: IMAGE_TIMESTAMP,
      messageIds: [IMAGE_MESSAGE_ID],
      sourceKind: 'image' as const,
      text: RAW_SEARCHABLE,
      imageOcrText: OCR_TEXT,
      derivedSource: 'image_ocr' as const
    }
  ]
}

function makeKnowledge() {
  return {
    search: vi.fn(async () => ({
      state: 'ready',
      evidence: syntheticKnowledgeEvidence(),
      conversationRetrieval: { totalMessages: 2, chunkCount: 1, complete: true },
      voiceCoverage: undefined
    })),
    requestCatchUp: vi.fn(() => ({ triggered: false, inProgress: false })),
    waitForIndexingComplete: vi.fn(async () => false),
    lastPassDurationMs: vi.fn(() => 0),
    beginInteractiveQuery: vi.fn(),
    endInteractiveQuery: vi.fn()
  } as never
}

const NOW = new Date('2026-09-16T09:00:00+08:00')

describe('图片文字索引 synthetic E2E（确定性，不依赖真模型）', () => {
  let knowledge: ReturnType<typeof makeKnowledge>
  let service: LocalQueryApiService

  beforeEach(() => {
    knowledge = makeKnowledge()
    service = new LocalQueryApiService(knowledge, () => NOW)
  })

  it('Question Tool 链路：命中图片文字的 Evidence 指向原始图片消息，且不泄露内部前缀', async () => {
    const result = await service.search({
      target: { query: GROUP_NAME },
      timeRange: { kind: 'all' },
      query: 'ChatGPT 价格',
      variants: ['ChatGPT']
    })

    expect(result.status).toBe('completed')

    // FOUND = YES
    expect(result.evidenceCount).toBe(1)
    expect(result.evidence).toHaveLength(1)
    const evidence = result.evidence![0]

    // sourceKind = image（原始消息是什么）
    expect(evidence.sourceKind).toBe('image')
    // derived source = image_ocr（靠什么搜到的）
    expect(evidence.derivedSource).toBe('image_ocr')
    // OCR 片段只作命中解释
    expect(evidence.imageOcrText).toBe(OCR_TEXT)

    // conversation scope = 技术交流群：target 把检索范围真正收敛到这一个会话
    expect(result.target).toEqual({ displayName: GROUP_NAME, type: 'group' })
    expect(evidence.conversationName).toBe(GROUP_NAME)
    expect(evidence.conversationType).toBe('group')
    expect(knowledge.search).toHaveBeenCalledTimes(2)
    for (const call of knowledge.search.mock.calls) {
      expect((call[0] as { conversationIds?: string[] }).conversationIds).toEqual([GROUP_MD5])
    }

    // sender / createTime 来自原始消息
    expect(evidence.sender).toBe('张三')
    expect(evidence.timestamp).toBe(IMAGE_TIMESTAMP)

    // Evidence messageRef = 原始 image message（jump target 就是它）。
    // 注意 `local:` 只是 WCDB 侧的本地 id 装饰，不属于身份本身，所以还原后是裸 id。
    const identity = decodeMessageRef(evidence.messageRef)
    expect(identity).toEqual({ conversationId: GROUP_MD5, messageId: '9001' })
    // 不能产生"OCR 消息"：证据集合里不存在任何非原始消息的身份
    expect(result.evidence!.every((item) => decodeMessageRef(item.messageRef)?.messageId === '9001')).toBe(true)
    expect(result.evidence!.some((item) => decodeMessageRef(item.messageRef)?.messageId === '9002')).toBe(false)

    // 内部前缀绝不泄露给用户（模型侧与 UI 侧都不允许）
    expect(evidence.text).not.toContain('图片文字：')
    expect(evidence.text).not.toContain('OCR:')
    expect(evidence.text).not.toContain('system-ocr')
    expect(evidence.text).toContain(OCR_TEXT)
  })

  it('Query Agent 链路：来源语义进入 tool result，OCR 片段不进模型上下文', async () => {
    const executor = createLocalQueryToolExecutor(service)
    const responses: Array<Awaited<ReturnType<QueryAgentProvider['chatWithTools']>>> = [
      {
        success: true,
        toolCalls: [
          {
            id: 'call-1',
            name: 'search_messages',
            arguments: JSON.stringify({
              target: { query: GROUP_NAME },
              timeRange: { kind: 'all' },
              queries: ['ChatGPT 价格']
            })
          }
        ]
      },
      { success: true, data: '找到了：技术交流群发过一张 ChatGPT 价格的图片。' }
    ]
    const provider: QueryAgentProvider = {
      getRuntimeConfig: () => ({
        configured: true,
        providerName: 'Fixture Provider',
        model: 'fixture-model',
        modelName: 'Fixture Model'
      }),
      chatWithTools: vi.fn(async () => responses.shift() || { success: true, data: 'done' })
    }

    const agentResult = await new QueryAgentService(provider, executor).run(
      '技术交流群之前是不是发过 ChatGPT 价格的图片？'
    )

    // 模型实际看到的 tool result
    const toolMessage = vi
      .mocked(provider.chatWithTools)
      .mock.calls[1]?.[0].find((message) => message.role === 'tool')
    const presented = JSON.parse(String(toolMessage?.content)) as Record<string, any>
    const presentedEvidence = presented.evidence?.[0]

    expect(presentedEvidence.sourceKind).toBe('image')
    expect(presentedEvidence.derivedSource).toBe('image_ocr')
    // 片段的内容已经在 text 里，不再重复塞进上下文（避免无谓 token）。
    expect(presentedEvidence.imageOcrText).toBeUndefined()
    expect(presentedEvidence.text).not.toContain('图片文字：')
    // messageRef 指向原始图片消息（模型只拿到 opaque ref，看不到会话身份）。
    expect(decodeMessageRef(presentedEvidence.messageRef)).toEqual({
      conversationId: GROUP_MD5,
      messageId: '9001'
    })

    // 暴露给 UI 的证据保留来源语义与片段
    const uiEvidence = agentResult.evidence.find((item) => item.messageRef === presentedEvidence.messageRef)
    expect(uiEvidence?.messageType).toBe('image')
    expect(uiEvidence?.derivedSource).toBe('image_ocr')
    expect(uiEvidence?.imageOcrText).toBe(OCR_TEXT)
    expect(uiEvidence?.text).not.toContain('图片文字：')
    expect(uiEvidence?.conversationName).toBe(GROUP_NAME)
  })
})

describe('partial coverage honesty（确定性，不依赖真模型）', () => {
  const NOT_INDEXED_KEYWORD = 'TRACE_NOT_YET_INDEXED_IMAGE'

  function partialImageCoverage() {
    return {
      totalImageMessages: 100,
      processed: 30,
      indexed: 28,
      empty: 2,
      missing: 0,
      failed: 0,
      pending: 70,
      established: true,
      complete: false,
      countedAt: Date.parse('2026-09-16T08:00:00+08:00')
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('已处理的 30 张里搜不到关键词时，覆盖度必须带上"不能断言没有"的语义', async () => {
    const knowledge = makeKnowledge()
    // 关键：已建立的 30 张里确实没有这个关键词 → 检索结果为空。
    knowledge.search.mockImplementation(async () => ({
      state: 'ready',
      evidence: [],
      // 文字索引这一维是**完整**的（噪音）：证明图片维度不会被文字维度"带过"。
      indexLatestAt: NOW.getTime(),
      sourceLatestAt: NOW.getTime(),
      conversationRetrieval: { totalMessages: 2, chunkCount: 1, complete: true },
      voiceCoverage: undefined
    }))
    const service = new LocalQueryApiService(knowledge, () => NOW)
    // 图片文字索引建立过，但只完成 30 / 100。
    service.setImageTextCoverageProvider(() => partialImageCoverage())

    const result = await service.search({
      target: { query: GROUP_NAME },
      timeRange: { kind: 'all' },
      query: NOT_INDEXED_KEYWORD
    })

    expect(result.status).toBe('completed')
    expect(result.evidenceCount).toBe(0)
    // 文字索引这一维是完整的（噪音），图片这一维才是缺口。
    expect(result.coverage).toEqual({ state: 'complete' })
    expect(result.imageOcrCoverage).toMatchObject({
      state: 'partial',
      totalImageMessages: 100,
      processed: 30,
      pending: 70
    })
    const summary = result.imageOcrCoverage!.summary
    expect(summary).toContain('30')
    expect(summary).toContain('100')
    expect(summary).toContain('不能因为没搜到就回答')

    // 覆盖度必须真的进入 Query Agent 的上下文，而不是只留在 Engine 里。
    const executor = createLocalQueryToolExecutor(service)
    const responses: Array<Awaited<ReturnType<QueryAgentProvider['chatWithTools']>>> = [
      {
        success: true,
        toolCalls: [
          {
            id: 'call-1',
            name: 'search_messages',
            arguments: JSON.stringify({
              target: { query: GROUP_NAME },
              timeRange: { kind: 'all' },
              queries: [NOT_INDEXED_KEYWORD]
            })
          }
        ]
      },
      {
        success: true,
        data: '图片文字索引目前只处理 30 / 100 条图片消息，当前结果不完整，无法确认全部历史图片。'
      }
    ]
    const provider: QueryAgentProvider = {
      getRuntimeConfig: () => ({
        configured: true,
        providerName: 'Fixture Provider',
        model: 'fixture-model',
        modelName: 'Fixture Model'
      }),
      chatWithTools: vi.fn(async () => responses.shift() || { success: true, data: 'done' })
    }
    const agentResult = await new QueryAgentService(provider, executor).run(
      `之前是不是有张图片写着 ${NOT_INDEXED_KEYWORD}？`
    )

    const calls = vi.mocked(provider.chatWithTools).mock.calls
    // 提示词里写死了零结果诚实性规则（不能指望模型自己想到）。
    expect(String(calls[0]?.[0]?.[0]?.content)).toContain('imageOcrCoverage')
    const presented = JSON.parse(
      String(calls[1]?.[0].find((message) => message.role === 'tool')?.content)
    ) as Record<string, any>
    expect(presented.evidenceCount).toBe(0)
    expect(presented.imageOcrCoverage).toMatchObject({
      state: 'partial',
      totalImageMessages: 100,
      processed: 30,
      pending: 70
    })
    expect(presented.imageOcrCoverage.summary).toContain('不能因为没搜到就回答')

    // 最终回答本身必须是"覆盖不完整"，不是"没有"。
    expect(agentResult.answer).toContain('30')
    expect(agentResult.answer).toContain('100')
    expect(agentResult.answer).not.toBe('没有')
  })

  it('图片索引完整时不下发零结果约束（避免模型机械附加警告）', async () => {
    const knowledge = makeKnowledge()
    knowledge.search.mockImplementation(async () => ({
      state: 'ready',
      evidence: [],
      conversationRetrieval: { totalMessages: 2, chunkCount: 1, complete: true },
      voiceCoverage: undefined
    }))
    const service = new LocalQueryApiService(knowledge, () => NOW)
    service.setImageTextCoverageProvider(() => ({
      ...partialImageCoverage(),
      processed: 100,
      indexed: 98,
      empty: 2,
      pending: 0,
      complete: true
    }))

    const result = await service.search({
      target: { query: GROUP_NAME },
      timeRange: { kind: 'all' },
      query: NOT_INDEXED_KEYWORD
    })

    expect(result.imageOcrCoverage?.state).toBe('complete')
    expect(result.imageOcrCoverage?.summary).not.toContain('不能因为没搜到就回答')
  })
})
