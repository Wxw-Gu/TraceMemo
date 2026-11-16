import { app } from 'electron'
import crypto from 'crypto'
import fs from 'fs-extra'
import path from 'path'
import type { Contact, Message } from '../../shared/types'

export interface CachedSelfInfo {
  wxid: string
  nickname: string
  avatar?: string
  accountRoot: string
}

export interface CachedGroupSnapshot {
  roomId: string
  memberCount: number
  members: {
    wxid: string
    nickname: string
    groupNickname: string
    wechatNickname: string
    remark: string
    avatar: string
  }[]
}

interface StartupCacheFile {
  version: 2
  platform: NodeJS.Platform
  accountRoot: string
  updatedAt: number
  self?: CachedSelfInfo
  contacts: Contact[]
}

interface CachedMessageBucketFile {
  version: 2
  platform: NodeJS.Platform
  accountRoot: string
  cacheKey: string
  updatedAt: number
  startTime?: number
  endTime?: number
  items: Message[]
}

interface CachedGroupSnapshotFile {
  version: 2
  platform: NodeJS.Platform
  accountRoot: string
  userMd5: string
  updatedAt: number
  snapshot: CachedGroupSnapshot
}

interface ScheduledWrite {
  value: unknown
  /** 内容指纹，与 value 一一对应；用于判断"磁盘上是否已经是这份内容" */
  signature: string
  revision: number
  generation: number
  cleanupFile?: string
  prune?: { directory: string; maxFiles: number }
}

interface AccountCachePaths {
  root: string
  startup: string
  messages: string
  groups: string
  legacy: string
}

const CACHE_VERSION = 2
const MAX_MESSAGE_BUCKETS = 768
const MAX_GROUP_SNAPSHOTS = 768
const MAX_MESSAGES_PER_BUCKET = 120
const MAX_MEMORY_MESSAGE_BUCKETS = 32
const MAX_MEMORY_GROUP_SNAPSHOTS = 32
const WRITE_DEBOUNCE_MS = 300
const PRUNE_INTERVAL_MS = 30_000

/**
 * 替换目标文件时的重试节奏（毫秒）。
 *
 * 覆盖写走 `rename`（Windows 上是 MoveFileEx+REPLACE_EXISTING），杀软扫描、索引器
 * 短暂持有句柄都会让它抛 EPERM/EBUSY/EACCES —— 这类占用是瞬时的，重试即可。
 * 4 次总计约 0.5s，超过这个量级说明是真的写不进去，应该保留旧缓存而不是继续磨。
 */
const REPLACE_RETRY_DELAYS_MS = [40, 120, 300] as const
/** 可重试的瞬时错误码。除此以外的错误重试也不会好。 */
const REPLACE_RETRYABLE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY', 'EAGAIN'])
/**
 * 退出刷盘的重试总预算（毫秒）。
 *
 * 单文件最坏重试等待 40+120+300=460ms；待写文件一多，累加起来就是肉眼可见的
 * 退出卡顿。这里给整批一个固定预算，预算耗尽后不再等待重试，剩余文件各试一次。
 * 首次尝试（真正的 writeFileSync + renameSync）不受预算限制 —— 那是必须做的写。
 */
const FLUSH_RETRY_BUDGET_MS = 120
/** 恢复写入用临时文件名的偏移量，避免与普通 revision 撞名。 */
const RESTORE_REVISION_OFFSET = 1_000_000

const startupMemory = new Map<string, StartupCacheFile>()
const messageMemory = new Map<string, CachedMessageBucketFile>()
const groupMemory = new Map<string, CachedGroupSnapshotFile>()
const writeTimers = new Map<string, NodeJS.Timeout>()
const writeQueues = new Map<string, Promise<void>>()
const scheduledWrites = new Map<string, ScheduledWrite>()
const writeRevisions = new Map<string, number>()
const lastPrunedAt = new Map<string, number>()
/**
 * 磁盘上**已经确认写入成功**的内容指纹。
 *
 * 与 `startupMemory` / `scheduledWrites` 是三份独立状态：
 * - startupMemory = 最新内存状态（可能是还没落盘的）
 * - scheduledWrites = 待写入队列（可能被后来的调用顶掉）
 * - persistedSignatures = 上一次真正 rename 成功的内容
 * 只有 rename 成功才更新它；失败的写入绝不能把内存态标记成"已持久化"，
 * 否则后续相同内容的保存会被指纹闸门静默丢掉，缓存永远追不上内存。
 */
const persistedSignatures = new Map<string, string>()
/**
 * 最近一次成功落盘的内容（只记启动缓存这类带指纹的文件）。
 *
 * 存在的唯一理由：rename 是"检查-执行"两段，检查通过之后到 rename 真正生效之间，
 * 退出刷盘或清缓存仍可能插进来。事后靠这份日志判断"我这一笔是不是把更新的内容踩了"，
 * 是就把它恢复回来。只留一条/文件，内存占用与一个 startup.json 同级。
 */
const lastCommits = new Map<string, { value: unknown; signature: string; generation: number }>()
/**
 * 退出刷盘纪元。
 *
 * `flushBootstrapCacheWritesSync()` 自增它，让已经越过检查点、正在飞行的异步写入
 * 在最后一步放弃 —— 退出时同步写的内容不应该被一个更早发起的异步写覆盖回去。
 */
let flushEpoch = 0
let cacheGeneration = 0

function normalizeRoot(accountRoot?: string): string {
  return String(accountRoot || '').trim()
}

function digest(value: string): string {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 24)
}

/**
 * 按 JSON 语义递归规范化：对象键排序、跳过值为 `undefined` 的属性。
 *
 * 与 `JSON.stringify` 的行为保持一致（后者同样丢弃 undefined 属性、保留 null），
 * 这样"指纹看到的"和"写进磁盘的"是同一份内容。
 */
function sortForStable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortForStable(item))
  if (value === null || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) {
    const item = source[key]
    if (item === undefined) continue
    sorted[key] = sortForStable(item)
  }
  return sorted
}

/** 稳定序列化：同一份数据不论键序如何，结果一致。 */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortForStable(value))
}

/**
 * 启动缓存内容指纹。
 *
 * 覆盖**实际会被持久化的全部内容**：直接对 `self` 和每个 `contact` 做稳定序列化，
 * 不维护字段白名单 —— 白名单漏一个字段就会出现"字段变了却不写盘"的静默失效，
 * 这比多写一次严重得多。`updatedAt` / `version` / `platform` 因为不属于 self 或
 * 任一 contact，天然不参与计算。
 *
 * 联系人顺序不参与语义：先压成规范串再对**字符串数组**排序；
 * 排序的是派生副本，传入数组本身不会被原地修改。
 *
 * 复杂度 O(n·k log k)，n = 联系人数、k = 单条字段数；相比写 2MB 磁盘可忽略。
 */
function startupSignature(cache: StartupCacheFile): string {
  const contacts = Array.isArray(cache.contacts) ? cache.contacts : []
  const contactKeys = contacts.map((contact) => stableStringify(contact))
  contactKeys.sort()
  const selfKey = cache.self ? stableStringify(cache.self) : 'none'
  return crypto
    .createHash('sha1')
    .update(`v${CACHE_VERSION}|${cache.platform}|${normalizeRoot(cache.accountRoot)}`)
    .update('|self|')
    .update(selfKey)
    .update('|contacts|')
    .update(contactKeys.join('\n'))
    .digest('hex')
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 同步 sleep：退出路径不能用 setTimeout，用 Atomics.wait 才不会空转烧 CPU。 */
function delaySync(ms: number): void {
  if (ms <= 0) return
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const until = Date.now() + ms
    while (Date.now() < until) {
      /* 极端环境下退化：没有 SharedArrayBuffer 时只能忙等 */
    }
  }
}

/**
 * 原子替换：临时文件 → 目标文件，全程不删除目标。
 *
 * `fs.rename` 在 Windows 上走 MoveFileExW(MOVEFILE_REPLACE_EXISTING)，在 POSIX 上是
 * rename(2)：两者都是"用新名字替换旧名字"，旧文件内容由文件系统在提交点丢弃，
 * 不存在"先删掉目标再尝试改名"的空窗期。
 *
 * EXDEV（跨卷）在这里是**不可恢复**的：临时文件天生建在目标同目录，正常永远跨不了卷。
 * 真出现 EXDEV 说明路径本身出了问题，此时唯一安全的动作是放弃本次写入 ——
 * `copyFile` 覆盖没有原子性，写到一半断电/磁盘满会把旧缓存截成半截 JSON，
 * 比"这次没更新"严重得多。所以这里直接抛出，旧文件原样保留。
 */
async function replaceFileAtomic(tempFile: string, file: string): Promise<void> {
  let lastError: unknown = null
  for (let attempt = 0; attempt <= REPLACE_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await fs.rename(tempFile, file)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code || ''
      if (code === 'EXDEV') throw error
      if (!REPLACE_RETRYABLE_CODES.has(code)) throw error
      lastError = error
      if (attempt < REPLACE_RETRY_DELAYS_MS.length) {
        await delay(REPLACE_RETRY_DELAYS_MS[attempt])
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('replace failed')
}

/**
 * `replaceFileAtomic` 的同步版本，供退出时的 `flushBootstrapCacheWritesSync` 使用。
 *
 * `deadline` 是整批刷盘的重试预算：超过它就不再等待重试，直接把这个文件的失败
 * 算掉（旧缓存保留）。不设预算的话，N 个待写文件 × 460ms 能把退出拖成分钟级。
 */
function replaceFileAtomicSync(
  tempFile: string,
  file: string,
  deadline = Number.POSITIVE_INFINITY
): void {
  let lastError: unknown = null
  for (let attempt = 0; attempt <= REPLACE_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      fs.renameSync(tempFile, file)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code || ''
      // 与异步路径同样的判断：跨卷不做覆盖复制，直接失败、旧文件保留。
      if (code === 'EXDEV') throw error
      if (!REPLACE_RETRYABLE_CODES.has(code)) throw error
      lastError = error
      if (attempt < REPLACE_RETRY_DELAYS_MS.length) {
        const wait = REPLACE_RETRY_DELAYS_MS[attempt]
        if (Date.now() + wait > deadline) break
        delaySync(wait)
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('replace failed')
}

function makeTempFile(file: string, revision: number): string {
  // 临时文件必须与目标同目录：跨卷 rename 会退化成 EXDEV。
  return `${file}.${process.pid}.${revision}.tmp`
}

function removeTempFileSync(tempFile: string): void {
  try {
    if (fs.existsSync(tempFile)) fs.removeSync(tempFile)
  } catch {
    // 清理失败不改变本次写入的结论，只是留下一个 .tmp
  }
}

function getAccountCachePaths(accountRoot: string): AccountCachePaths {
  const normalizedRoot = normalizeRoot(accountRoot)
  const accountKey = digest(`${process.platform}:${normalizedRoot}`)
  const bootstrapRoot = path.join(app.getPath('userData'), 'cache', 'bootstrap')
  const root = path.join(bootstrapRoot, `${process.platform}-${accountKey}`)
  return {
    root,
    startup: path.join(root, 'startup.json'),
    messages: path.join(root, 'messages'),
    groups: path.join(root, 'groups'),
    legacy: path.join(bootstrapRoot, `${process.platform}-${accountKey.slice(0, 16)}.json`)
  }
}

function messageBucketKey(userMd5: string, startTime?: number, endTime?: number): string {
  return `${userMd5}:${startTime ?? ''}:${endTime ?? ''}`
}

function getMessageCacheFile(accountRoot: string, cacheKey: string): string {
  return path.join(getAccountCachePaths(accountRoot).messages, `${digest(cacheKey)}.json`)
}

function getGroupCacheFile(accountRoot: string, userMd5: string): string {
  return path.join(getAccountCachePaths(accountRoot).groups, `${digest(userMd5)}.json`)
}

function readScheduledValue<T>(file: string): T | null {
  const scheduled = scheduledWrites.get(file)
  return scheduled ? (scheduled.value as T) : null
}

function touchMemory<T>(memory: Map<string, T>, file: string, value: T, maxEntries: number): void {
  memory.delete(file)
  memory.set(file, value)
  while (memory.size > maxEntries) {
    const oldest = memory.keys().next().value
    if (!oldest) break
    memory.delete(oldest)
  }
}

function isCurrentAccountFile(
  value: {
    version?: number
    platform?: NodeJS.Platform
    accountRoot?: string
  },
  accountRoot: string
): boolean {
  return (
    value.version === CACHE_VERSION &&
    value.platform === process.platform &&
    normalizeRoot(value.accountRoot) === normalizeRoot(accountRoot)
  )
}

function readStartupCacheFile(accountRoot: string): StartupCacheFile | null {
  const normalizedRoot = normalizeRoot(accountRoot)
  if (!normalizedRoot) return null
  const paths = getAccountCachePaths(normalizedRoot)
  const file = paths.startup
  const scheduled = readScheduledValue<StartupCacheFile>(file)
  if (scheduled) return scheduled
  const memory = startupMemory.get(file)
  if (memory) return memory

  try {
    if (!fs.existsSync(file)) {
      // Version 1 stored startup data in one JSON file. Migrate it lazily so
      // account discovery can still show a cached nickname/avatar before the
      // database key is entered.
      if (!fs.existsSync(paths.legacy)) return null
      const legacy = fs.readJsonSync(paths.legacy) as {
        version?: number
        platform?: NodeJS.Platform
        accountRoot?: string
        updatedAt?: number
        self?: CachedSelfInfo
        contacts?: Contact[]
      }
      if (
        legacy.version !== 1 ||
        legacy.platform !== process.platform ||
        normalizeRoot(legacy.accountRoot) !== normalizedRoot
      ) {
        return null
      }
      const migrated: StartupCacheFile = {
        version: CACHE_VERSION,
        platform: process.platform,
        accountRoot: normalizedRoot,
        updatedAt: Number(legacy.updatedAt) || 0,
        self: legacy.self,
        contacts: Array.isArray(legacy.contacts) ? legacy.contacts : []
      }
      startupMemory.set(file, migrated)
      scheduleWrite(file, migrated, startupSignature(migrated), { cleanupFile: paths.legacy })
      return migrated
    }
    const raw = fs.readJsonSync(file) as Partial<StartupCacheFile>
    if (!isCurrentAccountFile(raw, normalizedRoot)) return null
    const result: StartupCacheFile = {
      version: CACHE_VERSION,
      platform: process.platform,
      accountRoot: normalizedRoot,
      updatedAt: Number(raw.updatedAt) || 0,
      self: raw.self,
      contacts: Array.isArray(raw.contacts) ? raw.contacts : []
    }
    startupMemory.set(file, result)
    // 刚从磁盘读出来的内容就等于磁盘内容，直接登记为"已持久化"。
    // 不登记的话，每次启动后的第一次保存都会无条件重写一遍 —— 正是要消掉的放大。
    if (!persistedSignatures.has(file)) persistedSignatures.set(file, startupSignature(result))
    return result
  } catch (error) {
    console.warn('[BootstrapCache] startup read failed:', error)
    return null
  }
}

function readMessageBucketFile(
  accountRoot: string,
  cacheKey: string
): CachedMessageBucketFile | null {
  const normalizedRoot = normalizeRoot(accountRoot)
  if (!normalizedRoot) return null
  const file = getMessageCacheFile(normalizedRoot, cacheKey)
  const scheduled = readScheduledValue<CachedMessageBucketFile>(file)
  if (scheduled) return scheduled
  const memory = messageMemory.get(file)
  if (memory) {
    touchMemory(messageMemory, file, memory, MAX_MEMORY_MESSAGE_BUCKETS)
    return memory
  }

  try {
    if (!fs.existsSync(file)) return null
    const raw = fs.readJsonSync(file) as Partial<CachedMessageBucketFile>
    if (!isCurrentAccountFile(raw, normalizedRoot) || raw.cacheKey !== cacheKey) return null
    const result: CachedMessageBucketFile = {
      version: CACHE_VERSION,
      platform: process.platform,
      accountRoot: normalizedRoot,
      cacheKey,
      updatedAt: Number(raw.updatedAt) || 0,
      startTime: raw.startTime,
      endTime: raw.endTime,
      items: Array.isArray(raw.items) ? raw.items : []
    }
    touchMemory(messageMemory, file, result, MAX_MEMORY_MESSAGE_BUCKETS)
    return result
  } catch (error) {
    console.warn('[BootstrapCache] message read failed:', error)
    return null
  }
}

function readGroupSnapshotFile(
  accountRoot: string,
  userMd5: string
): CachedGroupSnapshotFile | null {
  const normalizedRoot = normalizeRoot(accountRoot)
  if (!normalizedRoot) return null
  const file = getGroupCacheFile(normalizedRoot, userMd5)
  const scheduled = readScheduledValue<CachedGroupSnapshotFile>(file)
  if (scheduled) return scheduled
  const memory = groupMemory.get(file)
  if (memory) {
    touchMemory(groupMemory, file, memory, MAX_MEMORY_GROUP_SNAPSHOTS)
    return memory
  }

  try {
    if (!fs.existsSync(file)) return null
    const raw = fs.readJsonSync(file) as Partial<CachedGroupSnapshotFile>
    if (!isCurrentAccountFile(raw, normalizedRoot) || raw.userMd5 !== userMd5 || !raw.snapshot) {
      return null
    }
    const result: CachedGroupSnapshotFile = {
      version: CACHE_VERSION,
      platform: process.platform,
      accountRoot: normalizedRoot,
      userMd5,
      updatedAt: Number(raw.updatedAt) || 0,
      snapshot: raw.snapshot
    }
    touchMemory(groupMemory, file, result, MAX_MEMORY_GROUP_SNAPSHOTS)
    return result
  } catch (error) {
    console.warn('[BootstrapCache] group snapshot read failed:', error)
    return null
  }
}

async function pruneCacheDirectory(directory: string, maxFiles: number): Promise<void> {
  const now = Date.now()
  if (now - (lastPrunedAt.get(directory) || 0) < PRUNE_INTERVAL_MS) return
  lastPrunedAt.set(directory, now)

  try {
    const names = (await fs.readdir(directory)).filter((name) => name.endsWith('.json'))
    if (names.length <= maxFiles) return
    const entries = await Promise.all(
      names.map(async (name) => {
        const file = path.join(directory, name)
        const stat = await fs.stat(file)
        return { file, modifiedAt: stat.mtimeMs }
      })
    )
    const expired = entries
      .sort((left, right) => right.modifiedAt - left.modifiedAt)
      .slice(maxFiles)
    await Promise.all(
      expired.map(async ({ file }) => {
        messageMemory.delete(file)
        groupMemory.delete(file)
        await fs.remove(file)
      })
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[BootstrapCache] prune failed:', error)
    }
  }
}

function queueWrite(file: string): void {
  const scheduled = scheduledWrites.get(file)
  if (!scheduled) return
  const epochAtSchedule = flushEpoch
  const previous = writeQueues.get(file) || Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const current = scheduledWrites.get(file)
      if (
        !current ||
        current.revision !== scheduled.revision ||
        current.generation !== cacheGeneration
      ) {
        return
      }

      const tempFile = makeTempFile(file, scheduled.revision)
      await fs.ensureDir(path.dirname(file))
      // 先把完整内容写进临时文件：目标文件在整个过程中始终是上一份完整数据。
      await fs.writeFile(tempFile, JSON.stringify(current.value), 'utf8')

      const latest = scheduledWrites.get(file)
      if (
        !latest ||
        latest.revision !== scheduled.revision ||
        latest.generation !== cacheGeneration ||
        flushEpoch !== epochAtSchedule
      ) {
        await fs.remove(tempFile).catch(() => undefined)
        return
      }

      // 替换前的最后一道闸：被 clear 掉（generation 变）或退出刷盘（epoch 变）就不提交。
      if (flushEpoch !== epochAtSchedule || scheduled.generation !== cacheGeneration) {
        await fs.remove(tempFile).catch(() => undefined)
        return
      }

      try {
        await replaceFileAtomic(tempFile, file)
      } catch (error) {
        // 失败：目标文件仍是旧内容（rename 是原子替换，没有"先删后改"的中间态），
        // 本次临时文件必须清掉，否则反复失败会堆 .tmp。
        await fs.remove(tempFile).catch(() => undefined)
        // 同时撤掉这条待写入记录：留着它会让下一次 commitStartupCache 误以为
        // "队列里还有一份不同内容"，白写一次。
        const failed = scheduledWrites.get(file)
        if (failed?.revision === scheduled.revision) scheduledWrites.delete(file)
        throw error
      }

      // 落盘之后核一次账：rename 是原子的，但"检查 epoch/generation"和"rename 生效"
      // 之间仍有窗口 —— 退出刷盘或清缓存可能正好插在中间。
      // 这时我们刚写下去的可能是旧内容，必须按日志把更新的那份放回去。
      const clobberedByFlush = flushEpoch !== epochAtSchedule
      const clobberedByClear = scheduled.generation !== cacheGeneration
      let committedSignature = scheduled.signature
      let committedValue: unknown = scheduled.value

      if (scheduled.signature && (clobberedByFlush || clobberedByClear)) {
        const newer = lastCommits.get(file)
        if (newer && newer.signature !== scheduled.signature) {
          // 有比我们更新的一份已经落过盘：恢复它。
          const restoreTemp = makeTempFile(file, scheduled.revision + RESTORE_REVISION_OFFSET)
          try {
            fs.writeFileSync(restoreTemp, JSON.stringify(newer.value), 'utf8')
            replaceFileAtomicSync(restoreTemp, file)
            committedSignature = newer.signature
            committedValue = newer.value
          } catch (error) {
            removeTempFileSync(restoreTemp)
            console.warn('[BootstrapCache] restore after race failed:', error)
          }
        } else if (clobberedByClear) {
          // 清缓存之后才落地的旧数据：不该留在磁盘上（否则等于缓存复活）。
          try {
            fs.removeSync(file)
          } catch {
            // 删不掉也不阻塞后续流程，下一次保存会覆盖它
          }
          committedSignature = ''
          committedValue = undefined
        }
      }

      // 只有 rename 成功才承认"磁盘上是这份内容"。superseded 的情况下也照记：
      // persistedSignatures 描述的是磁盘现状，不是"最新意图"。
      if (scheduled.signature) {
        if (committedSignature) {
          persistedSignatures.set(file, committedSignature)
          lastCommits.set(file, {
            value: committedValue,
            signature: committedSignature,
            generation: scheduled.generation
          })
        } else {
          persistedSignatures.delete(file)
          lastCommits.delete(file)
        }
      }

      const completed = scheduledWrites.get(file)
      if (
        completed?.revision === scheduled.revision &&
        completed.generation === scheduled.generation
      ) {
        scheduledWrites.delete(file)
      }
      if (current.cleanupFile) await fs.remove(current.cleanupFile)
      if (current.prune) {
        void pruneCacheDirectory(current.prune.directory, current.prune.maxFiles)
      }
    })
    .catch((error) => {
      console.warn('[BootstrapCache] write failed:', error)
    })
    .finally(() => {
      if (writeQueues.get(file) === next) writeQueues.delete(file)
    })
  writeQueues.set(file, next)
}

function scheduleWrite(
  file: string,
  value: unknown,
  signature: string,
  options?: { cleanupFile?: string; prune?: { directory: string; maxFiles: number } }
): void {
  const existingTimer = writeTimers.get(file)
  if (existingTimer) clearTimeout(existingTimer)
  const revision = (writeRevisions.get(file) || 0) + 1
  writeRevisions.set(file, revision)
  scheduledWrites.set(file, {
    value,
    signature,
    revision,
    generation: cacheGeneration,
    cleanupFile: options?.cleanupFile,
    prune: options?.prune
  })
  writeTimers.set(
    file,
    setTimeout(() => {
      writeTimers.delete(file)
      queueWrite(file)
    }, WRITE_DEBOUNCE_MS)
  )
}

/** 取消待写入任务（不动磁盘、不动内存态）。revision 递增让在途写入失效。 */
function cancelScheduledWrite(file: string): void {
  const timer = writeTimers.get(file)
  if (timer) {
    clearTimeout(timer)
    writeTimers.delete(file)
  }
  writeRevisions.set(file, (writeRevisions.get(file) || 0) + 1)
  scheduledWrites.delete(file)
}

function loadOrCreateStartupCache(accountRoot: string): StartupCacheFile | null {
  const normalizedRoot = normalizeRoot(accountRoot)
  if (!normalizedRoot) return null
  const existing = readStartupCacheFile(normalizedRoot)
  if (existing) return existing
  const created: StartupCacheFile = {
    version: CACHE_VERSION,
    platform: process.platform,
    accountRoot: normalizedRoot,
    updatedAt: Date.now(),
    contacts: []
  }
  startupMemory.set(getAccountCachePaths(normalizedRoot).startup, created)
  return created
}

/**
 * 提交一份新的启动缓存状态。
 *
 * 调用方必须传**新建的对象**（copy-on-write），不能传 `loadOrCreateStartupCache()`
 * 返回的那个内存对象本身 —— 否则"旧状态"和"新状态"是同一个引用，
 * 指纹永远相等，缓存就再也写不下去了。
 */
function commitStartupCache(next: StartupCacheFile): void {
  const paths = getAccountCachePaths(next.accountRoot)
  const file = paths.startup
  const signature = startupSignature(next)
  const persisted = persistedSignatures.get(file)
  const pending = scheduledWrites.get(file)

  startupMemory.set(file, next)

  if (persisted === signature) {
    // 磁盘上已经是这份内容。
    if (!pending) return
    if (pending.signature === signature) {
      // 队列里排着的就是要写的同一份内容：撤掉它，别做无意义的一次替换。
      cancelScheduledWrite(file)
      return
    }
    // 队列里排着一份**不同**的内容（A→B→A 的收尾）：必须再写一次，
    // 否则 B 落盘后内存里的 A 就永远丢了。
  }

  // 只有真正要写盘时才推进 updatedAt：内容没变却刷新时间戳，
  // 会让上层"上次更新时间"变成噪音。
  const value: StartupCacheFile = { ...next, updatedAt: Date.now() }
  startupMemory.set(file, value)
  scheduleWrite(file, value, signature, { cleanupFile: paths.legacy })
}

function containsLegacyMisparsedAppMessage(items: Message[]): boolean {
  return items.some((message) => {
    const content = message.contentData
    if (content?.type === 'system' && content.raw) {
      return (
        /<weappinfo\b/i.test(content.raw) && /<type>\s*(?:33|36|2001)\s*<\/type>/i.test(content.raw)
      )
    }
    if (
      content?.type === 'share' &&
      ((content.typeVal === '3' && !content.url) || content.typeVal === '2001')
    ) {
      return true
    }
    if (content?.type !== 'sticker') return false
    const url = String(content.url || content.thumbUrl || '')
    return /wxapp\.tenpay\.com\/mmpayhb|mp\.weixin\.qq\.com\/mp\/waerrpage/i.test(url)
  })
}

export function getBootstrapCache(accountRoot?: string): {
  self?: CachedSelfInfo
  contacts: Contact[]
  updatedAt: number
} | null {
  const cache = readStartupCacheFile(normalizeRoot(accountRoot))
  if (!cache) return null
  return {
    self: cache.self,
    contacts: cache.contacts,
    updatedAt: cache.updatedAt
  }
}

function isRawContactName(contact: Contact): boolean {
  const name = String(contact.m_nsNickName || '').trim()
  const username = String(contact.m_nsUsrName || '').trim()
  if (!name) return true
  if (name === username) return true
  if (name.endsWith('@chatroom')) return true
  if (name.startsWith('Group_') || name.startsWith('Unknown_')) return true
  return false
}

function accountRootCandidates(accountRoot: string): Set<string> {
  const directory = path.basename(normalizeRoot(accountRoot))
  const suffixMatch = directory.match(/^(.+)_([a-zA-Z0-9]{4})$/)
  return new Set([directory, suffixMatch?.[1] || ''].filter(Boolean))
}

export function mergeCachedSelfInfo(accountRoot: string, self: CachedSelfInfo): CachedSelfInfo {
  const cache = readStartupCacheFile(accountRoot)
  if (!cache) return self
  const identifiers = accountRootCandidates(accountRoot)
  if (self.wxid) identifiers.add(self.wxid)
  const isRawSelfName = (value?: string): boolean => {
    const name = String(value || '').trim()
    return !name || name === '我' || identifiers.has(name)
  }
  if (!isRawSelfName(self.nickname)) return self

  const cachedContact = cache.contacts.find(
    (contact) => identifiers.has(contact.m_nsUsrName) && !isRawContactName(contact)
  )
  const cachedNickname = !isRawSelfName(cache.self?.nickname)
    ? cache.self?.nickname
    : cachedContact?.m_nsNickName
  if (!cachedNickname) return self
  return {
    ...self,
    nickname: cachedNickname,
    avatar: self.avatar || cache.self?.avatar || cachedContact?.avatar
  }
}

export function mergeCachedContactAvatars(accountRoot: string, contacts: Contact[]): Contact[] {
  const cache = readStartupCacheFile(accountRoot)
  if (!cache?.contacts.length) return contacts
  const avatarByUsername = new Map(
    cache.contacts
      .filter((contact) => contact.m_nsUsrName && contact.avatar)
      .map((contact) => [contact.m_nsUsrName, contact.avatar as string])
  )
  const nameByUsername = new Map(
    cache.contacts
      .filter(
        (contact) => contact.m_nsUsrName && contact.m_nsNickName && !isRawContactName(contact)
      )
      .map((contact) => [contact.m_nsUsrName, contact.m_nsNickName])
  )
  if (avatarByUsername.size === 0 && nameByUsername.size === 0) return contacts
  return contacts.map((contact) => ({
    ...contact,
    avatar:
      contact.avatar || !avatarByUsername.has(contact.m_nsUsrName)
        ? contact.avatar
        : avatarByUsername.get(contact.m_nsUsrName),
    m_nsNickName:
      !isRawContactName(contact) || !nameByUsername.has(contact.m_nsUsrName)
        ? contact.m_nsNickName
        : nameByUsername.get(contact.m_nsUsrName) || contact.m_nsNickName
  }))
}

export function saveBootstrapSelf(accountRoot: string, self: CachedSelfInfo): void {
  const cache = loadOrCreateStartupCache(accountRoot)
  if (!cache) return
  // copy-on-write：不原地改内存对象，指纹才可能是"这次的新内容"。
  commitStartupCache({ ...cache, self })
}

export function saveBootstrapContacts(accountRoot: string, contacts: Contact[]): void {
  const cache = loadOrCreateStartupCache(accountRoot)
  if (!cache) return
  const avatarByUsername = new Map(
    cache.contacts
      .filter((contact) => contact.m_nsUsrName && contact.avatar)
      .map((contact) => [contact.m_nsUsrName, contact.avatar as string])
  )
  const nameByUsername = new Map(
    cache.contacts
      .filter(
        (contact) => contact.m_nsUsrName && contact.m_nsNickName && !isRawContactName(contact)
      )
      .map((contact) => [contact.m_nsUsrName, contact.m_nsNickName])
  )
  // 注意：`contacts.map` 产出新数组，传入的数组本身不会被排序或改写。
  const merged = contacts.map((contact) => ({
    ...contact,
    avatar:
      contact.avatar || !avatarByUsername.has(contact.m_nsUsrName)
        ? contact.avatar
        : avatarByUsername.get(contact.m_nsUsrName),
    m_nsNickName:
      !isRawContactName(contact) || !nameByUsername.has(contact.m_nsUsrName)
        ? contact.m_nsNickName
        : nameByUsername.get(contact.m_nsUsrName) || contact.m_nsNickName
  }))
  commitStartupCache({ ...cache, contacts: merged })
}

export function mergeBootstrapAvatars(accountRoot: string, avatars: Record<string, string>): void {
  const cache = loadOrCreateStartupCache(accountRoot)
  if (!cache?.contacts.length) return
  let changed = false
  const merged = cache.contacts.map((contact) => {
    const avatar = avatars[contact.m_nsUsrName]
    if (!avatar || contact.avatar === avatar) return contact
    changed = true
    return { ...contact, avatar }
  })
  if (!changed) return
  commitStartupCache({ ...cache, contacts: merged })
}

export function getCachedMessages(
  accountRoot: string,
  userMd5: string,
  startTime?: number,
  endTime?: number
): Message[] {
  return (
    readMessageBucketFile(accountRoot, messageBucketKey(userMd5, startTime, endTime))?.items || []
  )
}

export function getCachedMessagePage(
  accountRoot: string,
  userMd5: string,
  startTime?: number,
  endTime?: number
): { hit: boolean; messages: Message[]; groupSnapshot?: CachedGroupSnapshot } {
  const bucket = readMessageBucketFile(accountRoot, messageBucketKey(userMd5, startTime, endTime))
  const messages = bucket?.items || []
  return {
    hit: Boolean(bucket) && !containsLegacyMisparsedAppMessage(messages),
    messages,
    groupSnapshot: readGroupSnapshotFile(accountRoot, userMd5)?.snapshot
  }
}

export function saveCachedGroupSnapshot(
  accountRoot: string,
  userMd5: string,
  snapshot: CachedGroupSnapshot
): CachedGroupSnapshot {
  const normalizedRoot = normalizeRoot(accountRoot)
  if (!normalizedRoot || !userMd5) return snapshot
  const paths = getAccountCachePaths(normalizedRoot)
  const file = getGroupCacheFile(normalizedRoot, userMd5)
  const previous = readGroupSnapshotFile(normalizedRoot, userMd5)?.snapshot
  const previousByWxid = new Map((previous?.members || []).map((member) => [member.wxid, member]))
  const mergedSnapshot: CachedGroupSnapshot =
    previous && previous.roomId === snapshot.roomId
      ? {
          ...snapshot,
          members: snapshot.members.map((member) => {
            const oldMember = previousByWxid.get(member.wxid)
            const freshGroupNickname = String(member.groupNickname || '').trim()
            const freshWechatNickname = String(member.wechatNickname || '').trim()
            const oldGroupNickname = String(oldMember?.groupNickname || '').trim()
            const freshLooksLikeContactFallback =
              !freshGroupNickname || freshGroupNickname === freshWechatNickname
            const groupNickname =
              freshLooksLikeContactFallback && oldGroupNickname
                ? oldGroupNickname
                : freshGroupNickname
            return {
              ...member,
              groupNickname,
              nickname: groupNickname || member.nickname
            }
          })
        }
      : snapshot
  const value: CachedGroupSnapshotFile = {
    version: CACHE_VERSION,
    platform: process.platform,
    accountRoot: normalizedRoot,
    userMd5,
    updatedAt: Date.now(),
    snapshot: mergedSnapshot
  }
  touchMemory(groupMemory, file, value, MAX_MEMORY_GROUP_SNAPSHOTS)
  // 消息桶/群快照不做内容指纹（每次读都是一份新数据），signature 传空串，
  // queueWrite 会跳过 persistedSignatures 登记。
  scheduleWrite(file, value, '', {
    prune: { directory: paths.groups, maxFiles: MAX_GROUP_SNAPSHOTS }
  })
  return mergedSnapshot
}

export function saveCachedMessages(
  accountRoot: string,
  userMd5: string,
  startTime: number | undefined,
  endTime: number | undefined,
  messages: Message[]
): void {
  const normalizedRoot = normalizeRoot(accountRoot)
  if (!normalizedRoot || !userMd5) return
  const cacheKey = messageBucketKey(userMd5, startTime, endTime)
  const paths = getAccountCachePaths(normalizedRoot)
  const file = getMessageCacheFile(normalizedRoot, cacheKey)
  const value: CachedMessageBucketFile = {
    version: CACHE_VERSION,
    platform: process.platform,
    accountRoot: normalizedRoot,
    cacheKey,
    updatedAt: Date.now(),
    startTime,
    endTime,
    items: messages.slice(-MAX_MESSAGES_PER_BUCKET)
  }
  touchMemory(messageMemory, file, value, MAX_MEMORY_MESSAGE_BUCKETS)
  scheduleWrite(file, value, '', {
    prune: { directory: paths.messages, maxFiles: MAX_MESSAGE_BUCKETS }
  })
}

export function flushBootstrapCacheWritesSync(): void {
  // 自增纪元：已经越过检查点、正在飞行的异步写会在 rename 前发现自己过期并放弃，
  // 避免退出时的同步内容被一个更早发起的异步写覆盖回去。
  flushEpoch += 1
  for (const timer of writeTimers.values()) clearTimeout(timer)
  writeTimers.clear()
  const writes = Array.from(scheduledWrites.entries())
  scheduledWrites.clear()
  // 整批共享一份重试预算，避免 N 个文件各自重试把退出拖成分钟级。
  const deadline = Date.now() + FLUSH_RETRY_BUDGET_MS
  for (const [file, scheduled] of writes) {
    // 退出时同步写也算一次 revision 变更，让队列里同一文件的任务作废。
    writeRevisions.set(file, (writeRevisions.get(file) || 0) + 1)
    const tempFile = makeTempFile(file, scheduled.revision)
    try {
      fs.ensureDirSync(path.dirname(file))
      // 与异步路径保持同一套语义：先写完整临时文件，再原子换名，绝不先删目标。
      fs.writeFileSync(tempFile, JSON.stringify(scheduled.value), 'utf8')
      replaceFileAtomicSync(tempFile, file, deadline)
      if (scheduled.signature) {
        persistedSignatures.set(file, scheduled.signature)
        // 记进提交日志：若此时还有一笔在途异步写正好落在我们之后，
        // 它会在核账时发现自己踩了更新的内容，并按这条日志恢复。
        lastCommits.set(file, {
          value: scheduled.value,
          signature: scheduled.signature,
          generation: scheduled.generation
        })
      }
      if (scheduled.cleanupFile) fs.removeSync(scheduled.cleanupFile)
    } catch (error) {
      removeTempFileSync(tempFile)
      console.warn('[BootstrapCache] flush failed:', error)
    }
  }
}

export function clearBootstrapCache(): void {
  cacheGeneration += 1
  // 清缓存同样让在途写入作废，并且丢掉"已持久化"记录 —— 磁盘上的文件可能马上被删，
  // 留着旧指纹会让下一次保存误以为"磁盘上已经有了"而不写。
  flushEpoch += 1
  for (const timer of writeTimers.values()) clearTimeout(timer)
  writeTimers.clear()
  scheduledWrites.clear()
  writeQueues.clear()
  writeRevisions.clear()
  lastPrunedAt.clear()
  persistedSignatures.clear()
  lastCommits.clear()
  startupMemory.clear()
  messageMemory.clear()
  groupMemory.clear()
}
