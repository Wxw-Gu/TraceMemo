import type {
  KnowledgeCapacityPreflightRequest,
  KnowledgeIndexRequest,
  KnowledgeMemberStatsRequest,
  KnowledgeMemberStatsResult,
  KnowledgeRuntimeStatus,
  KnowledgeSearchRequest,
  KnowledgeSourceMessage,
  KnowledgeStatusRequest,
  KnowledgeStreamBatchRequest,
  KnowledgeStreamConversationRequest,
  KnowledgeStreamResult,
  KnowledgeConversationStatesRequest,
  KnowledgeSourceTotalsRequest,
  KnowledgeStreamStartRequest,
  KnowledgeWorkerRequest,
  KnowledgeWorkerResponse
} from '../../shared/knowledge'
import {
  DEFAULT_KNOWLEDGE_FTS_CONFIG,
  emptyKnowledgeSearchTimings
} from '../../shared/knowledge'
import {
  KnowledgeStore,
  estimateKnowledgeCapacityPreflight,
  getKnowledgeDatabasePath,
  removeKnowledgeDatabase
} from './knowledge-store'
import { existsSync } from 'fs'
import { serialize } from 'v8'

const stores = new Map<string, KnowledgeStore>()
const controllers = new Map<string, AbortController>()

/** 背压：主进程拉下一页前 Worker 已提交上一批，两侧同时驻留上限是「一页 × 2」。 */
class StreamingBatchQueue {
  private readonly buffer: KnowledgeSourceMessage[][] = []
  private wake: (() => void) | null = null
  private closed = false
  private failure: Error | null = null

  push(batch: KnowledgeSourceMessage[]): void {
    if (this.closed) return
    this.buffer.push(batch)
    this.release()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.release()
  }

  fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    this.closed = true
    this.release()
  }

  private release(): void {
    const resolve = this.wake
    this.wake = null
    resolve?.()
  }

  async *iterate(): AsyncGenerator<readonly KnowledgeSourceMessage[], void, void> {
    while (true) {
      if (!this.buffer.length && !this.closed) {
        await new Promise<void>((resolve) => {
          this.wake = resolve
        })
      }
      const next = this.buffer.shift()
      if (next) {
        yield next
        continue
      }
      if (this.failure) throw this.failure
      if (this.closed) return
    }
  }
}

type StreamSession = {
  queue: StreamingBatchQueue
  controller: AbortController
  store: KnowledgeStore
  task: Promise<{
    processedMessages: number
    chunkCount: number
    cancelled: boolean
    resumeTime: number | null
  }>
}

const streamSessions = new Map<string, StreamSession>()

function streamKey(payload: { databaseRoot: string; accountId: string; conversationId: string }): string {
  return `${payload.databaseRoot}|${payload.accountId}|${payload.conversationId}`
}

function send(
  message: KnowledgeWorkerResponse,
  transport?: KnowledgeWorkerResponse['transport']
): void {
  if (process.send) process.send({ ...message, transport })
}

function sendSearchResult(
  request: KnowledgeWorkerRequest,
  payload: KnowledgeWorkerResponse['payload'],
  workerReceivedAt: number,
  workerQueueMs: number
): void {
  const serializeStartedAt = Date.now()
  // This measures the actual payload encoding workload before Node IPC performs
  // its own transfer. It lets diagnostics separate payload cost from SQL time.
  serialize(payload)
  const responseSerializeMs = Date.now() - serializeStartedAt
  send(
    { version: 1, type: 'result', requestId: request.requestId, payload },
    {
      messageReceivedAt: workerReceivedAt - workerQueueMs,
      workerReceivedAt,
      workerCompletedAt: Date.now(),
      responseSerializeMs,
      workerQueueMs
    }
  )
}

function storeKey(databaseRoot: string, accountId: string): string {
  return getKnowledgeDatabasePath(databaseRoot, accountId)
}

function getStore(
  request: Pick<KnowledgeIndexRequest, 'databaseRoot' | 'accountId' | 'fts'>
): KnowledgeStore {
  const key = storeKey(request.databaseRoot, request.accountId)
  let store = stores.get(key)
  if (!store) {
    store = new KnowledgeStore(request.databaseRoot, request.accountId, request.fts)
    stores.set(key, store)
  }
  return store
}

function closeStore(databaseRoot: string, accountId: string): void {
  const key = storeKey(databaseRoot, accountId)
  const store = stores.get(key)
  if (store) store.close()
  stores.delete(key)
}

async function handleIndex(
  request: KnowledgeWorkerRequest,
  payload: KnowledgeIndexRequest
): Promise<void> {
  const controller = new AbortController()
  controllers.set(request.requestId, controller)
  try {
    const result = await getStore(payload).index(payload, controller.signal, (progress) => {
      send({ version: 1, type: 'progress', requestId: request.requestId, payload: progress })
    })
    send({ version: 1, type: 'result', requestId: request.requestId, payload: result })
  } finally {
    controllers.delete(request.requestId)
  }
}

async function handleStreamStart(
  request: KnowledgeWorkerRequest,
  payload: KnowledgeStreamStartRequest
): Promise<void> {
  const key = streamKey(payload)
  if (streamSessions.has(key)) throw new Error('该会话已在建立索引')

  const queue = new StreamingBatchQueue()
  const controller = new AbortController()
  const store = getStore(payload)
  // 续跑位置由 Worker 自己读：主进程只知道"这一遍要重建"，不该关心分页细节。
  // 显式 `null` 表示从零重建，不能落到 `??` 的默认分支里。
  const explicitResume = payload.resume
  const resume =
    explicitResume === null
      ? undefined
      : explicitResume ??
        (payload.completeSnapshot
          ? store.readBackfillResume(payload.conversationId) ?? undefined
          : undefined)
  const task = store.indexConversationStreaming(
    payload.conversationId,
    queue.iterate(),
    payload.chunker,
    {
      completeSnapshot: payload.completeSnapshot,
      sourceHighWaterTime: payload.sourceHighWaterTime,
      resume
    },
    controller.signal,
    (processedMessages, indexedChunks) => {
      send({
        version: 1,
        type: 'progress',
        requestId: request.requestId,
        payload: {
          accountId: payload.accountId,
          phase: 'indexing',
          conversationId: payload.conversationId,
          processedMessages,
          // 流式回填的会话总量未知，进度只上报已处理条数。
          totalMessages: 0,
          indexedChunks
        }
      })
    }
  )
  // 主进程可能在中途放弃这个会话；未消费的 rejection 会打崩 Worker 进程。
  task.catch(() => undefined)
  streamSessions.set(key, { queue, controller, store, task })

  send({
    version: 1,
    type: 'result',
    requestId: request.requestId,
    payload: { started: true, resumedFrom: resume?.time ?? null }
  })
}

async function handleStreamBatch(
  request: KnowledgeWorkerRequest,
  payload: KnowledgeStreamBatchRequest
): Promise<void> {
  const session = streamSessions.get(streamKey(payload))
  if (!session) throw new Error('该会话没有进行中的索引任务')
  session.queue.push(payload.messages)
  send({ version: 1, type: 'result', requestId: request.requestId, payload: { accepted: true } })
}

async function handleStreamFinish(
  request: KnowledgeWorkerRequest,
  payload: KnowledgeStreamConversationRequest
): Promise<void> {
  const key = streamKey(payload)
  const session = streamSessions.get(key)
  if (!session) throw new Error('该会话没有进行中的索引任务')
  streamSessions.delete(key)
  session.queue.close()
  const result = await session.task
  if (typeof payload.sourceHighWaterTime === 'number') {
    session.store.advanceSourceHighWater(payload.conversationId, payload.sourceHighWaterTime)
  }
  if (typeof payload.sourceMessageCount === 'number') {
    session.store.writeSourceTotals(payload.sourceMessageCount, payload.sourceLatestAt)
  }
  const streamResult: KnowledgeStreamResult = {
    conversationId: payload.conversationId,
    processedMessages: result.processedMessages,
    chunkCount: result.chunkCount,
    cancelled: result.cancelled,
    resumeTime: result.resumeTime
  }
  send({ version: 1, type: 'result', requestId: request.requestId, payload: streamResult })
}

async function handleConversationStates(
  request: KnowledgeWorkerRequest,
  payload: KnowledgeConversationStatesRequest
): Promise<void> {
  const path = getKnowledgeDatabasePath(payload.databaseRoot, payload.accountId)
  const states = existsSync(path)
    ? getStore({ ...payload, fts: DEFAULT_KNOWLEDGE_FTS_CONFIG }).readConversationIndexStates()
    : {}
  send({ version: 1, type: 'result', requestId: request.requestId, payload: { states } })
}

async function handleSourceTotals(
  request: KnowledgeWorkerRequest,
  payload: KnowledgeSourceTotalsRequest
): Promise<void> {
  // 没有已打开的库就说明这一遍没有真正写过索引，不新建空库来记口径。
  stores
    .get(storeKey(payload.databaseRoot, payload.accountId))
    ?.writeSourceTotals(payload.sourceMessageCount, payload.sourceLatestAt)
  send({ version: 1, type: 'result', requestId: request.requestId, payload: { accepted: true } })
}

async function handleStreamAbort(
  request: KnowledgeWorkerRequest,
  payload: KnowledgeStreamConversationRequest
): Promise<void> {
  const key = streamKey(payload)
  const session = streamSessions.get(key)
  streamSessions.delete(key)
  if (session) {
    session.controller.abort()
    session.queue.close()
    await session.task.catch(() => undefined)
  }
  send({ version: 1, type: 'result', requestId: request.requestId, payload: { removed: true } })
}

async function handlePreflight(  request: KnowledgeWorkerRequest,
  payload: KnowledgeCapacityPreflightRequest
): Promise<void> {
  const result = await estimateKnowledgeCapacityPreflight(payload)
  send({ version: 1, type: 'result', requestId: request.requestId, payload: result })
}

async function handleSearch(
  request: KnowledgeWorkerRequest,
  payload: KnowledgeSearchRequest,
  messageReceivedAt: number
): Promise<void> {
  const workerReceivedAt = Date.now()
  const workerQueueMs = Math.max(0, workerReceivedAt - messageReceivedAt)
  const workerExecutionStartedAt = Date.now()
  const path = getKnowledgeDatabasePath(payload.databaseRoot, payload.accountId)
  if (!existsSync(path)) {
    sendSearchResult(
      request,
      {
        state: 'unavailable',
        evidence: [],
        indexedMessageCount: 0,
        indexedChunkCount: 0,
        indexLatestAt: null,
        timings: emptyKnowledgeSearchTimings()
      },
      workerReceivedAt,
      workerQueueMs
    )
    return
  }
  const result = getStore(payload).searchWithStatus(payload)
  sendSearchResult(
    request,
    {
      ...result,
      timings: {
        ...result.timings,
        workerExecutionMs: Date.now() - workerExecutionStartedAt
      }
    },
    workerReceivedAt,
    workerQueueMs
  )
}

async function handleStatus(
  request: KnowledgeWorkerRequest,
  payload: KnowledgeStatusRequest
): Promise<void> {
  const path = getKnowledgeDatabasePath(payload.databaseRoot, payload.accountId)
  if (!existsSync(path)) {
    const unavailable: KnowledgeRuntimeStatus = {
      accountId: payload.accountId,
      state: 'unavailable',
      indexedMessageCount: 0,
      indexedChunkCount: 0,
      sourceMessageCount: null,
      processedMessages: 0,
      totalMessages: null,
      estimatedRemainingMs: null,
      databaseBytes: 0,
      walBytes: 0,
      shmBytes: 0,
      indexLatestAt: null,
      sourceLatestAt: null
    }
    send({ version: 1, type: 'result', requestId: request.requestId, payload: unavailable })
    return
  }
  send({
    version: 1,
    type: 'result',
    requestId: request.requestId,
    payload: getStore(payload).getRuntimeStatus()
  })
}

/**
 * 每个会话「已经索引到源数据的哪个时刻」。
 * 增量 pass 靠它决定哪些会话可以整段跳过（见 `KnowledgeStore.readSourceHighWaterMarks`）。
 */
async function handleHighWater(
  request: KnowledgeWorkerRequest,
  payload: KnowledgeStatusRequest
): Promise<void> {
  const path = getKnowledgeDatabasePath(payload.databaseRoot, payload.accountId)
  const marks = existsSync(path) ? getStore(payload).readSourceHighWaterMarks() : {}
  send({
    version: 1,
    type: 'result',
    requestId: request.requestId,
    payload: { marks } as unknown as KnowledgeWorkerResponse['payload']
  })
}

/**
 * 群员统计的按发送者聚合。
 *
 * 与 `handleSearch` 同样先判库是否存在：**「还没建索引」是正常状态，不是故障**，
 * 返回空结果而不是抛错，让上层能稳定地区分「没人发言」与「索引不存在」。
 */
async function handleMemberStats(
  request: KnowledgeWorkerRequest,
  payload: KnowledgeMemberStatsRequest
): Promise<void> {
  const path = getKnowledgeDatabasePath(payload.databaseRoot, payload.accountId)
  if (!existsSync(path)) {
    const unavailable: KnowledgeMemberStatsResult = {
      conversationId: payload.conversationId,
      totalMessages: 0,
      senders: [],
      unattributedMessages: 0,
      excludedSystemMessages: 0,
      earliestMessageTime: null,
      indexLatestAt: null
    }
    send({ version: 1, type: 'result', requestId: request.requestId, payload: unavailable })
    return
  }
  send({
    version: 1,
    type: 'result',
    requestId: request.requestId,
    payload: getStore(payload).memberStats(payload)
  })
}

async function handle(request: KnowledgeWorkerRequest, messageReceivedAt: number): Promise<void> {
  try {
    if (request.type === 'cancel') {
      const payload = request.payload as { targetRequestId: string }
      controllers.get(payload.targetRequestId)?.abort()
      // 分批索引用的是自己的 controller：漏掉它，取消会一直等到整遍跑完才生效。
      for (const session of streamSessions.values()) {
        session.controller.abort()
        session.queue.close()
      }
      send({ version: 1, type: 'result', requestId: request.requestId, payload: { removed: true } })
      return
    }
    if (request.type === 'close') {
      for (const controller of controllers.values()) controller.abort()
      for (const session of streamSessions.values()) {
        session.controller.abort()
        session.queue.close()
      }
      streamSessions.clear()
      for (const store of stores.values()) store.close()
      stores.clear()
      send({ version: 1, type: 'result', requestId: request.requestId, payload: { removed: true } })
      process.disconnect?.()
      return
    }
    if (request.type === 'remove') {
      const payload = request.payload as { accountId: string; databaseRoot: string }
      closeStore(payload.databaseRoot, payload.accountId)
      removeKnowledgeDatabase(payload.databaseRoot, payload.accountId)
      send({ version: 1, type: 'result', requestId: request.requestId, payload: { removed: true } })
      return
    }
    if (request.type === 'preflight') {
      await handlePreflight(request, request.payload as KnowledgeCapacityPreflightRequest)
      return
    }
    if (request.type === 'search') {
      await handleSearch(request, request.payload as KnowledgeSearchRequest, messageReceivedAt)
      return
    }
    if (request.type === 'status') {
      await handleStatus(request, request.payload as KnowledgeStatusRequest)
      return
    }
    if (request.type === 'highWater') {
      await handleHighWater(request, request.payload as KnowledgeStatusRequest)
      return
    }
    if (request.type === 'memberStats') {
      await handleMemberStats(request, request.payload as KnowledgeMemberStatsRequest)
      return
    }
    if (request.type === 'index') {
      await handleIndex(request, request.payload as KnowledgeIndexRequest)
      return
    }
    if (request.type === 'streamStart') {
      await handleStreamStart(request, request.payload as KnowledgeStreamStartRequest)
      return
    }
    if (request.type === 'streamBatch') {
      await handleStreamBatch(request, request.payload as KnowledgeStreamBatchRequest)
      return
    }
    if (request.type === 'streamFinish') {
      await handleStreamFinish(request, request.payload as KnowledgeStreamConversationRequest)
      return
    }
    if (request.type === 'streamAbort') {
      await handleStreamAbort(request, request.payload as KnowledgeStreamConversationRequest)
      return
    }
    if (request.type === 'conversationStates') {
      await handleConversationStates(request, request.payload as KnowledgeConversationStatesRequest)
      return
    }
    if (request.type === 'sourceTotals') {
      await handleSourceTotals(request, request.payload as KnowledgeSourceTotalsRequest)
      return
    }
    throw new Error(`Unsupported knowledge worker request: ${String(request.type)}`)
  } catch (error) {
    send({
      version: 1,
      type: 'error',
      requestId: request.requestId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

// 必须串行：分批索引在批与批之间 await，新请求切入会把 BEGIN IMMEDIATE 嵌套起来。
let requestChain: Promise<void> = Promise.resolve()

process.on('message', (message: KnowledgeWorkerRequest) => {
  if (message?.version !== 1) return
  if (message.type === 'streamAbort' || message.type === 'cancel') {
    void handle(message, Date.now())
    return
  }
  requestChain = requestChain.then(() => handle(message, Date.now()))
})
