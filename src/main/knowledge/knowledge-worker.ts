import type {
  KnowledgeCapacityPreflightRequest,
  KnowledgeIndexRequest,
  KnowledgeRuntimeStatus,
  KnowledgeSearchRequest,
  KnowledgeStatusRequest,
  KnowledgeWorkerRequest,
  KnowledgeWorkerResponse
} from '../../shared/knowledge'
import { emptyKnowledgeSearchTimings } from '../../shared/knowledge'
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

function send(
  message: KnowledgeWorkerResponse,
  transport?: KnowledgeWorkerResponse['transport']
): void {
  if (process.send) process.send({ ...message, transport })
}

function sendSearchResult(
  request: KnowledgeWorkerRequest,
  payload: KnowledgeWorkerResponse['payload'],
  workerReceivedAt: number
): void {
  const serializeStartedAt = Date.now()
  // This measures the actual payload encoding workload before Node IPC performs
  // its own transfer. It lets diagnostics separate payload cost from SQL time.
  serialize(payload)
  const responseSerializeMs = Date.now() - serializeStartedAt
  send(
    { version: 1, type: 'result', requestId: request.requestId, payload },
    { workerReceivedAt, workerCompletedAt: Date.now(), responseSerializeMs }
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

async function handlePreflight(
  request: KnowledgeWorkerRequest,
  payload: KnowledgeCapacityPreflightRequest
): Promise<void> {
  const result = await estimateKnowledgeCapacityPreflight(payload)
  send({ version: 1, type: 'result', requestId: request.requestId, payload: result })
}

async function handleSearch(
  request: KnowledgeWorkerRequest,
  payload: KnowledgeSearchRequest
): Promise<void> {
  const workerReceivedAt = Date.now()
  const path = getKnowledgeDatabasePath(payload.databaseRoot, payload.accountId)
  if (!existsSync(path)) {
    sendSearchResult(
      request,
      {
        state: 'unavailable',
        evidence: [],
        indexedMessageCount: 0,
        indexedChunkCount: 0,
        timings: emptyKnowledgeSearchTimings()
      },
      workerReceivedAt
    )
    return
  }
  const result = getStore(payload).searchWithStatus(payload)
  sendSearchResult(request, result, workerReceivedAt)
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
      shmBytes: 0
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

async function handle(request: KnowledgeWorkerRequest): Promise<void> {
  try {
    if (request.type === 'cancel') {
      const payload = request.payload as { targetRequestId: string }
      controllers.get(payload.targetRequestId)?.abort()
      send({ version: 1, type: 'result', requestId: request.requestId, payload: { removed: true } })
      return
    }
    if (request.type === 'close') {
      for (const controller of controllers.values()) controller.abort()
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
      await handleSearch(request, request.payload as KnowledgeSearchRequest)
      return
    }
    if (request.type === 'status') {
      await handleStatus(request, request.payload as KnowledgeStatusRequest)
      return
    }
    if (request.type === 'index') {
      await handleIndex(request, request.payload as KnowledgeIndexRequest)
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

process.on('message', (message: KnowledgeWorkerRequest) => {
  if (message?.version !== 1) return
  void handle(message)
})
