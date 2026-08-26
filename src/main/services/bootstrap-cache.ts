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

const startupMemory = new Map<string, StartupCacheFile>()
const messageMemory = new Map<string, CachedMessageBucketFile>()
const groupMemory = new Map<string, CachedGroupSnapshotFile>()
const writeTimers = new Map<string, NodeJS.Timeout>()
const writeQueues = new Map<string, Promise<void>>()
const scheduledWrites = new Map<string, ScheduledWrite>()
const writeRevisions = new Map<string, number>()
const lastPrunedAt = new Map<string, number>()
let cacheGeneration = 0

function normalizeRoot(accountRoot?: string): string {
  return String(accountRoot || '').trim()
}

function digest(value: string): string {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 24)
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
      scheduleWrite(file, migrated, { cleanupFile: paths.legacy })
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

      const tempFile = `${file}.${process.pid}.${scheduled.revision}.tmp`
      await fs.ensureDir(path.dirname(file))
      await fs.writeFile(tempFile, JSON.stringify(current.value), 'utf8')
      const latest = scheduledWrites.get(file)
      if (
        !latest ||
        latest.revision !== scheduled.revision ||
        latest.generation !== cacheGeneration
      ) {
        await fs.remove(tempFile)
        return
      }
      await fs.move(tempFile, file, { overwrite: true })
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
  options?: { cleanupFile?: string; prune?: { directory: string; maxFiles: number } }
): void {
  const existingTimer = writeTimers.get(file)
  if (existingTimer) clearTimeout(existingTimer)
  const revision = (writeRevisions.get(file) || 0) + 1
  writeRevisions.set(file, revision)
  scheduledWrites.set(file, {
    value,
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

function writeStartupCache(cache: StartupCacheFile): void {
  const paths = getAccountCachePaths(cache.accountRoot)
  startupMemory.set(paths.startup, cache)
  scheduleWrite(paths.startup, cache, { cleanupFile: paths.legacy })
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
  cache.self = self
  cache.updatedAt = Date.now()
  writeStartupCache(cache)
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
  cache.contacts = contacts.map((contact) => ({
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
  cache.updatedAt = Date.now()
  writeStartupCache(cache)
}

export function mergeBootstrapAvatars(accountRoot: string, avatars: Record<string, string>): void {
  const cache = loadOrCreateStartupCache(accountRoot)
  if (!cache?.contacts.length) return
  let changed = false
  cache.contacts = cache.contacts.map((contact) => {
    const avatar = avatars[contact.m_nsUsrName]
    if (!avatar || contact.avatar === avatar) return contact
    changed = true
    return { ...contact, avatar }
  })
  if (!changed) return
  cache.updatedAt = Date.now()
  writeStartupCache(cache)
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
  const mergedSnapshot: CachedGroupSnapshot = previous && previous.roomId === snapshot.roomId
    ? {
        ...snapshot,
        members: snapshot.members.map((member) => {
          const oldMember = previousByWxid.get(member.wxid)
          const freshGroupNickname = String(member.groupNickname || '').trim()
          const freshWechatNickname = String(member.wechatNickname || '').trim()
          const oldGroupNickname = String(oldMember?.groupNickname || '').trim()
          const freshLooksLikeContactFallback =
            !freshGroupNickname ||
            freshGroupNickname === freshWechatNickname
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
  scheduleWrite(file, value, {
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
  scheduleWrite(file, value, {
    prune: { directory: paths.messages, maxFiles: MAX_MESSAGE_BUCKETS }
  })
}

export function flushBootstrapCacheWritesSync(): void {
  for (const timer of writeTimers.values()) clearTimeout(timer)
  writeTimers.clear()
  const writes = Array.from(scheduledWrites.entries())
  scheduledWrites.clear()
  for (const [file, scheduled] of writes) {
    try {
      fs.ensureDirSync(path.dirname(file))
      fs.writeFileSync(file, JSON.stringify(scheduled.value), 'utf8')
      if (scheduled.cleanupFile) fs.removeSync(scheduled.cleanupFile)
    } catch (error) {
      console.warn('[BootstrapCache] flush failed:', error)
    }
  }
}

export function clearBootstrapCache(): void {
  cacheGeneration += 1
  for (const timer of writeTimers.values()) clearTimeout(timer)
  writeTimers.clear()
  scheduledWrites.clear()
  writeQueues.clear()
  writeRevisions.clear()
  lastPrunedAt.clear()
  startupMemory.clear()
  messageMemory.clear()
  groupMemory.clear()
}
