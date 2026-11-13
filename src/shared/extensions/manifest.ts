import {
  EXTENSION_PERMISSIONS,
  normalizeExtensionPermissions,
  type ExtensionPermission
} from './permissions'

/**
 * 扩展 manifest v1。
 *
 * 校验策略：**未知值一律拒绝而不是静默丢弃**。一个拼错的权限名如果被悄悄忽略，
 * 扩展会在运行期以 `PERMISSION_DENIED` 失败，而作者看到的是「manifest 合法」。
 */

export const EXTENSION_MANIFEST_VERSION = 1
/** 宿主实现的扩展 API 主版本。扩展的 `apiVersion` 主版本必须与它相同。 */
export const EXTENSION_API_VERSION = '1'
/** 低于该版本的 TraceMemo 不允许安装本 SDK 产出的扩展。 */
export const EXTENSION_MIN_APP_VERSION = '2.6.0'

export type ExtensionMessageType =
  | 'text'
  | 'image'
  | 'voice'
  | 'video'
  | 'sticker'
  | 'file'
  | 'link'
  | 'system'
  | 'other'

export const EXTENSION_MESSAGE_TYPES: readonly ExtensionMessageType[] = [
  'text',
  'image',
  'voice',
  'video',
  'sticker',
  'file',
  'link',
  'system',
  'other'
]

export interface ExtensionPageContribution {
  id: string
  title: string
  /** 相对扩展根目录的 HTML 路径；缺省用 `entrypoints.page`。 */
  entry?: string
}

export interface ExtensionAutomationActionContribution {
  id: string
  title: string
  description?: string
}

export interface ExtensionSubscriptions {
  messageTypes: ExtensionMessageType[]
  /** 空数组 = 不按会话过滤。非空时只投递这些会话。 */
  conversationIds: string[]
  requireMentionMe: boolean
  /** 默认 false：扩展默认收不到自己发出的消息。 */
  includeSelf: boolean
}

export interface ExtensionManifest {
  manifestVersion: number
  id: string
  name: string
  version: string
  apiVersion: string
  minAppVersion?: string
  description?: string
  author?: string
  homepage?: string
  permissions: ExtensionPermission[]
  entrypoints: {
    page?: string
    background?: string
  }
  subscriptions?: ExtensionSubscriptions
  contributions: {
    pages: ExtensionPageContribution[]
    automationActions: ExtensionAutomationActionContribution[]
  }
}

export interface ExtensionCompatibility {
  compatible: boolean
  code?: 'api_version' | 'app_version' | 'manifest'
  reason?: string
}

export interface ManifestParseResult {
  ok: boolean
  manifest?: ExtensionManifest
  code?: 'EXTENSION_INVALID_MANIFEST' | 'EXTENSION_INCOMPATIBLE'
  message?: string
}

const EXTENSION_ID_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)+$/
const RESERVED_ID_PREFIXES = ['com.tracememo.', 'tracememo.', 'tm.']
const SEMVER_PATTERN = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:-[0-9A-Za-z.-]{1,40})?$/
const PAGE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/
const ACTION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/
const MAX_PAGES = 20
const MAX_AUTOMATION_ACTIONS = 20
const MAX_NAME_LENGTH = 64
const MAX_DESCRIPTION_LENGTH = 500
const MAX_CONVERSATION_SCOPE = 200

export function isValidExtensionId(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const id = value.trim()
  if (id.length < 3 || id.length > 128) return false
  if (!EXTENSION_ID_PATTERN.test(id)) return false
  return !RESERVED_ID_PREFIXES.some((prefix) => id.startsWith(prefix))
}

export function isValidExtensionVersion(value: unknown): value is string {
  return typeof value === 'string' && SEMVER_PATTERN.test(value.trim())
}

/**
 * 纯数字比较，忽略 prerelease。
 *
 * `minAppVersion` 的语义是「最低可运行版本」，把 `2.6.0-beta.1` 判成低于 `2.6.0`
 * 会让预发布构建无法安装明示支持的扩展；宁可放行，也不误伤。
 */
export function compareSemver(left: string, right: string): number | null {
  const a = SEMVER_PATTERN.exec(String(left || '').trim())
  const b = SEMVER_PATTERN.exec(String(right || '').trim())
  if (!a || !b) return null
  for (let index = 1; index <= 3; index += 1) {
    const delta = Number(a[index]) - Number(b[index])
    if (delta !== 0) return delta > 0 ? 1 : -1
  }
  return 0
}

export function isApiVersionCompatible(
  apiVersion: unknown,
  hostApiVersion = EXTENSION_API_VERSION
): boolean {
  const declared = String(apiVersion ?? '').trim()
  if (!/^\d+$/.test(declared)) return false
  return declared === String(hostApiVersion).trim()
}

export function checkExtensionCompatibility(
  input: { apiVersion?: unknown; minAppVersion?: unknown },
  appVersion: string
): ExtensionCompatibility {
  if (!isApiVersionCompatible(input.apiVersion)) {
    return {
      compatible: false,
      code: 'api_version',
      reason: `扩展 API 版本 ${String(input.apiVersion ?? '')} 与当前 TraceMemo 不兼容`
    }
  }
  const minAppVersion = String(input.minAppVersion ?? '').trim()
  if (!minAppVersion) return { compatible: true }
  if (!isValidExtensionVersion(minAppVersion)) {
    return { compatible: false, code: 'manifest', reason: 'minAppVersion 不是合法版本号' }
  }
  const compared = compareSemver(appVersion, minAppVersion)
  if (compared === null) return { compatible: true }
  if (compared < 0) {
    return {
      compatible: false,
      code: 'app_version',
      reason: `需要 TraceMemo ${minAppVersion} 或更高版本（当前 ${appVersion}）`
    }
  }
  return { compatible: true }
}

/**
 * 相对路径安全检查（纯字符串层）。
 *
 * 只做语法判断；**真实路径是否仍在扩展目录内必须由主进程用 realpath 再验一次** ——
 * 符号链接可以绕过任何纯字符串检查。
 */
export function isSafeRelativeEntryPath(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const raw = value.trim().replace(/\\/g, '/')
  if (!raw || raw.length > 240) return false
  if (raw.includes('\0')) return false
  if (raw.startsWith('/') || raw.startsWith('//')) return false
  if (/^[A-Za-z]:/.test(raw)) return false
  const segments = raw.split('/')
  if (segments.length > 10) return false
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') return false
    if (segment.length > 64) return false
    if (!/^[A-Za-z0-9._@+\- ]+$/.test(segment)) return false
    if (/[. ]$/.test(segment)) return false
    // Windows 对 `con.txt` 与 `con` 一视同仁，保留名按「点前的主干」判断。
    if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(segment)) return false
  }
  return true
}

function asTrimmedString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, maxLength)
}

function parseMessageTypes(input: unknown): ExtensionMessageType[] {
  if (!Array.isArray(input)) return ['text']
  const result: ExtensionMessageType[] = []
  for (const value of input) {
    if (typeof value !== 'string') return []
    if (!EXTENSION_MESSAGE_TYPES.includes(value as ExtensionMessageType)) return []
    const typed = value as ExtensionMessageType
    if (!result.includes(typed)) result.push(typed)
  }
  return result.length ? result : ['text']
}

function parseSubscriptions(input: unknown): ExtensionSubscriptions | null {
  if (input === undefined) return null
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const raw = input as Record<string, unknown>
  const messageTypes = parseMessageTypes(raw.messageTypes)
  if (!messageTypes.length) return null
  const conversationIds: string[] = []
  if (raw.conversationIds !== undefined) {
    if (!Array.isArray(raw.conversationIds)) return null
    if (raw.conversationIds.length > MAX_CONVERSATION_SCOPE) return null
    for (const value of raw.conversationIds) {
      if (typeof value !== 'string') return null
      const id = value.trim()
      if (!id || id.length > 128) return null
      if (!conversationIds.includes(id)) conversationIds.push(id)
    }
  }
  return {
    messageTypes,
    conversationIds,
    requireMentionMe: raw.requireMentionMe === true,
    includeSelf: raw.includeSelf === true
  }
}

function parsePages(input: unknown): ExtensionPageContribution[] | null {
  if (input === undefined) return []
  if (!Array.isArray(input) || input.length > MAX_PAGES) return null
  const pages: ExtensionPageContribution[] = []
  for (const value of input) {
    if (!value || typeof value !== 'object') return null
    const raw = value as Record<string, unknown>
    const id = asTrimmedString(raw.id, 32)
    const title = asTrimmedString(raw.title, 40)
    if (!PAGE_ID_PATTERN.test(id) || !title) return null
    if (pages.some((page) => page.id === id)) return null
    if (raw.entry !== undefined) {
      if (!isSafeRelativeEntryPath(raw.entry)) return null
      pages.push({ id, title, entry: raw.entry })
    } else {
      pages.push({ id, title })
    }
  }
  return pages
}

function parseAutomationActions(input: unknown): ExtensionAutomationActionContribution[] | null {
  if (input === undefined) return []
  if (!Array.isArray(input) || input.length > MAX_AUTOMATION_ACTIONS) return null
  const actions: ExtensionAutomationActionContribution[] = []
  for (const value of input) {
    if (!value || typeof value !== 'object') return null
    const raw = value as Record<string, unknown>
    const id = asTrimmedString(raw.id, 64)
    const title = asTrimmedString(raw.title, 60)
    if (!ACTION_ID_PATTERN.test(id) || !title) return null
    if (actions.some((action) => action.id === id)) return null
    const description = asTrimmedString(raw.description, 200)
    actions.push({ id, title, ...(description ? { description } : {}) })
  }
  return actions
}

function fail(
  message: string,
  code: ManifestParseResult['code'] = 'EXTENSION_INVALID_MANIFEST'
): ManifestParseResult {
  return { ok: false, code, message }
}

/** 解析并收敛 manifest。失败时返回**具体**原因，供安装界面直接展示。 */
export function parseExtensionManifest(
  input: unknown,
  options: { appVersion?: string } = {}
): ManifestParseResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return fail('manifest 必须是 JSON 对象')
  }
  const raw = input as Record<string, unknown>

  if (Number(raw.manifestVersion) !== EXTENSION_MANIFEST_VERSION) {
    return fail(`manifestVersion 必须是 ${EXTENSION_MANIFEST_VERSION}`)
  }
  if (!isValidExtensionId(raw.id)) {
    return fail('id 必须是反向域名形式（如 com.example.hello），且不能使用 TraceMemo 保留前缀')
  }
  const name = asTrimmedString(raw.name, MAX_NAME_LENGTH)
  if (!name) return fail('name 不能为空')
  if (!isValidExtensionVersion(raw.version)) return fail('version 必须是 x.y.z 形式')
  if (!isApiVersionCompatible(raw.apiVersion)) {
    return fail('apiVersion 与当前 TraceMemo 扩展 API 不兼容', 'EXTENSION_INCOMPATIBLE')
  }
  if (raw.minAppVersion !== undefined && !isValidExtensionVersion(raw.minAppVersion)) {
    return fail('minAppVersion 必须是 x.y.z 形式')
  }

  if (!Array.isArray(raw.permissions)) return fail('permissions 必须是数组')
  for (const permission of raw.permissions) {
    if (
      typeof permission !== 'string' ||
      !(EXTENSION_PERMISSIONS as readonly string[]).includes(permission)
    ) {
      return fail(`未知权限：${String(permission)}`)
    }
  }
  const permissions = normalizeExtensionPermissions(raw.permissions)

  const entrypointsRaw = raw.entrypoints
  if (!entrypointsRaw || typeof entrypointsRaw !== 'object' || Array.isArray(entrypointsRaw)) {
    return fail('entrypoints 必须是对象')
  }
  const entryRaw = entrypointsRaw as Record<string, unknown>
  const entrypoints: ExtensionManifest['entrypoints'] = {}
  if (entryRaw.page !== undefined) {
    if (!isSafeRelativeEntryPath(entryRaw.page)) return fail('entrypoints.page 不是安全的相对路径')
    entrypoints.page = entryRaw.page
  }
  if (entryRaw.background !== undefined) {
    if (!isSafeRelativeEntryPath(entryRaw.background)) {
      return fail('entrypoints.background 不是安全的相对路径')
    }
    entrypoints.background = entryRaw.background
  }

  const subscriptions = parseSubscriptions(raw.subscriptions)
  if (raw.subscriptions !== undefined && subscriptions === null) {
    return fail('subscriptions 字段不合法（messageTypes 必须是已知消息类型）')
  }

  const contributionsRaw = raw.contributions
  if (
    contributionsRaw !== undefined &&
    (typeof contributionsRaw !== 'object' || Array.isArray(contributionsRaw))
  ) {
    return fail('contributions 必须是对象')
  }
  const contributionsObject = (contributionsRaw ?? {}) as Record<string, unknown>
  const pages = parsePages(contributionsObject.pages)
  if (pages === null) return fail('contributions.pages 不合法')
  const automationActions = parseAutomationActions(contributionsObject.automationActions)
  if (automationActions === null) return fail('contributions.automationActions 不合法')

  if (pages.length > 0 && !entrypoints.page) {
    return fail('注册了页面但缺少 entrypoints.page')
  }
  if ((subscriptions !== null || automationActions.length > 0) && !entrypoints.background) {
    return fail('声明了消息订阅或自动化动作，必须提供 entrypoints.background')
  }
  if (!entrypoints.page && !entrypoints.background) {
    return fail('至少需要 entrypoints.page 或 entrypoints.background')
  }
  if (permissions.includes('messages.subscribe') && !subscriptions) {
    return fail('申请 messages.subscribe 时必须声明 subscriptions')
  }

  const description = asTrimmedString(raw.description, MAX_DESCRIPTION_LENGTH)
  const author = asTrimmedString(raw.author, 80)
  const homepage = asTrimmedString(raw.homepage, 200)
  const minAppVersion = asTrimmedString(raw.minAppVersion, 20)

  const manifest: ExtensionManifest = {
    manifestVersion: EXTENSION_MANIFEST_VERSION,
    id: raw.id.trim(),
    name,
    version: String(raw.version).trim(),
    apiVersion: String(raw.apiVersion).trim(),
    ...(minAppVersion ? { minAppVersion } : {}),
    ...(description ? { description } : {}),
    ...(author ? { author } : {}),
    ...(homepage && /^https?:\/\//.test(homepage) ? { homepage } : {}),
    permissions,
    entrypoints,
    ...(subscriptions ? { subscriptions } : {}),
    contributions: { pages, automationActions }
  }

  if (options.appVersion) {
    const compatibility = checkExtensionCompatibility(manifest, options.appVersion)
    if (!compatibility.compatible) {
      return fail(compatibility.reason || '扩展与当前版本不兼容', 'EXTENSION_INCOMPATIBLE')
    }
  }

  return { ok: true, manifest }
}

/** 解析 manifest JSON 文本。JSON 语法错误与 schema 错误分开报，便于作者定位。 */
export function parseExtensionManifestJson(
  text: string,
  options: { appVersion?: string } = {}
): ManifestParseResult {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return fail('manifest.json 不是合法 JSON')
  }
  return parseExtensionManifest(value, options)
}
