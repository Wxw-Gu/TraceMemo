/**
 * 图片文字索引编排服务。
 *
 * 职责边界（刻意保持单一）：
 * - 快速统计图片消息数（SQL，**绝不解密**）
 * - 按会话 + 批次驱动 OCR：有界流水线，同一时刻在途 OCR 数不超过
 *   `activeOcrConcurrency`；库写入严格串行；每批之间让出 event loop
 * - 维护 checkpoint（可暂停 / 继续 / 取消 / 重启后恢复）
 * - 把结果写进派生库，并在**会话完成时**回调，让 Knowledge 重建该会话的索引
 *
 * 明确不做：
 * - 不修改 WCDB / 不写回原始消息 / 不产生任何"OCR 消息"
 * - 不实现图片搜索 Agent（检索继续走既有 Query Agent + Knowledge）
 * - 不在日志里写 OCR 正文 / 真实图片路径 / wxid / 群名
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  DEFAULT_IMAGE_TEXT_OCR_CONCURRENCY,
  IMAGE_TEXT_BACKFILL_TIER_ORDER,
  IMAGE_TEXT_INDEX_BATCH_SIZE,
  IMAGE_TEXT_INDEX_PROGRESS_INTERVAL_MS,
  IMAGE_TEXT_INDEX_RATE_MIN_SPAN_MS,
  IMAGE_TEXT_INDEX_RATE_WINDOW_MS,
  IMAGE_OCR_RETRIABLE_FAILURE_STATES,
  buildImageOcrArtifactKey,
  buildImageTextBackfillSegments,
  imageTextProcessedPercent,
  isTerminalImageOcrState,
  resolveImageTextOcrConcurrency,
  type ImageMessageCountProbe,
  type ImageMessageWatermark,
  type ImageOcrPersistedState,
  type ImageOcrProvenance,
  type ImageTextBackfillSegment,
  type ImageTextIndexCountResult,
  type ImageTextIndexCoverage,
  type ImageTextIndexPhase,
  type ImageTextIndexProgress,
  type ImageTextIndexRepairResult,
  type ImageTextIndexRunState,
  type ImageTextIndexStageStat,
  type ImageTextIndexStageTimings,
  type ImageTextIndexStartOptions,
  type ImageTextIndexStatus,
  type ImageTextIndexStorageStats,
  type ImageTextTierCoverage
} from '../../shared/image-text-index'
import {
  detectSystemOcrImageFormat,
  resolveSystemOcrEngine,
  type SystemOcrCapability
} from '../../shared/system-ocr'
import type * as chat from './chat-service'
/**
 * 消息 id 必须与 Knowledge 写入的 `knowledge_messages.message_id` 完全一致，
 * 否则 OCR 文本贴不到消息上、Evidence 也回不到原图。真源见 knowledge/message-identity。
 */
import { sourceMessageId } from '../knowledge/message-identity'
import type { ImageDecryptService } from '../image-decrypt-service'
import {
  ImageTextIndexStore,
  getImageTextIndexDatabasePath,
  removeImageTextIndexDatabase,
  type ConversationImageOcrEntry
} from './image-text-index-store'

/** 图片消息的数据 URL 前缀。 */
const MIME_BY_FORMAT: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  tiff: 'image/tiff'
}

export interface ImageTextIndexServiceDeps {
  /** `<userData>/image-text-index`。 */
  databaseRoot?: string
  /** 当前账号（wxid 优先，退回 accountRoot）。空串 = 微信未就绪。 */
  resolveAccountId?: () => string
  /** 当前微信数据根目录。 */
  resolveAccountRoot?: () => string
  listContacts?: () => Promise<Array<{ md5: string; m_nsUsrName: string; type: 'user' | 'group' }>>
  listMessages?: (conversationId: string) => Promise<chat.FormattedMessage[]>
  /**
   * 只取该会话的**图片消息**（推荐路径）。
   *
   * 与 `listMessages` 产出的 `FormattedMessage` 逐字段同构，差别只是"读哪些行"：
   * 由 WCDB 在 SQL 层过滤，而不是把整个会话读进来再筛。
   * 缺省时回退到 `listMessages`（测试用），但生产必须接上 —— 否则大会话会拖垮一遍 pass。
   */
  listImageMessages?: (
    conversationId: string,
    /**
     * 时间窗（`[sinceMs, beforeMs)`，半开）。不传 = 整个会话。
     *
     * recent-first 的分段计划靠它把"最近 7 天"和"更早"分开，而不是把整个会话
     * 读进来再在 JS 里筛 —— 那正是大会话跑不动的根因。
     */
    window?: { sinceMs?: number; beforeMs?: number }
  ) => Promise<chat.FormattedMessage[]>
  /**
   * 单个会话的图片消息计数（SQL 统计，不解密）。
   *
   * `count: null` = 统计失败，**不等于 0 张**；调用方必须区分。
   */
  countConversationImages?: (
    conversationId: string,
    range?: number | { sinceMs?: number; beforeMs?: number }
  ) => Promise<ImageMessageCountProbe>
  /**
   * 单个会话的图片消息增量水位（条数 + 最大插入序），SQL 聚合，不解密。
   *
   * 返回 null = 当前数据库不支持（调用方必须退化成"每轮重扫"，宁可慢也不可漏）。
   */
  imageWatermark?: (
    conversationId: string,
    range?: number | { sinceMs?: number; beforeMs?: number }
  ) => Promise<ImageMessageWatermark | null>
  decryptService?: () => ImageDecryptService | null
  /** 本地 OCR。 */
  recognize?: (imageDataUrl: string) => Promise<{
    success: boolean
    text: string
    language: string | null
    errorCode?: string
  }>
  capability?: () => Promise<SystemOcrCapability>
  /**
   * OCR 并发度。不传则用 `DEFAULT_IMAGE_TEXT_OCR_CONCURRENCY`，
   * 并由 `resolveImageTextOcrConcurrency` 收敛到合法区间。
   */
  ocrConcurrency?: number
  /**
   * 低频性能画像回调（生产注入 `appLogger.write`），供排查后台回填的耗时分布。
   *
   * 只写性能数字，不含图片内容 / 路径 / 会话标识。
   */
  logStageProfile?: (profile: ImageTextIndexStageTimings) => void
  /** 会话图片全部处理完后回调，用于把 OCR 文本灌进 Knowledge 索引。 */
  onConversationIndexed?: (conversationId: string) => Promise<void>
  /** 交互查询让路钩子。 */
  interactiveIdle?: () => Promise<void>
  /**
   * 正常运行态下向 Renderer 推送进度的最小间隔（默认 5000ms）。
   *
   * 只影响**通知节流**，不影响 batch / checkpoint / OCR 并发 —— 后台照常按 batch 推进。
   * 测试可以调小它，避免为了验证节流去等 5 秒。
   */
  progressNotifyIntervalMs?: number
  /**
   * 单个 await 步骤超过这么久就写一条 `slow step=…` warn（默认 5000ms）。
   * 测试可以调小它，避免为了验证超时告警真的等 5 秒。
   */
  slowStepWarnMs?: number
  /**
   * 距上次画像超过这么久且处理量有推进 → 也写一条（默认 30000ms）。
   * 测试可以调小它。
   */
  stageProfileMaxIdleMs?: number
  now?: () => number
}

function sha256Short(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}

const round1 = (value: number): number => Math.round(value * 10) / 10

/** 每处理这么多张图片写一条性能画像日志（低频：只够看趋势，不刷日志）。 */
const STAGE_PROFILE_EVERY_IMAGES = 500

/**
 * 距上次画像超过这么久且处理量有推进 → 也写一条（时间兜底）。
 *
 * 存在的意义：吞吐掉到个位数时，按 500 张触发要等十几分钟才出一条画像，
 * 而那正是最需要画像的时刻。30 秒仍然远低于"每批 12 张"的推送频率。
 */
const STAGE_PROFILE_MAX_IDLE_MS = 30_000

/**
 * 单个 await 步骤超过这么久就写一条 warn，指明"卡在哪一步"。
 *
 * 为什么需要：会话级等待（尤其是等 Knowledge 重建）没有上界，
 * 实测出现过**一次运行 81 分钟零落库**的情况。没有这条日志时，
 * 只能看到"没有进度"，无法区分"慢"和"被别的模块按住"。
 */
const SLOW_STEP_WARN_MS = 5_000

/** 会阻塞流水线、且可能有外部依赖的步骤名（只用于日志，不参与逻辑）。 */
type ImageTextIndexStep = 'conversation-setup' | 'list-image-messages' | 'knowledge-index'

/**
 * 有界样本的耗时聚合。
 *
 * 只保留最近 `capacity` 个样本：够算 p50/p95，又不会因为图片总量很大把内存撑起来。
 * `count` 是**累计**记录次数；mean / p50 / p95 取自保留窗口（同质负载下两者一致）。
 */
class StageStatAccumulator {
  private readonly samples: number[] = []
  private cursor = 0
  private count = 0
  private max = 0

  constructor(private readonly capacity = 1000) {}

  record(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return
    this.count += 1
    if (durationMs > this.max) this.max = durationMs
    if (this.samples.length < this.capacity) this.samples.push(durationMs)
    else {
      this.samples[this.cursor] = durationMs
      this.cursor = (this.cursor + 1) % this.capacity
    }
  }

  reset(): void {
    this.samples.length = 0
    this.cursor = 0
    this.count = 0
    this.max = 0
  }

  snapshot(): ImageTextIndexStageStat {
    if (this.count === 0 || this.samples.length === 0) {
      return { count: this.count, mean: 0, p50: 0, p95: 0, max: 0 }
    }
    const sorted = [...this.samples].sort((a, b) => a - b)
    const at = (quantile: number): number =>
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))]
    const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length
    return {
      count: this.count,
      mean: round1(mean),
      p50: round1(at(0.5)),
      p95: round1(at(0.95)),
      max: round1(this.max)
    }
  }
}

/** OCR 结果（不含身份信息，身份由 prepare 负责）。 */
interface OcrOutcome {
  state: ImageOcrPersistedState
  text: string
  errorCode?: string
}

/**
 * prepare 阶段的产物。
 *
 * prepare 是**同步**的（locate + decrypt 都占主线程），所以它必须尽快返回：
 * 要么直接短路成终态，要么把可并发的 OCR 任务交出去。
 */
type PreparedImage =
  /** 无需 OCR：已短路成终态（解密服务缺失 / 元数据缺失 / 图片不存在 / 命中已有 artifact）。 */
  | {
      kind: 'short-circuit'
      state: ImageOcrPersistedState
      text: string
      imageIdentity: string | null
    }
  /** 需要 OCR。 */
  | {
      kind: 'ocr'
      imageIdentity: string
      artifactKey: string
      dataUrl: string
    }

/** 一张图片进入终态后的结算输入。**单 writer**：写 artifact + binding 都走这里。 */
interface SettleInput {
  message: chat.FormattedMessage
  conversationId: string
  provenance: ImageOcrProvenance
  messageId: string
  state: ImageOcrPersistedState
  text: string
  imageIdentity: string | null
  artifactKey: string | null
  errorCode?: string
  /** 是否需要把 artifact 落库（短路成终态、命中已有 artifact 时都不需要）。 */
  writeArtifact: boolean
}

/** 图片消息判定：与 chat-service 的 `contentData.type === 'image'` 对齐。 */
export function isImageMessage(message: chat.FormattedMessage): boolean {
  return message.contentData?.type === 'image'
}

export class ImageTextIndexService {
  private deps: ImageTextIndexServiceDeps = {}
  private store: ImageTextIndexStore | null = null
  private storeAccountId = ''
  private accountKey = ''
  private running = false
  private cancelRequested = false
  private pauseRequested = false
  private passPromise: Promise<void> | null = null
  private counting = false
  private listeners = new Set<(status: ImageTextIndexStatus) => void>()
  private lastError: string | undefined
  /**
   * 当前阶段（recent-first 可见性）。
   *
   * 它**不参与进度计算**：总进度永远是 `processed / totalImageMessages`。
   */
  private currentPhase: ImageTextIndexPhase = 'complete'
  /** 本遍 pass 的起点，用于 `preLoop.startupMs`。 */
  private passStartedAt = 0
  private startedAt: number | undefined
  /** 上一次清理实际重建（失效）了多少个会话的 Knowledge 索引；用于诊断与测试。 */
  lastInvalidatedConversations = 0
  /**
   * 会话级 OCR 文本缓存。
   *
   * Knowledge 重建一个会话时会对每条消息问一次 resolver；不加缓存就是每条消息一次 SQL。
   * 写入 binding 时精确失效该会话，保证不会读到旧结果。
   */
  private conversationOcrCache = new Map<string, Map<string, ConversationImageOcrEntry>>()

  /** 本次 pass 的计数器（内存态；真实来源始终是派生库）。 */
  private counters = {
    totalImageMessages: 0,
    processedThisPass: 0,
    indexed: 0,
    empty: 0,
    missing: 0,
    failed: 0
  }

  /**
   * 各阶段的耗时画像。常驻开启：单次 record 只是几个数字的加减。
   * 重置时机 = 每次 pass 开始。
   */
  private readonly stageStats = {
    locate: new StageStatAccumulator(),
    decrypt: new StageStatAccumulator(),
    normalize: new StageStatAccumulator(),
    ocr: new StageStatAccumulator(),
    persist: new StageStatAccumulator()
  }

  /**
   * 流水线之外的成本（见 `ImageTextIndexPreLoopCost`）。
   *
   * 这一组数字存在的唯一目的：当 `perImageMs` 很漂亮、墙钟吞吐却很差时，
   * 能立刻指出"时间漏在哪个桶里"，而不是回头重新埋点。
   */
  private readonly preLoop = {
    /** 一遍 pass 开始前的一次性成本（能力探测 + 全账号图片统计 + 会话列表）。 */
    startupMs: 0,
    /** `countImageMessages`（遍历全部会话的 SQL 统计）。 */
    countImageMessagesMs: 0,
    /** 每个会话进入流水线前的准备累计（水位 / 计数 / listMessages）。 */
    conversationSetupMs: 0,
    /** `listMessages` 累计（读取并格式化会话消息）。 */
    listMessagesMs: 0,
    /** 会话完成后等待 Knowledge 重建的累计。 */
    onConversationIndexedMs: 0
  }
  /** 图片流水线本身的跨度（每个 batch 从开始到让出结束的累计），用于算单张净耗时。 */
  private batchLoopMs = 0
  /**
   * 本次 pass 真正结算过的图片数。
   *
   * `batchLoopMs` 每次 pass 都归零，所以单张净耗时的分母也必须是**本 pass** 的计数。
   * `counters.processedThisPass` 只在账号切换时归零，跨 pass 会一直累加 ——
   * 拿它当分母会把 26 秒/张摊成 5 毫秒/张，让画像彻底失去诊断价值。
   */
  private settledThisPass = 0
  /** 本次统计窗口内实际执行过的 OCR 次数（命中复用 / 跳过的不计）。 */
  private ocrExecutions = 0
  /** 上一次写性能画像日志时的累计处理量。 */
  private lastProfileLoggedAt = 0
  /** 上一次写性能画像日志的墙钟时刻（时间兜底用，见 `maybeLogStageProfile`）。 */
  private lastProfileLoggedAtWallClock = 0
  /** 当前生效的 OCR 并发度。 */
  private activeOcrConcurrency = DEFAULT_IMAGE_TEXT_OCR_CONCURRENCY
  /**
   * 当前会话是否产生了会改变 Knowledge 可搜索内容的变化（见 `settle()` 里的判定）。
   *
   * 一个会话处理完就把**整会话**交给 Knowledge 重建，代价是那边要把整个会话的消息
   * 读出来重分片。而绝大多数会话里，被识别的图片要么没有文字、要么图片文件已被清理 ——
   * 那些结果根本不改变可搜索内容，重建纯属白做。这个标志就是用来把这类会话摘掉的。
   */
  private knowledgeDirty = false
  /** 本遍因"没有可搜索内容变化"而跳过的 Knowledge 重建次数（诊断用）。 */
  private knowledgeIndexSkippedConversations = 0
  /**
   * 同一 artifact key 的在途 OCR。
   *
   * 并发调度下，同一批里两张相同内容的图片会在**任何一个**落地之前就被派发；
   * 没有这层去重就会把同一张图识别两次（既浪费又违反"最多识别一次"的契约）。
   */
  private inFlightOcr = new Map<string, Promise<OcrOutcome>>()

  private runState: ImageTextIndexRunState = 'idle'

  /**
   * 进度通知节流状态。
   *
   * 后台按 batch（12 张）推进，但 UI **不该感知 batch 大小** —— 每批都推会让计数以
   * 「+12」的粒度跳动。这里只节流"通知"这一层：正常运行态最多每
   * `IMAGE_TEXT_INDEX_PROGRESS_INTERVAL_MS` 推一次最新权威快照；
   * 状态变化（开始/暂停/继续/取消/失败/完成/清理）一律立即推。
   */
  private lastNotifyAt = 0
  private lastNotifiedState: ImageTextIndexRunState | null = null
  private notifyTimer: ReturnType<typeof setTimeout> | null = null
  /** 速度采样环。 */
  private rateSamples: Array<{ at: number; processed: number }> = []

  bind(deps: ImageTextIndexServiceDeps): void {
    this.deps = { ...this.deps, ...deps }
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  // ------------------------------------------------------------- store 生命周期

  private resolveAccountId(): string {
    return this.deps.resolveAccountId?.() || ''
  }

  /**
   * 获取当前账号的派生库句柄。
   *
   * 账号身份解析结果会缓存：`resolveAccountId()` 不是廉价 getter，不要放进热路径。
   * 缓存由 `resetAccount()` 统一失效；解析失败（空结果）不缓存。
   */
  private ensureStore(): ImageTextIndexStore | null {
    const root = this.deps.databaseRoot
    if (!root) return null
    if (this.store) return this.store
    const accountId = this.resolveAccountId()
    if (!accountId) return null
    const key = getImageTextIndexDatabasePath(root, accountId)
    this.store = new ImageTextIndexStore(key, accountId)
    this.storeAccountId = accountId
    this.accountKey = key
    return this.store
  }

  /**
   * 账号切换 / 数据库切换时丢弃句柄。
   *
   * 派生库按 accountId 分目录，句柄必须跟着换；否则会把 A 账号的 OCR
   * 写到 B 账号，或让新库读到旧账号的 coverage。
   *
   * **这是账号身份缓存的唯一失效信号**，新增切换路径必须调用它。
   */
  resetAccount(): void {
    this.conversationOcrCache.clear()
    this.store?.close()
    this.store = null
    this.storeAccountId = ''
    this.accountKey = ''
    this.counters = {
      totalImageMessages: 0,
      processedThisPass: 0,
      indexed: 0,
      empty: 0,
      missing: 0,
      failed: 0
    }
    this.runState = 'idle'
    this.cancelRequested = false
    this.pauseRequested = false
    this.lastError = undefined
    this.resetStageStats()
    this.resetProgressNotifications()
  }

  /** 重置通知节流与速度采样（换账号 / 清库 / pass 开始时都要清干净）。 */
  private resetProgressNotifications(): void {
    this.clearNotifyTimer()
    this.lastNotifyAt = 0
    this.lastNotifiedState = null
    this.rateSamples = []
  }

  /** 重置耗时画像与 OCR 计数（每次 pass 重新开始统计）。 */
  private resetStageStats(): void {
    for (const stat of Object.values(this.stageStats)) stat.reset()
    for (const key of Object.keys(this.preLoop) as Array<keyof typeof this.preLoop>) {
      this.preLoop[key] = 0
    }
    this.batchLoopMs = 0
    this.settledThisPass = 0
    this.ocrExecutions = 0
    this.inFlightOcr.clear()
    this.lastProfileLoggedAt = 0
    this.lastProfileLoggedAtWallClock = this.now()
    this.knowledgeIndexSkippedConversations = 0
  }

  /**
   * 跑一个可能很慢、且依赖外部模块的 await 步骤；超时就写一条 warn。
   *
   * 这是**唯一**能把"卡在哪一步"直接说出来的手段：没有它，
   * 长时间零落库只能看到"没有进度"，无法区分是自己慢还是被别人按住。
   * 只输出步骤名与耗时，没有任何会话标识 / 内容。
   */
  private async runStep<T>(step: ImageTextIndexStep, run: () => Promise<T>): Promise<T> {
    const startedAt = this.now()
    try {
      return await run()
    } finally {
      const elapsed = this.now() - startedAt
      if (elapsed >= (this.deps.slowStepWarnMs ?? SLOW_STEP_WARN_MS)) {
        // 用插值而不是 %s 占位符：日志要能被当作**单个字符串** grep，
        // 否则 `grep 'slow step=knowledge-index'` 永远搜不到。
        console.warn(`[ImageTextIndex] slow step=${step} elapsedMs=${Math.round(elapsed)}`)
      }
    }
  }

  /**
   * 按固定张数间隔把分阶段画像写进 app log。
   *
   * 触发条件是"处理量跨过下一个间隔"**或**"距上次已过 `STAGE_PROFILE_MAX_IDLE_MS`"。
   *
   * 为什么必须加时间兜底：只按处理量触发时，一旦吞吐掉到个位数，画像要等十几分钟才出一条 ——
   * 而"吞吐掉下来"恰恰是最需要画像的时刻。拿埋点自身的节拍去要求排查者等待，是循环论证。
   */
  private maybeLogStageProfile(): void {
    if (!this.deps.logStageProfile) return
    const processed = this.counters.processedThisPass
    if (processed === 0) return
    const byCount = processed - this.lastProfileLoggedAt >= STAGE_PROFILE_EVERY_IMAGES
    const byTime =
      processed > this.lastProfileLoggedAt &&
      this.now() - this.lastProfileLoggedAtWallClock >=
        (this.deps.stageProfileMaxIdleMs ?? STAGE_PROFILE_MAX_IDLE_MS)
    if (!byCount && !byTime) return
    this.lastProfileLoggedAt = processed
    this.lastProfileLoggedAtWallClock = this.now()
    this.deps.logStageProfile(this.buildStageTimings())
  }

  /** 各阶段耗时画像（只含性能数字）。 */
  buildStageTimings(): ImageTextIndexStageTimings {
    const processed = this.counters.processedThisPass
    return {
      counters: {
        processed,
        indexed: this.counters.indexed,
        empty: this.counters.empty,
        missing: this.counters.missing,
        failed: this.counters.failed
      },
      // 日志里给一个速度：大会话回填时"还剩多久"和"是否卡住"全靠它判断。
      ratePerSec: this.peekRate(processed, this.counters.totalImageMessages).speedPerSec,
      ocrExecutions: this.ocrExecutions,
      ocrConcurrency: this.activeOcrConcurrency,
      locate: this.stageStats.locate.snapshot(),
      decrypt: this.stageStats.decrypt.snapshot(),
      normalize: this.stageStats.normalize.snapshot(),
      ocr: this.stageStats.ocr.snapshot(),
      persist: this.stageStats.persist.snapshot(),
      perImageMs: round1(this.batchLoopMs / Math.max(1, this.settledThisPass)),
      knowledgeIndexSkipped: this.knowledgeIndexSkippedConversations,
      preLoop: { ...this.preLoop }
    }
  }

  // ------------------------------------------------------------------- 只读接口

  /** Knowledge 索引时用：把某会话的 OCR 文本贴到消息上（与语音 resolver 同构）。 */
  getConversationOcr(conversationId: string): Map<string, ConversationImageOcrEntry> {
    const cached = this.conversationOcrCache.get(conversationId)
    if (cached) return cached
    const store = this.ensureStore()
    if (!store) return new Map()
    const result = store.getConversationOcr(conversationId)
    this.conversationOcrCache.set(conversationId, result)
    return result
  }

  /**
   * 覆盖度。
   *
   * **分母只能来自落盘的 SQL 统计**，不能从派生库自己推：派生库只知道自己处理过什么。
   * 如果按 `processed + pending` 反推 total，应用重启后 pending 无处可来，
   * total 就会退化成 processed —— 30% 的部分索引会被谎报成"已覆盖全部"。
   * 这正是"把 partial coverage 当 complete"要避免的。
   */
  private coverageFromCounts(counts: Record<string, number>): ImageTextIndexCoverage {
    const indexed = counts['indexed'] ?? 0
    const empty = counts['empty'] ?? 0
    const missing = (counts['image_missing'] ?? 0) + (counts['metadata_missing'] ?? 0)
    const failed =
      (counts['decrypt_failed'] ?? 0) +
      (counts['decode_failed'] ?? 0) +
      (counts['ocr_failed'] ?? 0) +
      (counts['cancelled'] ?? 0)
    const runtimeUnavailable = counts['decrypt_unavailable'] ?? 0
    // 运行时不可用**不计入 processed**：它不是"这条图片已经处理过了"。
    const settled = indexed + empty + missing + failed
    const counted = this.store?.readCountedTotal() ?? null
    /**
     * 进度用「流水线**真实走过**的集合」，而不是 `countImageMessages()` 的预估值。
     *
     * 两者会差最后几个百分点：预估值是遍历消息表数出来的，而流水线拿到的其实是
     * 「消息表 + 召回归档」合并去重后的集合，两者对同一条消息的判定并不总是一致。
     * 拿预估值当分母，一个**已经跑完**的索引会永远显示成"部分完成"，
     * ETA 也会被算成几十小时。
     */
    const scan = this.store?.readScanProgress() ?? null
    const useScan = (scan?.total ?? 0) > 0 && (scan?.processed ?? 0) > 0
    const processed = useScan ? (scan?.processed as number) : settled
    const total = useScan
      ? (scan?.total as number)
      : this.counters.totalImageMessages || counted?.total || settled + runtimeUnavailable
    /**
     * 系统性失败：处理过一批，但一条都没能给出确定结果
     * （整条流水线的前置依赖没接上时就是这个形态）。
     * 它必须阻断 `complete` —— 否则 Query Agent 会拿着"覆盖完整"去回答"没有"。
     */
    const systemicFailure = processed > 0 && indexed === 0 && empty === 0 && missing === 0
    /**
     * 覆盖完整性。
     *
     * 分母取自流水线**真实走过**的集合时（`useScan`），不再要求 `counted.complete`：
     * 那个标志表达的是"`countImageMessages()` 把每个会话都数上了"，而进度现在已经
     * 不用那个分母了。继续要求它，会让一个**已经跑完**的索引因为"某个会话数不上"
     * 而永远停在"部分完成"。
     */
    const complete =
      total > 0 &&
      runtimeUnavailable === 0 &&
      !systemicFailure &&
      processed >= total &&
      (useScan || (counted !== null && counted.complete))
    return {
      totalImageMessages: total,
      processed,
      indexed,
      empty,
      missing,
      failed,
      runtimeUnavailable,
      pending: Math.max(0, total - processed - runtimeUnavailable),
      // 从未统计过总数 → 不算"已建立"：不知道分母就不允许声称覆盖。
      established: counted !== null && (processed > 0 || runtimeUnavailable > 0),
      complete,
      systemicFailure,
      countedAt: counted?.countedAt ?? null,
      // recent-first 的时间维度：让调用方能回答"这一段时间能不能下确定性结论"。
      ...this.tierCoverageSnapshot(complete)
    }
  }

  /**
   * 覆盖度快照（只读、同步），供 Query Agent 在工具结果里携带图片覆盖度。
   *
   * 刻意**不建库**：只因为用户问了一句话就凭空创建一个派生库是没道理的。
   * 库不存在 = 从未建立过索引 = `not_built`。
   */
  getCoverageSnapshot(): ImageTextIndexCoverage | null {
    const root = this.deps.databaseRoot
    const accountId = this.resolveAccountId()
    if (!root || !accountId) return null
    if (!this.store && !existsSync(getImageTextIndexDatabasePath(root, accountId))) {
      return null
    }
    const store = this.ensureStore()
    if (!store) return null
    return this.coverageFromCounts(store.countByState())
  }

  private progressFromCounts(counts: Record<string, number>): ImageTextIndexProgress {
    const coverage = this.coverageFromCounts(counts)
    const total = coverage.totalImageMessages
    const percent = imageTextProcessedPercent(coverage.processed, total)
    return {
      state: this.runState,
      totalImageMessages: total,
      processed: coverage.processed,
      indexed: coverage.indexed,
      empty: coverage.empty,
      missing: coverage.missing,
      failed: coverage.failed,
      runtimeUnavailable: coverage.runtimeUnavailable,
      systemicFailure: coverage.systemicFailure,
      pending: coverage.pending,
      percent,
      processedPercent: percent,
      ...(this.startedAt ? { startedAt: this.startedAt } : {}),
      updatedAt: this.now(),
      cancellable: this.running,
      paused: this.runState === 'paused',
      ...this.rateSnapshot(coverage.processed, total),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      // 阶段提示只在"真的在做这件事"时给：运行/暂停时报当前分段；整体完成时报完成。
      // 其余情况（idle / cancelled 且未完成）不给 —— 宁可不说，也不给一句过期的阶段。
      ...(this.running || this.runState === 'paused'
        ? { currentPhase: this.currentPhase }
        : coverage.complete
          ? { currentPhase: 'complete' as ImageTextIndexPhase }
          : {})
    }
  }

  private emptyStorage(): ImageTextIndexStorageStats {
    return { indexedImages: 0, ocrTextCount: 0, totalBytes: 0, updatedAt: null }
  }

  async getStatus(): Promise<ImageTextIndexStatus> {
    const store = this.ensureStore()
    if (!store) {
      return {
        progress: {
          state: this.runState,
          totalImageMessages: this.counters.totalImageMessages,
          processed: 0,
          indexed: 0,
          empty: 0,
          missing: 0,
          failed: 0,
          runtimeUnavailable: 0,
          systemicFailure: false,
          pending: 0,
          percent: 0,
          processedPercent: 0,
          updatedAt: this.now(),
          cancellable: false,
          paused: false
        },
        coverage: {
          totalImageMessages: 0,
          processed: 0,
          indexed: 0,
          empty: 0,
          missing: 0,
          failed: 0,
          runtimeUnavailable: 0,
          pending: 0,
          established: false,
          complete: false,
          systemicFailure: false,
          countedAt: null,
          tiers: [],
          coveredToMs: null
        },
        storage: this.emptyStorage(),
        counting: this.counting
      }
    }
    const counts = store.countByState()
    return {
      progress: this.progressFromCounts(counts),
      coverage: this.coverageFromCounts(counts),
      storage: store.storageStats(),
      counting: this.counting,
      stageTimings: this.buildStageTimings()
    }
  }

  onStatusChange(listener: (status: ImageTextIndexStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 取消待发的尾随通知。生命周期结束时必须调用，避免残留 timer。 */
  private clearNotifyTimer(): void {
    if (this.notifyTimer === null) return
    clearTimeout(this.notifyTimer)
    this.notifyTimer = null
  }

  private get notifyIntervalMs(): number {
    const configured = this.deps.progressNotifyIntervalMs
    return typeof configured === 'number' && configured >= 0
      ? configured
      : IMAGE_TEXT_INDEX_PROGRESS_INTERVAL_MS
  }

  /** 立刻把**最新权威快照**推给监听者。 */
  private notify(status: ImageTextIndexStatus): void {
    this.lastNotifyAt = this.now()
    this.lastNotifiedState = status.progress.state
    this.clearNotifyTimer()
    for (const listener of this.listeners) {
      try {
        listener(status)
      } catch {
        // 监听器异常不得影响索引。
      }
    }
  }

  /**
   * 通知入口（节流）。
   *
   * 规则：**状态变化立即推**；同一状态下的进度最多每 `notifyIntervalMs` 推一次，
   * 没到窗口就安排一次尾随推送（保证 UI 最终看到最新值，且**不阻塞后台**）。
   * 快照始终取自 `getStatus()`，所以推出去的永远是当前权威状态，
   * 不是"把窗口内几十个 delta 重放给 Renderer"。
   */
  private async emit(): Promise<void> {
    if (!this.listeners.size) return
    /**
     * 先判"要不要推"，再决定"要不要查"。
     *
     * `getStatus()` 要跑几条聚合查询（随派生库增长而变贵），而 batch 循环每
     * `BATCH_SIZE` 张就调一次 `emit()`。重扫一个"绝大多数图片已有终态"的会话时，
     * 一个会话能产生上千个 batch：每个 batch 都白查一次库，会把整条流水线按住 ——
     * 表现为"进度不动、速度掉到 0.1 张/秒"。
     *
     * `progress.state` 就是 `runState`，所以这里可以先用本地状态判断，
     * 只有"状态变了"或"到了通知窗口"才真正去查。
     */
    const stateChanged = this.runState !== this.lastNotifiedState
    if (!stateChanged && this.now() - this.lastNotifyAt < this.notifyIntervalMs) {
      /*
       * 只在**任务仍在推进**时安排尾随推送。
       *
       * 少了这一行会掉进一个自续的定时器链：终态之后 `emit()` 既不是状态变化、
       * 又没到窗口，于是又排一个 timer；timer 触发再来一次…… 通知会一直空转下去
       * （测试里表现为"pass 结束后又多出一次通知"）。
       */
      if (this.runState !== 'running') return
      if (this.notifyTimer !== null) return
      const wait = Math.max(0, this.notifyIntervalMs - (this.now() - this.lastNotifyAt))
      this.notifyTimer = setTimeout(() => {
        this.notifyTimer = null
        void this.emit()
      }, wait)
      return
    }
    this.notify(await this.getStatus())
  }

  /** 记录一个速度采样点（只在处理量前进时调用）。 */
  private sampleRate(processed: number): void {
    const at = this.now()
    const last = this.rateSamples[this.rateSamples.length - 1]
    if (last && last.processed === processed) return
    this.rateSamples.push({ at, processed })
    const cutoff = at - IMAGE_TEXT_INDEX_RATE_WINDOW_MS
    while (this.rateSamples.length > 2 && this.rateSamples[0].at < cutoff) this.rateSamples.shift()
  }

  /**
   * 最近窗口的实测速度与剩余时间。
   *
   * 用窗口而不是全程平均：全量回填跑几小时，历史平均会把"现在快不快"糊掉。
   * 跨度不足 / 分母不可信时返回 null，让 UI 显示"计算中"而不是编一个数。
   */
  private rateSnapshot(
    processed: number,
    total: number
  ): {
    speedPerSec: number | null
    etaMs: number | null
  } {
    this.sampleRate(processed)
    return this.peekRate(processed, total)
  }

  /**
   * 只读地算一次速度，**不推入采样点**。
   *
   * 给性能画像日志用：`buildStageTimings()` 会被每次 `getStatus()` 调用，
   * 若顺手采样就会把采样环刷成"状态查询频率"，速度数字随之失真。
   */
  private peekRate(
    processed: number,
    total: number
  ): {
    speedPerSec: number | null
    etaMs: number | null
  } {
    if (this.rateSamples.length < 2) return { speedPerSec: null, etaMs: null }
    const first = this.rateSamples[0]
    const last = this.rateSamples[this.rateSamples.length - 1]
    const spanMs = last.at - first.at
    const delta = last.processed - first.processed
    if (spanMs < IMAGE_TEXT_INDEX_RATE_MIN_SPAN_MS || delta <= 0) {
      return { speedPerSec: null, etaMs: null }
    }
    const speedPerSec = Math.round((delta / (spanMs / 1000)) * 10) / 10
    // 分母不可信（没有落盘总数）时不估 ETA —— 宁可说"计算中"，也不要给假数字。
    const remaining = total > 0 ? total - processed : 0
    const etaMs =
      speedPerSec > 0 && remaining > 0 ? Math.round((remaining / speedPerSec) * 1000) : null
    return { speedPerSec, etaMs }
  }

  // --------------------------------------------------------------------- 统计

  /**
   * 快速统计当前账号的图片消息数。
   *
   * 走 SQL COUNT（`local_type & 65535 = 3`），**不解密任何图片** —— 这是
   * 「点击索引前先告诉用户有多少张」能够足够快的前提。
   */
  async countImageMessages(sinceMs?: number): Promise<ImageTextIndexCountResult> {
    const startedAt = this.now()
    const contacts = await (this.deps.listContacts?.() ?? Promise.resolve([]))
    let total = 0
    let scanned = 0
    let failed = 0
    let typeColumn: string | null = null
    let firstError: string | undefined
    for (const contact of contacts) {
      const probe = await (this.deps.countConversationImages?.(contact.md5, sinceMs) ??
        Promise.resolve<ImageMessageCountProbe>({
          count: null,
          typeColumn: null,
          error: '未接入图片消息统计能力'
        }))
      if (probe.typeColumn && !typeColumn) typeColumn = probe.typeColumn
      if (probe.count === null) {
        // **统计失败不是 0 张**：必须单独计数，否则 UI 会把"数不出来"说成"没有图片"。
        failed += 1
        if (!firstError) firstError = probe.error
        continue
      }
      scanned += 1
      total += probe.count
    }
    this.counters.totalImageMessages = total
    // 落盘：coverage 的分母必须能被重启后读到（见 coverageFromCounts）。
    // 只要有一个会话没数上，分母就是偏小的 → 标记为不完整，coverage 拿不到 complete。
    this.ensureStore()?.writeCountedTotal({
      total,
      countedAt: this.now(),
      complete: contacts.length > 0 && failed === 0
    })
    return {
      totalImageMessages: total,
      scannedConversations: scanned,
      failedConversations: failed,
      typeColumn,
      ...(firstError ? { error: firstError } : {}),
      durationMs: this.now() - startedAt
    }
  }

  // ------------------------------------------------------------------ 单张处理

  /**
   * prepare：locate → decrypt → 身份计算 → artifact 命中判断。
   *
   * **同步**执行（locate / decrypt 都是阻塞调用，只能占主线程），所以这里刻意不做 OCR：
   * 把 OCR 交出去之后主线程才能立刻去 prepare 下一张，让同步段与异步 OCR 重叠 ——
   * 这是吞吐提升的真正来源，而不是把 SQLite 也并发化。
   */
  private prepareImage(
    message: chat.FormattedMessage,
    conversationId: string,
    provenance: ImageOcrProvenance
  ): PreparedImage {
    const imageContent =
      message.contentData?.type === 'image'
        ? (message.contentData as { md5?: string; datName?: string })
        : undefined

    const decrypt = this.deps.decryptService?.() ?? null
    /**
     * 解密服务缺失是**运行时**问题，不是这张图片的问题。
     *
     * 必须用独立状态，绝不能与真正的解密失败混为一谈 —— 否则派生库里会堆满
     * `decrypt_failed`，数字看着像"图片坏了"，coverage 还会显示"都处理完了"。
     */
    if (!decrypt) {
      return { kind: 'short-circuit', state: 'decrypt_unavailable', text: '', imageIdentity: null }
    }

    // 图片消息缺少定位字段：连"去哪找文件"都不知道，属消息侧缺失而非 OCR 失败。
    if (!imageContent?.md5 && !imageContent?.datName) {
      return { kind: 'short-circuit', state: 'metadata_missing', text: '', imageIdentity: null }
    }

    const locateStartedAt = this.now()
    let datPath: string | null = null
    try {
      datPath = decrypt.findImageFile(imageContent?.md5, imageContent?.datName, {
        accountDir: this.deps.resolveAccountRoot?.() || undefined,
        sessionMd5: conversationId,
        createTime: message.createTime,
        allowThumbnail: true,
        preferThumbnail: true
      })
    } catch {
      datPath = null
    }
    this.stageStats.locate.record(this.now() - locateStartedAt)
    // 微信清理过原图与缩略图 —— 这是正常情况，不是任务级错误。
    if (!datPath) {
      return { kind: 'short-circuit', state: 'image_missing', text: '', imageIdentity: null }
    }

    const decryptStartedAt = this.now()
    let bytes: Buffer | null = null
    try {
      bytes = decrypt.decryptImage(datPath)
    } catch {
      bytes = null
    }
    this.stageStats.decrypt.record(this.now() - decryptStartedAt)
    if (!bytes || bytes.length === 0) {
      return { kind: 'short-circuit', state: 'decrypt_failed', text: '', imageIdentity: null }
    }

    const imageIdentity = `sha256:${sha256Short(bytes)}`
    const format = detectSystemOcrImageFormat(bytes)
    // 解密"没抛错"但产出不是图片 → 解码失败，不是 OCR 失败。
    if (!format) {
      return { kind: 'short-circuit', state: 'decode_failed', text: '', imageIdentity }
    }

    const store = this.ensureStore()
    const artifactKey = buildImageOcrArtifactKey({ imageIdentity, provenance })

    // 同一张图（可能被转发到多个会话）已经算过 → 直接复用，绝不重复 OCR。
    const cached = store?.getArtifact(artifactKey) ?? null
    if (cached && isTerminalImageOcrState(cached.state)) {
      return { kind: 'short-circuit', state: cached.state, text: cached.text, imageIdentity }
    }

    // normalize：构造交给引擎的输入。macOS 的引擎直接吃原始字节，但现有 recognize
    // 契约收的是 data URL，所以这里仍要 base64 编一次 —— 它有成本，单独计时。
    const normalizeStartedAt = this.now()
    const mime = MIME_BY_FORMAT[format] ?? 'image/png'
    const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`
    this.stageStats.normalize.record(this.now() - normalizeStartedAt)

    return { kind: 'ocr', imageIdentity, artifactKey, dataUrl }
  }

  /** 真正的 OCR 调用（异步，跑在 libuv worker pool 上）。只归类结果，不碰数据库。 */
  private async executeOcr(dataUrl: string): Promise<OcrOutcome> {
    try {
      const result = await (this.deps.recognize?.(dataUrl) ??
        Promise.resolve({ success: false, text: '', language: null, errorCode: 'OCR_FAILED' }))
      if (result.success && result.text.trim()) return { state: 'indexed', text: result.text }
      // 表情包 / 风景 / 头像 —— 没有文字是**正常终态**，不重试。
      if (result.success || result.errorCode === 'OCR_EMPTY_RESULT') {
        return { state: 'empty', text: '' }
      }
      return {
        state: 'ocr_failed',
        text: '',
        ...(result.errorCode ? { errorCode: result.errorCode } : {})
      }
    } catch {
      return { state: 'ocr_failed', text: '' }
    }
  }

  /**
   * 按 artifact key 复用在途 OCR。
   *
   * 并发调度下，同一批里内容相同的两张图片会在**任何一个**落地之前就被派发出去；
   * 让它们共享同一个 promise 才能保证「同一张图最多识别一次」。
   */
  private runOcr(artifactKey: string, dataUrl: string): Promise<OcrOutcome> {
    const existing = this.inFlightOcr.get(artifactKey)
    if (existing) return existing

    const startedAt = this.now()
    const task = this.executeOcr(dataUrl).then((outcome) => {
      this.ocrExecutions += 1
      this.stageStats.ocr.record(this.now() - startedAt)
      return outcome
    })
    this.inFlightOcr.set(artifactKey, task)
    void task.then(
      () => {
        if (this.inFlightOcr.get(artifactKey) === task) this.inFlightOcr.delete(artifactKey)
      },
      () => {
        if (this.inFlightOcr.get(artifactKey) === task) this.inFlightOcr.delete(artifactKey)
      }
    )
    return task
  }

  /**
   * 结算一张图片：写 artifact（可选）+ binding，并推进计数器。
   *
   * **单 writer**：只在这里写库，且只在图片确实进入终态之后调用 ——
   * 所以 `processed` 永远等于"真正有终态结果的图片数"，绝不会把"已派发"算进去。
   */
  private settle(input: SettleInput): void {
    const store = this.ensureStore()
    const startedAt = this.now()
    const timestamp = this.now()

    if (input.writeArtifact && store && input.imageIdentity && input.artifactKey) {
      store.putArtifact({
        accountId: this.storeAccountId,
        artifactKey: input.artifactKey,
        imageIdentity: input.imageIdentity,
        state: input.state,
        text: input.text,
        charCount: input.text.length,
        engine: input.provenance.engine,
        platform: input.provenance.platform,
        runtimeVersion: input.provenance.runtimeVersion,
        language: input.provenance.language,
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
        createdAt: timestamp,
        updatedAt: timestamp
      })
    }

    store?.putBinding({
      accountId: this.storeAccountId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      createTime: (input.message.createTime || 0) * 1000,
      ...(input.message.senderId || input.message.from
        ? { senderId: input.message.senderId || input.message.from }
        : {}),
      ...(input.message.isSender
        ? { senderName: '我' }
        : input.message.name
          ? { senderName: input.message.name }
          : {}),
      imageIdentity: input.imageIdentity ?? '',
      artifactKey:
        input.artifactKey ??
        buildImageOcrArtifactKey({
          imageIdentity: input.imageIdentity ?? 'unavailable',
          provenance: input.provenance
        }),
      state: input.state,
      updatedAt: timestamp
    })
    this.stageStats.persist.record(this.now() - startedAt)

    this.conversationOcrCache.delete(input.conversationId)
    this.counters.processedThisPass += 1
    this.settledThisPass += 1
    if (input.state === 'indexed') this.counters.indexed += 1
    else if (input.state === 'empty') this.counters.empty += 1
    else if (input.state === 'image_missing') this.counters.missing += 1
    else this.counters.failed += 1

    /**
     * 本会话是否产生了**会改变 Knowledge 可搜索内容**的变化。
     *
     * 只有"识别出文字"这一种终态会改变可搜索内容：
     * - `indexed` 且文字非空 ⇒ 派生文本是新进索引的 ⇒ 必须让 Knowledge 重建这个会话；
     * - `empty` / `image_missing` / 失败 ⇒ 本来就没有可搜索文字，索引侧无需改动。
     *
     * 为什么"本来就没有"是安全的：`fill()` 对**已知终态**的消息直接短路、根本不会走到
     * `settle()`，所以这里不可能把"原本有文字"改写成"没有文字"——那才是需要重建的情况。
     * 也就是说：凡是能进 `settle()` 的消息，在索引里都没有可搜索的派生文本。
     */
    if (input.state === 'indexed' && input.text.trim()) this.knowledgeDirty = true
  }

  /**
   * 处理一批图片。这是一台**有界流水线**，不是串行 for-await：
   *
   *   prepare（同步：locate + decrypt）  主线程，一次一张
   *   OCR（异步）                        同一时刻最多 `activeOcrConcurrency` 个在途
   *   settle（单 writer：artifact + binding）结果一产生就写，不攒批
   *
   * 提升吞吐的关键不是"把库也并发写"，而是：**主线程不会停下来等 OCR**。
   * 某个 OCR 在途时，主线程已经去 prepare 下一张了，于是同步段与异步段重叠；
   * 写入仍然严格串行，所以 checkpoint / binding / progress 的语义一点没变。
   *
   * 暂停 / 取消时**停止领取新任务**，但把在途的收尾写完 —— 算了却不落库等于白算。
   */
  private async processBatch(
    batch: chat.FormattedMessage[],
    conversationId: string,
    provenance: ImageOcrProvenance,
    ocrByMessage: Map<string, ConversationImageOcrEntry>,
    canDispatch: () => boolean,
    consumeBudget: () => void
  ): Promise<{ processed: number; interrupted: boolean }> {
    const concurrency = this.activeOcrConcurrency
    const inFlight: Array<Promise<SettleInput>> = []
    let cursor = 0
    let processed = 0

    /** 派发到槽位满 / 预算用尽 / 本批取完为止。 */
    const fill = (): void => {
      while (inFlight.length < concurrency && cursor < batch.length) {
        const message = batch[cursor]
        const messageId = sourceMessageId(message)

        // 派生库里已有终态结果 → 复用（含"无文字"/"图片缺失"），不重复劳动。
        const known = ocrByMessage.get(messageId)
        if (known && isTerminalImageOcrState(known.state)) {
          cursor += 1
          processed += 1
          continue
        }
        if (!canDispatch()) return

        cursor += 1
        consumeBudget()

        const prepared = this.prepareImage(message, conversationId, provenance)
        if (prepared.kind === 'short-circuit') {
          // 不需要 OCR 的终态：立刻结算，不占并发槽位。
          this.settle({
            message,
            conversationId,
            provenance,
            messageId,
            state: prepared.state,
            text: prepared.text,
            imageIdentity: prepared.imageIdentity,
            artifactKey: null,
            writeArtifact: false
          })
          processed += 1
          continue
        }

        inFlight.push(
          this.runOcr(prepared.artifactKey, prepared.dataUrl).then(
            (outcome): SettleInput => ({
              message,
              conversationId,
              provenance,
              messageId,
              state: outcome.state,
              text: outcome.text,
              imageIdentity: prepared.imageIdentity,
              artifactKey: prepared.artifactKey,
              ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
              writeArtifact: true
            })
          )
        )
      }
    }

    while (cursor < batch.length || inFlight.length > 0) {
      if (!this.cancelRequested && !this.pauseRequested) fill()
      if (inFlight.length === 0) break

      const settled = await Promise.race(
        inFlight.map((task, index) => task.then((value) => ({ index, value })))
      )
      inFlight.splice(settled.index, 1)
      this.settle(settled.value)
      processed += 1
    }

    return {
      processed,
      interrupted: this.cancelRequested || this.pauseRequested
    }
  }

  // --------------------------------------------------------------------- pass

  /**
   * 启动一次 pass。
   *
   * 「暂停 / 继续」刻意实现为「停止 + 重新跑一次 pass」而不是原地挂起：
   * - checkpoint（scan_state）与 artifact 缓存都在库里，重跑会跳过已完成会话、
   *   并且命中 artifact 缓存不再重复 OCR，所以恢复成本很低；
   * - 与项目既有的「中断后重跑、靠 checkpoint 续做」语义一致，不引入新的挂起状态机。
   */
  startPass(options: ImageTextIndexStartOptions = {}): {
    started: boolean
    state: ImageTextIndexRunState
  } {
    if (this.running) return { started: false, state: this.runState }
    this.cancelRequested = false
    this.pauseRequested = false
    this.lastError = undefined
    this.startedAt = this.now()
    // 并发度在 pass 开始时定一次：pass 中途变化会让耗时画像不可解释。
    this.activeOcrConcurrency = resolveImageTextOcrConcurrency(this.deps.ocrConcurrency)
    this.resetStageStats()
    // 新的一遍从零开始计时：上一次的采样会把速度算歪。
    this.resetProgressNotifications()
    this.runState = 'running'
    this.passPromise = this.runPass(options)
      .catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error)
        this.runState = 'error'
      })
      .finally(() => {
        this.running = false
        this.passPromise = null
        void this.emit()
      })
    void this.emit()
    return { started: true, state: this.runState }
  }

  /**
   * 一次索引 pass。
   *
   * recent-first 的核心：**外层是时间分段，内层才是会话**。
   *
   * 为什么不能只把会话列表按"最近活跃"排序就完事：那只保证"先把 A 群全部历史扫完"，
   * 而用户要的是"最近这几天的图片，不管在哪个群，都先能搜"。所以必须分段优先 ——
   * 先把最近 7 天在所有会话上横着扫完，再退到下一个更老的分段。
   *
   * 四条不可动摇的性质：
   * 1. **锚点固定**：backfill 的 `anchorMs` 一旦落盘就不再变，分段边界因此稳定，
   *    不会"跑几小时后 7 天窗口往前挪"。
   * 2. **新消息永远优先**：比锚点更新的图片由"增量补齐"负责，且它在每个调度点之前跑。
   * 3. **已完成的分段不重扫**；已 terminal 的 binding 永远跳过（不重复 OCR）。
   * 4. **进度不骗人**：总进度始终是 `processed / total`，分段只提供阶段文案。
   */
  private async runPass(options: ImageTextIndexStartOptions): Promise<void> {
    const store = this.ensureStore()
    if (!store) {
      this.lastError = '微信数据尚未就绪'
      this.runState = 'error'
      return
    }
    this.running = true

    // 进入图片流水线之前的一次性成本：单列出来，避免被摊进"每张图片"。
    const preLoopStartedAt = this.now()
    // `startupMs` 的参照点。逐会话逻辑被抽成独立方法之后，它必须放在实例上。
    this.passStartedAt = preLoopStartedAt
    const capability = (await this.deps.capability?.()) ?? null
    if (capability && !capability.available) {
      this.lastError = '当前系统不支持本地图片文字识别'
      this.runState = 'error'
      return
    }
    /**
     * **前置依赖自检**：解密服务必须可用。
     *
     * 没有它，每张图片都会在流水线第一步失败。原实现会把"整条流水线根本跑不起来"
     * 落成几万条 `decrypt_failed` —— 既污染派生库、又让用户以为图片坏了，
     * 还让 coverage 看起来"都处理完了"。
     *
     * 所以必须在**写任何一条记录之前**停下来：宁可一次都不跑，也不要写一堆假失败。
     */
    if (!this.deps.decryptService?.()) {
      this.lastError = '图片解密服务尚未就绪，无法读取微信图片；本次未写入任何记录。'
      this.runState = 'error'
      return
    }
    const provenance: ImageOcrProvenance = {
      // 引擎由平台决定。这条兜底只在 capability 探测失败时走：
      // 它绝不接受"某一个平台"的硬编码值。
      engine: capability?.engine ?? resolveSystemOcrEngine(process.platform),
      platform: capability?.platform ?? process.platform,
      runtimeVersion: capability?.runtimeVersion ?? null,
      language: capability?.language ?? null
    }

    // 统计一次总数（SQL），进度百分比才有真实分母。
    this.counting = true
    const countStartedAt = this.now()
    try {
      await this.countImageMessages(options.sinceMs)
    } finally {
      this.counting = false
      this.preLoop.countImageMessagesMs = this.now() - countStartedAt
    }

    let contacts = await (this.deps.listContacts?.() ?? Promise.resolve([]))
    if (options.conversationLimit && options.conversationLimit > 0) {
      contacts = contacts.slice(0, options.conversationLimit)
    }
    /**
     * `startupMs` 的取样点必须是"第一张图片进入流水线的那一刻"，不能在这里就记 ——
     * 否则会话级的准备成本会漏在外面，而那正是"单张很快、整遍很慢"的差额来源之一。
     */
    const preLoopState = { captured: false }

    const scanState = store.readScanState()
    const budget = {
      remaining: options.messageLimit && options.messageLimit > 0 ? options.messageLimit : Infinity
    }
    /**
     * 受控窗口（用于小样本验证）：只跑这一个窗口，**不写任何分段状态**，
     * 因此同一个窗口可以反复跑（checkpoint 是围绕全量集合建立的，混用会让"跳过"
     * 变得不可解释）。
     */
    const windowed = Boolean(options.sinceMs && options.sinceMs > 0)

    const plan = this.resolveBackfillPlan(store, options)

    /**
     * 升级场景：老版本可能已经把**全量**图片索引建完了。此时库里没有任何分段信息，
     * 应当直接落成"全部完成"，不重新回填 —— 用户已经拥有的东西不能被降级。
     *
     * 但**不能只看库里自称的进度**：`readScanProgress()` 记的是"上一次跑完时留下了多少"，
     * 它不知道源里后来又新增了图片。只信它就会把"库里自称已完成、源侧其实有新增"
     * 误判成"全部完成"，于是那些新增的图片永远不会被索引。
     *
     * 所以必须先向**源侧**核实：逐会话比对插入序水位，只有确实没有新内容时才算数。
     * 这次核实本身就是增量补齐（水位没涨的会话一条 SQL 就跳过），不会白跑。
     */
    if (!windowed && plan.created) {
      const existing = this.coverageFromCounts(store.countByState())
      if (existing.complete) {
        const verified = await this.processWindow({
          window: null,
          incremental: true,
          contacts,
          provenance,
          store,
          budget,
          scanState,
          preLoopState,
          marksConversationDone: true
        })
        if (!verified.interrupted && !verified.truncated && verified.imageCount === 0) {
          for (const tier of IMAGE_TEXT_BACKFILL_TIER_ORDER) {
            store.writeBackfillTierState(tier, 'complete')
          }
          store.writeBackfillCoveredToMs(this.now())
          this.currentPhase = 'complete'
          this.runState = 'completed'
          this.running = false
          await this.emit()
          return
        }
      }
    }
    const lastSegment = plan.segments[plan.segments.length - 1]
    /**
     * 增量补齐跑过没有（本次 pass）。
     *
     * 它必须**独立于"本分段要不要扫"**：所有分段都已完成时，仍然需要一次补齐，
     * 否则"全部建完之后新到的图片"就再也没人接。
     */
    let swept = false

    for (const segment of plan.segments) {
      if (this.cancelRequested || this.pauseRequested || budget.remaining <= 0) break

      const tierState = windowed ? null : store.readBackfillState().tierStates[segment.tier]
      // 已完成的分段不再重扫 —— restart / resume 因此从**当前**分段继续，
      // 而不是回到最近 7 天把已经做过的事再做一遍。
      const shouldScan = windowed || tierState !== 'complete'

      /**
       * 增量补齐：**每个调度点先跑一次**，且本 pass 至少跑一次。
       *
       * 排在历史分段之前，是为了"绝不会因为正在扫十年前的历史，让今天新收到的图片排队"；
       * 即使分段全部完成、本 pass 没有任何分段要扫，也仍然要跑一次。
       */
      if (!windowed && (!swept || shouldScan)) {
        const interrupted = await this.sweepIncremental({
          plan,
          contacts,
          provenance,
          store,
          budget,
          scanState,
          preLoopState
        })
        swept = true
        if (interrupted) break
      }

      if (!shouldScan) continue

      this.currentPhase = windowed ? 'incremental' : segment.tier
      if (!windowed) store.writeBackfillTierState(segment.tier, 'running')
      await this.emit()

      const scanned = await this.processWindow({
        window: { sinceMs: segment.startMs, beforeMs: segment.endMs },
        incremental: false,
        contacts,
        provenance,
        store,
        budget,
        scanState,
        preLoopState,
        marksConversationDone: !windowed && segment === lastSegment
      })

      // 被取消 / 暂停 / 预算截断 → 这一段**没有**跑完，绝不能标成 complete。
      if (scanned.interrupted || scanned.truncated) break

      if (!windowed) store.writeBackfillTierState(segment.tier, 'complete')
      await this.emit()
    }

    if (this.cancelRequested) this.runState = 'cancelled'
    else if (this.pauseRequested) this.runState = 'paused'
    else this.runState = 'completed'
    // 只有真正跑完全部分段才把阶段切成"完成"；中途停下时保留当前阶段（那才是实话）。
    if (this.runState === 'completed' && !windowed) this.currentPhase = 'complete'
    this.running = false
    await this.emit()
  }

  /**
   * 解析本次 pass 的分段计划。
   *
   * 计划一律由**落盘的锚点**派生：锚点不随 pass 变化，所以"跑了几小时之后
   * 7 天窗口往前漂移、进而产生重复或遗漏"在结构上就不可能发生。
   */
  private resolveBackfillPlan(
    store: ImageTextIndexStore,
    options: ImageTextIndexStartOptions
  ): { anchorMs: number; segments: ImageTextBackfillSegment[]; created: boolean } {
    if (options.sinceMs && options.sinceMs > 0) {
      // 受控窗口：单段、无上界、不落任何分段状态。
      return {
        anchorMs: options.sinceMs,
        segments: [
          { tier: 'recent_7d', startMs: options.sinceMs, endMs: Number.POSITIVE_INFINITY }
        ],
        created: false
      }
    }
    const state = store.readBackfillState()
    if (state.anchorMs !== null) {
      return {
        anchorMs: state.anchorMs,
        segments: buildImageTextBackfillSegments(state.anchorMs),
        created: false
      }
    }
    const anchorMs = this.now()
    store.writeBackfillAnchor(anchorMs)
    for (const tier of IMAGE_TEXT_BACKFILL_TIER_ORDER) {
      store.writeBackfillTierState(tier, 'pending')
    }
    return { anchorMs, segments: buildImageTextBackfillSegments(anchorMs), created: true }
  }

  /**
   * 增量补齐：把"锚点之后新到的东西"处理掉，永远排在历史分段之前。
   *
   * 窗口 = `[max(锚点, 上次补齐水位), +∞)`，只覆盖新到的东西，所以刚建计划时
   * 它在时间上是空的、连枚举都省掉。水位可用时另有一层判据：插入序没涨的会话
   * 直接跳过，涨了的会话则**去掉时间窗**读（见 `processWindow`）。
   *
   * 返回 true = 被取消 / 暂停 / 预算截断。
   */
  private async sweepIncremental(input: {
    plan: { anchorMs: number; segments: ImageTextBackfillSegment[] }
    contacts: Array<{ md5: string; m_nsUsrName: string; type: 'user' | 'group' }>
    provenance: ImageOcrProvenance
    store: ImageTextIndexStore
    budget: { remaining: number }
    scanState: Map<
      string,
      { state: string; imageTotal: number; processed: number; maxLocalId: number }
    >
    preLoopState: { captured: boolean }
  }): Promise<boolean> {
    const incrementalSinceMs = Math.max(
      input.plan.anchorMs,
      input.store.readBackfillState().coveredToMs ?? 0
    )
    // 窗口在时间上必然为空 → 直接跳过，省掉一轮枚举。
    if (this.now() - incrementalSinceMs < 1_000) return false

    const swept = await this.processWindow({
      window: { sinceMs: incrementalSinceMs },
      incremental: true,
      contacts: input.contacts,
      provenance: input.provenance,
      store: input.store,
      budget: input.budget,
      scanState: input.scanState,
      preLoopState: input.preLoopState,
      marksConversationDone: false
    })
    // 只有真的扫完（没被取消 / 暂停 / 预算截断）才推进水位，否则会漏掉没扫到的部分。
    if (!swept.interrupted && !swept.truncated && input.budget.remaining > 0) {
      input.store.writeBackfillCoveredToMs(this.now())
    }
    return swept.interrupted || swept.truncated
  }

  /**
   * 处理一个窗口（`null` = 不看时间，用于受控小样本验证）。
   *
   * 每个会话先做两条**纯 SQL 聚合**：源侧水位 + 窗口内图片条数。
   * 条数为 0 就整段跳过 —— 不读消息、不解密、不写任何"完成"标记。
   */
  private async processWindow(input: {
    window: { sinceMs?: number; beforeMs?: number } | null
    /**
     * 增量补齐模式。
     *
     * - 水位**可用**且水位涨了 → 去掉时间窗读这个会话（接得住晚到的旧时间消息）；
     * - 水位可用且没涨 → 跳过；
     * - 水位**不可用** → 按时间窗兜底重扫：宁可慢，也不允许因为判据拿不到就漏。
     */
    incremental: boolean
    contacts: Array<{ md5: string; m_nsUsrName: string; type: 'user' | 'group' }>
    provenance: ImageOcrProvenance
    store: ImageTextIndexStore
    budget: { remaining: number }
    scanState: Map<
      string,
      { state: string; imageTotal: number; processed: number; maxLocalId: number }
    >
    preLoopState: { captured: boolean }
    /** 本窗口扫完是否意味着该会话**全部**图片都已定态（最后一个分段）。 */
    marksConversationDone: boolean
  }): Promise<{ interrupted: boolean; imageCount: number; truncated: boolean }> {
    const { incremental, contacts, provenance, store, budget, scanState } = input
    let imageCount = 0
    /**
     * 预算被截断。
     *
     * 必须与"跑完了"区分开：被截断的分段**不能**被标记成 complete ——
     * 否则下一次 pass 会以"这一段已完成"跳过，被截掉的那些图片就永远不会被处理。
     */
    let truncated = false

    for (const contact of contacts) {
      if (this.cancelRequested || this.pauseRequested) {
        return { interrupted: true, imageCount, truncated }
      }
      if (budget.remaining <= 0) {
        truncated = true
        break
      }

      const conversationId = contact.md5
      const previous = scanState.get(conversationId)
      /**
       * 会话级准备：水位 / 计数 / 让路 / 读消息。
       *
       * 单独计时的理由：这些是"每会话一次"的成本，与图片张数无关。
       * 会话图片很少时，它会把该会话的单张成本抬到几十上百毫秒 ——
       * 而 `perImageMs` 只覆盖 batch 循环，看不到它。
       */
      const setupStartedAt = this.now()

      /**
       * 源侧水位：`count` + `max(local_id)`，一条 SQL 聚合（**整会话**，不带窗口）。
       *
       * 增量判据用 `maxLocalId` 而不是 create_time：`local_id` 是 WCDB 行内单调的
       * 插入序，因此"撤回一张旧图 + 新增一张新图"这种总数不变的变更也能被发现，
       * 而 create_time 会被"晚到的旧时间消息"骗过。
       */
      const watermark = await (this.deps.imageWatermark?.(conversationId) ??
        Promise.resolve<ImageMessageWatermark | null>(null))

      /**
       * 这一段对这个会话实际要读的时间窗。
       *
       * `null` = 不看时间（整会话，新 → 旧）。
       */
      let effectiveWindow = input.window
      if (incremental && watermark !== null && previous !== undefined) {
        // 水位可用：没涨就代表确实没有新内容，跳过（不读消息、不查窗口）。
        if (previous.maxLocalId > 0 && watermark.maxLocalId <= previous.maxLocalId) {
          this.preLoop.conversationSetupMs += this.now() - setupStartedAt
          continue
        }
        /**
         * 判据可用且涨了 → **去掉时间窗**读这个会话。
         *
         * 为什么不能只读"锚点之后"：`local_id` 是插入序，而 `create_time` 是业务时间，
         * 两者可以不一致 —— 网络补发、消息恢复、合并转发回填都会让一条**旧时间**的
         * 消息在今天才落库。只按时间窗读就永远接不到它，用户会"搜不到明明收到过的图"。
         * 代价只落在真的发生了插入的会话上，而每一轮之后水位即被推平。
         */
        effectiveWindow = null
      }
      const windowArg = effectiveWindow === null ? undefined : effectiveWindow

      /**
       * 窗口内是否有图片：一条 SQL COUNT。
       *
       * `count === null` 是**统计失败，不是 0 张** —— 必须跳过并且不写任何完成标记，
       * 否则这段会被当成"已覆盖"，把数不出来谎报成没有图片。
       */
      const probe = await (this.deps.countConversationImages?.(
        conversationId,
        windowArg
      ) ?? Promise.resolve<ImageMessageCountProbe>({ count: null, typeColumn: null }))
      if (probe.count === null) {
        this.preLoop.conversationSetupMs += this.now() - setupStartedAt
        continue
      }
      const imageTotal = probe.count
      if (imageTotal === 0) {
        this.preLoop.conversationSetupMs += this.now() - setupStartedAt
        this.rememberConversationWatermark({
          store,
          scanState,
          conversationId,
          watermark,
          processed: previous?.processed ?? 0,
          marksConversationDone: input.marksConversationDone
        })
        continue
      }

      await this.deps.interactiveIdle?.()

      /**
       * 读这个会话的图片消息。
       *
       * **优先走专用查询**（`listImageMessages`）：它在 SQL 层只取图片行，
       * 行数由图片数量决定，而不是消息数量。大会话全量读一次要十几秒，
       * 而那些行里 99% 以上是图片索引根本不看的文本消息。
       *
       * 兼容路径保留给没有接专用查询的调用方（主要是测试）。
       * 两条路径产出的 `FormattedMessage` 逐字段同构，所以 artifact / binding /
       * checkpoint 的键完全不变。
       */
      let imageMessages: chat.FormattedMessage[] = []
      const listStartedAt = this.now()
      try {
        const source = await this.runStep('list-image-messages', () =>
          this.deps.listImageMessages
            ? this.deps.listImageMessages(conversationId, windowArg)
            : (this.deps.listMessages?.(conversationId) ?? Promise.resolve([]))
        )
        imageMessages = source
          // 专用路径仍要过滤：召回归档合并可能补进非图片的撤回消息。
          .filter(isImageMessage)
          // 时间窗过滤：兼容路径没有 SQL 层窗口，只能在这里筛；这也让小样本验证
          // 的语义与专用路径一致。
          .filter((message) => {
            if (effectiveWindow === null) return true
            const createTimeMs = (message.createTime || 0) * 1000
            if (effectiveWindow.sinceMs !== undefined && createTimeMs < effectiveWindow.sinceMs) {
              return false
            }
            if (effectiveWindow.beforeMs !== undefined && createTimeMs >= effectiveWindow.beforeMs) {
              return false
            }
            return true
          })
      } catch {
        imageMessages = []
      }
      this.preLoop.listMessagesMs += this.now() - listStartedAt
      this.preLoop.conversationSetupMs += this.now() - setupStartedAt
      if (!imageMessages.length) {
        this.rememberConversationWatermark({
          store,
          scanState,
          conversationId,
          watermark,
          processed: previous?.processed ?? 0,
          marksConversationDone: input.marksConversationDone
        })
        continue
      }
      imageCount += imageMessages.length
      /**
       * 水位取**实际读到的**消息里最大的 local_id，而不是源侧水位：
       * 万一在我们查水位之后、读消息之前又落了一条新图，用观测值会让下一轮
       * 发现"源水位更高"从而重扫（安全）；用源侧水位则会把它永久跳过（漏索引）。
       */
      const observedMaxLocalId = imageMessages.reduce(
        (max, message) => Math.max(max, Number(message.localId) || 0),
        0
      )

      const ocrByMessage = store.getConversationOcr(conversationId)
      let processedInConversation = 0
      let interrupted = false
      // 每个会话单独判定"是否需要让 Knowledge 重建"，不跨会话累积。
      this.knowledgeDirty = false

      for (let index = 0; index < imageMessages.length; index += IMAGE_TEXT_INDEX_BATCH_SIZE) {
        if (!input.preLoopState.captured) {
          input.preLoopState.captured = true
          this.preLoop.startupMs = this.now() - this.passStartedAt
        }
        if (this.cancelRequested || this.pauseRequested) {
          interrupted = true
          break
        }
        const batchStartedAt = this.now()
        const batch = imageMessages.slice(index, index + IMAGE_TEXT_INDEX_BATCH_SIZE)
        const batchResult = await this.processBatch(
          batch,
          conversationId,
          provenance,
          ocrByMessage,
          () => budget.remaining > 0,
          () => {
            budget.remaining -= 1
          }
        )
        processedInConversation += batchResult.processed
        if (batchResult.interrupted) {
          this.batchLoopMs += this.now() - batchStartedAt
          interrupted = true
          break
        }

        // 批次之间让出 event loop：交互查询 / UI 永远优先于后台历史 OCR。
        await new Promise<void>((resolve) => setImmediate(resolve))
        await this.emit()
        this.batchLoopMs += this.now() - batchStartedAt
        this.maybeLogStageProfile()
      }

      /**
       * 预算（`messageLimit`）用完而提前收工 —— 这**不是** `done`。
       *
       * 写 `done` 会让下一遍按水位错误跳过这些图片（**永久漏索引**），
       * 或者让用户以为这个会话已经处理完。预算耗尽只能记 `partial`。
       */
      if (interrupted || budget.remaining <= 0) {
        store.writeScanState({
          conversationId,
          state: 'partial',
          /**
           * **整会话**的图片总数，不是本窗口的条数。
           *
           * `image_ocr_scan_state.image_total` 是进度的分母（`readScanProgress()` 求和）；
           * 把某个分段的窗口条数写进去，分母就会缩到"这一段处理了多少"，
           * 于是总进度会突然跳到接近 100% —— 那是这个功能最不能犯的谎。
           */
          imageTotal: watermark?.count ?? previous?.imageTotal ?? imageMessages.length,
          imageProcessed: processedInConversation,
          maxLocalId: observedMaxLocalId
        })
        scanState.set(conversationId, {
          state: 'partial',
          imageTotal: imageMessages.length,
          processed: previous?.processed ?? 0,
          maxLocalId: observedMaxLocalId
        })
        truncated = true
        return { interrupted: true, imageCount, truncated }
      }

      this.rememberConversationWatermark({
        store,
        scanState,
        conversationId,
        watermark,
        processed: (previous?.processed ?? 0) + processedInConversation,
        marksConversationDone: input.marksConversationDone,
        observedMaxLocalId
      })

      /**
       * 会话的图片都处理完了 → **只有真的产生了可搜索内容变化**才让 Knowledge 重建。
       *
       * 为什么必须门控：Knowledge 侧是"读整个会话 → 重分片整会话"，代价与消息数成正比，
       * 而且这一步在 `await` 路径上。图片索引走过的大多数会话里，被识别的图片要么
       * 没有文字、要么图片文件已被清理 —— 那些结果不改变可搜索内容，重建纯属白做，
       * 却会把图片索引按住（实测单会话可达十几秒）。
       *
       * 判定规则见 `settle()`：只有"识别出文字"的终态会置 `knowledgeDirty`。
       */
      if (!this.knowledgeDirty) {
        this.knowledgeIndexSkippedConversations += 1
        await this.emit()
        continue
      }

      const indexedStartedAt = this.now()
      try {
        // 这一步是**别的模块**的成本，且没有上界（Knowledge 侧会先等它自己的索引跑完）。
        // 用 runStep 包起来，超时就会打一条 `slow step=knowledge-index`。
        await this.runStep('knowledge-index', async () => {
          await this.deps.onConversationIndexed?.(conversationId)
        })
      } catch {
        // 索引回调失败不应中断 OCR：派生文本已经落库，下一遍还会再灌。
      }
      this.preLoop.onConversationIndexedMs += this.now() - indexedStartedAt
      await this.emit()
    }

    return { interrupted: false, imageCount, truncated }
  }

  /**
   * 写入会话 checkpoint。
   *
   * 存的是**源侧水位**（整会话的 count / maxLocalId），不是窗口内的观测值：
   * 增量补齐的判据必须是"源有没有变"，用窗口观测值会让每次窗口扫描都改水位，
   * 于是增量判断永远为真 —— 表现就是"每轮都重扫一遍"。
   */
  private rememberConversationWatermark(input: {
    store: ImageTextIndexStore
    scanState: Map<
      string,
      { state: string; imageTotal: number; processed: number; maxLocalId: number }
    >
    conversationId: string
    watermark: ImageMessageWatermark | null
    processed: number
    marksConversationDone: boolean
    observedMaxLocalId?: number
  }): void {
    const { store, scanState, conversationId, watermark, processed, marksConversationDone } = input
    const previous = scanState.get(conversationId)
    const state: 'done' | 'partial' =
      marksConversationDone && previous?.state !== 'partial' ? 'done' : 'partial'
    const imageTotal = watermark?.count ?? previous?.imageTotal ?? 0
    const maxLocalId = watermark?.maxLocalId ?? input.observedMaxLocalId ?? previous?.maxLocalId ?? 0
    store.writeScanState({
      conversationId,
      state,
      imageTotal,
      imageProcessed: processed,
      maxLocalId
    })
    scanState.set(conversationId, { state, imageTotal, processed, maxLocalId })
  }

  /**
   * 分段覆盖度（recent-first 的时间维度）。
   *
   * 三种情形必须分清：
   * - 从未规划过（新用户 / 旧版本）→ `tiers: []`，调用方只能按整体状态判断。
   * - 规划过 → 逐段给出真实运行态。
   * - **整体已经 complete** → 一律表达为"全部完成"。老版本已经把全量索引建完的账号，
   *   升级后不能被重新拉回去做 backfill，也不能因为"没有分段信息"而让 Query Agent
   *   以为历史还没扫完。
   */
  private tierCoverageSnapshot(complete: boolean): {
    tiers: ImageTextTierCoverage[]
    coveredToMs: number | null
  } {
    const store = this.store
    if (!store) return { tiers: [], coveredToMs: null }
    const state = store.readBackfillState()
    const anchorMs =
      state.anchorMs ?? (complete ? (store.readCountedTotal()?.countedAt ?? this.now()) : null)
    if (anchorMs === null) return { tiers: [], coveredToMs: state.coveredToMs }
    const tiers: ImageTextTierCoverage[] = buildImageTextBackfillSegments(anchorMs).map(
      (segment) => ({
        tier: segment.tier,
        state: complete ? 'complete' : (state.tierStates[segment.tier] ?? 'pending'),
        startMs: segment.startMs,
        endMs: segment.endMs
      })
    )
    const coveredToMs = complete ? Math.max(state.coveredToMs ?? 0, anchorMs) : state.coveredToMs
    return { tiers, coveredToMs }
  }


  // --------------------------------------------------------------- 控制接口

  pause(): { paused: boolean; state: ImageTextIndexRunState } {
    if (!this.running) return { paused: false, state: this.runState }
    this.pauseRequested = true
    return { paused: true, state: 'paused' }
  }

  resume(options: ImageTextIndexStartOptions = {}): {
    started: boolean
    state: ImageTextIndexRunState
  } {
    if (this.running) return { started: false, state: this.runState }
    return this.startPass(options)
  }

  async cancel(): Promise<{ cancellable: boolean; cancelled: boolean }> {
    if (!this.running) return { cancellable: false, cancelled: false }
    this.cancelRequested = true
    const pending = this.passPromise
    if (pending) await pending.catch(() => undefined)
    return { cancellable: true, cancelled: true }
  }

  isRunning(): boolean {
    return this.running
  }

  // ------------------------------------------------------------------- 清理

  /**
   * 清理「图片文字索引能力」的全部派生数据。
   *
   * 只删本能力自己生成的东西：artifact（OCR 文本）、binding、checkpoint、库文件。
   * 明确**不碰**：WCDB、微信图片、图片解密密钥、普通文字知识库、语音转写、聊天消息、Agent 配置。
   */
  async clear(): Promise<{ removed: boolean; removedBytes: number }> {
    await this.cancel()
    // 清库后速度采样与待发通知都必须作废：否则 UI 会拿旧采样算出假速度。
    this.resetProgressNotifications()
    this.conversationOcrCache.clear()
    const store = this.ensureStore()
    /**
     * **必须在删之前**记下受影响会话。
     *
     * OCR 派生文本已经通过 normalizer 进了 Knowledge 的 chunks / FTS。
     * 只删派生库、不做这一步，用户执行「清理图片文字索引」之后**仍然能搜到图片里的文字** ——
     * 那就等于"清理成功"是假的。硬条件：清理图片文字索引 ≠ 只删 OCR SQLite。
     */
    const affectedConversations = store?.conversationIdsWithOcr() ?? []
    let removedBytes = 0
    if (store) {
      removedBytes = store.storageStats().totalBytes
      store.clearDerivedData()
      // 先折 WAL 再关连接，然后才允许删文件（见 store.close / removeImageTextIndexDatabase）。
      store.close()
      this.store = null
      this.storeAccountId = ''
    }
    const databasePath = this.accountKey
    this.accountKey = ''
    const removal = databasePath
      ? removeImageTextIndexDatabase(databasePath)
      : { removed: true, leftovers: [] as string[] }
    // 总数统计也一并作废：下次回到「未建立」时重新 COUNT(*)，
    // 否则 UI 会拿着一个已经没有任何派生数据支撑的旧分母。
    this.counters = {
      totalImageMessages: 0,
      processedThisPass: 0,
      indexed: 0,
      empty: 0,
      missing: 0,
      failed: 0
    }
    this.runState = 'idle'
    this.startedAt = undefined
    await this.emit()

    /**
     * 逐个重建**受影响的会话**，让 OCR 派生文本从 Knowledge 里消失。
     *
     * 刻意不做两件更省事但更糟的事：
     * - 不清空整个 Knowledge（那会连普通文字消息的索引一起丢掉）；
     * - 不假装"删了文件就等于清理完成"（chunks/FTS 里还留着旧文字）。
     *
     * rebuilt 这里已经返回空（派生库已删、resolver 拿不到 OCR），所以重建出来的
     * 会话副本天然不含 OCR 文本；`completeSnapshot` 会把旧的 chunk 一起替换掉。
     */
    let invalidatedConversations = 0
    for (const conversationId of affectedConversations) {
      try {
        await this.deps.onConversationIndexed?.(conversationId)
        invalidatedConversations += 1
      } catch {
        // 单个会话重建失败不应让清理整体失败：派生数据已经删了，
        // 下一遍索引也会因为 resolver 返回空而自然收敛。
      }
    }
    this.lastInvalidatedConversations = invalidatedConversations
    /**
     * 重建过程中 Knowledge 会通过 resolver 调 `getConversationOcr`，
     * 那会把派生库**重新打开**（`ensureStore`）。清理完必须再收干净：
     * 否则「清理成功」之后还留着一个空库句柄，Windows 上也会妨碍目录删除。
     */
    this.store?.close()
    this.store = null
    this.storeAccountId = ''
    this.accountKey = ''
    // `removed: false` = 文件仍被占用没删掉，必须如实上报，不能假装清理成功。
    return { removed: removal.removed, removedBytes }
  }

  /**
   * 缓存清理前先停下任务，并**把 Knowledge 里的 OCR 派生文本一起失效**。
   *
   * 直接复用 `clear()` 而不是只 `cancel()`：缓存清理（含"清理全部"）同样会删掉派生库，
   * 如果这里不顺手重建 Knowledge，用户会得到一个自相矛盾的状态 ——
   * 「问问微信」里搜得到图片文字，但派生库明明已经没了。
   */
  async prepareForCacheClear(): Promise<void> {
    await this.clear()
  }

  /**
   * 派生索引修复（Derived Index Repair）。
   *
   * 只重建 **L3（Knowledge 派生条目 / chunks / FTS）**，数据来源是已有的
   * L2 binding + L1 artifact。**绝不**读原图、解密或调用 OCR 引擎 ——
   * L1 是几万张图片堆出来的昂贵产物，修一个索引问题不该让它重算一遍。
   *
   * `ocrExecutions: 0` 不是"期望"，而是这条路径的定义：类型上写死成字面量 0，
   * 任何让它变成非 0 的改动都会直接编译失败。
   */
  async repairKnowledgeIndex(
    options: { conversationLimit?: number } = {}
  ): Promise<ImageTextIndexRepairResult> {
    const startedAt = this.now()
    // 运行中不并发重建：pass 正在写 binding，同时重建会让 Knowledge 读到半程状态。
    if (this.running) {
      return { conversations: 0, ocrExecutions: 0, durationMs: 0, skipped: true }
    }
    const store = this.ensureStore()
    if (!store) {
      return {
        conversations: 0,
        ocrExecutions: 0,
        durationMs: this.now() - startedAt,
        skipped: false
      }
    }
    const limit =
      options.conversationLimit && options.conversationLimit > 0
        ? options.conversationLimit
        : undefined
    const conversationIds = limit
      ? store.conversationIdsWithIndexedOcr().slice(0, limit)
      : store.conversationIdsWithIndexedOcr()

    let conversations = 0
    for (const conversationId of conversationIds) {
      try {
        await this.deps.onConversationIndexed?.(conversationId)
        conversations += 1
      } catch {
        // 单个会话重建失败不影响其余：修索引是尽力而为的廉价操作，可重试。
      }
    }
    return {
      conversations,
      ocrExecutions: 0,
      durationMs: this.now() - startedAt,
      skipped: false
    }
  }

  /**
   * 重置**可重试的失败记录**（代码修好之后重跑用）。
   *
   * 刻意不做成"清空整个派生库"：那会连已经成功的 OCR 记录一起丢掉，
   * 用户要为此重新跑几万张图片。这里只删失败绑定 + 它们的 checkpoint，
   * `indexed` / `empty` 一条不动，下一轮 pass 自然接上。
   */
  async resetRetriableFailures(): Promise<{ reset: number }> {
    await this.cancel()
    this.conversationOcrCache.clear()
    const store = this.ensureStore()
    if (!store) return { reset: 0 }
    const reset = store.resetFailures([...IMAGE_OCR_RETRIABLE_FAILURE_STATES])
    await this.emit()
    return { reset }
  }

  /** 缓存清理前先停下任务，避免边删边写。 */
}

export const imageTextIndexService = new ImageTextIndexService()
