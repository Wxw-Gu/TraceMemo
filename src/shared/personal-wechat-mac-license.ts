/**
 * macOS 设备授权接口的 wire 类型。
 * 所有字段都由 `parseMacLicenseStatus` 运行时校验后才会交给上层使用。
 */

export type MacLicenseState =
  | 'unlicensed' // no license for this device
  | 'valid' // online check passed in this process
  | 'cached' // local cache verified, not re-confirmed online
  | 'expired'
  | 'revoked'
  | 'device_mismatch' // token belongs to a different device
  | 'identity_error' // device key unusable
  | 'server_unavailable' // network / 5xx; cache may still hold
  | 'checking' // an online refresh is in flight
  | 'unsupported' // host is running but has no /license endpoints (old build)
  | 'runtime_missing' // host not reachable / runtime absent
  | 'platform_unsupported' // not macOS native (Windows / OSS)

const MAC_LICENSE_STATES = new Set<MacLicenseState>([
  'unlicensed',
  'valid',
  'cached',
  'expired',
  'revoked',
  'device_mismatch',
  'identity_error',
  'server_unavailable',
  'checking',
  'unsupported',
  'runtime_missing',
  'platform_unsupported'
])

export interface MacLicenseStatus {
  deviceId: string | null
  state: MacLicenseState
  authorized: boolean
  source: 'online' | 'cache' | 'none'
  features: string[]
  lastCheckedAt: string | null
  licenseExpiresAt: string | null
  tokenExpiresAt: string | null
  message: string
  /** False when the running host predates the license endpoints (404). */
  runtimeProtocolSupported?: boolean
  /** Host-reported numeric TM_WECHAT_* code when a refresh failed. */
  errorCode?: number | null
}

const DEVICE_ID_PATTERN = /^mac_[0-9a-f]{64}$/

function asOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asOptionalIsoDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  // Accept RFC3339 (what the native core emits); reject obvious garbage.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) return null
  return value
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/**
 * 把任意 JSON 校验成 MacLicenseStatus；无法确认的字段一律落到安全默认值。
 * `authorized` 由 state 重算，伪造的 `authorized: true` 覆盖不了已撤销状态。
 */
export function parseMacLicenseStatus(raw: unknown): MacLicenseStatus {
  const base: MacLicenseStatus = {
    deviceId: null,
    state: 'unlicensed',
    authorized: false,
    source: 'none',
    features: [],
    lastCheckedAt: null,
    licenseExpiresAt: null,
    tokenExpiresAt: null,
    message: '当前设备暂无发送能力授权'
  }
  if (raw === null || typeof raw !== 'object') return base
  const record = raw as Record<string, unknown>

  const deviceId = asOptionalString(record.deviceId)
  if (deviceId !== null && DEVICE_ID_PATTERN.test(deviceId)) {
    base.deviceId = deviceId
  }

  const state = asOptionalString(record.state)
  if (state !== null && MAC_LICENSE_STATES.has(state as MacLicenseState)) {
    base.state = state as MacLicenseState
  }

  const source = asOptionalString(record.source)
  if (source === 'online' || source === 'cache' || source === 'none') {
    base.source = source
  }

  base.features = asStringArray(record.features)
  base.lastCheckedAt = asOptionalIsoDate(record.lastCheckedAt)
  base.licenseExpiresAt = asOptionalIsoDate(record.licenseExpiresAt)
  base.tokenExpiresAt = asOptionalIsoDate(record.tokenExpiresAt)

  const message = asOptionalString(record.message)
  if (message !== null) base.message = message

  if (typeof record.runtimeProtocolSupported === 'boolean') {
    base.runtimeProtocolSupported = record.runtimeProtocolSupported
  }
  if (typeof record.errorCode === 'number' && Number.isFinite(record.errorCode)) {
    base.errorCode = record.errorCode
  }

  /*
   * authorized is DERIVED, not copied: only a small whitelist of states may
   * present as authorized, and even then the payload's own boolean must agree.
   * This keeps a forged {"authorized": true} from flipping a revoked state.
   */
  const trustedStates: ReadonlySet<MacLicenseState> = new Set(['valid', 'cached'])
  base.authorized = trustedStates.has(base.state) && record.authorized === true

  return base
}

/**
 * Build the "runtime missing / old host" status without a network round-trip.
 * Used when the host is down or answered 404 on /license/status.
 */
export function offlineMacLicenseStatus(
  state: 'runtime_missing' | 'unsupported' | 'platform_unsupported' | 'server_unavailable',
  message: string
): MacLicenseStatus {
  return {
    deviceId: null,
    state,
    authorized: false,
    source: 'none',
    features: [],
    lastCheckedAt: null,
    licenseExpiresAt: null,
    tokenExpiresAt: null,
    message,
    runtimeProtocolSupported: state === 'unsupported' ? false : undefined
  }
}
