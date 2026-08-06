import type { KnowledgeWorkerRequest, KnowledgeWorkerResponse } from '../../shared/knowledge'

export const KNOWLEDGE_WORKER_PROTOCOL_VERSION = 1 as const

export type WorkerKnowledgeRequest = KnowledgeWorkerRequest
export type WorkerKnowledgeResponse = KnowledgeWorkerResponse
