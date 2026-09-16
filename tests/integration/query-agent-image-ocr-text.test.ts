/**
 * 精确读消息（`query_messages`）必须能读到**图片里识别出的文字**。
 *
 * 真机回归：问「我今早给文件传输助手发的那张图片里写了什么」，Query Agent 准确找到了
 * 原始图片消息（2026/9/16 07:30:15、sender=self、type=image），却回答
 * 「查询只返回图片附件，没有取得 OCR 文字」，甚至反过来建议用户"建立图片文字索引后再查"。
 *
 * 真机派生库 + Knowledge 实测结论（CASE A）：
 *   L1 artifact  state=indexed / char_count=17
 *   L2 binding   state=indexed
 *   L3 Knowledge image_ocr_text 与 artifact 文本**逐字相同**，chunk 里也含该文本且指向原图 messageId
 * —— 即"索引早就建好了，只是查询路径没把它接出来"。缺口在 L4，不在 L1/L2/L3。
 *
 * 这一组测试把 L4 的契约钉死：
 *   1. 图片消息的 OCR 文本必须走 `imageOcrText` + `derivedSource=image_ocr` 独立字段；
 *   2. 证据**永远是原始图片消息**，不许为了 OCR 文本编造一条文字消息；
 *   3. `empty`（识别过没文字）与 `not_indexed`（还没索引）必须能被区分，
 *      两者都不允许模型凭想象描述图片内容。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImageTextIndexCoverage } from '../../src/shared/image-text-index'
import { decodeMessageRef } from '../../src/shared/local-query-api'

process.env.TZ = 'Asia/Shanghai'

const fixture = vi.hoisted(() => {
  const selfImageTime = Date.parse('2026-09-16T07:30:15+08:00')
  const otherImageTime = Date.parse('2026-09-16T08:10:00+08:00')
  return {
    selfImageTime,
    otherImageTime,
    contacts: [
      {
        m_nsUsrName: 'filehelper',
        m_nsNickName: '文件传输助手',
        md5: 'md5-filehelper',
        type: 'user' as const
      }
    ],
    messages: [
      {
        id: '9001',
        localId: '9001',
        from: 'assistant',
        // 我发出的那张图：isSender = true（自我身份来自 mesDes，不是昵称）
        type: '图片',
        datetime: '2026/9/16 07:30:15',
        content: '',
        contentData: { type: 'image', md5: 'md5-self-image', datName: 'dat-self' },
        isSender: true,
        name: '我',
        createTime: Math.floor(selfImageTime / 1000)
      },
      {
        id: '9002',
        localId: '9002',
        from: 'user',
        type: '图片',
        datetime: '2026/9/16 08:10:00',
        content: '',
        contentData: { type: 'image', md5: 'md5-other-image', datName: 'dat-other' },
        isSender: false,
        name: '文件传输助手',
        createTime: Math.floor(otherImageTime / 1000)
      }
    ]
  }
})

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

/** 与真实派生库同形：binding 主键 = `sourceMessageId(message)` = `local:<localId>`。 */
const SELF_KEY = 'local:9001'
const OTHER_KEY = 'local:9002'

function coverage(overrides: Partial<ImageTextIndexCoverage> = {}): ImageTextIndexCoverage {
  return {
    totalImageMessages: 2,
    processed: 2,
    indexed: 2,
    empty: 0,
    missing: 0,
    failed: 0,
    runtimeUnavailable: 0,
    pending: 0,
    established: true,
    complete: true,
    systemicFailure: false,
    countedAt: Date.parse('2026-09-16T09:00:00+08:00'),
    ...overrides
  }
}

type OcrFixture = Map<string, { state: string; text: string }>

function makeService(options: { ocr?: OcrFixture; coverage?: ImageTextIndexCoverage } = {}) {
  const knowledge = {
    search: vi.fn(async () => ({ state: 'ready', evidence: [] })),
    requestCatchUp: vi.fn(() => ({ triggered: false, inProgress: false })),
    waitForIndexingComplete: vi.fn(async () => false),
    lastPassDurationMs: vi.fn(() => 0),
    beginInteractiveQuery: vi.fn(),
    endInteractiveQuery: vi.fn()
  } as never
  const service = new LocalQueryApiService(knowledge, () => new Date('2026-09-16T09:30:00+08:00'))
  const ocr = options.ocr ?? new Map([[SELF_KEY, { state: 'indexed', text: 'ChatGPT Plus $20' }]])
  service.setImageOcrEntryProvider((_conversationId, messageId) => ocr.get(messageId))
  if (options.coverage !== undefined) {
    service.setImageTextCoverageProvider(() => options.coverage!)
  }
  return service
}

const askSelfImages = {
  target: { query: '文件传输助手' },
  timeRange: { kind: 'all' },
  direction: 'to_target',
  messageTypes: ['image']
}

describe('query_messages：图片消息必须携带 OCR 派生文本', () => {
  let service: LocalQueryApiService
  beforeEach(() => {
    service = makeService()
  })

  it('我发出的图片带 OCR 文本时，走 imageOcrText + derivedSource，不混进 text', async () => {
    const result = await service.messages(askSelfImages as never)

    expect(result.status).toBe('completed')
    expect(result.returnedCount).toBe(1)
    const message = result.messages![0]

    // 派生文本必须单独一个字段：混进 `text` 就无法与"群友发的文字消息"区分。
    expect(message.imageOcrText).toBe('ChatGPT Plus $20')
    expect(message.derivedSource).toBe('image_ocr')
    expect(message.imageTextState).toBe('indexed')
    expect(message.text).toBeUndefined()
    expect(message.attachment).toEqual({ kind: 'image' })
  })

  it('对方的图片不会被贴错 OCR 文本（键必须按消息身份匹配）', async () => {
    const result = await service.messages({
      ...askSelfImages,
      direction: 'from_target'
    } as never)

    expect(result.returnedCount).toBe(1)
    // OTHER_KEY 在派生库里没有绑定 → 只能是 not_indexed，绝不能借用另一条消息的文本。
    expect(result.messages![0].imageOcrText).toBeUndefined()
    expect(result.messages![0].imageTextState).toBe('not_indexed')
  })

  it('识别过但图里没文字 → empty（已知结论），不是 not_indexed', async () => {
    const empty = makeService({ ocr: new Map([[SELF_KEY, { state: 'empty', text: '' }]]) })
    const result = await empty.messages(askSelfImages as never)

    // `empty` 与 `not_indexed` 必须能分辨：前者是"已经知道没文字"，
    // 后者是"还不知道"。把两者混起来，模型就会在没索引时断言"图里没内容"。
    expect(result.messages![0].imageTextState).toBe('empty')
    expect(result.messages![0].imageOcrText).toBeUndefined()
  })

  it('图片文字索引未建立时，tool result 明确带上 not_built 覆盖度', async () => {
    const notBuilt = makeService({
      ocr: new Map(),
      coverage: coverage({
        processed: 0,
        indexed: 0,
        pending: 0,
        established: false,
        complete: false
      })
    })
    const result = await notBuilt.messages(askSelfImages as never)

    expect(result.messages![0].imageTextState).toBe('not_indexed')
    expect(result.imageOcrCoverage?.state).toBe('not_built')
    expect(result.imageOcrCoverage?.summary).toContain('尚未建立')
  })

  it('覆盖度部分完成时，summary 必须说明结果可能不完整（不许当 complete）', async () => {
    const partial = makeService({
      coverage: coverage({
        totalImageMessages: 100,
        processed: 30,
        indexed: 30,
        pending: 70,
        complete: false
      })
    })
    const result = await partial.messages(askSelfImages as never)

    expect(result.imageOcrCoverage?.state).toBe('partial')
    expect(result.imageOcrCoverage?.summary).toContain('30')
    expect(result.imageOcrCoverage?.summary).toContain('100')
  })

  it('普通文字消息完全不受影响（对照组）', async () => {
    const plain = makeService({ ocr: new Map() })
    const result = await plain.messages({
      target: { query: '文件传输助手' },
      timeRange: { kind: 'all' },
      direction: 'to_target',
      messageTypes: ['text']
    } as never)

    // 图片那两条都是 image，文字查询必然是 0 条 —— 关键是**不能**因为接了 OCR 路径
    // 就凭空多出消息。
    expect(result.returnedCount).toBe(0)
  })
})

describe('Query Agent：证据永远是原始图片消息', () => {
  function provider(
    responses: Array<Awaited<ReturnType<QueryAgentProvider['chatWithTools']>>>
  ): QueryAgentProvider {
    return {
      getRuntimeConfig: () => ({
        configured: true,
        providerName: 'Fixture Provider',
        model: 'fixture-model',
        modelName: 'Fixture Model'
      }),
      chatWithTools: vi.fn(async () => responses.shift() || { success: true, data: 'done' })
    }
  }

  const selfImageArgs = JSON.stringify({
    target: { query: '文件传输助手' },
    timeRange: { kind: 'all' },
    temporalBasis: { kind: 'none' },
    direction: 'to_target',
    messageTypes: ['image']
  })

  it('模型能在 Tool Result 里读到 imageOcrText，且证据仍指向原图 messageRef', async () => {
    const configured = provider([
      {
        success: true,
        toolCalls: [{ id: 'c1', name: 'query_messages', arguments: selfImageArgs }]
      },
      { success: true, data: '那张图片里的文字是 ChatGPT Plus $20。' }
    ])
    const service = makeService()
    const result = await new QueryAgentService(
      configured,
      createLocalQueryToolExecutor(service)
    ).run('我今早给文件传输助手发的那张图片里写了什么')

    const calls = vi.mocked(configured.chatWithTools).mock.calls
    const toolResult = JSON.parse(
      String(calls[1]?.[0].find((message) => message.role === 'tool')?.content)
    ) as Record<string, any>

    // 1) 模型确实拿到了派生文本（这正是真机上缺的那一环）
    expect(toolResult.messages?.[0].imageOcrText).toBe('ChatGPT Plus $20')
    expect(toolResult.messages?.[0].derivedSource).toBe('image_ocr')
    expect(toolResult.messages?.[0].imageTextState).toBe('indexed')

    // 2) 证据只有一条，且解出来就是**原始图片消息**（不是虚构的 OCR 文字消息）
    expect(result.evidence).toHaveLength(1)
    expect(decodeMessageRef(result.evidence![0].messageRef)).toEqual({
      conversationId: 'md5-filehelper',
      messageId: '9001'
    })
    expect(result.evidence![0].messageType).toBe('image')

    // 3) UI 拿得到来源语义（「图片文字」标记），且 snippet 不进模型上下文之外的重复字段
    expect(result.evidence![0].derivedSource).toBe('image_ocr')
    expect(result.evidence![0].imageOcrText).toBe('ChatGPT Plus $20')
  })

  it('系统提示词把图片文字的三态语义写死，并禁止凭空建议建立索引', async () => {
    const scripted = provider([{ success: true, data: 'ok' }])
    const service = makeService()
    void new QueryAgentService(scripted, createLocalQueryToolExecutor(service)).run(
      '我今早给文件传输助手发的那张图片里写了什么'
    )

    const systemPrompt = String(vi.mocked(scripted.chatWithTools).mock.calls[0]?.[0]?.[0]?.content)
    expect(systemPrompt).toContain('imageOcrText')
    // 三态必须分别说清楚
    expect(systemPrompt).toContain('indexed')
    expect(systemPrompt).toContain('empty')
    expect(systemPrompt).toContain('not_indexed')
    // OCR 不是看图：empty 时不许猜画面
    expect(systemPrompt).toContain('OCR 不是看图')
    // 不许无条件建议"先建立图片文字索引再查"
    expect(systemPrompt).toContain('建立图片文字索引')
  })

  it('索引已建好的情况下，模型不会拿到任何"还没建立"的误导信号', async () => {
    const configured = provider([
      {
        success: true,
        toolCalls: [{ id: 'c1', name: 'query_messages', arguments: selfImageArgs }]
      },
      { success: true, data: '那张图里有 ChatGPT Plus $20。' }
    ])
    const service = makeService({ coverage: coverage() })
    await new QueryAgentService(configured, createLocalQueryToolExecutor(service)).run(
      '我今早给文件传输助手发的那张图片里写了什么'
    )

    const calls = vi.mocked(configured.chatWithTools).mock.calls
    const toolResult = JSON.parse(
      String(calls[1]?.[0].find((message) => message.role === 'tool')?.content)
    ) as Record<string, any>

    // 覆盖度是 complete 且带了派生文本 → 模型没有任何理由说"没有取得 OCR 文字"。
    expect(toolResult.imageOcrCoverage?.state).toBe('complete')
    expect(toolResult.messages?.[0].imageOcrText).toBe('ChatGPT Plus $20')
  })
})
