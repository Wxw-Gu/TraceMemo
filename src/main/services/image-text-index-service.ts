/**
 * 图片文字索引编排服务。
 *
 * 职责边界（刻意保持单一）：
 * - 快速统计图片消息数（SQL，**绝不解密**）
 * - 按会话 + 批次驱动 OCR；**严格串行（concurrency = 1）**：循环体内只有一次
 *   `await`，不存在 Promise.all 扇出，且每批之间让出 event loop
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
  IMAGE_TEXT_INDEX_BATCH_SIZE,
  IMAGE_TEXT_INDEX_ENGINE,
  IMAGE_OCR_RETRIABLE_FAILURE_STATES,
  buildImageOcrArtifactKey,
  imageTextProcessedPercent,
  isTerminalImageOcrState,
  type ImageMessageCountProbe,
  type ImageMessageWatermark,
  type ImageOcrPersistedState,
  type ImageOcrProvenance,
  type ImageTextIndexCountResult,
  type ImageTextIndexCoverage,
  type ImageTextIndexProgress,
  type ImageTextIndexRepairResult,
  type ImageTextIndexRunState,
  type ImageTextIndexStartOptions,
  type ImageTextIndexStatus,
  type ImageTextIndexStorageStats
} from '../../shared/image-text-index'
import { detectSystemOcrImageFormat, type SystemOcrCapability } from '../../shared/system-ocr'
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
   * 单个会话的图片消息计数探针（SQL 统计，不解密）。
   *
   * `count: null` = 统计失败，**不等于 0 张**；调用方必须区分。
   */
  countConversationImages?: (
    conversationId: string,
    sinceMs?: number
  ) => Promise<ImageMessageCountProbe>
  /**
   * 单个会话的图片消息增量水位（条数 + 最大插入序），SQL 聚合，不解密。
   *
   * 返回 null = 当前数据库不支持（调用方必须退化成"每轮重扫"，宁可慢也不可漏）。
   */
  imageWatermark?: (conversationId: string, sinceMs?: number) => Promise<ImageMessageWatermark | null>
  decryptService?: () => ImageDecryptService | null
  /** 本地 OCR。 */
  recognize?: (imageDataUrl: string) => Promise<{
    success: boolean
    text: string
    language: string | null
    errorCode?: string
  }>
  capability?: () => Promise<SystemOcrCapability>
  /** 会话图片全部处理完后回调，用于把 OCR 文本灌进 Knowledge 索引。 */
  onConversationIndexed?: (conversationId: string) => Promise<void>
  /** 交互查询让路钩子。 */
  interactiveIdle?: () => Promise<void>
  now?: () => number
}

function sha256Short(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
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

  /** 本轮 pass 的计数器（内存态；真实来源始终是派生库）。 */
  private counters = {
    totalImageMessages: 0,
    processedThisPass: 0,
    indexed: 0,
    empty: 0,
    missing: 0,
    failed: 0
  }

  private runState: ImageTextIndexRunState = 'idle'

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

  private ensureStore(): ImageTextIndexStore | null {
    const root = this.deps.databaseRoot
    const accountId = this.resolveAccountId()
    if (!root || !accountId) return null
    if (this.store && this.storeAccountId === accountId) return this.store
    this.store?.close()
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
   * 这正是 §18 禁止的"把 partial coverage 当 complete"。
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
    const processed = indexed + empty + missing + failed
    const counted = this.store?.readCountedTotal() ?? null
    // 内存计数器只在本轮 pass 内比落盘值更新（刚统计完、尚未落盘的窗口）。
    const total =
      this.counters.totalImageMessages || counted?.total || processed + runtimeUnavailable
    /**
     * 系统性失败：处理过一批，但一条都没能给出确定结果。
     *
     * 这正是本次事故的形态（45,479 张全部失败，成功 / 无文字 / 缺失都是 0）。
     * 它必须阻断 `complete` —— 否则 Query Agent 会拿着"覆盖完整"去回答"没有"。
     */
    const systemicFailure = processed > 0 && indexed === 0 && empty === 0 && missing === 0
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
      // 分母不完整、有 pending、有运行时不可用、或"全军覆没" → 都不算 complete。
      complete:
        counted !== null &&
        counted.complete &&
        total > 0 &&
        runtimeUnavailable === 0 &&
        !systemicFailure &&
        processed >= total,
      systemicFailure,
      countedAt: counted?.countedAt ?? null
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
      ...(this.lastError ? { lastError: this.lastError } : {})
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
          countedAt: null
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
      counting: this.counting
    }
  }

  onStatusChange(listener: (status: ImageTextIndexStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private async emit(): Promise<void> {
    if (!this.listeners.size) return
    const status = await this.getStatus()
    for (const listener of this.listeners) {
      try {
        listener(status)
      } catch {
        // 监听器异常不得影响索引。
      }
    }
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

  private async processOne(
    message: chat.FormattedMessage,
    conversationId: string,
    provenance: ImageOcrProvenance
  ): Promise<{ state: ImageOcrPersistedState; text: string; imageIdentity: string | null }> {
    const imageContent =
      message.contentData?.type === 'image'
        ? (message.contentData as { md5?: string; datName?: string })
        : undefined

    const decrypt = this.deps.decryptService?.() ?? null
    /**
     * 解密服务缺失是**运行时**问题，不是这张图片的问题。
     *
     * 本次事故就是它：`imageDecryptService` 只在用户点开某张图时才懒加载，
     * 于是全量回填 45,479 张全部落成 `decrypt_failed` —— 数字看着像"图片坏了"，
     * 实际是流水线前置依赖没接上。这里必须用独立状态，绝不能与真正的解密失败混为一谈。
     */
    if (!decrypt) return { state: 'decrypt_unavailable', text: '', imageIdentity: null }

    // 图片消息缺少定位字段：连"去哪找文件"都不知道，属消息侧缺失而非 OCR 失败。
    if (!imageContent?.md5 && !imageContent?.datName) {
      return { state: 'metadata_missing', text: '', imageIdentity: null }
    }

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
    // 微信清理过原图与缩略图 —— 这是正常情况，不是任务级错误。
    if (!datPath) return { state: 'image_missing', text: '', imageIdentity: null }

    let bytes: Buffer | null = null
    try {
      bytes = decrypt.decryptImage(datPath)
    } catch {
      bytes = null
    }
    if (!bytes || bytes.length === 0) {
      return { state: 'decrypt_failed', text: '', imageIdentity: null }
    }

    const imageIdentity = `sha256:${sha256Short(bytes)}`
    const format = detectSystemOcrImageFormat(bytes)
    // 解密"没抛错"但产出不是图片 → 解码失败，不是 OCR 失败。
    if (!format) return { state: 'decode_failed', text: '', imageIdentity }

    const store = this.ensureStore()
    const artifactKey = buildImageOcrArtifactKey({ imageIdentity, provenance })

    // 同一张图（可能被转发到多个会话）已经算过 → 直接复用，绝不重复 OCR。
    const cached = store?.getArtifact(artifactKey) ?? null
    if (cached && isTerminalImageOcrState(cached.state)) {
      return { state: cached.state, text: cached.text, imageIdentity }
    }

    const mime = MIME_BY_FORMAT[format] ?? 'image/png'
    let state: ImageOcrPersistedState = 'ocr_failed'
    let text = ''
    let errorCode: string | undefined
    try {
      const result = await (this.deps.recognize?.(`data:${mime};base64,${bytes.toString('base64')}`) ??
        Promise.resolve({ success: false, text: '', language: null, errorCode: 'OCR_FAILED' }))
      if (result.success && result.text.trim()) {
        state = 'indexed'
        text = result.text
      } else if (result.success || result.errorCode === 'OCR_EMPTY_RESULT') {
        // 表情包 / 风景 / 头像 —— 没有文字是**正常终态**，不重试。
        state = 'empty'
      } else {
        state = 'ocr_failed'
        errorCode = result.errorCode
      }
    } catch {
      state = 'ocr_failed'
    }

    const now = this.now()
    if (store) {
      store.putArtifact({
        accountId: this.storeAccountId,
        artifactKey,
        imageIdentity,
        state,
        text,
        charCount: text.length,
        engine: provenance.engine,
        platform: provenance.platform,
        runtimeVersion: provenance.runtimeVersion,
        language: provenance.language,
        ...(errorCode ? { errorCode } : {}),
        createdAt: now,
        updatedAt: now
      })
    }
    return { state, text, imageIdentity }
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
  startPass(options: ImageTextIndexStartOptions = {}): { started: boolean; state: ImageTextIndexRunState } {
    if (this.running) return { started: false, state: this.runState }
    this.cancelRequested = false
    this.pauseRequested = false
    this.lastError = undefined
    this.startedAt = this.now()
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

  private async runPass(options: ImageTextIndexStartOptions): Promise<void> {
    const store = this.ensureStore()
    if (!store) {
      this.lastError = '微信数据尚未就绪'
      this.runState = 'error'
      return
    }
    this.running = true

    const capability = (await this.deps.capability?.()) ?? null
    if (capability && !capability.available) {
      this.lastError = '当前系统不支持本地图片文字识别'
      this.runState = 'error'
      return
    }
    /**
     * **前置依赖自检（本次事故的根因防线）**：解密服务必须可用。
     *
     * 没有它，每张图片都会在 `processOne` 的第一步失败。原实现会把"整条流水线
     * 根本跑不起来"这件事落成 45,479 条 `decrypt_failed` —— 既污染派生库，
     * 又让用户以为自己的图片坏了，还让 coverage 看起来"都处理完了"。
     *
     * 所以必须在**写任何一条记录之前**停下来：宁可一次都不跑，也不要写一堆假失败。
     */
    if (!this.deps.decryptService?.()) {
      this.lastError = '图片解密服务尚未就绪，无法读取微信图片；本次未写入任何记录。'
      this.runState = 'error'
      return
    }
    const provenance: ImageOcrProvenance = {
      engine: capability?.engine ?? IMAGE_TEXT_INDEX_ENGINE,
      platform: capability?.platform ?? process.platform,
      runtimeVersion: capability?.runtimeVersion ?? null,
      language: capability?.language ?? null
    }

    // 统计一次总数（SQL），进度百分比才有真实分母。
    this.counting = true
    try {
      await this.countImageMessages(options.sinceMs)
    } finally {
      this.counting = false
    }

    let contacts = await (this.deps.listContacts?.() ?? Promise.resolve([]))
    if (options.conversationLimit && options.conversationLimit > 0) {
      contacts = contacts.slice(0, options.conversationLimit)
    }

    const scanState = store.readScanState()
    let budget = options.messageLimit && options.messageLimit > 0 ? options.messageLimit : Infinity

    for (const contact of contacts) {
      if (this.cancelRequested || this.pauseRequested) break
      if (budget <= 0) break

      const conversationId = contact.md5
      /**
       * 是否只处理一个时间窗口（用于小样本验证）。
       *
       * 带窗口时**不做增量跳过**：checkpoint 是围绕全量集合建立的，
       * 窗口内的图片可能从未被处理过，继续按"该会话已完成"跳过会让窗口形同虚设。
       */
      const windowed = Boolean(options.sinceMs && options.sinceMs > 0)
      // 增量水位 = 条数 + 最大插入序（§2）。只比条数会漏掉「撤回一张旧图 +
      // 新增一张新图」这种总数不变、集合却变了的会话。
      const watermark = await (this.deps.imageWatermark?.(conversationId, options.sinceMs) ??
        Promise.resolve(null))
      const imageTotal =
        watermark?.count ??
        (await this.deps.countConversationImages?.(conversationId, options.sinceMs))?.count ??
        0
      if (imageTotal === 0) {
        store.writeScanState({
          conversationId,
          state: 'done',
          imageTotal: 0,
          imageProcessed: 0,
          maxLocalId: watermark?.maxLocalId ?? 0
        })
        continue
      }

      // 增量：会话已完成且**水位完全未变** → 不读 WCDB、不 OCR。
      // 水位不可用时（数据库不支持该聚合）一律重扫：宁可慢，不可漏。
      const previous = scanState.get(conversationId)
      if (
        !windowed &&
        watermark &&
        previous &&
        previous.state === 'done' &&
        previous.imageTotal === watermark.count &&
        previous.maxLocalId === watermark.maxLocalId
      ) {
        continue
      }

      await this.deps.interactiveIdle?.()

      let messages: chat.FormattedMessage[] = []
      try {
        messages = await (this.deps.listMessages?.(conversationId) ?? Promise.resolve([]))
      } catch {
        messages = []
      }
      const imageMessages = messages
        .filter(isImageMessage)
        // 时间窗过滤：小样本验证时只看窗口内的图片，不然还是在跑全量。
        .filter((message) =>
          windowed ? (message.createTime || 0) * 1000 >= (options.sinceMs as number) : true
        )
      if (!imageMessages.length) {
        store.writeScanState({
          conversationId,
          state: 'done',
          imageTotal: 0,
          imageProcessed: 0,
          maxLocalId: 0
        })
        continue
      }
      // 水位取**实际读到的**消息里最大的 local_id，而不是源侧水位：
      // 万一在我们查水位之后、读消息之前又落了一条新图，用观测值会让下一轮
      // 发现"源水位更高"从而重扫（安全）；用源侧水位则会把它永久跳过（漏索引）。
      const observedMaxLocalId = imageMessages.reduce(
        (max, message) => Math.max(max, Number(message.localId) || 0),
        0
      )

      const ocrByMessage = store.getConversationOcr(conversationId)
      let processedInConversation = 0
      let interrupted = false

      for (let index = 0; index < imageMessages.length; index += IMAGE_TEXT_INDEX_BATCH_SIZE) {
        if (this.cancelRequested || this.pauseRequested) {
          interrupted = true
          break
        }
        const batch = imageMessages.slice(index, index + IMAGE_TEXT_INDEX_BATCH_SIZE)

        for (const message of batch) {
          if (budget <= 0) break
          const messageId = sourceMessageId(message)

          // 派生库里已有终态结果 → 复用（含"无文字"/"图片缺失"），不重复劳动。
          const known = ocrByMessage.get(messageId)
          if (known && isTerminalImageOcrState(known.state)) {
            processedInConversation += 1
            continue
          }

          const outcome = await this.processOne(message, conversationId, provenance)
          const now = this.now()
          store.putBinding({
            accountId: this.storeAccountId,
            conversationId,
            messageId,
            createTime: (message.createTime || 0) * 1000,
            ...(message.senderId || message.from ? { senderId: message.senderId || message.from } : {}),
            ...(message.isSender ? { senderName: '我' } : message.name ? { senderName: message.name } : {}),
            imageIdentity: outcome.imageIdentity ?? '',
            artifactKey: outcome.imageIdentity
              ? buildImageOcrArtifactKey({ imageIdentity: outcome.imageIdentity, provenance })
              : buildImageOcrArtifactKey({ imageIdentity: 'unavailable', provenance }),
            state: outcome.state,
            updatedAt: now
          })

          this.conversationOcrCache.delete(conversationId)
          processedInConversation += 1
          this.counters.processedThisPass += 1
          if (outcome.state === 'indexed') this.counters.indexed += 1
          else if (outcome.state === 'empty') this.counters.empty += 1
          else if (outcome.state === 'image_missing') this.counters.missing += 1
          else this.counters.failed += 1
          budget -= 1
        }

        // 批次之间让出 event loop：交互查询 / UI 永远优先于后台历史 OCR。
        await new Promise<void>((resolve) => setImmediate(resolve))
        await this.emit()
      }

      if (interrupted) {
        store.writeScanState({
          conversationId,
          state: 'partial',
          imageTotal: imageMessages.length,
          imageProcessed: processedInConversation,
          maxLocalId: observedMaxLocalId
        })
        break
      }

      store.writeScanState({
        conversationId,
        state: 'done',
        imageTotal: imageMessages.length,
        imageProcessed: processedInConversation,
        maxLocalId: observedMaxLocalId
      })

      // 会话的图片都处理完了 → 让 Knowledge 重建这个会话，OCR 文本才可被搜索。
      try {
        await this.deps.onConversationIndexed?.(conversationId)
      } catch {
        // 索引回调失败不应中断 OCR：派生文本已经落库，下一遍还会再灌。
      }
      await this.emit()
    }

    if (this.cancelRequested) this.runState = 'cancelled'
    else if (this.pauseRequested) this.runState = 'paused'
    else this.runState = 'completed'
    this.running = false
    await this.emit()
  }

  // --------------------------------------------------------------- 控制接口

  pause(): { paused: boolean; state: ImageTextIndexRunState } {
    if (!this.running) return { paused: false, state: this.runState }
    this.pauseRequested = true
    return { paused: true, state: 'paused' }
  }

  resume(options: ImageTextIndexStartOptions = {}): { started: boolean; state: ImageTextIndexRunState } {
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
      return { conversations: 0, ocrExecutions: 0, durationMs: this.now() - startedAt, skipped: false }
    }
    const limit = options.conversationLimit && options.conversationLimit > 0 ? options.conversationLimit : undefined
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
