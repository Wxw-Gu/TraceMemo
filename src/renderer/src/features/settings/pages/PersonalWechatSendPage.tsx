import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type {
  PersonalWechatSendCapability,
  PersonalWechatSenderStatus
} from '../../../../../shared/personal-wechat'
import type {
  MacLicenseState,
  MacLicenseStatus
} from '../../../../../shared/personal-wechat-mac-license'
import {
  Button,
  Input,
  Skeleton
} from '../../../components/ui'
import { isMac, isWindows } from '../../../utils/runtime-environment'

const REPOSITORY_URL = 'https://github.com/Wxw-Gu/TraceMemo'
// README 就是仓库首页，跳转后需要的正是「交流与反馈」这一节（含群二维码）。
const GROUP_README_URL = `${REPOSITORY_URL}#-交流与反馈`

const capabilityLabel: Record<PersonalWechatSendCapability['status'], string> = {
  unsupported: '暂不支持',
  unconfigured: '尚未配置',
  needs_binding: '需要绑定',
  initializing: '初始化中',
  ready: '已就绪',
  error: '异常'
}

function normalizeWindowsPort(value: string): string | null {
  const text = value.trim()
  if (!/^\d{1,5}$/.test(text)) return null
  const port = Number(text)
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? String(port) : null
}

function SendCapabilityAuthorizationCard({
  onNotice
}: {
  onNotice?: (message: string) => void
}): ReactElement {
  const [deviceId, setDeviceId] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!isMac) return
    let cancelled = false
    void (async () => {
      try {
        const status = await window.api.getMacLicenseStatus?.()
        if (!cancelled && status?.deviceId) {
          setDeviceId(status.deviceId)
        }
      } catch {
        // 忽略读取异常
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const copyDeviceId = async (): Promise<void> => {
    if (!deviceId) return
    try {
      await navigator.clipboard.writeText(deviceId)
      setCopied(true)
      onNotice?.('设备 ID 已复制')
      window.setTimeout(() => setCopied(false), 2_000)
    } catch {
      onNotice?.('复制失败，请手动选择设备 ID 复制')
    }
  }

  return (
    <section className="settings-card grid gap-3">
      {isMac ? (
        <div className="mac-native-device-row">
          <div className="mac-native-device-value">
            <span>本机设备 ID</span>
            <code title={deviceId || undefined}>
              {deviceId ? summarizeDeviceId(deviceId) : '（尚未生成）'}
            </code>
          </div>
          <Button
            variant="ghost"
            size="sm"
            disabled={!deviceId}
            aria-label="复制完整设备 ID"
            onClick={() => void copyDeviceId()}
          >
            {copied ? '已复制' : '复制'}
          </Button>
        </div>
      ) : null}
      <p>发送能力属授权制，需要联系群主。请先加入交流群，然后在群内添加群主申请授权。</p>
      <p className="settings-footnote">
        进群请点击{' '}
        <a
          className="text-primary hover:underline"
          href={GROUP_README_URL}
          target="_blank"
          rel="noreferrer"
        >
          这里
        </a>{' '}
        跳转。
      </p>
    </section>
  )
}

const macLicenseStateLabel: Record<MacLicenseState, string> = {
  unlicensed: '当前设备暂无发送能力授权',
  valid: '已授权',
  cached: '授权有效（本地缓存）',
  expired: '授权已过期',
  revoked: '授权已撤销',
  device_mismatch: '授权与当前设备不匹配',
  identity_error: '设备身份异常',
  server_unavailable: '授权服务器不可用',
  checking: '检测中…',
  unsupported: '发送组件版本较旧',
  runtime_missing: '发送组件未运行',
  platform_unsupported: '当前构建不支持'
}

const macLicenseFeatureLabel: Record<string, string> = {
  basic: '基础功能',
  wechat: '微信发送',
  advanced: '高级功能',
  api: 'API 接口'
}

function licenseTone(state: MacLicenseState): string {
  if (state === 'valid' || state === 'cached') return 'is-ready'
  if (state === 'revoked' || state === 'expired' || state === 'identity_error') return 'is-error'
  return 'is-neutral'
}

function licenseStateConflictsWithExpiry(license: MacLicenseStatus): boolean {
  const expiresAt = license.licenseExpiresAt ? Date.parse(license.licenseExpiresAt) : NaN
  return license.state === 'expired' && Number.isFinite(expiresAt) && expiresAt > Date.now()
}

function macLicenseStatusLabel(license: MacLicenseStatus): string {
  if (license.state === 'valid' || license.state === 'cached') return '设备已授权'
  if (licenseStateConflictsWithExpiry(license)) return '授权状态需刷新'
  return macLicenseStateLabel[license.state]
}

function macLicenseStatusTone(license: MacLicenseStatus): string {
  return licenseStateConflictsWithExpiry(license) ? 'is-neutral' : licenseTone(license.state)
}

function macLicenseStatusHint(license: MacLicenseStatus): string {
  if (licenseStateConflictsWithExpiry(license)) {
    return '当前授权状态与到期日不一致，请点击「重新检测授权」更新状态。'
  }
  return '将设备 ID 提供给授权管理员，完成授权后点击「重新检测授权」。'
}

function formatMacLicenseDateTime(iso: string | null): string {
  if (!iso) return '—'
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return iso
  return parsed.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function formatMacLicenseDate(iso: string | null): string {
  if (!iso) return '—'
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return iso
  return parsed.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
}

function summarizeDeviceId(deviceId: string): string {
  return deviceId.length === 68 ? `${deviceId.slice(0, 12)}…${deviceId.slice(-6)}` : deviceId
}

/** 展示当前设备的授权状态，并提供刷新与复制设备 ID 的操作。 */
export function MacNativeLicenseCard({
  onNotice,
  onStatusChange
}: {
  onNotice: (message: string) => void
  onStatusChange: (status: MacLicenseStatus) => void
}): ReactElement {
  const [license, setLicense] = useState<MacLicenseStatus | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await window.api.getMacLicenseStatus()
      setLicense(next)
      onStatusChange(next)
    } catch {
      setLicense(null)
    }
  }, [onStatusChange])

  useEffect(() => {
    void load()
  }, [load])

  const refresh = async (): Promise<void> => {
    if (refreshing) return
    setRefreshing(true)
    try {
      const next = await window.api.refreshMacLicense()
      setLicense(next)
      onStatusChange(next)
      if (next.authorized) {
        onNotice('授权检测完成：已授权')
      } else {
        onNotice(next.message || '授权检测完成')
      }
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : '授权检测失败')
    } finally {
      setRefreshing(false)
    }
  }

  const copyDeviceId = async (): Promise<void> => {
    if (!license?.deviceId) return
    try {
      await navigator.clipboard.writeText(license.deviceId)
      setCopied(true)
      onNotice('设备 ID 已复制')
      window.setTimeout(() => setCopied(false), 2_000)
    } catch {
      onNotice('复制失败，请手动选择设备 ID 复制')
    }
  }

  if (!license) {
    return <Skeleton className="h-24 w-full" />
  }
  // OSS 构建走到这里（platform_unsupported）时不渲染卡片，保证免费版不出现授权入口。
  if (license.state === 'platform_unsupported') {
    return <></>
  }

  return (
    <section className="settings-card mac-native-license-card" aria-label="发送能力授权">
      <header className="mac-native-license-header">
        <strong>发送能力授权</strong>
        <span className={`mac-native-license-status ${macLicenseStatusTone(license)}`}>
          {macLicenseStatusLabel(license)}
        </span>
      </header>

      <div className="mac-native-device-row">
        <div className="mac-native-device-value">
          <span>本机设备 ID</span>
          <code title={license.deviceId || undefined}>
            {license.deviceId ? summarizeDeviceId(license.deviceId) : '（尚未生成）'}
          </code>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={!license.deviceId}
          aria-label="复制完整设备 ID"
          onClick={() => void copyDeviceId()}
        >
          {copied ? '已复制' : '复制'}
        </Button>
      </div>
      {license.deviceId && (!license.authorized || licenseStateConflictsWithExpiry(license)) ? (
        <p className="mac-native-license-hint">{macLicenseStatusHint(license)}</p>
      ) : null}
      {license.authorized && license.features.length > 0 ? (
        <div className="mac-native-license-features" aria-label="已开通功能">
          {license.features.map((feature) => (
            <span key={feature}>{macLicenseFeatureLabel[feature] || feature}</span>
          ))}
        </div>
      ) : null}
      <div className="mac-native-license-meta">
        <span>
          授权到期 <strong>{formatMacLicenseDate(license.licenseExpiresAt)}</strong>
        </span>
        <span>
          最近检测 <strong>{formatMacLicenseDateTime(license.lastCheckedAt)}</strong>
        </span>
      </div>
      <div className="mac-native-license-footer">
        <span />
        <Button
          variant="outline"
          size="sm"
          disabled={refreshing || license.state === 'unsupported'}
          onClick={() => void refresh()}
        >
          {refreshing ? '检测中…' : '重新检测授权'}
        </Button>
      </div>
    </section>
  )
}

export function PersonalWechatSendPage({
  onNotice
}: {
  onNotice: (message: string) => void
  onOpenTextToSpeechSettings?: () => void
}): ReactElement {
  const isPortEndpointPlatform = isWindows || isMac
  const [capability, setCapability] = useState<PersonalWechatSendCapability | null>(null)
  const [loading, setLoading] = useState(true)
  const [detecting, setDetecting] = useState(false)
  const [error, setError] = useState('')
  const [windowsSenderStatus, setWindowsSenderStatus] = useState<PersonalWechatSenderStatus | null>(
    null
  )
  const [windowsPortInput, setWindowsPortInput] = useState('')
  const [windowsDetectedPort, setWindowsDetectedPort] = useState('')
  const [windowsEndpointBusy, setWindowsEndpointBusy] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    if (isPortEndpointPlatform) {
      try {
        const settingsResult = await window.api.getSettings?.()
        const configuredPort = String(settingsResult?.settings?.windowsWechatPort || '').trim()
        if (configuredPort) {
          const status = await window.api.getPersonalWechatSenderStatus()
          setWindowsSenderStatus(status)
        } else {
          setWindowsSenderStatus(null)
        }
      } catch {
        // 状态刷新失败保留现有展示
      } finally {
        setLoading(false)
      }
      return
    }
    setError('')
    try {
      const nextCapability = await window.api.getPersonalWechatSendCapability()
      setCapability(nextCapability)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '微信发送能力读取失败')
    } finally {
      setLoading(false)
    }
  }, [isPortEndpointPlatform])

  useEffect(() => {
    if (isPortEndpointPlatform) return
    void refresh()
  }, [isPortEndpointPlatform, refresh])

  useEffect(() => {
    if (!isPortEndpointPlatform) return
    let active = true
    const loadPortEndpoint = async (): Promise<void> => {
      try {
        const settingsResult = await window.api.getSettings?.()
        const configuredPort = String(settingsResult?.settings?.windowsWechatPort || '').trim()
        if (!active) return
        setWindowsPortInput(configuredPort)
        if (configuredPort) {
          const status = await window.api.getPersonalWechatSenderStatus()
          if (!active) return
          setWindowsSenderStatus(status)
        }
        setLoading(false)
      } catch (reason) {
        if (!active) return
        setWindowsSenderStatus(null)
        setError(reason instanceof Error ? reason.message : '微信发送能力状态读取失败')
        setLoading(false)
      }
    }
    void loadPortEndpoint()
    return () => {
      active = false
    }
  }, [isPortEndpointPlatform, refresh])

  const detectCapability = async (): Promise<void> => {
    if (isPortEndpointPlatform) {
      await detectWindowsEndpoint()
      return
    }
    if (detecting) return
    setDetecting(true)
    try {
      await refresh()
    } finally {
      setDetecting(false)
    }
  }

  const normalizedWindowsPort = normalizeWindowsPort(windowsPortInput)
  const windowsCanSave = Boolean(
    normalizedWindowsPort &&
    normalizedWindowsPort === windowsDetectedPort &&
    windowsSenderStatus?.endpointReady &&
    windowsSenderStatus.canSend
  )

  const handleWindowsPortInput = (value: string): void => {
    setWindowsPortInput(value)
    setWindowsDetectedPort('')
    setWindowsSenderStatus(null)
  }

  const detectWindowsEndpoint = async (): Promise<void> => {
    if (windowsEndpointBusy) return
    if (!normalizedWindowsPort) {
      onNotice('请输入 1 到 65535 之间的微信发送能力端口')
      return
    }
    setWindowsEndpointBusy(true)
    setError('')
    setWindowsDetectedPort('')
    try {
      const nextStatus = await window.api.checkPersonalWechatSenderStatus(normalizedWindowsPort)
      setWindowsSenderStatus(nextStatus)
      if (nextStatus.endpointReady && nextStatus.canSend) {
        setWindowsDetectedPort(normalizedWindowsPort)
        onNotice('已检测到微信发送能力，请点击保存')
      } else {
        onNotice(nextStatus.error || nextStatus.message || '未检测到微信发送能力')
      }
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : '微信发送能力检测失败')
    } finally {
      setWindowsEndpointBusy(false)
    }
  }

  const saveWindowsEndpoint = async (): Promise<void> => {
    if (windowsEndpointBusy || !windowsCanSave || !normalizedWindowsPort) return
    setWindowsEndpointBusy(true)
    try {
      await window.api.setSettings({ windowsWechatPort: normalizedWindowsPort })
      setWindowsDetectedPort('')
      await refresh()
      onNotice('微信发送能力端口已保存')
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : '微信发送能力端口保存失败')
    } finally {
      setWindowsEndpointBusy(false)
    }
  }

  const clearWindowsEndpoint = async (): Promise<void> => {
    if (windowsEndpointBusy || !windowsPortInput.trim()) return
    setWindowsEndpointBusy(true)
    setError('')
    try {
      await window.api.setSettings({ windowsWechatPort: '' })
      setWindowsPortInput('')
      setWindowsDetectedPort('')
      setWindowsSenderStatus(null)
      await refresh()
      onNotice('微信发送能力端口已清除')
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : '微信发送能力端口清除失败')
    } finally {
      setWindowsEndpointBusy(false)
    }
  }

  const status = capability?.status || 'error'
  const ready = capability?.ready === true
  const pageStatus: PersonalWechatSendCapability['status'] = isPortEndpointPlatform
    ? windowsSenderStatus?.canSend
      ? 'ready'
      : windowsSenderStatus?.state === 'error' && windowsSenderStatus.endpointReady
        ? 'error'
        : windowsPortInput.trim()
          ? 'initializing'
          : 'unconfigured'
    : status
  const pageReady = isPortEndpointPlatform ? Boolean(windowsSenderStatus?.canSend) : ready
  const pageCapabilities = isPortEndpointPlatform
    ? {
        text: Boolean(windowsSenderStatus?.canSendText),
        image: Boolean(windowsSenderStatus?.canSendImage),
        voice: Boolean(windowsSenderStatus?.canSendVoice)
      }
    : capability?.capabilities || { text: false, image: false, voice: false }
  const platformDisplayName = isMac ? 'macOS' : 'Windows'
  const pageMessage = isPortEndpointPlatform
    ? windowsSenderStatus?.message || `请输入端口并检测 ${platformDisplayName} 微信发送能力`
    : capability?.message || '微信发送能力暂不可用'

  return (
    <div className="settings-page personal-wechat-send-page">
      <header className="settings-page-header">
        <div>
          <h1>微信发送</h1>
          <p>管理个人微信消息发送能力，日报和档案发送都会使用这里的状态。</p>
        </div>
        <span
          className={`settings-status-badge ${loading ? 'checking' : pageReady ? '' : pageStatus === 'unsupported' ? 'unavailable' : 'warning'}`}
        >
          {loading ? '检测中' : capabilityLabel[pageStatus]}
        </span>
      </header>
      <div className="settings-page-scroll">
        <div className="settings-page-content">
          {loading && !capability && !isPortEndpointPlatform ? (
            <Skeleton className="h-28 w-full" />
          ) : (
            <>
              <h2 className="settings-section-heading">发送能力</h2>
              <section className="settings-card">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <span className="settings-card-kicker">个人微信</span>
                    <strong className="mt-1 block text-base">{pageMessage}</strong>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {pageStatus === 'unsupported'
                        ? '微信消息发送目前仅支持 macOS 和 Windows。'
                        : isPortEndpointPlatform
                          ? `${platformDisplayName} 通过本机微信发送接口工作，请先配置并检测接口端口。`
                          : '档案中的文字、图片和语音发送，以及定时日报发送，都会使用这项能力。'}
                    </p>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => void detectCapability()}>
                    {detecting || windowsEndpointBusy
                      ? '刷新中…'
                      : isPortEndpointPlatform
                        ? '重新检测'
                        : '刷新状态'}
                  </Button>
                </div>
                <div className="mt-5 grid grid-cols-3 gap-2" aria-label="微信发送能力明细">
                  {(
                    [
                      ['文字', pageCapabilities.text],
                      ['图片', pageCapabilities.image],
                      ['语音', pageCapabilities.voice]
                    ] as const
                  ).map(([label, available]) => (
                    <div
                      key={label}
                      className="rounded-lg border border-border-subtle px-3 py-2"
                    >
                      <span className="block text-xs text-muted-foreground">{label}</span>
                      <strong className="mt-1 block text-sm">
                        {available ? '可发送' : '未就绪'}
                      </strong>
                    </div>
                  ))}
                </div>
                {error ? (
                  <p className="mt-3 text-sm text-destructive" role="alert">
                    {error}
                  </p>
                ) : null}
              </section>

              {isPortEndpointPlatform ? (
                <>
                  <h2 className="settings-section-heading">{platformDisplayName} 接口配置</h2>
                  <section className="settings-card tts-runtime-card">
                    <div className="tts-runtime-summary">
                      <span className="settings-card-kicker">{platformDisplayName}</span>
                      <strong>
                        {!windowsSenderStatus
                          ? windowsPortInput
                            ? '待检测'
                            : '未配置'
                          : windowsSenderStatus.canSend
                            ? '微信发送能力已就绪'
                            : windowsSenderStatus.endpointReady
                              ? '接口已连接，但暂不可发送'
                              : '未检测到发送能力'}
                      </strong>
                      <small>
                        {windowsSenderStatus?.message || '输入端口后检测微信发送能力'}
                      </small>
                    </div>
                    <div className="tts-runtime-actions tts-windows-endpoint-actions">
                      <label className="tts-windows-port-field">
                        <span>端口</span>
                        <Input
                          aria-label="微信发送能力端口"
                          className="tts-windows-port-input"
                          type="number"
                          min={1}
                          max={65535}
                          inputMode="numeric"
                          placeholder="端口号"
                          value={windowsPortInput}
                          disabled={windowsEndpointBusy}
                          onChange={(event) => handleWindowsPortInput(event.target.value)}
                        />
                      </label>
                      <Button
                        variant={windowsCanSave ? 'default' : 'outline'}
                        size="sm"
                        disabled={windowsEndpointBusy}
                        onClick={() =>
                          void (windowsCanSave ? saveWindowsEndpoint() : detectWindowsEndpoint())
                        }
                      >
                        {windowsEndpointBusy
                          ? windowsCanSave
                            ? '保存中…'
                            : '检测中…'
                          : windowsCanSave
                            ? '保存'
                            : '检测'}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={windowsEndpointBusy || !windowsPortInput.trim()}
                        onClick={() => void clearWindowsEndpoint()}
                      >
                        清除端口
                      </Button>
                    </div>
                  </section>

                  <h2 className="settings-section-heading">发送能力授权</h2>
                  <SendCapabilityAuthorizationCard onNotice={onNotice} />
                </>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
