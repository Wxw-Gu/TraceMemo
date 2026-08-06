import { fork, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import type {
  KnowledgeCapacityPreflight,
  KnowledgeCapacityPreflightRequest,
  KnowledgeIndexProgress,
  KnowledgeIndexRequest,
  KnowledgeIndexResult,
  KnowledgeRuntimeStatus,
  KnowledgeSearchRequest,
  KnowledgeSearchResult,
  KnowledgeStatusRequest,
  KnowledgeWorkerRequest,
  KnowledgeWorkerResponse
} from '../../shared/knowledge'

type WorkerResult =
  | KnowledgeIndexResult
  | KnowledgeCapacityPreflight
  | KnowledgeSearchResult
  | KnowledgeRuntimeStatus
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

  constructor(private readonly workerPath: string) {}

  index(
    payload: KnowledgeIndexRequest,
    onProgress?: (progress: KnowledgeIndexProgress) => void
  ): Promise<KnowledgeIndexResult> {
    return this.request('index', payload, onProgress) as Promise<KnowledgeIndexResult>
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

  remove(accountId: string, databaseRoot: string): Promise<{ removed: true }> {
    return this.request('remove', { accountId, databaseRoot }) as Promise<{ removed: true }>
  }

  cancel(targetRequestId: string): Promise<{ removed: true }> {
    return this.request('cancel', { targetRequestId }) as Promise<{ removed: true }>
  }

  async dispose(): Promise<void> {
    const child = this.child
    if (!child) return
    try {
      await this.request('close', {})
    } catch {
      // The child is about to be stopped; its only job is a derived local index.
    }
    if (this.child === child) this.child = null
    if (!child.killed) child.kill()
  }

  private request(
    type: KnowledgeWorkerRequest['type'],
    payload: KnowledgeWorkerRequest['payload'],
    onProgress?: (progress: KnowledgeIndexProgress) => void
  ): Promise<WorkerResult> {
    const hadWorker = Boolean(this.child?.connected)
    const child = this.ensureChild()
    const requestId = randomUUID()
    const sentAt = Date.now()
    const request: KnowledgeWorkerRequest = { version: 1, type, requestId, sentAt, payload }
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
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'advanced',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })
    child.on('message', (message: KnowledgeWorkerResponse) => {
      if (message?.version !== 1) return
      if (message.type === 'progress') {
        const pending = this.pending.get(message.requestId)
        if (pending && message.payload)
          pending.onProgress?.(message.payload as KnowledgeIndexProgress)
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
        responseSerializeMs: transport.responseSerializeMs,
        responseTransferMs,
        workerIpcMs: workerBootMs + dispatchMs + responseTransferMs
      }
    }
  }

  private failAll(error: Error): void {
    for (const requestId of this.pending.keys()) this.finish(requestId, undefined, error)
  }
}
