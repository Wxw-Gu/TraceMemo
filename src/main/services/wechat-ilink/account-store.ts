import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Dirent
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ILinkCredentials } from './types'

/**
 * 账号与游标持久化。
 *
 * 目录布局沿用历史命名（含 `wechat-connector` 这一层），保证升级后**不需要重新扫码**：
 *   ~/.tracememo/wechat-connector/accounts/<account-id>.json         凭据
 *   ~/.tracememo/wechat-connector/accounts/<account-id>.sync.json    长轮询游标
 *   ~/.tracememo/wechat-connector/accounts/<account-id>.context.json 会话上下文令牌
 *
 * 历史目录 ~/.wechatexplorer/wechat-connector/accounts 只读兼容，不删除、不覆写。
 */

const CONNECTOR_DIR_NAME = 'wechat-connector'
const ACCOUNTS_DIR_NAME = 'accounts'
const CURRENT_ROOT = '.tracememo'
const LEGACY_ROOT = '.wechatexplorer'
const FILE_MODE = 0o600
const DIR_MODE = 0o700

export type HomeDirectoryResolver = () => string

export function normalizeAccountId(raw: string): string {
  const value = String(raw ?? '')
  if (!value) return ''
  // @ . : 统一替换为 -，使账号 ID 可以作为文件名。
  return value.replace(/[@.:]/g, '-')
}

export function accountsDirectory(home: HomeDirectoryResolver = homedir): string {
  return join(home(), CURRENT_ROOT, CONNECTOR_DIR_NAME, ACCOUNTS_DIR_NAME)
}

export function legacyAccountsDirectory(home: HomeDirectoryResolver = homedir): string {
  return join(home(), LEGACY_ROOT, CONNECTOR_DIR_NAME, ACCOUNTS_DIR_NAME)
}

function ensureDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: DIR_MODE })
}

/** 原子写入：先写临时文件再 rename，避免进程退出留下半截 JSON。 */
function writeJsonAtomically(path: string, value: unknown): void {
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(tempPath, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: FILE_MODE })
    chmodSync(tempPath, FILE_MODE)
    renameSync(tempPath, path)
    chmodSync(path, FILE_MODE)
  } catch (error) {
    try {
      rmSync(tempPath, { force: true })
    } catch {
      // 清理失败不影响主流程：文件本身不会覆盖有效数据。
    }
    throw error
  }
}

function readJsonIfValid<T>(path: string, validate: (value: T) => boolean): T | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as T
    return validate(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function isCredentials(value: unknown): value is ILinkCredentials {
  const candidate = value as Partial<ILinkCredentials> | null
  return Boolean(candidate && typeof candidate.bot_token === 'string' && candidate.bot_token)
}

/** 找到某个账号凭据实际所在目录：优先当前目录，其次历史目录。 */
export function resolveAccountDirectory(
  accountId: string,
  home: HomeDirectoryResolver = homedir
): { directory: string; legacy: boolean } {
  const current = accountsDirectory(home)
  if (existsSync(join(current, `${accountId}.json`))) return { directory: current, legacy: false }
  const legacy = legacyAccountsDirectory(home)
  if (existsSync(join(legacy, `${accountId}.json`))) return { directory: legacy, legacy: true }
  return { directory: current, legacy: false }
}

/**
 * 保存新登录的凭据。
 * 先写入新凭据再清理旧账号文件，因此一次失败的登录不会摧毁上一个可用账号。
 * 同时保留同前缀的 `<id>.sync.json` / `<id>.context.json`。
 */
export function saveCredentials(
  credentials: ILinkCredentials,
  home: HomeDirectoryResolver = homedir
): string {
  const directory = accountsDirectory(home)
  ensureDirectory(directory)
  const accountId = normalizeAccountId(credentials.ilink_bot_id)
  if (!accountId) throw new Error('登录凭据缺少 ilink_bot_id，无法保存')

  const path = join(directory, `${accountId}.json`)
  writeJsonAtomically(path, credentials)

  const keepPrefix = `${accountId}.`
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) continue
    if (!entry.name.endsWith('.json')) continue
    if (entry.name.startsWith(keepPrefix)) continue
    try {
      rmSync(join(directory, entry.name), { force: true })
    } catch {
      // 旧凭据清理失败不影响新凭据可用性。
    }
  }
  return path
}

function loadCredentialsFromDirectory(directory: string): ILinkCredentials[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return []
  }
  const result: ILinkCredentials[] = []
  for (const entry of entries) {
    if (entry.isDirectory() || !entry.name.endsWith('.json')) continue
    const credential = readJsonIfValid<ILinkCredentials>(join(directory, entry.name), isCredentials)
    if (credential) result.push(credential)
  }
  return result
}

/** 当前目录优先；当前目录为空时回退到历史目录（一次性升级兼容，不迁移不删除）。 */
export function loadAllCredentials(home: HomeDirectoryResolver = homedir): ILinkCredentials[] {
  const current = loadCredentialsFromDirectory(accountsDirectory(home))
  if (current.length > 0) return current
  return loadCredentialsFromDirectory(legacyAccountsDirectory(home))
}

export function findCredentials(
  accountId: string,
  home: HomeDirectoryResolver = homedir
): ILinkCredentials | undefined {
  const { directory } = resolveAccountDirectory(accountId, home)
  const credential = readJsonIfValid<ILinkCredentials>(
    join(directory, `${accountId}.json`),
    isCredentials
  )
  if (credential) return credential
  return loadAllCredentials(home).find(
    (item) => normalizeAccountId(item.ilink_bot_id) === accountId || item.ilink_bot_id === accountId
  )
}

/* ------------------------------------------------------------------ */
/* 长轮询游标                                                          */
/* ------------------------------------------------------------------ */

interface SyncRecord {
  get_updates_buf: string
}

/**
 * 游标按账号隔离保存。切换账号时绝不沿用上一个账号的游标。
 */
export function loadCursor(accountId: string, home: HomeDirectoryResolver = homedir): string {
  const { directory } = resolveAccountDirectory(accountId, home)
  const record = readJsonIfValid<SyncRecord>(join(directory, `${accountId}.sync.json`), (value) =>
    Boolean(value && typeof value.get_updates_buf === 'string')
  )
  return record?.get_updates_buf ?? ''
}

export function saveCursor(
  accountId: string,
  getUpdatesBuf: string,
  home: HomeDirectoryResolver = homedir
): void {
  // 必须写到 loadCursor 实际读取的目录：如果凭据仍在历史目录（尚未迁移），
  // 写进当前目录会导致游标永远读不回来，长轮询就会反复重投同一条消息。
  const { directory } = resolveAccountDirectory(accountId, home)
  ensureDirectory(directory)
  writeJsonAtomically(join(directory, `${accountId}.sync.json`), {
    get_updates_buf: getUpdatesBuf
  } satisfies SyncRecord)
}

export function clearCursor(accountId: string, home: HomeDirectoryResolver = homedir): void {
  const { directory } = resolveAccountDirectory(accountId, home)
  try {
    rmSync(join(directory, `${accountId}.sync.json`), { force: true })
  } catch {
    // 游标清理失败不阻断重连流程。
  }
}

/* ------------------------------------------------------------------ */
/* 会话上下文令牌                                                      */
/* ------------------------------------------------------------------ */

interface ContextRecord {
  tokens: Record<string, { context_token: string; updated_at: number }>
}

/**
 * context_token 属于**会话上下文**，不是账号长期凭据。
 * 按「账号 + 用户」保存最近一次有效值，用于重启后的主动发送（例如定时日报）。
 * 永不写入日志，文件权限 0600。
 */
export function saveContextToken(
  accountId: string,
  toUserId: string,
  contextToken: string,
  home: HomeDirectoryResolver = homedir,
  now: () => number = Date.now
): void {
  if (!contextToken) return
  const { directory } = resolveAccountDirectory(accountId, home)
  ensureDirectory(directory)
  const path = join(directory, `${accountId}.context.json`)
  const existing = readJsonIfValid<ContextRecord>(path, (value) =>
    Boolean(value && typeof value.tokens === 'object' && value.tokens !== null)
  ) ?? { tokens: {} }

  const tokens: ContextRecord['tokens'] = {
    ...existing.tokens,
    [toUserId]: { context_token: contextToken, updated_at: now() }
  }

  // 只保留最近 500 条，避免文件无限增长。
  const entries = Object.entries(tokens).sort(
    (left, right) => right[1].updated_at - left[1].updated_at
  )
  const trimmed = Object.fromEntries(entries.slice(0, 500))
  writeJsonAtomically(path, { tokens: trimmed } satisfies ContextRecord)
}

export function loadContextToken(
  accountId: string,
  toUserId: string,
  home: HomeDirectoryResolver = homedir
): string | undefined {
  const { directory } = resolveAccountDirectory(accountId, home)
  const record = readJsonIfValid<ContextRecord>(
    join(directory, `${accountId}.context.json`),
    (value) => Boolean(value && typeof value.tokens === 'object' && value.tokens !== null)
  )
  return record?.tokens?.[toUserId]?.context_token || undefined
}
