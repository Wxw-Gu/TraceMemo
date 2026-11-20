import { join } from 'path'
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
  KnowledgeStreamStartResult
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

  /** 开始一个会话的分批索引：消息不随请求下发，由调用方逐批推送。 */
  startConversationStream(
    request: Omit<KnowledgeStreamStartRequest, 'databaseRoot'>,
    onProgress?: (progress: KnowledgeIndexProgress) => void
  ): Promise<KnowledgeStreamStartResult> {
    return this.worker.startConversationStream(
      { ...request, databaseRoot: this.databaseRoot },
      onProgress
    )
  }

  pushConversationBatch(
    request: Omit<KnowledgeStreamBatchRequest, 'databaseRoot'>
  ): Promise<void> {
    return this.worker.pushConversationBatch({ ...request, databaseRoot: this.databaseRoot })
  }

  finishConversationStream(
    request: Omit<KnowledgeStreamConversationRequest, 'databaseRoot'>
  ): Promise<KnowledgeStreamResult> {
    return this.worker.finishConversationStream({ ...request, databaseRoot: this.databaseRoot })
  }

  abortConversationStream(
    request: Omit<KnowledgeStreamConversationRequest, 'databaseRoot'>
  ): Promise<void> {
    return this.worker.abortConversationStream({ ...request, databaseRoot: this.databaseRoot })
  }

  writeSourceTotals(request: Omit<KnowledgeSourceTotalsRequest, 'databaseRoot'>): Promise<void> {
    return this.worker.writeSourceTotals({ ...request, databaseRoot: this.databaseRoot })
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

  /** 每个会话的索引状态（是否完整覆盖），查询侧据此判断覆盖度。 */
  conversationStates(
    request: Omit<KnowledgeConversationStatesRequest, 'databaseRoot'>
  ): Promise<Record<string, KnowledgeConversationIndexState>> {
    return this.worker.conversationStates({ ...request, databaseRoot: this.databaseRoot })
  }

  /** 每个会话已经索引到的源侧时刻（epoch ms）；增量 pass 用它跳过没有变化的会话。 */
  highWaterMarks(request: Omit<KnowledgeStatusRequest, 'databaseRoot'>): Promise<Record<string, number>> {
    return this.worker.highWaterMarks({ ...request, databaseRoot: this.databaseRoot })
  }

  /** 单个会话内「按发送者聚合」的发言统计（群员统计用）。 */
  memberStats(
    request: Omit<KnowledgeMemberStatsRequest, 'databaseRoot'>
  ): Promise<KnowledgeMemberStatsResult> {
    return this.worker.memberStats({ ...request, databaseRoot: this.databaseRoot })
  }

  /** 只中止正在跑的索引任务；查询请求不受影响。 */
  cancelIndex(): Promise<boolean> {
    return this.worker.cancelActiveIndex()
  }

  dispose(): Promise<void> {
    return this.worker.dispose()
  }
}
