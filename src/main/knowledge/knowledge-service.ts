import { join } from 'path'
import type {
  KnowledgeCapacityPreflight,
  KnowledgeCapacityPreflightRequest,
  KnowledgeIndexProgress,
  KnowledgeIndexRequest,
  KnowledgeIndexResult,
  KnowledgeRuntimeStatus,
  KnowledgeSearchRequest,
  KnowledgeSearchResult,
  KnowledgeStatusRequest
} from '../../shared/knowledge'
import { KnowledgeWorkerHost } from './knowledge-worker-host'

/** Minimal main-process service; no renderer API is exposed in Task 0～Task 2. */
export class KnowledgeService {
  private readonly worker: KnowledgeWorkerHost

  constructor(userDataPath: string, workerPath: string) {
    this.worker = new KnowledgeWorkerHost(workerPath)
    this.databaseRoot = join(userDataPath, 'knowledge')
  }

  private readonly databaseRoot: string

  index(
    request: Omit<KnowledgeIndexRequest, 'databaseRoot'>,
    onProgress?: (progress: KnowledgeIndexProgress) => void
  ): Promise<KnowledgeIndexResult> {
    return this.worker.index({ ...request, databaseRoot: this.databaseRoot }, onProgress)
  }

  preflight(
    request: Omit<KnowledgeCapacityPreflightRequest, 'databaseRoot'>
  ): Promise<KnowledgeCapacityPreflight> {
    return this.worker.preflight({ ...request, databaseRoot: this.databaseRoot })
  }

  remove(accountId: string): Promise<{ removed: true }> {
    return this.worker.remove(accountId, this.databaseRoot)
  }

  search(request: Omit<KnowledgeSearchRequest, 'databaseRoot'>): Promise<KnowledgeSearchResult> {
    return this.worker.search({ ...request, databaseRoot: this.databaseRoot })
  }

  status(request: Omit<KnowledgeStatusRequest, 'databaseRoot'>): Promise<KnowledgeRuntimeStatus> {
    return this.worker.status({ ...request, databaseRoot: this.databaseRoot })
  }

  dispose(): Promise<void> {
    return this.worker.dispose()
  }
}
