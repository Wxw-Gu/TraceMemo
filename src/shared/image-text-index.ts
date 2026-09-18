/**
 * 图片文字索引（Image OCR Derived Text）契约。
 *
 * 硬规则（与语音转写同源的设计约束）：
 * - 微信图片消息是 **authoritative source**，OCR 文本是 **derived content**。
 * - OCR 文本绝不写回原始消息、绝不修改 WCDB、绝不伪装成用户发送的文字消息。
 * - OCR 命中时 Evidence 必须回到**原始图片消息**，而不是一条虚构的 OCR 消息。
 *
 * 因此这里刻意分成两层：
 * 1. `ImageOcrArtifact` —— 按「图片内容 + OCR 运行时指纹」去重的派生文本（可能一张图被转发到多个会话）。
 * 2. `ImageOcrBinding`  —— 「某个会话里的某条图片消息 → 某个 artifact」的绑定，保证去重不丢来源。
 */

/**
 * 派生文本的引擎标识**不在这里定义**：它是 System OCR 运行时按平台决定的
 * （`resolveSystemOcrEngine`），并随 `ImageOcrProvenance` 一起进入 artifact 指纹。
 * 本模块只消费该值，不再持有任何单一平台的引擎常量。
 */

/** 派生库自身的 schema 版本（与 Knowledge 的 schema 相互独立）。 */
export const IMAGE_TEXT_INDEX_SCHEMA_VERSION = 1

/** 每个批次的图片条数；批间让出 event loop，保证 UI / 查询不被卡住。 */
export const IMAGE_TEXT_INDEX_BATCH_SIZE = 12

/**
 * 正常运行态下，向 Renderer 推送进度的最小间隔。
 *
 * 后台仍然按 `IMAGE_TEXT_INDEX_BATCH_SIZE` 推进（batch / checkpoint / 并发都不受影响），
 * 但**UI 不该感知 batch 大小** —— 每批都推会让计数以「+12」的粒度跳动。
 * 所以这里只节流**通知**：状态变化（开始/暂停/继续/取消/失败/完成/清理）一律立即推送。
 */
export const IMAGE_TEXT_INDEX_PROGRESS_INTERVAL_MS = 5000

/** 速度统计窗口：取最近这段时间的增量，而不是整个任务的平均。 */
export const IMAGE_TEXT_INDEX_RATE_WINDOW_MS = 60_000

/** 窗口内至少要有这么长的跨度才给出速度，否则显示「计算中」。 */
export const IMAGE_TEXT_INDEX_RATE_MIN_SPAN_MS = 20_000

/**
 * OCR 并发度**硬上限**。
 *
 * `@napi-rs/system-ocr` 的 `recognize()` 是 napi AsyncTask，实际执行会占用
 * libuv **共享**线程池（fs / zlib / dns 等 native 异步工作也在用同一个池）。
 * 开得太高不会让单个识别更快，只会挤占同一进程里其它 native 异步工作。
 */
export const MAX_IMAGE_TEXT_OCR_CONCURRENCY = 4

/**
 * 默认 OCR 并发度（生产值）。
 *
 * 取值规则：在"吞吐明显更高、且 CPU / UI 交互代价可接受"的前提下取**最低**并发。
 * 超过 2 之后单次识别耗时会明显劣化（多个识别互相争抢 CPU），
 * 属于"多出来的并发全花在争抢上"。
 *
 * **这个值是待复测的**：原取舍依据来自一次现已修复的固定开销存在时的对照，
 * 而那个开销不随并发变化、会压扁并发收益。需要重新做锁定输入的对照后再决定；
 * 在那之前保持 2，不要按"池子多大就用多大"去推。
 */
export const DEFAULT_IMAGE_TEXT_OCR_CONCURRENCY = 2

/** 解析并发度：只接受 1..MAX 的整数，其余一律回落到默认值。 */
export function resolveImageTextOcrConcurrency(raw?: string | number | null): number {
  const value = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(value) || value < 1) return DEFAULT_IMAGE_TEXT_OCR_CONCURRENCY
  return Math.min(MAX_IMAGE_TEXT_OCR_CONCURRENCY, Math.floor(value))
}

/** 已完成一批之后、回到会话循环前的让出时间。 */
export const IMAGE_TEXT_INDEX_YIELD_MS = 0

/**
 * 单段时间窗口的图片消息读取上限。
 *
 * 必须显式给 limit：底层在不给 limit 时按 `create_time ASC` 排序并截断 ——
 * 那是"从最老开始读"，正好与 recent-first 相反，而且会把窗口内较新的图片悄悄丢掉。
 */
export const IMAGE_TEXT_SEGMENT_MESSAGE_LIMIT = 200_000

// ---------------------------------------------------------------- recent-first
//
// 首次建立索引时，用户要的不是"从十年前开始扫"，而是"最近聊天的图片先能搜"。
// 这里把"最近优先"固化成**显式时间分段计划**，而不是靠反转全库排序碰运气。
//
// 三条硬约束（任何实现都必须同时满足）：
// 1. 分段唯一来源是本文件：`[startInclusive, endExclusive)`，不允许别的模块自己推边界。
// 2. 一次 backfill session 的 `anchorMs` **固定不变**，否则跑几小时后窗口会漂移，
//    产生重复 / 遗漏 / checkpoint 不稳定。
// 3. 比锚点更新的消息由**增量补齐**单独负责，永远排在所有历史分段之前。

/** 历史回填分段。刻意用时间语义而不是 Tier 编号（内部也不要出现 Tier 1/2）。 */
export type ImageTextBackfillTier = 'recent_7d' | 'recent_30d' | 'recent_1y' | 'archive'

/** 处理顺序 = 优先级顺序：越靠前越新。 */
export const IMAGE_TEXT_BACKFILL_TIER_ORDER: readonly ImageTextBackfillTier[] = [
  'recent_7d',
  'recent_30d',
  'recent_1y',
  'archive'
]

/**
 * 「最近」窗口的天数。
 *
 * 取 7 天而不是 3 天：用户对"最近"的直觉通常是"这一周"，而 7 天窗口在真实库里
 * 通常只有几百到几千张图，几分钟内就能把"最近聊天里的图"变成可搜索。
 */
export const IMAGE_TEXT_RECENT_WINDOW_DAYS = 7

/** 各段下界的回看天数；`archive` 无下界。 */
export const IMAGE_TEXT_BACKFILL_WINDOW_DAYS: Record<ImageTextBackfillTier, number> = {
  recent_7d: IMAGE_TEXT_RECENT_WINDOW_DAYS,
  recent_30d: 30,
  recent_1y: 365,
  archive: Number.POSITIVE_INFINITY
}

/** 各段的用户可见名称。 */
export const IMAGE_TEXT_BACKFILL_TIER_LABEL: Record<ImageTextBackfillTier, string> = {
  recent_7d: '最近图片',
  recent_30d: '最近 30 天',
  recent_1y: '近一年图片',
  archive: '更早图片'
}

const DAY_MS = 24 * 60 * 60 * 1000

/** 一段回填窗口。`endMs` 为开区间上界；`archive` 的 `startMs` 是 -∞。 */
export interface ImageTextBackfillSegment {
  tier: ImageTextBackfillTier
  /** epoch ms，**闭**下界。 */
  startMs: number
  /** epoch ms，**开**上界。 */
  endMs: number
}

/**
 * 由固定锚点推出全部分段。
 *
 * 结果按优先级从新到旧排列，且**互不重叠、无空隙**：
 * `[now-7d, now)` → `[now-30d, now-7d)` → `[now-365d, now-30d)` → `(-∞, now-365d)`。
 *
 * 相邻段的边界由同一个锚点派生，所以不会 off-by-one：上一段的 `endMs` 恒等于下一段的
 * `startMs`，而区间语义是"下界闭、上界开"，落在边界上的消息只会被**一段**认领。
 */
export function buildImageTextBackfillSegments(anchorMs: number): ImageTextBackfillSegment[] {
  const segments: ImageTextBackfillSegment[] = []
  let upper = anchorMs
  for (const tier of IMAGE_TEXT_BACKFILL_TIER_ORDER) {
    const days = IMAGE_TEXT_BACKFILL_WINDOW_DAYS[tier]
    const lower = Number.isFinite(days) ? anchorMs - days * DAY_MS : Number.NEGATIVE_INFINITY
    segments.push({ tier, startMs: lower, endMs: upper })
    upper = lower
  }
  return segments
}

/**
 * 把 ms 半开区间转换成底层查询要的**秒**闭区间。
 *
 * **唯一的换算实现**：`sinceMs` 下取整做闭下界，`beforeMs` 下取整减一放开区间上界。
 * 两端必须用同一种取整方式 —— 一边 ceil 一边 floor 的话，边界那一秒会被
 * 相邻两段同时认领（重复 OCR）或被同时跳过（漏索引）。
 *
 * 微信的 `create_time` 只有秒级精度，所以 1 秒以内的边界歧义无法在源头消除；
 * 能做的是让它**确定且不重叠**。
 */
export function imageTextWindowToSeconds(range: { sinceMs?: number; beforeMs?: number }): {
  sinceSec: number | null
  beforeSecInclusive: number | null
} {
  const { sinceMs, beforeMs } = range
  const sinceSec =
    typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs > 0
      ? Math.floor(sinceMs / 1000)
      : null
  const beforeSecInclusive =
    typeof beforeMs === 'number' && Number.isFinite(beforeMs) && beforeMs > 0
      ? Math.floor(beforeMs / 1000) - 1
      : null
  return { sinceSec, beforeSecInclusive }
}

/** 分段 → 秒闭区间；语义同 `imageTextWindowToSeconds`。 */
export function imageTextSegmentToSecondRange(segment: ImageTextBackfillSegment): {
  sinceSec: number | null
  beforeSecInclusive: number | null
} {
  return imageTextWindowToSeconds({
    ...(Number.isFinite(segment.startMs) ? { sinceMs: segment.startMs } : {}),
    ...(Number.isFinite(segment.endMs) ? { beforeMs: segment.endMs } : {})
  })
}

// ---------------------------------------------------------------- 进度阶段

/** 索引运行阶段：增量补齐 / 某个历史分段 / 全部完成。 */
export type ImageTextIndexPhase = 'incremental' | ImageTextBackfillTier | 'complete'

export function imageTextPhaseLabel(phase: ImageTextIndexPhase): string {
  switch (phase) {
    case 'incremental':
    case 'recent_7d':
      return '正在优先索引最近图片'
    case 'recent_30d':
      return '正在补齐最近 30 天'
    case 'recent_1y':
      return '正在补齐近一年图片'
    case 'archive':
      return '正在补齐更早图片'
    case 'complete':
      return '图片文字索引已完成'
  }
}

/**
 * 「某段已可搜索」的宣告文案。
 *
 * 只允许在**该段真的 complete** 时使用 —— 它是一句承诺，不是进度提示。
 */
export function imageTextTierSearchableNotice(tier: ImageTextBackfillTier): string {
  switch (tier) {
    case 'recent_7d':
      return '最近图片已可搜索'
    case 'recent_30d':
      return '最近 30 天图片已可搜索'
    case 'recent_1y':
      return '近一年图片已可搜索'
    case 'archive':
      return '更早图片已可搜索'
  }
}

/** 分段的运行态。只有 `complete` 才允许被当作"这段已经完整可搜"。 */
export type ImageTextTierRunState = 'pending' | 'running' | 'complete'

/** 单个历史分段的完成状态与边界。 */
export interface ImageTextTierCoverage {
  tier: ImageTextBackfillTier
  state: ImageTextTierRunState
  /** epoch ms，闭下界；`archive` 为 -∞。 */
  startMs: number
  /** epoch ms，开上界。 */
  endMs: number
}

/** 时间范围询问的结论。 */
export interface ImageTextRangeCoverage {
  state: 'not_built' | 'partial' | 'complete'
  /** 请求范围内**已真正完整**的子区间；无交集时为 null。 */
  coveredFromMs: number | null
  coveredToMs: number | null
  /** 请求范围是否有一部分落在"尚未覆盖"的区域。 */
  hasUncovered: boolean
}

/**
 * 给定查询时间范围，回答"这一段的图片文字覆盖是否完整"。
 *
 * 判据刻意严格：只有当**整个请求区间**都落在已完成的覆盖并集里才回 `complete`。
 * 请求范围开放（不传 sinceMs / beforeMs）时视为"全部历史"，只要有任何一段没完成
 * 就是 `partial` —— 这正是零结果诚实性要的：0 条证据不能回答"没有"。
 */
export function imageTextRangeCoverage(
  coverage: ImageTextIndexCoverage,
  range: { sinceMs?: number; beforeMs?: number } = {}
): ImageTextRangeCoverage {
  if (!coverage.established) {
    return { state: 'not_built', coveredFromMs: null, coveredToMs: null, hasUncovered: true }
  }
  // 整体 complete = 全部图片消息都已定态 → 任意时间范围都完整，开放区间也一样。
  // 少了这一条，"全历史"这种没有上界的查询会永远因为"上界之后还没覆盖"被判成 partial。
  if (coverage.complete) {
    return { state: 'complete', coveredFromMs: null, coveredToMs: null, hasUncovered: false }
  }
  // 已完成分段 + 增量水位合并成"已覆盖并集"。
  //
  // `?? []` 不是多余的防御：覆盖度快照可能来自**旧版本落盘的库**（那时还没有分段概念），
  // 也可能来自手写的夹具。缺字段只应该让"时间维度"暂时不可用，绝不能让查询直接崩。
  const tiers = coverage.tiers ?? []
  const covered: { startMs: number; endMs: number }[] = tiers
    .filter((entry) => entry.state === 'complete')
    .map((entry) => ({ startMs: entry.startMs, endMs: entry.endMs }))
  if (coverage.coveredToMs !== null && coverage.coveredToMs !== undefined && tiers.length) {
    const anchorMs = tiers[0]?.endMs ?? coverage.coveredToMs
    covered.push({ startMs: anchorMs, endMs: coverage.coveredToMs })
  }
  const merged = mergeImageTextRanges(covered)

  // 查询范围：不给边界 = 全历史（-∞, +∞）。
  const queryStart = range.sinceMs ?? Number.NEGATIVE_INFINITY
  const queryEnd = range.beforeMs ?? Number.POSITIVE_INFINITY
  if (!(queryEnd > queryStart)) {
    return { state: 'complete', coveredFromMs: null, coveredToMs: null, hasUncovered: false }
  }

  let cursor = queryStart
  let coveredFromMs: number | null = null
  let coveredToMs: number | null = null
  for (const span of merged) {
    if (span.endMs <= cursor) continue
    if (span.startMs > cursor) break
    if (coveredFromMs === null) coveredFromMs = Math.max(span.startMs, queryStart)
    coveredToMs = Math.min(span.endMs, queryEnd)
    cursor = Math.min(span.endMs, queryEnd)
    if (cursor >= queryEnd) break
  }
  const hasUncovered = cursor < queryEnd
  return {
    state: hasUncovered ? 'partial' : 'complete',
    coveredFromMs: coveredFromMs === null ? null : coveredFromMs,
    coveredToMs,
    hasUncovered
  }
}

function mergeImageTextRanges(
  ranges: { startMs: number; endMs: number }[]
): { startMs: number; endMs: number }[] {
  const sorted = [...ranges].sort((left, right) => left.startMs - right.startMs)
  const merged: { startMs: number; endMs: number }[] = []
  for (const current of sorted) {
    const last = merged[merged.length - 1]
    if (last && current.startMs <= last.endMs) {
      if (current.endMs > last.endMs) last.endMs = current.endMs
      continue
    }
    merged.push({ ...current })
  }
  return merged
}

/**
 * 「哪些时间段已经**真正**可以放心搜」的人话描述。
 *
 * recent-first 之后，"索引建了多少"和"哪段时间能下确定结论"是两件事：
 * 最近 7 天可能已经 100% 可用，而更早的历史还在补齐。只给一个总百分比，
 * 模型会把"最近能搜"误当成"全历史都搜过了"，于是对"去年有没有发过 XXX"
 * 给出"没有"这种不该下的结论。
 */
export function describeImageTextCoveredRanges(coverage: ImageTextIndexCoverage): string {
  if (!coverage.established) return '还没有任何一个时间段完成图片文字索引。'
  const completed = (coverage.tiers ?? []).filter((entry) => entry.state === 'complete')
  if (coverage.complete) return '全部历史时间的图片文字都已可搜索。'
  if (!completed.length) return '还没有任何一个时间段完成图片文字索引。'
  const labels = completed.map((entry) => IMAGE_TEXT_BACKFILL_TIER_LABEL[entry.tier])
  // 只有归档段也完成才可能覆盖到最早；否则一定还有更老的历史没扫。
  const hasArchive = completed.some((entry) => entry.tier === 'archive')
  return hasArchive
    ? `已完整覆盖：${labels.join('、')}。`
    : `已完整覆盖：${labels.join('、')}；更早的图片仍在补齐。`
}

/**
 * 时间范围覆盖度的人话结论（Query Agent 只引用，不自己换算）。
 *
 * 与 `describeImageTextCoverage` 的分工：那个回答"整体建了多少"，
 * 这个回答"**这次查的这个时间段**能不能下确定性结论"。
 */
export function describeImageTextRangeCoverage(
  coverage: ImageTextIndexCoverage,
  range: { sinceMs?: number; beforeMs?: number } = {}
): string {
  const result = imageTextRangeCoverage(coverage, range)
  if (result.state === 'not_built') {
    return '图片文字索引尚未建立：当前范围内图片里的文字还搜不到，不能据此回答"没有"。'
  }
  if (result.state === 'complete') {
    return '图片文字索引已覆盖该时间范围：范围内没有匹配的图片文字，可以据此回答。'
  }
  return '图片文字历史仍在补齐，这次查询的时间范围尚未完整索引：当前结果不能排除尚未索引的图片。'
}

/** 单张图片的 OCR 结果状态。 */
export type ImageOcrState =
  /** 尚未处理 */
  | 'pending'
  /** 正在处理（进程中断后会回到 pending） */
  | 'processing'
  /** 成功识别出文字 */
  | 'indexed'
  /** 成功识别，但图片里没有文字（表情包 / 风景 / 头像…）——这是**正常终态**，不重试 */
  | 'empty'
  /** 图片消息本身缺少定位字段（md5 / datName），无法找到文件 */
  | 'metadata_missing'
  /** 图片文件已不存在（微信清理过原图与缩略图）——**正常终态**，不是 OCR 失败 */
  | 'image_missing'
  /**
   * 解密服务不可用（运行时环境问题）。
   *
   * **这不是单张图片的失败** —— 它意味着整条流水线的前置依赖缺失。
   * 它的存在会阻断 `complete`，并且正常流程应该在 preflight 就拦下、根本不写这种状态。
   */
  | 'decrypt_unavailable'
  /** 找到了文件，但解密失败（密钥/账号上下文不对，或文件损坏） */
  | 'decrypt_failed'
  /** 解密产出无法识别为图片格式（解码失败） */
  | 'decode_failed'
  /** 解码成功，但 OCR 执行失败 */
  | 'ocr_failed'
  /** 用户取消时正在处理 */
  | 'cancelled'

/**
 * 可以落库的状态。
 *
 * `processing` 是瞬态的（只存在于一次 pass 的内存里）：进程崩溃后它没有任何意义，
 * 而且它绝不允许进入 Knowledge 索引 —— Knowledge 只应该看到"已定态"。
 */
export type ImageOcrPersistedState = Exclude<ImageOcrState, 'processing'>

/** 终态集合：落在这里的状态不会在下次 pass 被自动重试。 */
export const IMAGE_OCR_TERMINAL_STATES: readonly ImageOcrState[] = [
  'indexed',
  'empty',
  'metadata_missing',
  'image_missing',
  'decrypt_failed',
  'decode_failed',
  'ocr_failed',
  'cancelled'
]

/**
 * 运行时不可用态：**不是**单张图片的终态。
 *
 * 它与终态分开，是为了让「这 4.5 万张都失败了」永远不能被当成"该条已处理"。
 */
export const IMAGE_OCR_RUNTIME_UNAVAILABLE_STATES: readonly ImageOcrState[] = [
  'decrypt_unavailable'
]

export function isTerminalImageOcrState(state: ImageOcrState): boolean {
  return IMAGE_OCR_TERMINAL_STATES.includes(state)
}

export function isRuntimeUnavailableImageOcrState(state: ImageOcrState): boolean {
  return IMAGE_OCR_RUNTIME_UNAVAILABLE_STATES.includes(state)
}

/**
 * **可重试的失败态**。
 *
 * 代码修好之后，这些状态的记录可以安全地重跑 —— 它们要么是运行时依赖缺失，
 * 要么是"当时环境不对"造成的失败。重置只删这些绑定与它们的 checkpoint，
 * 成功记录（indexed / empty）一条都不动。
 */
export const IMAGE_OCR_RETRIABLE_FAILURE_STATES: readonly ImageOcrPersistedState[] = [
  'decrypt_unavailable',
  'decrypt_failed',
  'decode_failed',
  'ocr_failed'
]

/**
 * OCR 运行时指纹。
 *
 * 缓存身份**不能只是图片 hash**：换 OCR 引擎 / 升级运行时 / 换语言配置之后
 * 必须允许重新识别，否则用户会永远拿到旧引擎的结果。
 */
export interface ImageOcrProvenance {
  engine: string
  platform: string
  runtimeVersion: string | null
  /** 实际使用的 OCR 语言标签；null 表示由系统用户语言决定。 */
  language: string | null
}

/**
 * artifact 去重键 = 图片内容身份 + OCR 运行时指纹。
 *
 * 刻意不包含 conversationId / messageId —— 同一张图片被转发到多个会话时，
 * OCR 只算一次，但会有多条 binding 指向同一个 artifact。
 */
export function buildImageOcrArtifactKey(input: {
  imageIdentity: string
  provenance: ImageOcrProvenance
}): string {
  const { imageIdentity, provenance } = input
  return [
    imageIdentity,
    provenance.engine,
    provenance.platform,
    provenance.runtimeVersion ?? 'unknown',
    provenance.language ?? 'auto'
  ].join('|')
}

/** 派生文本记录（按 artifact key 唯一）。 */
export interface ImageOcrArtifact {
  accountId: string
  artifactKey: string
  imageIdentity: string
  state: ImageOcrPersistedState
  /** OCR 正文；`empty` 状态为空串。 */
  text: string
  charCount: number
  engine: string
  platform: string
  runtimeVersion: string | null
  language: string | null
  /** 只在失败时写入；用于诊断，绝不包含 OCR 正文。 */
  errorCode?: string
  createdAt: number
  updatedAt: number
}

/** 「某会话的某条图片消息」到 artifact 的绑定。 */
export interface ImageOcrBinding {
  accountId: string
  conversationId: string
  messageId: string
  /** Unix epoch **毫秒**（Knowledge 契约统一用毫秒）。 */
  createTime: number
  senderId?: string
  senderName?: string
  /** 图片内容身份（去重维度 1）。 */
  imageIdentity: string
  /**
   * 指向的 artifact（内容身份 + OCR 运行时指纹）。
   *
   * 必须携带完整 artifact key 而不是只存 imageIdentity：换了 OCR 引擎/运行时之后
   * 同一张图会有多个 artifact，绑定必须能精确指到"这次用哪个指纹算出来的文本"。
   */
  artifactKey: string
  state: ImageOcrPersistedState
  updatedAt: number
}

/** 索引任务运行态。 */
export type ImageTextIndexRunState =
  | 'idle'
  | 'counting'
  | 'running'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'error'

/** 进度（面向 UI；只含数字与状态，绝不含 OCR 正文 / 路径 / wxid）。 */
export interface ImageTextIndexProgress {
  state: ImageTextIndexRunState
  /** 检测到的图片消息总数（SQL 统计，未解密）。 */
  totalImageMessages: number
  processed: number
  indexed: number
  empty: number
  missing: number
  failed: number
  /** 运行时不可用（如解密服务缺失）；不计入 processed，且会阻断 complete。 */
  runtimeUnavailable: number
  /** 系统性失败（处理过但一条都没成功）——UI 必须显示"异常"而不是"已建立"。 */
  systemicFailure: boolean
  pending: number
  /** 0–100，保留 1 位小数；未完成时封顶 99.9。 */
  percent: number
  /** 处理进度百分比（与 percent 同源，语义化别名）。 */
  processedPercent: number
  startedAt?: number
  updatedAt: number
  cancellable: boolean
  paused: boolean
  lastError?: string
  /**
   * 最近窗口（`IMAGE_TEXT_INDEX_RATE_WINDOW_MS`）的实测速度，单位 张/秒。
   *
   * 刻意用**滑动窗口**而不是整个任务的平均：全量回填要跑几小时，
   * 历史平均会把"现在到底快不快"完全糊掉。样本跨度不足时为 null（UI 显示"计算中"）。
   */
  speedPerSec?: number | null
  /** 按当前窗口速度估算的剩余时间（毫秒）；速度不可用或分母不可信时为 null。 */
  etaMs?: number | null
  /**
   * 当前正在处理的阶段（recent-first 的可见性）。
   *
   * **它只是阶段提示，不是进度**：总进度仍然必须是 `processed / totalImageMessages`
   * （全量图片消息），绝不允许用"某个分段处理完了"冒充整体完成。
   */
  currentPhase?: ImageTextIndexPhase
}

/**
 * 图片文字索引的覆盖度 —— **独立的覆盖维度**。
 *
 * 文字消息索引 100% 不代表图片文字可用；Query Agent 必须能单独看到这一维。
 */
export interface ImageTextIndexCoverage {
  totalImageMessages: number
  /** 已进入**非运行时**终态的条数（indexed + empty + missing + failed）。 */
  processed: number
  indexed: number
  empty: number
  missing: number
  failed: number
  /**
   * 运行时不可用（如解密服务缺失）的条数。
   *
   * 单独一列、**不计入 processed**：它代表"流水线前置依赖缺失"，
   * 绝不能与"这条图片已经处理过了"混为一谈。
   */
  runtimeUnavailable: number
  pending: number
  /** 是否建立过（有落盘统计且处理过）。 */
  established: boolean
  /** 是否**真正**覆盖完整（分母可信 + 无 pending + 无运行时不可用 + 不是"全军覆没"）。 */
  complete: boolean
  /**
   * 系统性失败：处理过一批，但 indexed / empty / missing 全为 0、失败却不为 0。
   *
   * 这就是"4.5 万张全部失败、却告诉用户已建立"那种情况的判据 ——
   * 它必须阻断 `complete`，并让 UI 显示"异常"。
   */
  systemicFailure: boolean
  /**
   * `totalImageMessages` 的统计时刻（epoch ms）；null = 从未统计过。
   *
   * 必须有这个时间戳：total 是**某一时刻**的 SQL 统计，之后微信里新增的图片
   * 还没进索引。只说"已覆盖全部 N 条"而不给统计时刻，就是在把「当时完整」
   * 冒充成「现在完整」。
   */
  countedAt: number | null
  /**
   * 各历史分段的完成状态与边界（新 → 旧）。未建立 / 旧快照时为 `[]`。
   *
   * 边界来自**当时固定的锚点**，因此可以和用户查询的时间范围直接求交。
   */
  tiers: ImageTextTierCoverage[]
  /**
   * 增量补齐水位：`create_time <= coveredToMs` 的新图片都已处理完；null = 尚无。
   *
   * 它单独存在的原因：锚点之后新到的图片不属于任何历史分段，必须有独立水位
   * 才能回答"最近这几个小时是否已经可搜"。
   */
  coveredToMs: number | null
}

/** 覆盖度状态（外加"未建立"）。UI 与 Query Agent 共用同一判据，避免两处各推一套口径漂移。 */
export type ImageTextCoverageState = 'not_built' | 'partial' | 'complete' | 'failed'

export function imageTextCoverageState(coverage: ImageTextIndexCoverage): ImageTextCoverageState {
  if (!coverage.established) return 'not_built'
  if (coverage.systemicFailure) return 'failed'
  return coverage.complete ? 'complete' : 'partial'
}

/**
 * 处理进度百分比。
 *
 * 保留 1 位小数，且**未完成时封顶 99.9%**：直接四舍五入会把 99.5% 显示成 100%，
 * 于是出现"已建立 · 仅完成 100%"这种自相矛盾的显示。进度条可以近似，结论句不行。
 */
export function imageTextProcessedPercent(processed: number, total: number): number {
  if (!(total > 0)) return 0
  const raw = (processed / total) * 100
  if (raw >= 100) return 100
  return Math.min(99.9, Math.round(raw * 10) / 10)
}

/** 覆盖度的人话结论，供 Query Agent / UI 直接引用。 */
export function describeImageTextCoverage(coverage: ImageTextIndexCoverage): string {
  if (!coverage.established) {
    return '图片文字索引尚未建立：目前只能搜索文字消息，图片里的文字还搜不到。'
  }
  if (coverage.systemicFailure) {
    return `图片文字索引当前异常：已处理的 ${coverage.processed.toLocaleString()} 条图片消息全部失败（成功识别 0 条、无文字 0 条、图片缺失 0 条）。当前无法搜索图片中的文字。`
  }
  if (coverage.complete) {
    return `图片文字索引已覆盖全部 ${coverage.totalImageMessages.toLocaleString()} 条图片消息。`
  }
  const percent = imageTextProcessedPercent(coverage.processed, coverage.totalImageMessages)
  return `图片文字索引只完成 ${percent}%（${coverage.processed.toLocaleString()} / ${coverage.totalImageMessages.toLocaleString()} 条图片消息），当前图片搜索结果可能不完整。`
}

/** 快速统计结果（不含解密）。 */
export interface ImageTextIndexCountResult {
  totalImageMessages: number
  scannedConversations: number
  /**
   * 统计失败（拿不到数）的会话数。
   *
   * 必须与 `totalImageMessages = 0` 区分开：**"一张图片都没有"和"根本没数成"是两件事**。
   * 把后者显示成 0 会让用户以为账号里没有图片，从而放弃建立索引 —— 这正是本功能
   * 一直在避免的那类谎话。
   */
  failedConversations: number
  /** 实际用于判定"这是图片消息"的列名；null = 一个会话都没探测到。 */
  typeColumn: string | null
  /** 失败原因摘要（仅供诊断，不含用户数据）。 */
  error?: string
  durationMs: number
}

/**
 * 单个会话的图片消息计数结果。
 *
 * `count: null` = **统计失败**，不等于 0 张。调用方必须区分处理。
 */
export interface ImageMessageCountProbe {
  count: number | null
  /** 实际用于判定图片消息的类型列名。 */
  typeColumn: string | null
  /** 失败原因摘要（不含任何用户内容）。 */
  error?: string
}

/**
 * 会话级增量水位。
 *
 * 刻意用 **两个** 判据而不是只比 count：
 * - `count` 能发现大多数增删；
 * - `maxLocalId`（消息插入序的最大值）能发现「总数相同但集合变了」——
 *   例如撤回一张旧图的同时新增一张新图，count 不变但新图的 local_id 更大。
 *
 * 只用 count 会静默漏掉新图片；只用 create_time 会被「后到的旧时间消息」
 * （网络延迟 / 消息恢复 / 合并转发回填）骗过。`local_id` 是 WCDB 行内单调的
 * 插入序，对 append 与「等量替换」两种情况都成立。
 */
export interface ImageMessageWatermark {
  count: number
  /** 该会话图片消息的最大插入序；没有图片时为 0。 */
  maxLocalId: number
}

/**
 * 派生索引修复的结果。
 *
 * 分层前提（任何一层都不许越界去动上一层）：
 * - L1 Image OCR Artifact —— 昂贵，持久化，**尽量永不重复计算**
 * - L2 Message Binding —— 便宜，可修复
 * - L3 Knowledge Derived Entry / FTS —— 便宜，可重建
 * - L4 Query Agent / Evidence —— 查询层，只读
 *
 * 修 L2/L3/L4 **绝不能**自动清 L1。`ocrExecutions` 因此被写死成字面量 `0`：
 * 修复路径一旦开始调 OCR，类型就不再成立，编译期就会拦下来。
 */
export interface ImageTextIndexRepairResult {
  /** 实际重建了派生索引的会话数。 */
  conversations: number
  /** 永远是 0 —— 修复路径禁止触发 OCR（这一条是契约，不是观察值）。 */
  ocrExecutions: 0
  durationMs: number
  /** 索引任务正在运行时拒绝并发修复（避免读到半程 binding）。 */
  skipped: boolean
}

/** 派生数据占用（设置 → 缓存与清理）。 */
export interface ImageTextIndexStorageStats {
  indexedImages: number
  ocrTextCount: number
  totalBytes: number
  updatedAt: number | null
}

/** 索引过程中用于写入派生库的单条结果。 */
export interface ImageOcrWriteInput {
  accountId: string
  conversationId: string
  messageId: string
  createTime: number
  senderId?: string
  senderName?: string
  /** 已解密的图片内容身份；取不到图片时为 null。 */
  imageIdentity: string | null
  state: ImageOcrPersistedState
  text: string
  provenance: ImageOcrProvenance
  errorCode?: string
}

/** 索引服务的启动参数。 */
export interface ImageTextIndexStartOptions {
  /** 只处理前 N 个会话，用于受控 smoke；不传 = 全量。 */
  conversationLimit?: number
  /** 只处理前 N 条图片消息，用于受控 smoke。 */
  messageLimit?: number
  /**
   * 只处理这个时刻（epoch ms）**之后**的图片消息；不传 = 全部历史。
   *
   * 存在的意义是**可验证性**：几万张图片的全量回填没法用来排查问题，
   * 先跑"最近一天"这种小窗口才能证明链路是通的。
   * 带窗口运行时会**跳过增量跳过逻辑**（每次都重扫窗口内的消息），
   * 因为 checkpoint 是围绕全量集合建立的，混用会让"跳过"变得不可解释。
   */
  sinceMs?: number
}

/** 单个阶段的耗时聚合。**只含性能数字**，不含任何图片内容 / 路径 / 标识。 */
export interface ImageTextIndexStageStat {
  count: number
  mean: number
  p50: number
  p95: number
  max: number
}

/**
 * backfill 的**只读性能画像**，用来回答"时间花在哪一段"。
 *
 * 只写性能数字，不含图片内容 / 路径 / 会话标识；UI 不渲染，仅落到 app log。
 * 刻意不暴露单张图片的耗时序列：那会把"哪张图慢"变成可推断的信息。
 */
export interface ImageTextIndexStageTimings {
  /** 本遍累计计数（与 UI 进度同源）。让这一行日志自洽，不必再去别处对数。 */
  counters: {
    processed: number
    indexed: number
    empty: number
    missing: number
    failed: number
  }
  /** 最近窗口的实测速度（张/秒）；样本不足或分母不可信时为 null。 */
  ratePerSec: number | null
  /** 本遍实际执行过的 OCR 次数（命中已有 artifact 而跳过的不计）。 */
  ocrExecutions: number
  /** 本遍生效的 OCR 并发度。 */
  ocrConcurrency: number
  /** 找图片文件（同步，占主线程）。 */
  locate: ImageTextIndexStageStat
  /** 解密（同步 + CPU，占主线程）。 */
  decrypt: ImageTextIndexStageStat
  /** 构造可识别输入（base64 编码；Windows 还包含转 PNG）。 */
  normalize: ImageTextIndexStageStat
  /** 识别（异步）。 */
  ocr: ImageTextIndexStageStat
  /** 写 artifact + binding（SQLite，单 writer）。 */
  persist: ImageTextIndexStageStat
  /**
   * 单张图片在流水线里的净耗时。
   *
   * 分母只含真正进入流水线的图片，所以这个值可以直接与上面五段之和对照；
   * **不要用"整遍耗时 ÷ 处理张数"**，那会把 `preLoop` 的一次性成本摊进每张图片。
   */
  perImageMs: number
  /**
   * 本遍因为"没有可搜索内容变化"而**跳过** Knowledge 重建的会话数。
   *
   * 与 `preLoop.onConversationIndexedMs` 配套看：跳过越多、那段时间越小，
   * 说明门控在起作用。它同时是"到底有没有白做"的直接证据。
   */
  knowledgeIndexSkipped: number
  /** 进入流水线**之前**的一次性成本（不按图片数摊）。 */
  preLoop: ImageTextIndexPreLoopCost
}

/**
 * 流水线**之外**的成本（单位毫秒），用来解释"单张成本很低、整遍却很慢"。
 *
 * 这个结构的每一个字段都是"有理由不属于单张成本"的量：
 * 一次性的、每会话一次的、以及**别的模块**的。它们必须单独可见 ——
 * 否则 `perImageMs` 会看起来很好，而墙钟吞吐差好几倍，且无从归因。
 */
export interface ImageTextIndexPreLoopCost {
  /** 一遍 pass 开始前的一次性成本（能力探测 + 全账号图片统计 + 会话列表）。 */
  startupMs: number
  /** └ 其中：统计图片消息总数（遍历全部会话的 SQL）。 */
  countImageMessagesMs: number
  /** 每个会话进入流水线前的准备累计（水位 / 计数 / `listMessages`）。 */
  conversationSetupMs: number
  /** └ 其中：读取并格式化会话消息累计。**已知的大头之一**。 */
  listMessagesMs: number
  /**
   * 会话完成后等待 Knowledge 重建（`onConversationIndexed`）的累计。
   *
   * 这是**别的模块**的成本：Knowledge 侧会对同一个会话再全量读一遍消息并整篇写索引，
   * 而且如果此时有索引在跑还会先等它。它不在 batch 循环里，所以 `perImageMs` 看不到它。
   */
  onConversationIndexedMs: number
}

/** 对外状态快照（问问微信卡片 / 设置清理页共用同一份）。 */
export interface ImageTextIndexStatus {
  progress: ImageTextIndexProgress
  coverage: ImageTextIndexCoverage
  storage: ImageTextIndexStorageStats
  /** 正在做「检测到多少条图片消息」的 SQL 统计。 */
  counting: boolean
  /** 各阶段耗时画像（可选的附加诊断字段，UI 不渲染）。 */
  stageTimings?: ImageTextIndexStageTimings
}
