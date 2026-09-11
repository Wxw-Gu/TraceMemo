import { describe, expect, it, vi, beforeEach } from 'vitest'

const fixture = vi.hoisted(() => ({
  contacts: [
    { m_nsUsrName: 'wxid-bobo', m_nsNickName: 'BOBO', md5: 'md5-bobo', type: 'user' as const },
    { m_nsUsrName: 'wxid-bobo-2', m_nsNickName: 'BOBO', md5: 'md5-bobo-2', type: 'user' as const }
  ],
  messages: [
    { id: 'm1', from: 'user', type: '图片', datetime: '2026/8/2 10:00:00', content: '', contentData: { type: 'image', md5: 'image-md5' }, isSender: false, name: 'BOBO', createTime: Math.floor(new Date('2026-08-02T10:00:00+08:00').getTime() / 1000) },
    { id: 'm2', from: 'assistant', type: '文件', datetime: '2026/8/3 10:00:00', content: '', isSender: true, exportMediaType: 'file' as const, exportMediaName: 'a.pdf', createTime: Math.floor(new Date('2026-08-03T10:00:00+08:00').getTime() / 1000) }
  ]
}))
vi.mock('../../src/main/services/chat-service', () => ({
  isReady: () => true,
  listContactsAsync: vi.fn(async () => fixture.contacts),
  listMessagesAsync: vi.fn(async () => fixture.messages)
}))

import { LocalQueryApiService } from '../../src/main/services/local-query-api-service'

describe('LocalQueryApiService', () => {
  const knowledge = {
    search: vi.fn(async () => ({ state: 'ready', evidence: [{ conversationId: 'md5-bobo', messageId: 'm1', timestamp: 1, sender: 'BOBO', sourceKind: 'text', text: '你好' }], conversationRetrieval: { totalMessages: 2, chunkCount: 1, complete: true }, voiceCoverage: undefined })),
    requestCatchUp: vi.fn(() => ({ triggered: false, inProgress: false })),
    waitForIndexingComplete: vi.fn(async () => false),
    lastPassDurationMs: vi.fn(() => 0),
    beginInteractiveQuery: vi.fn(),
    endInteractiveQuery: vi.fn()
  } as any
  /** 固定时钟：requestedEnd 由它决定。 */
  const NOW = new Date('2026-09-09T12:00:00+08:00').getTime()
  const DAY = 24 * 60 * 60 * 1000
  let service: LocalQueryApiService
  beforeEach(() => {
    vi.clearAllMocks()
    // mockReset 会清掉 once 队列与实现：避免上一个用例残留的队列被下一个用例消费。
    knowledge.search.mockReset()
    knowledge.search.mockImplementation(async () => ({
      state: 'ready',
      evidence: [{ conversationId: 'md5-bobo', messageId: 'm1', timestamp: 1, sender: 'BOBO', sourceKind: 'text', text: '你好' }],
      conversationRetrieval: { totalMessages: 2, chunkCount: 1, complete: true },
      voiceCoverage: undefined
    }))
    knowledge.requestCatchUp.mockReset()
    knowledge.requestCatchUp.mockReturnValue({ triggered: false, inProgress: false })
    knowledge.waitForIndexingComplete.mockReset()
    knowledge.waitForIndexingComplete.mockResolvedValue(false)
    knowledge.lastPassDurationMs.mockReset()
    knowledge.lastPassDurationMs.mockReturnValue(0)
    if (!fixture.contacts.some((contact) => contact.md5 === 'md5-bobo-2')) fixture.contacts.push({ m_nsUsrName: 'wxid-bobo-2', m_nsNickName: 'BOBO', md5: 'md5-bobo-2', type: 'user' })
    service = new LocalQueryApiService(knowledge, () => new Date('2026-09-09T12:00:00+08:00'))
  })

  it('publishes capability contract and resolves previous month', async () => {
    expect(service.capabilities().tools.query_messages.messageTypes).toContain('file')
    const result = await service.messages({ target: { query: 'BOBO' }, timeRange: { kind: 'previous_month' }, direction: 'any', order: 'asc', limit: 1 })
    expect(result.status).toBe('ambiguous_contact')
    fixture.contacts.splice(1)
    const resolved = await service.messages({ target: { query: 'BOBO' }, timeRange: { kind: 'previous_month' }, direction: 'any', order: 'asc', limit: 1 })
    expect(resolved.query?.resolvedTimeRange).toMatchObject({ startTime: expect.any(Number), endTime: expect.any(Number), label: '2026年8月' })
    expect(resolved.returnedCount).toBe(1)
  })

  it('filters direction and message type, and rejects too many variants', async () => {
    fixture.contacts.splice(1)
    const result = await service.messages({ target: { query: 'BOBO' }, timeRange: { kind: 'all' }, direction: 'to_target', messageTypes: ['file'], limit: 1 })
    expect(result.messages?.[0].sourceKind).toBe('file')
    await expect(service.search({ target: { query: 'BOBO' }, timeRange: { kind: 'all' }, query: 'x', variants: ['1', '2', '3', '4', '5'] })).resolves.toMatchObject({ status: 'invalid_request' })
  })

  it('returns canonical type and attachment for the earliest non-text message', async () => {
    fixture.contacts.splice(1)
    const result = await service.messages({ target: { query: 'BOBO' }, timeRange: { kind: 'all' }, order: 'asc', limit: 1, excludeSystem: true })
    expect(result.messages?.[0]).toMatchObject({ messageType: 'image', sourceKind: 'image', attachment: { kind: 'image' } })
    expect(result.messages?.[0]).not.toHaveProperty('text')
  })

  it('round-trips opaque refs from messages, search, and overview through context', async () => {
    fixture.contacts.splice(1)
    const queried = await service.messages({ target: { query: 'BOBO' }, timeRange: { kind: 'all' }, order: 'asc', limit: 1 })
    const queriedRef = queried.messages?.[0]?.messageRef
    expect(queriedRef).toEqual(expect.any(String))
    await expect(service.context({ messageRef: queriedRef!, before: 0, after: 0 })).resolves.toMatchObject({
      status: 'completed',
      anchor: { messageRef: queriedRef }
    })

    knowledge.search.mockResolvedValueOnce({ state: 'ready', evidence: [{ conversationId: 'md5-bobo', messageId: 'local:m1', timestamp: 1, sender: 'BOBO', sourceKind: 'text', text: '你好' }], conversationRetrieval: { totalMessages: 2, chunkCount: 1, complete: true }, voiceCoverage: undefined })
    const searched = await service.search({ target: { query: 'BOBO' }, timeRange: { kind: 'all' }, query: '你好' })
    const searchedRef = searched.evidence?.[0]?.messageRef
    expect(searchedRef).toBe(queriedRef)
    await expect(service.context({ messageRef: searchedRef!, before: 0, after: 0 })).resolves.toMatchObject({ status: 'completed' })

    // 概览直读 WCDB，不再消费派生索引 → 这里不再排队 knowledge mock（残留队列会污染后续用例）。
    const overview = await service.overview({ target: { query: 'BOBO' }, timeRange: { kind: 'all' } })
    const overviewRef = overview.evidence?.[0]?.messageRef
    expect(overviewRef).toBe(queriedRef)
    await expect(service.context({ messageRef: overviewRef!, before: 0, after: 0 })).resolves.toMatchObject({ status: 'completed' })
  })

  it('会话概览以 WCDB 为事实来源，并在派生索引为空时不返回「0 + complete」（P0 回归）', async () => {
    fixture.contacts.splice(1)
    // 陈旧索引的真实形态：索引对这一会话在范围内 0 行，且自称 complete。
    knowledge.search.mockResolvedValue({
      state: 'ready',
      evidence: [],
      conversationRetrieval: { totalMessages: 0, chunkCount: 0, complete: true },
      voiceCoverage: undefined
    })
    const result = await service.overview({ target: { query: 'BOBO' }, timeRange: { kind: 'previous_month' } })
    expect(result).toMatchObject({ status: 'completed', origin: 'wcdb', sourceMessageCount: 2, evidenceCount: 2 })
    expect(result.coverage).toEqual({ state: 'complete' })
    expect(result.evidence?.map((item) => item.messageRef)).toHaveLength(2)
    // 概览不再依赖派生索引（索引可能滞后于 WCDB）。
    expect(knowledge.search).not.toHaveBeenCalled()
  })

  it('会话概览保留时间片代表证据，并如实标注覆盖状态', async () => {
    fixture.contacts.splice(1)
    const result = await service.overview({ target: { query: 'BOBO' }, timeRange: { kind: 'previous_month' } })
    expect(result.sourceCoverage).toEqual({ state: 'complete', sourceMessageCount: 2 })
    expect(result.evidence?.map((item) => item.timestamp)).toEqual(
      [...fixture.messages].map((message) => message.createTime * 1000)
    )
    expect(result.selection?.mode).toBe('temporal_coverage')
  })

  it('scope=groups 只检索群会话，并把群名与成员写进证据', async () => {
    fixture.contacts.splice(1)
    fixture.contacts.push({ m_nsUsrName: 'wxid-group@chatroom', m_nsNickName: 'TraceMemo 交流群', md5: 'md5-group', type: 'group' } as never)
    knowledge.search.mockResolvedValue({
      state: 'ready',
      evidence: [{ conversationId: 'md5-group', messageId: 'g1', timestamp: 5, sender: '张三', sourceKind: 'text', text: '最近开始健身了' }],
      voiceCoverage: undefined
    })
    const result = await service.search({ timeRange: { kind: 'all' }, query: '健身', scope: { kind: 'groups' } })
    expect(knowledge.search).toHaveBeenCalledWith(expect.objectContaining({ conversationIds: ['md5-group'] }))
    expect(result.scope).toEqual({ kind: 'groups', conversationCount: 1 })
    expect(result.evidence?.[0]).toMatchObject({
      conversationName: 'TraceMemo 交流群',
      conversationType: 'group',
      sender: '张三'
    })
  })

  it('scope=all 省略 target 时按全局检索（不传 conversationIds）', async () => {
    fixture.contacts.splice(1)
    knowledge.search.mockResolvedValue({ state: 'ready', evidence: [], voiceCoverage: undefined })
    const result = await service.search({ timeRange: { kind: 'all' }, query: '健身', scope: { kind: 'all' } })
    expect(knowledge.search).toHaveBeenCalledWith(expect.objectContaining({ conversationIds: undefined }))
    // 跨会话检索不宣称"完整"：派生索引不是完整性权威。
    expect(result.coverage).toEqual({ state: 'partial' })
  })

  it('scope 内的 target 越界会被结构化拒绝（而不是悄悄扩大范围）', async () => {
    fixture.contacts.splice(1)
    const result = await service.search({
      target: { query: 'BOBO' },
      timeRange: { kind: 'all' },
      query: '健身',
      scope: { kind: 'groups' }
    })
    expect(result).toMatchObject({
      status: 'invalid_tool_arguments',
      field: 'target',
      constraint: 'target_outside_scope',
      actual: 'BOBO'
    })
    expect(knowledge.search).not.toHaveBeenCalled()
  })

  it('scope=contact 只允许该单聊会话，未知会话会被拒绝', async () => {
    fixture.contacts.splice(1)
    const allowed = await service.messages({ target: { query: 'BOBO' }, timeRange: { kind: 'all' }, scope: { kind: 'contact', conversationId: 'md5-bobo' } })
    expect(allowed.status).toBe('completed')

    const rejected = await service.messages({ target: { query: 'BOBO' }, timeRange: { kind: 'all' }, scope: { kind: 'contact', conversationId: 'md5-unknown' } })
    expect(rejected.status).toBe('scope_conversation_not_found')
  })

  it('会话概览在范围内有多个会话且未指定 target 时要求指定 target', async () => {
    fixture.contacts.splice(1)
    const result = await service.overview({ timeRange: { kind: 'all' }, scope: { kind: 'groups' } })
    expect(result).toMatchObject({ status: 'invalid_tool_arguments', constraint: 'target_required_for_scope' })
  })

  describe('freshness contract（索引落后时不得出现 stale complete negative）', () => {
    it('交互检索全程标记为前台：后台索引必须让路（否则查询会被 pass 拖慢）', async () => {
      fixture.contacts.splice(1)
      const order: string[] = []
      knowledge.beginInteractiveQuery.mockImplementation(() => order.push('begin'))
      knowledge.endInteractiveQuery.mockImplementation(() => order.push('end'))
      knowledge.search.mockImplementation(async () => {
        order.push('search')
        return { state: 'ready', evidence: [], indexLatestAt: NOW - 30 * 1000, sourceLatestAt: NOW - 1000, voiceCoverage: undefined }
      })

      await service.search({ target: { query: 'BOBO' }, timeRange: { kind: 'all' }, query: '健身' })

      expect(order).toEqual(['begin', 'search', 'end'])
      expect(knowledge.beginInteractiveQuery).toHaveBeenCalledTimes(1)
      expect(knowledge.endInteractiveQuery).toHaveBeenCalledTimes(1)
    })

    it('同一次查询的多个 probe 共用 retrieval session（避免重复读群成员快照）', async () => {
      fixture.contacts.splice(1)
      knowledge.search.mockResolvedValue({ state: 'ready', indexLatestAt: NOW - 30 * 1000, sourceLatestAt: NOW - 1000, evidence: [], voiceCoverage: undefined })

      await service.search({ target: { query: 'BOBO' }, timeRange: { kind: 'all' }, query: '健身', variants: ['锻炼', '跑步'] })

      expect(knowledge.search).toHaveBeenCalledTimes(3)
      const sessions = new Set(knowledge.search.mock.calls.map((call: unknown[]) => (call[0] as { retrievalSessionId?: string }).retrievalSessionId))
      expect(sessions.size).toBe(1)
      expect([...sessions][0]).toEqual(expect.any(String))
    })
    const staleIndex = (): Record<string, unknown> => ({
      state: 'ready',
      evidence: [],
      indexLatestAt: NOW - 10 * DAY,
      voiceCoverage: undefined
    })
    const freshIndex = (evidence: unknown[] = []): Record<string, unknown> => ({
      state: 'ready',
      evidence,
      indexLatestAt: NOW - 30 * 1000,
      voiceCoverage: undefined
    })

    it('索引明显落后 → coverage=partial、请求追赶，且 0 结果不被当成“没有”', async () => {
      fixture.contacts.splice(1)
      knowledge.search.mockResolvedValue({ ...staleIndex(), sourceLatestAt: NOW - 1000 })
      knowledge.requestCatchUp.mockReturnValue({ triggered: true, inProgress: true })
      knowledge.waitForIndexingComplete.mockResolvedValue(false)

      const result = await service.search({ target: { query: 'BOBO' }, timeRange: { kind: 'all' }, query: '健身' })

      expect(result.coverage).toEqual({ state: 'partial' })
      expect(result.evidenceCount).toBe(0)
      expect(result.indexLatestAt).toBe(NOW - 10 * DAY)
      expect(result.sourceLatestAt).toBe(NOW - 1000)
      expect(result.freshness).toEqual({ catchUp: 'pending' })
      expect(knowledge.requestCatchUp).toHaveBeenCalledTimes(1)
      expect(knowledge.waitForIndexingComplete).toHaveBeenCalledWith(2000)
    })

    it('追赶在预算内完成 → 用新索引重新检索（不能拿同步前的结果回答）', async () => {
      fixture.contacts.splice(1)
      knowledge.search
        .mockResolvedValueOnce({ ...staleIndex(), sourceLatestAt: NOW - 1000 })
        .mockResolvedValueOnce({
          state: 'ready',
          indexLatestAt: NOW - 30 * 1000,
          sourceLatestAt: NOW - 1000,
          voiceCoverage: undefined,
          evidence: [{ conversationId: 'md5-bobo', messageId: 'new-1', timestamp: NOW - 60_000, sender: 'BOBO', sourceKind: 'text', text: '最近开始健身了' }]
        })
      knowledge.requestCatchUp.mockReturnValue({ triggered: true, inProgress: true })
      knowledge.waitForIndexingComplete.mockResolvedValue(true)

      const result = await service.search({ target: { query: 'BOBO' }, timeRange: { kind: 'all' }, query: '健身' })

      expect(knowledge.search).toHaveBeenCalledTimes(2)
      expect(result.coverage).toEqual({ state: 'complete' })
      expect(result.freshness).toEqual({ catchUp: 'completed' })
      expect(result.evidenceCount).toBe(1)
      expect(result.evidence?.[0]).toMatchObject({ text: '最近开始健身了', sender: 'BOBO' })
    })

    it('索引已追平 → 不触发同步（fresh path 不增加开销）', async () => {
      fixture.contacts.splice(1)
      knowledge.search.mockResolvedValue({ ...freshIndex(), sourceLatestAt: NOW - 1000 })

      const result = await service.search({ target: { query: 'BOBO' }, timeRange: { kind: 'all' }, query: '健身' })

      expect(result.freshness).toEqual({ catchUp: 'none' })
      expect(result.coverage).toEqual({ state: 'complete' })
      expect(knowledge.requestCatchUp).not.toHaveBeenCalled()
      expect(knowledge.waitForIndexingComplete).not.toHaveBeenCalled()
    })

    it('请求范围落在索引覆盖窗口内 → 不触发同步', async () => {
      fixture.contacts.splice(1)
      // 索引追到"昨天"，而问的是"上个月"（早于索引覆盖边界）→ 完全覆盖。
      knowledge.search.mockResolvedValue({
        state: 'ready',
        evidence: [],
        indexLatestAt: NOW - DAY,
        sourceLatestAt: NOW - 1000,
        voiceCoverage: undefined
      })

      const result = await service.search({ target: { query: 'BOBO' }, timeRange: { kind: 'previous_month' }, query: '健身' })

      expect(knowledge.requestCatchUp).not.toHaveBeenCalled()
      expect(result.coverage).toEqual({ state: 'complete' })
      expect(result.indexCoverage?.covered).toBe(true)
    })

    it('有界时间范围落后于索引时必须 partial（resolvedTimeRange 是秒，freshness 口径是毫秒）', async () => {
      fixture.contacts.splice(1)
      // 回归：`resolvedTimeRange.endTime` 是 epoch 秒，而 indexLatestAt 是 epoch 毫秒。
      // 混单位会让请求边界被算成 1970 年，从而把"落后"误判成"已覆盖"。
      knowledge.search.mockResolvedValue({
        state: 'ready',
        evidence: [],
        indexLatestAt: NOW - 4 * 60 * 1000,
        sourceLatestAt: NOW,
        voiceCoverage: undefined
      })

      const result = await service.search({ target: { query: 'BOBO' }, timeRange: { kind: 'today' }, query: '健身' })

      expect(result.resolvedTimeRange?.endTime).toEqual(expect.any(Number))
      // 请求边界（今天）晚于索引覆盖边界 4 分钟 → 只能 partial。
      expect(result.coverage).toEqual({ state: 'partial' })
      expect(result.indexCoverage?.covered).toBe(false)
      expect(result.indexCoverage?.summary).toContain('暂时无法确认')
    })

    it('已有索引任务在跑 → 复用而不阻塞本次查询', async () => {
      fixture.contacts.splice(1)
      knowledge.search.mockResolvedValue({ ...staleIndex(), sourceLatestAt: NOW - 1000 })
      knowledge.requestCatchUp.mockReturnValue({ triggered: false, inProgress: true })

      const result = await service.search({ target: { query: 'BOBO' }, timeRange: { kind: 'all' }, query: '健身' })

      expect(result.freshness).toEqual({ catchUp: 'reused' })
      expect(knowledge.waitForIndexingComplete).not.toHaveBeenCalled()
      expect(result.coverage).toEqual({ state: 'partial' })
    })

    it('追平后 0 结果才允许 complete negative；落后时同一条件只能是 partial', async () => {
      fixture.contacts.splice(1)
      knowledge.search.mockResolvedValue({ ...staleIndex(), sourceLatestAt: NOW - 1000 })
      const stale = await service.search({ target: { query: 'BOBO' }, timeRange: { kind: 'all' }, query: '不存在的词' })
      expect(stale.coverage).toEqual({ state: 'partial' })

      knowledge.search.mockResolvedValue({ ...freshIndex(), sourceLatestAt: NOW - 1000 })
      const fresh = await service.search({ target: { query: 'BOBO' }, timeRange: { kind: 'all' }, query: '不存在的词' })
      expect(fresh.coverage).toEqual({ state: 'complete' })
      expect(fresh.evidenceCount).toBe(0)
    })

    it('派生索引不可用时保持 unknown/partial，不冒充 complete', async () => {
      fixture.contacts.splice(1)
      knowledge.search.mockResolvedValue({ state: 'unavailable', evidence: [], indexLatestAt: null, sourceLatestAt: null, voiceCoverage: undefined })
      const empty = await service.search({ target: { query: 'BOBO' }, timeRange: { kind: 'all' }, query: '健身' })
      expect(empty.coverage).toEqual({ state: 'unknown' })
      expect(knowledge.requestCatchUp).not.toHaveBeenCalled()
    })

    it('落后量低于门槛（max(下限, 上一遍耗时)）时不触发追赶，只如实 partial', async () => {
      fixture.contacts.splice(1)
      // 上一遍索引耗时 15 分钟 → 15 分钟的落后不值得立刻再跑一遍（否则会连续索引）。
      knowledge.lastPassDurationMs.mockReturnValue(15 * 60 * 1000)
      knowledge.search.mockResolvedValue({
        state: 'ready',
        evidence: [],
        indexLatestAt: NOW - 15 * 60 * 1000,
        sourceLatestAt: NOW - 1000,
        voiceCoverage: undefined
      })

      const result = await service.search({ target: { query: 'BOBO' }, timeRange: { kind: 'all' }, query: '健身' })

      expect(result.freshness).toEqual({ catchUp: 'skipped' })
      expect(result.coverage).toEqual({ state: 'partial' })
      expect(knowledge.requestCatchUp).not.toHaveBeenCalled()
    })

    it('落后量超过上一遍耗时 → 值得再追一遍', async () => {
      fixture.contacts.splice(1)
      knowledge.lastPassDurationMs.mockReturnValue(60 * 1000)
      knowledge.search.mockResolvedValue({ ...staleIndex(), sourceLatestAt: NOW - 1000 })
      knowledge.requestCatchUp.mockReturnValue({ triggered: true, inProgress: true })

      const result = await service.search({ target: { query: 'BOBO' }, timeRange: { kind: 'all' }, query: '健身' })

      expect(knowledge.requestCatchUp).toHaveBeenCalledTimes(1)
      expect(result.freshness).toEqual({ catchUp: 'pending' })
    })
  })
})

describe('LocalQueryApiService — indexCoverage 结论句', () => {
  const NOW2 = new Date('2026-09-09T12:00:00+08:00').getTime()
  let service2: LocalQueryApiService

  beforeEach(() => {
    vi.clearAllMocks()
    if (!fixture.contacts.some((contact) => contact.md5 === 'md5-bobo-2')) fixture.contacts.push({ m_nsUsrName: 'wxid-bobo-2', m_nsNickName: 'BOBO', md5: 'md5-bobo-2', type: 'user' })
    service2 = new LocalQueryApiService(
      {
        search: vi.fn(async () => ({
          state: 'ready',
          evidence: [],
          indexLatestAt: NOW2 - 10 * 24 * 60 * 60 * 1000,
          sourceLatestAt: NOW2 - 1000,
          voiceCoverage: undefined
        })),
        requestCatchUp: vi.fn(() => ({ triggered: false, inProgress: false })),
        waitForIndexingComplete: vi.fn(async () => false),
        lastPassDurationMs: vi.fn(() => 0),
        beginInteractiveQuery: vi.fn(),
        endInteractiveQuery: vi.fn()
      } as never,
      () => new Date('2026-09-09T12:00:00+08:00')
    )
    fixture.contacts.splice(1)
  })

  it('落后时给出可直接引用的本地时间结论，且明确"暂时无法确认"', async () => {
    const result = await service2.search({ target: { query: 'BOBO' }, timeRange: { kind: 'all' }, query: '健身' })
    expect(result.coverage).toEqual({ state: 'partial' })
    // 8/30 12:00 的本地时间标签（固定时钟下可断言）
    expect(result.indexCoverage?.covered).toBe(false)
    expect(result.indexCoverage?.indexLatestAtLabel).toBe('08-30 12:00')
    expect(result.indexCoverage?.summary).toContain('还没进索引')
    expect(result.indexCoverage?.summary).toContain('暂时无法确认')
    // 不要把 epoch 数字交给模型去猜
    expect(result.indexCoverage?.summary).not.toMatch(/\d{12,}/)
  })
})
