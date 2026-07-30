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

interface CachedMessageBucket {
  updatedAt: number
  startTime?: number
  endTime?: number
  items: Message[]
}

interface BootstrapCacheFile {
  version: 1
  platform: NodeJS.Platform
  accountRoot: string
  updatedAt: number
  self?: CachedSelfInfo
  contacts?: Contact[]
  messages?: Record<string, CachedMessageBucket>
  groupSnapshots?: Record<string, { updatedAt: number; snapshot: CachedGroupSnapshot }>
}

const CACHE_VERSION = 1
const MAX_MESSAGE_BUCKETS = 768
const MAX_MESSAGES_PER_BUCKET = 120
const WRITE_DEBOUNCE_MS = 300
const memoryCache = new Map<string, BootstrapCacheFile>()
const writeTimers = new Map<string, NodeJS.Timeout>()
const writeQueues = new Map<string, Promise<void>>()

function normalizeRoot(accountRoot?: string): string {
  return String(accountRoot || '').trim()
}

function getCacheFile(accountRoot?: string): string {
  const normalizedRoot = normalizeRoot(accountRoot) || 'default'
  const hash = crypto
    .createHash('sha1')
    .update(`${process.platform}:${normalizedRoot}`)
    .digest('hex')
    .slice(0, 16)
  return path.join(
    app.getPath('userData'),
    'cache',
    'bootstrap',
    `${process.platform}-${hash}.json`
  )
}

function readCacheFile(accountRoot?: string): BootstrapCacheFile | null {
  const normalizedRoot = normalizeRoot(accountRoot)
  if (!normalizedRoot) return null
  const file = getCacheFile(normalizedRoot)
  const cached = memoryCache.get(file)
  if (cached) return cached
  try {
    if (!fs.existsSync(file)) return null
    const raw = fs.readJsonSync(file) as Partial<BootstrapCacheFile>
    if (raw.version !== CACHE_VERSION || raw.platform !== process.platform) return null
    if (normalizeRoot(raw.accountRoot) !== normalizedRoot) return null
    const result: BootstrapCacheFile = {
      version: CACHE_VERSION,
      platform: process.platform,
      accountRoot: normalizedRoot,
      updatedAt: Number(raw.updatedAt) || 0,
      self: raw.self,
      contacts: Array.isArray(raw.contacts) ? raw.contacts : [],
      messages: raw.messages && typeof raw.messages === 'object' ? raw.messages : {},
      groupSnapshots:
        raw.groupSnapshots && typeof raw.groupSnapshots === 'object' ? raw.groupSnapshots : {}
    }
    memoryCache.set(file, result)
    return result
  } catch (error) {
    console.warn('[BootstrapCache] read failed:', error)
    return null
  }
}

function writeCacheFile(cache: BootstrapCacheFile): void {
  const file = getCacheFile(cache.accountRoot)
  memoryCache.set(file, cache)
  const existingTimer = writeTimers.get(file)
  if (existingTimer) clearTimeout(existingTimer)
  writeTimers.set(
    file,
    setTimeout(() => {
      writeTimers.delete(file)
      const serialized = JSON.stringify(memoryCache.get(file) || cache)
      const previous = writeQueues.get(file) || Promise.resolve()
      const next = previous
        .catch(() => undefined)
        .then(async () => {
          await fs.ensureDir(path.dirname(file))
          await fs.writeFile(file, serialized, 'utf8')
        })
        .catch((error) => {
          console.warn('[BootstrapCache] write failed:', error)
        })
        .finally(() => {
          if (writeQueues.get(file) === next) writeQueues.delete(file)
        })
      writeQueues.set(file, next)
    }, WRITE_DEBOUNCE_MS)
  )
}

function loadOrCreate(accountRoot?: string): BootstrapCacheFile | null {
  const normalizedRoot = normalizeRoot(accountRoot)
  if (!normalizedRoot) return null
  const existing = readCacheFile(normalizedRoot)
  if (existing) return existing
  const created: BootstrapCacheFile = {
    version: CACHE_VERSION,
    platform: process.platform,
    accountRoot: normalizedRoot,
    updatedAt: Date.now(),
    contacts: [],
    messages: {},
    groupSnapshots: {}
  }
  memoryCache.set(getCacheFile(normalizedRoot), created)
  return created
}

function messageBucketKey(userMd5: string, startTime?: number, endTime?: number): string {
  return `${userMd5}:${startTime ?? ''}:${endTime ?? ''}`
}

function cachedMessageIdentity(message: Message): string {
  if (message.localId) return `local:${message.localId}`
  if (message.serverId) return `server:${message.serverId}`
  return `id:${message.id}`
}

function containsLegacyMisparsedAppMessage(items: Message[]): boolean {
  return items.some((message) => {
    const content = message.contentData
    if (content?.type === 'system' && content.raw) {
      return (
        /<weappinfo\b/i.test(content.raw) &&
        /<type>\s*(?:33|36|2001)\s*<\/type>/i.test(content.raw)
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

function pruneMessageBuckets(messages: Record<string, CachedMessageBucket>): void {
  const entries = Object.entries(messages)
  if (entries.length <= MAX_MESSAGE_BUCKETS) return
  entries
    .sort((left, right) => (right[1].updatedAt || 0) - (left[1].updatedAt || 0))
    .slice(MAX_MESSAGE_BUCKETS)
    .forEach(([key]) => {
      delete messages[key]
    })
}

export function getBootstrapCache(accountRoot?: string): {
  self?: CachedSelfInfo
  contacts: Contact[]
  updatedAt: number
} | null {
  const cache = readCacheFile(accountRoot)
  if (!cache) return null
  return {
    self: cache.self,
    contacts: cache.contacts || [],
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

export function mergeCachedContactAvatars(accountRoot: string, contacts: Contact[]): Contact[] {
  const cache = readCacheFile(accountRoot)
  if (!cache?.contacts?.length) return contacts
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
  const cache = loadOrCreate(accountRoot)
  if (!cache) return
  cache.self = self
  cache.updatedAt = Date.now()
  writeCacheFile(cache)
}

export function saveBootstrapContacts(accountRoot: string, contacts: Contact[]): void {
  const cache = loadOrCreate(accountRoot)
  if (!cache) return
  const avatarByUsername = new Map(
    (cache.contacts || [])
      .filter((contact) => contact.m_nsUsrName && contact.avatar)
      .map((contact) => [contact.m_nsUsrName, contact.avatar as string])
  )
  const nameByUsername = new Map(
    (cache.contacts || [])
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
  writeCacheFile(cache)
}

export function mergeBootstrapAvatars(accountRoot: string, avatars: Record<string, string>): void {
  const cache = loadOrCreate(accountRoot)
  if (!cache || !cache.contacts?.length) return
  let changed = false
  cache.contacts = cache.contacts.map((contact) => {
    const avatar = avatars[contact.m_nsUsrName]
    if (!avatar || contact.avatar === avatar) return contact
    changed = true
    return { ...contact, avatar }
  })
  if (!changed) return
  cache.updatedAt = Date.now()
  writeCacheFile(cache)
}

export function getCachedMessages(
  accountRoot: string,
  userMd5: string,
  startTime?: number,
  endTime?: number
): Message[] {
  const cache = readCacheFile(accountRoot)
  const bucket = cache?.messages?.[messageBucketKey(userMd5, startTime, endTime)]
  return bucket?.items || []
}

export function getCachedMessagePage(
  accountRoot: string,
  userMd5: string,
  startTime?: number,
  endTime?: number
): { hit: boolean; messages: Message[]; groupSnapshot?: CachedGroupSnapshot } {
  const cache = readCacheFile(accountRoot)
  const key = messageBucketKey(userMd5, startTime, endTime)
  let bucket = cache?.messages?.[key]
  if (!bucket && cache?.messages && startTime === undefined && endTime === undefined) {
    const merged = new Map<string, Message>()
    for (const [cachedKey, candidate] of Object.entries(cache.messages)) {
      if (!cachedKey.startsWith(`${userMd5}:`)) continue
      for (const message of candidate.items || []) {
        merged.set(cachedMessageIdentity(message), message)
      }
    }
    const migratedMessages = Array.from(merged.values())
      .sort((left, right) => (left.createTime || 0) - (right.createTime || 0))
      .slice(-MAX_MESSAGES_PER_BUCKET)
    if (migratedMessages.length > 0) {
      bucket = {
        updatedAt: Date.now(),
        items: migratedMessages
      }
      cache.messages[key] = bucket
      cache.updatedAt = Date.now()
      pruneMessageBuckets(cache.messages)
      writeCacheFile(cache)
    }
  }
  return {
    hit: Boolean(bucket) && !containsLegacyMisparsedAppMessage(bucket?.items || []),
    messages: bucket?.items || [],
    groupSnapshot: cache?.groupSnapshots?.[userMd5]?.snapshot
  }
}

export function saveCachedGroupSnapshot(
  accountRoot: string,
  userMd5: string,
  snapshot: CachedGroupSnapshot
): void {
  const cache = loadOrCreate(accountRoot)
  if (!cache) return
  cache.groupSnapshots ||= {}
  cache.groupSnapshots[userMd5] = { updatedAt: Date.now(), snapshot }
  cache.updatedAt = Date.now()
  writeCacheFile(cache)
}

export function flushBootstrapCacheWritesSync(): void {
  for (const [file, cache] of memoryCache) {
    const timer = writeTimers.get(file)
    if (timer) clearTimeout(timer)
    writeTimers.delete(file)
    try {
      fs.ensureDirSync(path.dirname(file))
      fs.writeFileSync(file, JSON.stringify(cache), 'utf8')
    } catch (error) {
      console.warn('[BootstrapCache] flush failed:', error)
    }
  }
}

export function clearBootstrapCache(): void {
  for (const timer of writeTimers.values()) clearTimeout(timer)
  writeTimers.clear()
  writeQueues.clear()
  memoryCache.clear()
}

export function saveCachedMessages(
  accountRoot: string,
  userMd5: string,
  startTime: number | undefined,
  endTime: number | undefined,
  messages: Message[]
): void {
  const cache = loadOrCreate(accountRoot)
  if (!cache) return
  const nextMessages = cache.messages || {}
  nextMessages[messageBucketKey(userMd5, startTime, endTime)] = {
    updatedAt: Date.now(),
    startTime,
    endTime,
    items: messages.slice(-MAX_MESSAGES_PER_BUCKET)
  }
  pruneMessageBuckets(nextMessages)
  cache.messages = nextMessages
  cache.updatedAt = Date.now()
  writeCacheFile(cache)
}
