import { fork, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'
import { terminateChildProcess, waitForChildExit } from '../process-tree'
import type {
  KnowledgeCapacityPreflight,
  KnowledgeCapacityPreflightRequest,
  KnowledgeIndexProgress,
  KnowledgeIndexRequest,
  KnowledgeIndexResult,
  KnowledgeMemberStatsRequest,
  KnowledgeMemberStatsResult,
  KnowledgeRuntimeStatus,
  KnowledgeSearchRequest,
  KnowledgeSearchResult,
  KnowledgeStatusRequest,
  KnowledgeConversationIndexState,
  KnowledgeConversationStatesRequest,
  KnowledgeSourceTotalsRequest,
  KnowledgeStreamBatchRequest,
  KnowledgeStreamConversationRequest,
  KnowledgeStreamResult,
  KnowledgeStreamStartRequest,
  KnowledgeStreamStartResult,
  KnowledgeWorkerRequest,
  KnowledgeWorkerResponse
} from '../../shared/knowledge'

type WorkerResult =
  | KnowledgeIndexResult
  | KnowledgeCapacityPreflight
  | KnowledgeSearchResult
  | KnowledgeRuntimeStatus
  | KnowledgeMemberStatsResult
  | KnowledgeStreamStartResult
  | KnowledgeStreamResult
  | { marks: Record<string, number> }
  | { accepted: true }
  | { removed: true }
type PendingRequest = {
  resolve: (result: WorkerResult) => void
  reject: (error: Error) => void
  onProgress?: (progress: KnowledgeIndexProgress) => void
  sentAt: number
  workerBootStartedAt?: number
}

/**
 * Main-process boundary for the derived knowledge database. The child runs
 * with ELECTRON_RUN_AS_NODE so synchronous node:sqlite calls never block UI.
 */
export class KnowledgeWorkerHost {
  private child: ChildProcess | null = null
  private childStartedAt = 0
  private readonly pending = new Map<string, PendingRequest>()
  /**
   * 当前在跑的索引请求 id。
   *
   * 之前没有它，所以「取消同步」在 UI 上不存在、在主进程里也无法表达 ——
   * 唯一能停下来的方式就是退出应用。这里显式跟踪，`cancelActiveIndex()` 才能
   * 精确地只中止索引，而**不会**影响任何并发进行的查询请求。
   */
  private activeIndexRequestId: string | null = null
  /** 进度消息回带的是已 resolve 的 streamStart requestId，不能靠 `pending` 找回调。 */
  private readonly streamProgress = new Map<string, (progress: KnowledgeIndexProgress) => void>()

  constructor(private readonly workerPath: string) {}

  index(
    payload: KnowledgeIndexRequest,
    onProgress?: (progress: KnowledgeIndexProgress) => void
  ): Promise<KnowledgeIndexResult> {
    return this.request('index', payload, onProgress, (requestId) => {
      this.activeIndexRequestId = requestId
    }) as Promise<KnowledgeIndexResult>
  }

  preflight(payload: KnowledgeCapacityPreflightRequest): Promise<KnowledgeCapacityPreflight> {
    return this.request('preflight', payload) as Promise<KnowledgeCapacityPreflight>
  }

  search(payload: KnowledgeSearchRequest): Promise<KnowledgeSearchResult> {
    return this.request('search', payload) as Promise<KnowledgeSearchResult>
  }

  status(payload: KnowledgeStatusRequest): Promise<KnowledgeRuntimeStatus> {
    return this.request('status', payload) as Promise<KnowledgeRuntimeStatus>
  }

  /** 每个会话的索引状态；覆盖度判断的唯一依据。 */
  conversationStates(
    payload: KnowledgeConversationStatesRequest
  ): Promise<Record<string, KnowledgeConversationIndexState>> {
    return this.request('conversationStates', payload).then(
      (result) =>
        (result as { states?: Record<string, KnowledgeConversationIndexState> }).states ?? {}
    )
  }

  /** 每个会话已经索引到的源侧时刻；用于增量 pass 跳过没有变化的会话。 */
  highWaterMarks(payload: KnowledgeStatusRequest): Promise<Record<string, number>> {
    return this.request('highWater', payload as unknown as KnowledgeWorkerRequest['payload']).then(
      (result) => ('marks' in result ? result.marks : {})
    )
  }

  /** 单个会话内「按发送者聚合」的发言统计（群员统计用，只回聚合不回正文）。 */
  memberStats(payload: KnowledgeMemberStatsRequest): Promise<KnowledgeMemberStatsResult> {
    return this.request('memberStats', payload) as Promise<KnowledgeMemberStatsResult>
  }

  /** 开始一个会话的分批索引；消息由调用方逐批推送。 */
  async startConversationStream(
    payload: KnowledgeStreamStartRequest,
    onProgress?: (progress: KnowledgeIndexProgress) => void
  ): Promise<KnowledgeStreamStartResult> {
    if (onProgress) this.streamProgress.set(payload.conversationId, onProgress)
    try {
      return (await this.request('streamStart', payload)) as KnowledgeStreamStartResult
    } catch (error) {
      this.streamProgress.delete(payload.conversationId)
      throw error
    }
  }

  async pushConversationBatch(payload: KnowledgeStreamBatchRequest): Promise<void> {
    await this.request('streamBatch', payload)
  }

  async finishConversationStream(
    payload: KnowledgeStreamConversationRequest
  ): Promise<KnowledgeStreamResult> {
    try {
      return (await this.request('streamFinish', payload)) as KnowledgeStreamResult
    } finally {
      this.streamProgress.delete(payload.conversationId)
    }
  }

  async writeSourceTotals(payload: KnowledgeSourceTotalsRequest): Promise<void> {
    await this.request('sourceTotals', payload)
  }

  async abortConversationStream(payload: KnowledgeStreamConversationRequest): Promise<void> {
    try {
      await this.request('streamAbort', payload)
    } finally {
      this.streamProgress.delete(payload.conversationId)
    }
  }

  /** 只中止正在跑的索引任务，返回是否真的有任务被中止。 */
  async cancelActiveIndex(): Promise<boolean> {
    const target = this.activeIndexRequestId
    if (!target) return false
    await this.cancel(target)
    return true
  }

  remove(accountId: string, databaseRoot: string): Promise<{ removed: true }> {
    return this.request('remove', { accountId, databaseRoot }) as Promise<{ removed: true }>
  }

  cancel(targetRequestId: string): Promise<{ removed: true }> {
    return this.request('cancel', { targetRequestId }) as Promise<{ removed: true }>
  }

  async dispose(options: { closeTimeoutMs?: number; exitTimeoutMs?: number } = {}): Promise<void> {
    const child = this.child
    if (!child) return
    const closeTimeoutMs = options.closeTimeoutMs ?? 1_500
    const exitTimeoutMs = options.exitTimeoutMs ?? 2_000
    // close 请求必须有超时，避免同步 SQLite 事务把应用退出永久挂死。
    const closePromise = this.request('close', {}).catch(() => undefined)
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      await Promise.race([
        closePromise,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, closeTimeoutMs)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
    if (this.child === child) this.child = null
    const exited = await waitForChildExit(child, 300)
    if (!exited) {
      await terminateChildProcess(child, { timeoutMs: exitTimeoutMs })
    }
    this.failAll(new Error('Knowledge worker disposed'))
  }

  private request(
    type: KnowledgeWorkerRequest['type'],
    payload: KnowledgeWorkerRequest['payload'],
    onProgress?: (progress: KnowledgeIndexProgress) => void,
    onRequestId?: (requestId: string) => void
  ): Promise<WorkerResult> {
    const hadWorker = Boolean(this.child?.connected)
    const child = this.ensureChild()
    const requestId = randomUUID()
    const sentAt = Date.now()
    const request: KnowledgeWorkerRequest = { version: 1, type, requestId, sentAt, payload }
    onRequestId?.(requestId)
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, {
        resolve,
        reject,
        onProgress,
        sentAt,
        workerBootStartedAt: hadWorker ? undefined : this.childStartedAt
      })
      child.send(request, (error) => {
        if (error) this.finish(requestId, undefined, error)
      })
    })
  }

  private ensureChild(): ChildProcess {
    if (this.child?.connected) return this.child
    const child = fork(this.workerPath, [], {
      cwd: tmpdir(),
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'advanced',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })
    child.on('message', (message: KnowledgeWorkerResponse) => {
      if (message?.version !== 1) return
      if (message.type === 'progress') {
        const progress = message.payload as KnowledgeIndexProgress | undefined
        if (!progress) return
        const pending = this.pending.get(message.requestId)
        if (pending?.onProgress) {
          pending.onProgress(progress)
          return
        }
        if (progress.conversationId) {
          this.streamProgress.get(progress.conversationId)?.(progress)
        }
        return
      }
      this.finish(
        message.requestId,
        message.payload as WorkerResult | undefined,
        message.type === 'error'
          ? new Error(message.error || 'Knowledge worker failed')
          : undefined,
        message.transport
      )
    })
    child.once('error', (error) => this.failAll(error))
    child.once('exit', (code) => {
      if (this.child === child) this.child = null
      this.failAll(new Error(`Knowledge worker exited (${code ?? 'unknown'})`))
    })
    this.child = child
    this.childStartedAt = Date.now()
    return child
  }

  private finish(
    requestId: string,
    result?: WorkerResult,
    error?: Error,
    transport?: KnowledgeWorkerResponse['transport']
  ): void {
    const pending = this.pending.get(requestId)
    if (!pending) return
    this.pending.delete(requestId)
    if (this.activeIndexRequestId === requestId) this.activeIndexRequestId = null
    if (error) pending.reject(error)
    else if (result) pending.resolve(this.applyTransportTimings(result, pending, transport))
    else pending.reject(new Error('Knowledge worker returned no result'))
  }

  private applyTransportTimings(
    result: WorkerResult,
    pending: PendingRequest,
    transport?: KnowledgeWorkerResponse['transport']
  ): WorkerResult {
    if (!('timings' in result) || !transport) return result
    const receivedAt = Date.now()
    const workerBootMs = pending.workerBootStartedAt
      ? Math.max(0, transport.workerReceivedAt - pending.workerBootStartedAt)
      : 0
    const dispatchMs = Math.max(0, transport.workerReceivedAt - pending.sentAt)
    const responseTransferMs = Math.max(0, receivedAt - transport.workerCompletedAt)
    return {
      ...result,
      timings: {
        ...result.timings,
        workerBootMs,
        dispatchMs,
        workerSqlMs: result.timings.totalMs,
        workerExecutionMs: result.timings.workerExecutionMs ?? result.timings.totalMs,
        workerQueueMs: transport.workerQueueMs ?? 0,
        responseSerializeMs: transport.responseSerializeMs,
        responseTransferMs,
        serializationMs: transport.responseSerializeMs,
        ipcMs: workerBootMs + dispatchMs + responseTransferMs,
        workerIpcMs: workerBootMs + dispatchMs + responseTransferMs
      }
    }
  }

  private failAll(error: Error): void {
    this.streamProgress.clear()
    for (const requestId of this.pending.keys()) this.finish(requestId, undefined, error)
  }
}
