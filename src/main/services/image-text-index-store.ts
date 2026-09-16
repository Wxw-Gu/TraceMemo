/**
 * 图片文字索引的**派生存储**（与 Knowledge 派生库物理分离）。
 *
 * 为什么单独一个库而不是往 knowledge.sqlite 里加表：
 * - 清理语义干净：整个能力 = 三个文件（.sqlite/-wal/-shm），删掉即可，不留残渣。
 * - 零迁移风险：不动已发布的 knowledge schema（§26 要求升级不破坏既有派生库）。
 * - 去重语义天然：artifact 按「图片内容 + OCR 运行时指纹」唯一，binding 承担多来源。
 *
 * 账号隔离与 Knowledge 一致：路径按 accountId 摘要分目录 + 库内 account_id 自证。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, statSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  IMAGE_TEXT_INDEX_SCHEMA_VERSION,
  type ImageOcrArtifact,
  type ImageOcrBinding,
  type ImageOcrPersistedState,
  type ImageTextIndexStorageStats
} from '../../shared/image-text-index'

const MAX_SAFE_ACCOUNT_SEGMENT = /^[a-f0-9]{32}$/

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** 派生库目录名不直接暴露 accountId。 */
export function imageTextIndexAccountKey(accountId: string): string {
  return sha256Hex(`image-text-index-account-v1:${accountId}`).slice(0, 32)
}

export function getImageTextIndexDatabasePath(databaseRoot: string, accountId: string): string {
  const accountKey = imageTextIndexAccountKey(accountId)
  if (!MAX_SAFE_ACCOUNT_SEGMENT.test(accountKey)) {
    throw new Error('Invalid image text index account key')
  }
  return join(resolve(databaseRoot), accountKey, 'image-text-index.sqlite')
}

/**
 * 精确删除三件套（与 Knowledge 的 removeKnowledgeDatabase 同构）。
 *
 * **删除后必须回验**：Windows 上只要还有句柄（WAL/SHM 未关干净、别的进程打开了库），
 * `rmSync` 可能不报错却没真的删掉 —— 那就是"看似清理成功，实际没删"。
 * 这里把没删掉的路径返回给调用方，让上层能如实报告失败，而不是假装成功。
 */
export function removeImageTextIndexDatabase(databasePath: string): {
  removed: boolean
  leftovers: string[]
} {
  const leftovers: string[] = []
  for (const suffix of ['', '-wal', '-shm']) {
    const target = `${databasePath}${suffix}`
    if (!existsSync(target)) continue
    try {
      rmSync(target, { force: true })
    } catch {
      // 删除失败（典型原因是文件仍被占用）→ 由下面的回验兜住。
    }
    if (existsSync(target)) leftovers.push(target)
  }
  return { removed: leftovers.length === 0, leftovers }
}

function asRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : []
}

function artifactFromRow(row: Record<string, unknown>): ImageOcrArtifact {
  return {
    accountId: String(row.account_id),
    artifactKey: String(row.artifact_key),
    imageIdentity: String(row.image_identity),
    state: String(row.state) as ImageOcrPersistedState,
    text: String(row.text ?? ''),
    charCount: Number(row.char_count ?? 0),
    engine: String(row.engine),
    platform: String(row.platform),
    runtimeVersion: row.runtime_version ? String(row.runtime_version) : null,
    language: row.language ? String(row.language) : null,
    ...(row.error_code ? { errorCode: String(row.error_code) } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  }
}

/** 会话内「消息 → OCR 文本」，供 Knowledge 索引时解析（与语音 resolver 同构）。 */
export interface ConversationImageOcrEntry {
  state: ImageOcrPersistedState
  text: string
}

export class ImageTextIndexStore {
  private readonly database: DatabaseSync

  constructor(
    private readonly databasePath: string,
    private readonly accountId: string
  ) {
    mkdirSync(dirname(databasePath), { recursive: true })
    this.database = new DatabaseSync(databasePath)
    this.initialize()
  }

  private initialize(): void {
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS image_ocr_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS image_ocr_artifacts (
        artifact_key TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        image_identity TEXT NOT NULL,
        state TEXT NOT NULL,
        text TEXT NOT NULL,
        char_count INTEGER NOT NULL DEFAULT 0,
        engine TEXT NOT NULL,
        platform TEXT NOT NULL,
        runtime_version TEXT,
        language TEXT,
        error_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS image_ocr_artifacts_identity
        ON image_ocr_artifacts (image_identity);
      CREATE TABLE IF NOT EXISTS image_ocr_bindings (
        conversation_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        create_time INTEGER NOT NULL,
        sender_id TEXT,
        sender_name TEXT,
        image_identity TEXT NOT NULL,
        artifact_key TEXT NOT NULL,
        state TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, message_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS image_ocr_bindings_identity
        ON image_ocr_bindings (image_identity);
      CREATE INDEX IF NOT EXISTS image_ocr_bindings_state
        ON image_ocr_bindings (state);
      -- 每个会话的扫描 checkpoint：重启后据此跳过已完成的会话。
      CREATE TABLE IF NOT EXISTS image_ocr_scan_state (
        conversation_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        state TEXT NOT NULL,
        image_total INTEGER NOT NULL DEFAULT 0,
        image_processed INTEGER NOT NULL DEFAULT 0,
        image_max_local_id INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `)

    // 探测式加列（与 Knowledge 一致）：旧库缺列时补上，不做版本号比较。
    const bindingColumns = new Set(
      asRows(this.database.prepare('PRAGMA table_info(image_ocr_bindings)').all()).map((row) =>
        String(row.name)
      )
    )
    if (!bindingColumns.has('artifact_key')) {
      this.database.exec(
        "ALTER TABLE image_ocr_bindings ADD COLUMN artifact_key TEXT NOT NULL DEFAULT ''"
      )
    }

    const scanColumns = new Set(
      asRows(this.database.prepare('PRAGMA table_info(image_ocr_scan_state)').all()).map((row) =>
        String(row.name)
      )
    )
    if (!scanColumns.has('image_max_local_id')) {
      // 旧库补列后默认 0：等于「水位未知」，下一次 pass 会重扫该会话并写入真实水位。
      this.database.exec(
        'ALTER TABLE image_ocr_scan_state ADD COLUMN image_max_local_id INTEGER NOT NULL DEFAULT 0'
      )
    }

    const storedAccount = this.readMeta('account_id')
    if (storedAccount && storedAccount !== this.accountId) {
      throw new Error('Image text index account isolation check failed')
    }
    if (!storedAccount) this.writeMeta('account_id', this.accountId)
    if (!this.readMeta('schema_version')) {
      this.writeMeta('schema_version', String(IMAGE_TEXT_INDEX_SCHEMA_VERSION))
    }
  }

  private readMeta(key: string): string | null {
    const row = this.database
      .prepare('SELECT value FROM image_ocr_meta WHERE key = ?')
      .get(key) as Record<string, unknown> | undefined
    return row ? String(row.value) : null
  }

  private writeMeta(key: string, value: string): void {
    this.database
      .prepare(
        'INSERT INTO image_ocr_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, value)
  }

  // ---------------------------------------------------------------- artifacts

  getArtifact(artifactKey: string): ImageOcrArtifact | null {
    const row = this.database
      .prepare('SELECT * FROM image_ocr_artifacts WHERE artifact_key = ?')
      .get(artifactKey) as Record<string, unknown> | undefined
    return row ? artifactFromRow(row) : null
  }

  putArtifact(artifact: ImageOcrArtifact): void {
    if (artifact.accountId !== this.accountId) {
      throw new Error('Image OCR artifact account does not match database')
    }
    const existing = this.getArtifact(artifact.artifactKey)
    this.database
      .prepare(
        `INSERT INTO image_ocr_artifacts (
          artifact_key, account_id, image_identity, state, text, char_count,
          engine, platform, runtime_version, language, error_code, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(artifact_key) DO UPDATE SET
          state = excluded.state,
          text = excluded.text,
          char_count = excluded.char_count,
          runtime_version = excluded.runtime_version,
          language = excluded.language,
          error_code = excluded.error_code,
          updated_at = excluded.updated_at`
      )
      .run(
        artifact.artifactKey,
        artifact.accountId,
        artifact.imageIdentity,
        artifact.state,
        artifact.text,
        artifact.charCount,
        artifact.engine,
        artifact.platform,
        artifact.runtimeVersion,
        artifact.language,
        artifact.errorCode ?? null,
        existing?.createdAt ?? artifact.createdAt,
        artifact.updatedAt
      )
  }

  // ----------------------------------------------------------------- bindings

  /** 写入绑定；同一 OCR 结果可被多个会话/消息引用。 */
  putBinding(binding: ImageOcrBinding): void {
    if (binding.accountId !== this.accountId) {
      throw new Error('Image OCR binding account does not match database')
    }
    this.database
      .prepare(
        `INSERT INTO image_ocr_bindings (
          conversation_id, message_id, account_id, create_time, sender_id, sender_name,
          image_identity, artifact_key, state, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id, message_id) DO UPDATE SET
          create_time = excluded.create_time,
          sender_id = excluded.sender_id,
          sender_name = excluded.sender_name,
          image_identity = excluded.image_identity,
          artifact_key = excluded.artifact_key,
          state = excluded.state,
          updated_at = excluded.updated_at`
      )
      .run(
        binding.conversationId,
        binding.messageId,
        binding.accountId,
        binding.createTime,
        binding.senderId ?? null,
        binding.senderName ?? null,
        binding.imageIdentity,
        binding.artifactKey,
        binding.state,
        binding.updatedAt
      )
  }

  /**
   * 某会话的「消息 → OCR 文本」映射。
   *
   * 与语音的 `withVoiceTranscript` 同构：在**主进程**把派生文本贴到消息上，
   * 再交给 Knowledge 索引，派生库不需要被 worker 打开。
   */
  getConversationOcr(
    conversationId: string
  ): Map<string, ConversationImageOcrEntry> {
    const rows = asRows(
      this.database
        .prepare(
          `SELECT b.message_id AS message_id, b.state AS binding_state,
                  a.state AS artifact_state, a.text AS text
           FROM image_ocr_bindings b
           LEFT JOIN image_ocr_artifacts a ON a.artifact_key = b.artifact_key
           WHERE b.conversation_id = ?`
        )
        .all(conversationId)
    )
    const result = new Map<string, ConversationImageOcrEntry>()
    for (const row of rows) {
      result.set(String(row.message_id), {
        state: String(row.artifact_state || row.binding_state) as ImageOcrPersistedState,
        text: String(row.text ?? '')
      })
    }
    return result
  }

  // -------------------------------------------------------------- checkpoint

  /**
   * 已持久化的图片消息总数统计。
   *
   * 必须落盘：派生库只知道自己**处理过**什么，不知道源数据里**一共**有多少图片。
   * 一旦把这个 total 只放在内存里，应用重启后 coverage 就会退化成
   * 「processed / processed」→ 把 30% 的部分索引谎报成 100% 完整覆盖。
   */
  readCountedTotal(): { total: number; countedAt: number; complete: boolean } | null {
    const total = this.readMeta('total_image_messages')
    const countedAt = this.readMeta('total_image_counted_at')
    if (total === null || countedAt === null) return null
    const parsedTotal = Number(total)
    const parsedCountedAt = Number(countedAt)
    if (!Number.isFinite(parsedTotal) || !Number.isFinite(parsedCountedAt)) return null
    return {
      total: parsedTotal,
      countedAt: parsedCountedAt,
      // 统计时若有会话没数上（数据库不支持该统计），分母就是偏小的 →
      // 绝不能据此声称"已覆盖全部"，否则少数的那些会话会被静默算进"已覆盖"。
      complete: this.readMeta('total_image_messages_complete') === '1'
    }
  }

  writeCountedTotal(input: { total: number; countedAt: number; complete: boolean }): void {
    this.writeMeta('total_image_messages', String(input.total))
    this.writeMeta('total_image_counted_at', String(input.countedAt))
    this.writeMeta('total_image_messages_complete', input.complete ? '1' : '0')
  }

  readScanState(): Map<
    string,
    { state: string; imageTotal: number; processed: number; maxLocalId: number }
  > {
    const rows = asRows(
      this.database
        .prepare(
          'SELECT conversation_id, state, image_total, image_processed, image_max_local_id FROM image_ocr_scan_state'
        )
        .all()
    )
    const map = new Map<
      string,
      { state: string; imageTotal: number; processed: number; maxLocalId: number }
    >()
    for (const row of rows) {
      map.set(String(row.conversation_id), {
        state: String(row.state),
        imageTotal: Number(row.image_total ?? 0),
        processed: Number(row.image_processed ?? 0),
        maxLocalId: Number(row.image_max_local_id ?? 0)
      })
    }
    return map
  }

  writeScanState(input: {
    conversationId: string
    state: 'done' | 'partial'
    imageTotal: number
    imageProcessed: number
    /** 本会话图片消息的最大插入序（增量水位）。 */
    maxLocalId: number
  }): void {
    this.database
      .prepare(
        `INSERT INTO image_ocr_scan_state (
          conversation_id, account_id, state, image_total, image_processed,
          image_max_local_id, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET
          state = excluded.state,
          image_total = excluded.image_total,
          image_processed = excluded.image_processed,
          image_max_local_id = excluded.image_max_local_id,
          updated_at = excluded.updated_at`
      )
      .run(
        input.conversationId,
        this.accountId,
        input.state,
        input.imageTotal,
        input.imageProcessed,
        input.maxLocalId,
        Date.now()
      )
  }

  // ------------------------------------------------------------------ 统计

  /**
   * 有 OCR 派生绑定的会话集合。
   *
   * 清理时**必须**先拿到它：OCR 文本早已被灌进 Knowledge 的 chunks / FTS，
   * 只删派生病不会让那些派生文字失效 —— 用户仍会从旧索引里搜到图片里的文字。
   */
  conversationIdsWithOcr(): string[] {
    const rows = asRows(
      this.database.prepare('SELECT DISTINCT conversation_id FROM image_ocr_bindings').all()
    )
    return rows.map((row) => String(row.conversation_id))
  }

  /**
   * **有 OCR 派生文本**（artifact 里 char_count > 0）的会话集合。
   *
   * 派生索引修复只需要重建它们：只有这些会话的 Knowledge 里"应该"存在图片派生文字。
   * 全是 `empty` 的会话本来就没有派生文字可修，重建它们只是白读一遍 WCDB。
   */
  conversationIdsWithIndexedOcr(): string[] {
    const rows = asRows(
      this.database
        .prepare(
          `SELECT DISTINCT b.conversation_id AS conversation_id
           FROM image_ocr_bindings b
           JOIN image_ocr_artifacts a ON a.artifact_key = b.artifact_key
           WHERE a.char_count > 0`
        )
        .all()
    )
    return rows.map((row) => String(row.conversation_id))
  }

  /**
   * 重置指定状态的失败记录，让它们可以被下一轮 pass 重新处理。
   *
   * 用途：**代码修好后**，把上一次 bug 造成的假失败（例如整批 `decrypt_failed`）
   * 变成可重试状态，而不是要求用户删掉整个派生库 —— 那会连已经成功的记录一起丢掉。
   *
   * 三件事一起做，缺一不可：
   * 1. 删掉这些失败绑定；
   * 2. 删掉它们所在会话的 checkpoint —— 否则 pass 会以"该会话已完成"直接跳过，
   *    表现为"点了重试但什么都没发生"；
   * 3. 删掉因此变成孤儿的 artifact（**没有任何绑定再引用的**才删，成功记录一条不动）。
   */
  resetFailures(states: ImageOcrPersistedState[]): number {
    if (!states.length) return 0
    const placeholders = states.map(() => '?').join(', ')
    const affected = asRows(
      this.database
        .prepare(
          `SELECT DISTINCT conversation_id FROM image_ocr_bindings WHERE state IN (${placeholders})`
        )
        .all(...states)
    ).map((row) => String(row.conversation_id))
    const artifactKeys = asRows(
      this.database
        .prepare(
          `SELECT DISTINCT artifact_key FROM image_ocr_bindings WHERE state IN (${placeholders})`
        )
        .all(...states)
    ).map((row) => String(row.artifact_key))

    const info = this.database
      .prepare(`DELETE FROM image_ocr_bindings WHERE state IN (${placeholders})`)
      .run(...states)

    const clearScan = this.database.prepare(
      'DELETE FROM image_ocr_scan_state WHERE conversation_id = ?'
    )
    for (const conversationId of affected) clearScan.run(conversationId)

    const dropOrphan = this.database.prepare(
      `DELETE FROM image_ocr_artifacts
        WHERE artifact_key = ?
          AND NOT EXISTS (SELECT 1 FROM image_ocr_bindings b WHERE b.artifact_key = ?)`
    )
    for (const artifactKey of artifactKeys) dropOrphan.run(artifactKey, artifactKey)

    return Number(info.changes ?? 0)
  }

  /** 按状态聚合绑定数 —— 覆盖度与进度都从这里取，保证与库内真实一致。 */
  countByState(): Record<string, number> {    const rows = asRows(
      this.database
        .prepare('SELECT state, COUNT(*) AS total FROM image_ocr_bindings GROUP BY state')
        .all()
    )
    const counts: Record<string, number> = {}
    for (const row of rows) counts[String(row.state)] = Number(row.total ?? 0)
    return counts
  }

  storageStats(): ImageTextIndexStorageStats {
    const counts = this.countByState()
    const textRow = this.database
      .prepare(
        "SELECT COUNT(*) AS total FROM image_ocr_artifacts WHERE state = 'indexed' AND length(text) > 0"
      )
      .get() as Record<string, unknown> | undefined
    const updatedRow = this.database
      .prepare('SELECT MAX(updated_at) AS latest FROM image_ocr_bindings')
      .get() as Record<string, unknown> | undefined
    let totalBytes = 0
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        totalBytes += statSync(`${this.databasePath}${suffix}`).size
      } catch {
        // 文件可能尚未创建；忽略。
      }
    }
    const latest = updatedRow?.latest
    return {
      indexedImages: counts['indexed'] ?? 0,
      ocrTextCount: Number(textRow?.total ?? 0),
      totalBytes,
      updatedAt: latest === null || latest === undefined ? null : Number(latest)
    }
  }

  /** 清空全部派生数据（表级清空；文件级删除由 service 负责）。 */
  clearAll(): void {
    this.database.exec(`
      DELETE FROM image_ocr_bindings;
      DELETE FROM image_ocr_artifacts;
      DELETE FROM image_ocr_scan_state;
      DELETE FROM image_ocr_meta WHERE key IN (
        'total_image_messages',
        'total_image_counted_at',
        'total_image_messages_complete'
      );
    `)
  }

  /**
   * 清空并重置检查点。
   *
   * 注意：必须同时清 `scan_state`，否则清理后再次索引会因为「会话已完成」
   * 而直接跳过 —— UI 会停在「未建立」但实际再也不跑。
   */
  clearDerivedData(): void {
    this.clearAll()
  }

  close(): void {
    try {
      // 先折叠 WAL 再关连接：否则 -wal / -shm 可能仍被持有，
      // Windows 上会导致后续 rmSync 静默失败（"清理成功"但文件还在）。
      this.database.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    } catch {
      // 库可能已经处于不可写状态；关闭仍然要做。
    }
    try {
      this.database.close()
    } catch {
      // best effort
    }
  }
}
