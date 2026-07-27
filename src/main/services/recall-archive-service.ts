import { app } from 'electron'
import crypto from 'crypto'
import fs from 'fs-extra'
import path from 'path'
import type { Message } from '../../shared/types'

type RecallRecord = {
  targetIds: string[]
  actor?: string
  noticeId: string
  createTime: number
}

type ArchivedMessage = Message & {
  archivedAt: number
  recallNotice?: boolean
}

type SessionArchive = {
  username: string
  updatedAt: number
  messages: ArchivedMessage[]
  recalls: RecallRecord[]
}

type RecallArchiveFile = {
  version: 1
  accountRoot: string
  updatedAt: number
  sessions: Record<string, SessionArchive>
}

const ARCHIVE_VERSION = 1
const MAX_MESSAGES_PER_SESSION = 3000
const MAX_RECALLS_PER_SESSION = 500
const WRITE_DEBOUNCE_MS = 250

let archive: RecallArchiveFile | null = null
let archivePath = ''
let writeTimer: NodeJS.Timeout | null = null
let writeQueue: Promise<void> = Promise.resolve()

function messageIdentity(message: Message): string {
  if (message.recoveredFromRecallJournal) {
    return `recovered:${message.localId || 0}:${message.serverId || message.id}`
  }
  if (message.localId) return `local:${message.localId}`
  if (message.serverId) return `server:${message.serverId}`
  if (message.id) return `id:${message.id}`
  return `${message.createTime || 0}:${message.from}:${message.type}:${message.content}`
}

function messageTargetIds(message: Message): string[] {
  return Array.from(
    new Set(
      [
        message.serverId,
        message.localId ? String(message.localId) : '',
        message.id ? String(message.id) : ''
      ].filter((value): value is string => Boolean(value))
    )
  )
}

function isRecallNotice(message: Message): boolean {
  return message.contentData?.type === 'system' && Boolean(message.contentData.recall)
}

function matchesRecall(message: Message, recall: RecallRecord): boolean {
  const messageIds = messageTargetIds(message)
  return recall.targetIds.some((targetId) => messageIds.includes(targetId))
}

function inferRecallTarget(
  messages: Iterable<ArchivedMessage>,
  notice: Message,
  actor?: string,
  claimedTargetIds: Set<string> = new Set()
): ArchivedMessage | undefined {
  const noticeTime = notice.createTime || 0
  const expectsMine = /^(你|我)$/.test(String(actor || '').trim()) || /^你撤回/.test(notice.content)
  const eligible = Array.from(messages)
    .filter((message) => {
      if (message.type === '系统消息' || message.from === 'system' || message.recallNotice)
        return false
      if (!message.recoveredFromRecallJournal) return false
      if (messageTargetIds(message).some((targetId) => claimedTargetIds.has(targetId))) return false
      if (noticeTime && message.createTime && message.createTime > noticeTime) return false
      if (noticeTime && message.createTime && noticeTime - message.createTime > 180) return false
      return true
    })
    .sort((left, right) => {
      const timeDelta = (right.createTime || 0) - (left.createTime || 0)
      if (timeDelta) return timeDelta
      return (right.localId || 0) - (left.localId || 0)
    })

  const strict = eligible.find((message) => {
    if (expectsMine) return message.isSender
    if (!actor) return true
    const names = [message.name, message.senderId].map((value) => String(value || '').trim())
    return !names.some(Boolean) || names.includes(actor)
  })

  // Journal rows are captured at deletion time, so the fallback never points at
  // an unrelated visible message merely because it happened to be nearby.
  return strict || eligible[0]
}

function annotateFromRecall(message: Message, recalls: RecallRecord[]): Message {
  if (isRecallNotice(message)) return message
  const recall = recalls.find((item) => matchesRecall(message, item))
  if (!recall) return message
  const recalledByMe = /^(你|我)$/.test(String(recall.actor || '').trim())
  return {
    ...message,
    from: recalledByMe ? 'assistant' : message.from,
    isSender: recalledByMe ? true : message.isSender,
    recalled: true,
    recalledBy: recall.actor
  }
}

function scheduleWrite(): void {
  if (!archive || !archivePath) return
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = setTimeout(() => {
    writeTimer = null
    if (!archive || !archivePath) return
    const targetPath = archivePath
    const serialized = JSON.stringify(archive)
    writeQueue = writeQueue
      .catch(() => undefined)
      .then(async () => {
        await fs.ensureDir(path.dirname(targetPath))
        const temporaryPath = `${targetPath}.tmp`
        await fs.writeFile(temporaryPath, serialized, 'utf8')
        await fs.move(temporaryPath, targetPath, { overwrite: true })
      })
      .catch((error) => {
        console.warn('[RecallArchive] write failed:', error)
      })
  }, WRITE_DEBOUNCE_MS)
}

function loadArchive(accountRoot: string): RecallArchiveFile {
  const hash = crypto
    .createHash('sha1')
    .update(`${process.platform}:${accountRoot}`)
    .digest('hex')
    .slice(0, 16)
  archivePath = path.join(app.getPath('userData'), 'recall-archive', `${hash}.json`)

  try {
    if (fs.existsSync(archivePath)) {
      const stored = fs.readJsonSync(archivePath) as Partial<RecallArchiveFile>
      if (
        stored.version === ARCHIVE_VERSION &&
        stored.accountRoot === accountRoot &&
        stored.sessions &&
        typeof stored.sessions === 'object'
      ) {
        return stored as RecallArchiveFile
      }
    }
  } catch (error) {
    console.warn('[RecallArchive] read failed:', error)
  }

  return {
    version: ARCHIVE_VERSION,
    accountRoot,
    updatedAt: Date.now(),
    sessions: {}
  }
}

export function configureRecallArchive(accountRoot: string): void {
  const normalizedRoot = String(accountRoot || '').trim()
  if (!normalizedRoot) {
    archive = null
    archivePath = ''
    return
  }
  if (archive?.accountRoot === normalizedRoot) return
  archive = loadArchive(normalizedRoot)
}

export function recordRecallArchiveMessages(
  sessionMd5: string,
  username: string,
  messages: Message[]
): void {
  if (!archive || !sessionMd5 || messages.length === 0) return

  const bucket =
    archive.sessions[sessionMd5] ||
    ({
      username,
      updatedAt: Date.now(),
      messages: [],
      recalls: []
    } satisfies SessionArchive)
  if (username) bucket.username = username

  const byIdentity = new Map(bucket.messages.map((message) => [messageIdentity(message), message]))
  let changed = false
  const targetlessNoticeIds = new Set(
    messages
      .filter((message) => {
        const recall =
          message.contentData?.type === 'system' ? message.contentData.recall : undefined
        return Boolean(recall && !(recall.targetIds?.length || recall.targetId))
      })
      .map(messageIdentity)
  )
  if (targetlessNoticeIds.size > 0) {
    const retained = bucket.recalls.filter((record) => !targetlessNoticeIds.has(record.noticeId))
    if (retained.length !== bucket.recalls.length) {
      bucket.recalls = retained
      changed = true
    }
  }

  for (const sourceMessage of messages) {
    const recallData =
      sourceMessage.contentData?.type === 'system' ? sourceMessage.contentData.recall : undefined
    if (recallData) {
      let targetIds = Array.from(
        new Set([...(recallData.targetIds || []), recallData.targetId || ''].filter(Boolean))
      )
      const noticeId = messageIdentity(sourceMessage)
      const noticeTargetIds = new Set(messageTargetIds(sourceMessage))
      const existingRecordIndex = bucket.recalls.findIndex((record) => record.noticeId === noticeId)
      const existingRecord =
        existingRecordIndex >= 0 ? bucket.recalls[existingRecordIndex] : undefined
      const existingTargetsNotice =
        existingRecord &&
        existingRecord.targetIds.length > 0 &&
        existingRecord.targetIds.every((targetId) => noticeTargetIds.has(targetId))

      if (
        targetIds.length === 0 &&
        existingRecord &&
        !existingTargetsNotice &&
        !targetlessNoticeIds.has(noticeId)
      ) {
        targetIds = existingRecord.targetIds
      }
      if (targetIds.length === 0) {
        const claimedTargetIds = new Set(bucket.recalls.flatMap((record) => record.targetIds))
        const inferred = inferRecallTarget(
          byIdentity.values(),
          sourceMessage,
          recallData.actor,
          claimedTargetIds
        )
        if (inferred) targetIds = messageTargetIds(inferred)
      }
      if (targetIds.length > 0) {
        const nextRecord: RecallRecord = {
          targetIds,
          actor: recallData.actor,
          noticeId,
          createTime: sourceMessage.createTime || 0
        }
        const unchanged =
          existingRecord &&
          existingRecord.targetIds.length === targetIds.length &&
          existingRecord.targetIds.every((targetId) => targetIds.includes(targetId)) &&
          existingRecord.actor === nextRecord.actor
        if (!unchanged) {
          if (existingRecordIndex >= 0) bucket.recalls.splice(existingRecordIndex, 1, nextRecord)
          else bucket.recalls.push(nextRecord)
          changed = true
        }
      }
    }

    const annotated = annotateFromRecall(sourceMessage, bucket.recalls)
    const next: ArchivedMessage = {
      ...annotated,
      archivedAt: Date.now(),
      recallNotice: isRecallNotice(sourceMessage)
    }
    const identity = messageIdentity(next)
    const previous = byIdentity.get(identity)
    if (
      !previous ||
      previous.recalled !== next.recalled ||
      previous.content !== next.content ||
      previous.serverId !== next.serverId
    ) {
      byIdentity.set(identity, next)
      changed = true
    }
  }

  const recalls = bucket.recalls.slice(-MAX_RECALLS_PER_SESSION)
  const nextMessages = Array.from(byIdentity.values())
    .map((message) => annotateFromRecall(message, recalls) as ArchivedMessage)
    .sort((left, right) => {
      const timeDelta = (left.createTime || 0) - (right.createTime || 0)
      return timeDelta || messageIdentity(left).localeCompare(messageIdentity(right))
    })
    .slice(-MAX_MESSAGES_PER_SESSION)

  if (!changed && nextMessages.every((message, index) => message === bucket.messages[index])) return

  bucket.messages = nextMessages
  bucket.recalls = recalls
  bucket.updatedAt = Date.now()
  archive.sessions[sessionMd5] = bucket
  archive.updatedAt = Date.now()
  scheduleWrite()
}

export function mergeRecallArchiveMessages<T extends Message>(
  sessionMd5: string,
  sourceMessages: T[],
  startTime?: number,
  endTime?: number,
  limit?: number
): T[] {
  const bucket = archive?.sessions[sessionMd5]
  if (!bucket) return sourceMessages

  const merged = new Map<string, Message>()
  for (const message of sourceMessages) {
    const archived = bucket.messages.find(
      (candidate) => messageIdentity(candidate) === messageIdentity(message)
    )
    merged.set(
      messageIdentity(message),
      annotateFromRecall(
        archived?.recalled
          ? { ...message, recalled: true, recalledBy: archived.recalledBy }
          : message,
        bucket.recalls
      )
    )
  }

  for (const archived of bucket.messages) {
    if (!archived.recalled && !archived.recallNotice) continue
    const createTime = archived.createTime || 0
    if (startTime && createTime < startTime) continue
    if (endTime && createTime > endTime) continue
    const identity = messageIdentity(archived)
    if (!merged.has(identity)) merged.set(identity, archived)
  }

  const result = Array.from(merged.values()).sort((left, right) => {
    const timeDelta = (left.createTime || 0) - (right.createTime || 0)
    return timeDelta || messageIdentity(left).localeCompare(messageIdentity(right))
  })
  const visible = limit && result.length > limit ? result.slice(-limit) : result
  return visible as T[]
}

export function extractChangedConversationMd5(payload: string): string[] {
  const matches = String(payload || '').match(/(?:Chat_|chat_)?([a-f0-9]{32})/gi) || []
  return Array.from(
    new Set(
      matches
        .map((value) => value.replace(/^chat_/i, '').toLowerCase())
        .filter((value) => /^[a-f0-9]{32}$/.test(value))
    )
  )
}

type ArchiveContact = {
  md5: string
  m_nsUsrName: string
  type: 'user' | 'group'
  activityKey?: string
}

export class RecallArchiveMonitor {
  private pending = new Set<string>()
  private activityBySession = new Map<string, string>()
  private timer: NodeJS.Timeout | null = null
  private stopped = false

  constructor(
    private readonly listContacts: () => ArchiveContact[],
    private readonly loadMessages: (sessionMd5: string) => Message[]
  ) {}

  seedAll(): void {
    const groups = this.conversationContacts()
    this.activityBySession = new Map(
      groups.map((contact) => [contact.md5, String(contact.activityKey || '')])
    )
    const allowed = new Set(groups.map((contact) => contact.md5))
    if (archive) {
      let pruned = false
      for (const sessionMd5 of Object.keys(archive.sessions)) {
        if (allowed.has(sessionMd5)) continue
        delete archive.sessions[sessionMd5]
        pruned = true
      }
      if (pruned) {
        archive.updatedAt = Date.now()
        scheduleWrite()
      }
    }
  }

  handleDatabaseChange(payload: string): void {
    // Ordinary message inserts are already visible in the main reader. The
    // archive scan is only needed when the native event indicates a recall.
    if (!/(recall|revoke|revokemsg|撤回)/i.test(String(payload || ''))) return
    const groups = this.conversationContacts()
    const knownMd5 = new Set(groups.map((contact) => contact.md5.toLowerCase()))
    const payloadTargets = extractChangedConversationMd5(payload).filter((md5) => knownMd5.has(md5))
    const changedActivity = groups
      .filter((contact) => {
        const nextKey = String(contact.activityKey || '')
        const previousKey = this.activityBySession.get(contact.md5)
        this.activityBySession.set(contact.md5, nextKey)
        return Boolean(nextKey && previousKey !== undefined && previousKey !== nextKey)
      })
      .map((contact) => contact.md5)
    const targets = Array.from(new Set([...payloadTargets, ...changedActivity]))
    if (targets.length > 0) {
      console.log(`[RecallArchive] database change queued=${targets.length}`)
      this.enqueue(targets)
    }
  }

  private conversationContacts(): ArchiveContact[] {
    return this.listContacts().filter(
      (contact) =>
        contact.m_nsUsrName &&
        !contact.m_nsUsrName.startsWith('@placeholder') &&
        contact.m_nsUsrName !== 'brandsessionholder' &&
        contact.m_nsUsrName !== 'brandservicesessionholder'
    )
  }

  stop(): void {
    this.stopped = true
    this.pending.clear()
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private enqueue(sessionMd5s: string[]): void {
    if (this.stopped) return
    for (const md5 of sessionMd5s) {
      if (md5) this.pending.add(md5)
    }
    this.schedule()
  }

  private schedule(): void {
    if (this.stopped || this.timer || this.pending.size === 0) return
    this.timer = setTimeout(() => {
      this.timer = null
      const md5 = this.pending.values().next().value as string | undefined
      if (!md5) return
      this.pending.delete(md5)
      try {
        this.loadMessages(md5)
      } catch (error) {
        console.warn(`[RecallArchive] background scan failed md5=${md5}:`, error)
      }
      this.schedule()
    }, 20)
  }
}
