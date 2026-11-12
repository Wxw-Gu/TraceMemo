import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type {
  PersonalWechatSendCapability,
  PersonalWechatSenderStatus
} from '../../../../../shared/personal-wechat'
import type {
  MacLicenseState,
  MacLicenseStatus
} from '../../../../../shared/personal-wechat-mac-license'
import type { MacWechatSendRuntimeAvailabilityResult } from '../../../../../shared/personal-wechat-mac-runtime'
import { resolveMacSendPrimaryAction } from '../../../../../shared/personal-wechat-mac-send-action'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Input,
  Skeleton
} from '../../../components/ui'
import { PersonalWechatSetupGuide } from '../../../components/chat/PersonalWechatSetupGuide'
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

function getEndpointPort(endpoint: string | undefined): string | null {
  if (!endpoint) return null
  try {
    return new URL(endpoint).port || null
  } catch {
    return null
  }
}

function boundToCurrentWechat(status: PersonalWechatSenderStatus | null): boolean {
  if (!status) return false
  return (
    status.state === 'online' ||
    Boolean(
      status.wechatPid &&
      status.boundWechatPid === status.wechatPid &&
      status.attachReady &&
      status.baseAddressReady
    )
  )
}

function SendCapabilityAuthorizationCard(): ReactElement {
  return (
    <section className="settings-card grid gap-2">
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
  onNotice,
  onOpenTextToSpeechSettings
}: {
  onNotice: (message: string) => void
  onOpenTextToSpeechSettings?: () => void
}): ReactElement {
  const [capability, setCapability] = useState<PersonalWechatSendCapability | null>(null)
  const [senderStatus, setSenderStatus] = useState<PersonalWechatSenderStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [binding, setBinding] = useState(false)
  const [detecting, setDetecting] = useState(false)
  const [error, setError] = useState('')
  const [windowsSenderStatus, setWindowsSenderStatus] = useState<PersonalWechatSenderStatus | null>(
    null
  )
  const [windowsPortInput, setWindowsPortInput] = useState('')
  const [windowsDetectedPort, setWindowsDetectedPort] = useState('')
  const [windowsEndpointBusy, setWindowsEndpointBusy] = useState(false)
  const [setupExpanded, setSetupExpanded] = useState<boolean | null>(null)
  const [macLicenseStatus, setMacLicenseStatus] = useState<MacLicenseStatus | null>(null)
  const [macRuntimeAvailability, setMacRuntimeAvailability] =
    useState<MacWechatSendRuntimeAvailabilityResult | null>(null)
  const [macResidualProcesses, setMacResidualProcesses] = useState<
    Awaited<ReturnType<typeof window.api.listMacWechatResidualProcesses>>
  >([])
  const [macResidualDialogOpen, setMacResidualDialogOpen] = useState(false)
  const [macResidualBusy, setMacResidualBusy] = useState(false)
  const [macWechatRebindRequired, setMacWechatRebindRequired] = useState(false)
  const [mac4290PortStatus, setMac4290PortStatus] = useState<
    | { state: 'loading' | 'available' | 'error'; processes: [] }
    | { state: 'occupied'; processes: Array<{ pid: number; name: string }> }
  >({ state: 'loading', processes: [] })
  const setupDefaultInitialized = useRef(false)
  const refreshMac4290PortStatus = useCallback(async (): Promise<void> => {
    try {
      const processes = await window.api.listMacWechatResidualProcesses()
      const listeners = processes
        .filter((process) => process.targets.includes('port_4290'))
        .map(({ pid, name }) => ({ pid, name }))
      setMac4290PortStatus(
        listeners.length > 0
          ? { state: 'occupied', processes: listeners }
          : { state: 'available', processes: [] }
      )
    } catch {
      setMac4290PortStatus({ state: 'error', processes: [] })
    }
  }, [])
  const refresh = useCallback(async (): Promise<void> => {
    if (isWindows) {
      setLoading(false)
      return
    }
    setError('')
    try {
      const nextCapability = await window.api.getPersonalWechatSendCapability()
      setCapability(nextCapability)
      setSenderStatus(nextCapability.senderStatus)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '微信发送能力读取失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isWindows) return
    let active = true
    const loadMacStatus = async (): Promise<void> => {
      try {
        const availability = await window.api.getMacSendRuntimeAvailability()
        if (!active) return
        setMacRuntimeAvailability(availability)
        if (availability.state !== 'available') {
          setSenderStatus({
            state: 'runtime_missing',
            platform: 'darwin',
            arch: 'arm64',
            sipDisabled: true,
            wechatRunning: false,
            endpoint: '',
            endpointReady: false,
            runtimeReady: false,
            attachReady: false,
            baseAddressReady: false,
            textHookInstalled: false,
            textHookReady: false,
            imageHookInstalled: false,
            imageHookReady: false,
            messageListenerReady: false,
            canSend: false,
            canSendText: false,
            canSendImage: false,
            canSendVoice: false,
            message: availability.message,
            error: availability.message
          })
          setLoading(false)
          return
        }
        const [nextCapability, license] = await Promise.all([
          window.api.getPersonalWechatSendCapability(),
          window.api.getMacLicenseStatus()
        ])
        if (!active) return
        setCapability(nextCapability)
        setSenderStatus(nextCapability.senderStatus)
        setMacLicenseStatus(license)
      } catch (reason) {
        if (!active) return
        setError(reason instanceof Error ? reason.message : '微信发送能力读取失败')
      } finally {
        if (active) setLoading(false)
      }
    }
    void loadMacStatus()
    return () => {
      active = false
    }
  }, [refresh])

  useEffect(() => {
    if (!isMac) return undefined
    void refreshMac4290PortStatus()
    const timer = window.setInterval(() => void refreshMac4290PortStatus(), 5_000)
    return () => window.clearInterval(timer)
  }, [refreshMac4290PortStatus])

  useEffect(() => {
    if (isWindows || !senderStatus || senderStatus.canSend || senderStatus.state === 'error') {
      return undefined
    }
    if (!boundToCurrentWechat(senderStatus)) return undefined
    const timer = window.setInterval(() => void refresh(), 1_000)
    return () => window.clearInterval(timer)
  }, [refresh, senderStatus])

  useEffect(() => {
    if (!isWindows) return
    let active = true
    const loadWindowsEndpoint = async (): Promise<void> => {
      try {
        const settingsResult = await window.api.getSettings()
        const configuredPort = String(settingsResult.settings.windowsWechatPort || '').trim()
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
    void loadWindowsEndpoint()
    return () => {
      active = false
    }
  }, [refresh])

  const bindWechat = async (): Promise<void> => {
    if (binding) return
    setBinding(true)
    setError('')
    try {
      const nextStatus = await window.api.rebindPersonalWechatSender()
      setSenderStatus(nextStatus)
      if (boundToCurrentWechat(nextStatus)) {
        setMacWechatRebindRequired(false)
      }
      const nextCapability = await window.api.getPersonalWechatSendCapability()
      setCapability(nextCapability)
      if (nextStatus.state === 'error' && nextStatus.message) setError(nextStatus.message)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '个人微信绑定失败')
    } finally {
      setBinding(false)
    }
  }

  const detectCapability = async (): Promise<void> => {
    if (isWindows) {
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

  const inspectMacResidualProcesses = async (): Promise<void> => {
    if (macResidualBusy) return
    setMacResidualBusy(true)
    try {
      const targets = await window.api.listMacWechatResidualProcesses()
      setMacResidualProcesses(targets)
      const listeners = targets
        .filter((process) => process.targets.includes('port_4290'))
        .map(({ pid, name }) => ({ pid, name }))
      setMac4290PortStatus(
        listeners.length > 0
          ? { state: 'occupied', processes: listeners }
          : { state: 'available', processes: [] }
      )
      if (targets.length === 0) {
        setMacResidualBusy(false)
        await restartMacSendRuntime()
        return
      }
      setMacResidualDialogOpen(true)
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : '读取残留进程失败')
    } finally {
      setMacResidualBusy(false)
    }
  }

  const cleanupMacResidualProcesses = async (): Promise<void> => {
    if (macResidualBusy || macResidualProcesses.length === 0) return
    setMacResidualBusy(true)
    try {
      const result = await window.api.cleanupMacWechatResidualProcesses(
        macResidualProcesses.map(({ pid, confirmationToken }) => ({ pid, confirmationToken }))
      )
      if (result.stopped.some((target) => target.targets.includes('wechat'))) {
        setMacWechatRebindRequired(true)
      }
      const stillAlive = result.remaining
      setMacResidualProcesses([])
      setMacResidualDialogOpen(false)
      await refreshMac4290PortStatus()
      if (stillAlive.length > 0) {
        onNotice(
          `${result.stopped.length} 个进程已退出，${stillAlive.length} 个系统无法结束（${stillAlive
            .map((target) => target.name)
            .join('、')}）；正在改用可用端口启动发送组件…`
        )
      }
      await restartMacSendRuntime()
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : '清理残留进程失败')
    } finally {
      setMacResidualBusy(false)
    }
  }

  const restartMacSendRuntime = async (): Promise<void> => {
    setMacResidualBusy(true)
    try {
      const snapshot = await window.api.startMacSendRuntime()
      if (snapshot.lifecycle !== 'online') {
        throw new Error(snapshot.error || '发送组件启动失败')
      }
      if (snapshot.binding?.runtimeState === 'ready' && snapshot.binding.bound) {
        onNotice('发送 Host 已启动并连接到已有微信会话。')
      }
      await refresh()
      await refreshMac4290PortStatus()
      if (!snapshot.binding?.bound) {
        const fallback = snapshot.portFallbackFrom
          ? `${snapshot.portFallbackFrom} 已被占用，已改用 ${snapshot.port} 端口。`
          : ''
        onNotice(
          fallback
            ? `发送 Host 已在 ${snapshot.port} 端口启动。${fallback}`
            : '已清理并重启发送 Host；如刚才关闭了微信，请重新打开微信并绑定。'
        )
      }
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : '发送组件启动失败')
    } finally {
      setMacResidualBusy(false)
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
  const pageStatus: PersonalWechatSendCapability['status'] = isWindows
    ? windowsSenderStatus?.canSend
      ? 'ready'
      : windowsSenderStatus?.state === 'error' && windowsSenderStatus.endpointReady
        ? 'error'
        : windowsPortInput.trim()
          ? 'initializing'
          : 'unconfigured'
    : status
  const pageReady = isWindows ? Boolean(windowsSenderStatus?.canSend) : ready
  const pageCapabilities = isWindows
    ? {
        text: Boolean(windowsSenderStatus?.canSendText),
        image: Boolean(windowsSenderStatus?.canSendImage),
        voice: Boolean(windowsSenderStatus?.canSendVoice)
      }
    : capability?.capabilities || { text: false, image: false, voice: false }
  const pageMessage = isWindows
    ? windowsSenderStatus?.message || '请输入端口并检测 Windows 微信发送能力'
    : capability?.message || '微信发送能力暂不可用'
  const macUnavailable = isMac && macRuntimeAvailability?.state === 'unavailable'
  const macComponentError = isMac && macRuntimeAvailability?.state === 'component_error'
  const macBound = boundToCurrentWechat(senderStatus)
  const macSendPort = getEndpointPort(senderStatus?.endpoint)
  const macEnvironmentReady = Boolean(
    senderStatus?.runtimeReady && macBound && senderStatus.canSend
  )
  useEffect(() => {
    if (isMac && senderStatus && !setupDefaultInitialized.current) {
      setSetupExpanded(!macEnvironmentReady)
      setupDefaultInitialized.current = true
    }
  }, [macEnvironmentReady, senderStatus])

  const setupBodyId = 'personal-wechat-first-use-setup'
  const macPrimaryAction = resolveMacSendPrimaryAction({
    runtime: macRuntimeAvailability,
    license: macLicenseStatus,
    senderStatus,
    binding,
    detecting: loading || detecting
  })

  return (
    <>
      <div className="settings-page personal-wechat-send-page">
        <header className="settings-page-header">
          <div>
            <h1>微信发送</h1>
            <p>管理个人微信消息发送能力，日报和档案发送都会使用这里的状态。</p>
          </div>
          <span
            className={`settings-status-badge ${loading ? 'checking' : pageReady ? '' : pageStatus === 'unsupported' ? 'unavailable' : 'warning'}`}
          >
            {loading
              ? '检测中'
              : macUnavailable
                ? '没有微信发送能力'
                : macComponentError
                  ? '发送组件异常'
                  : capabilityLabel[pageStatus]}
          </span>
        </header>
        <div className="settings-page-scroll">
          <div className="settings-page-content">
            {loading && !capability ? (
              <Skeleton className="h-28 w-full" />
            ) : (
              <>
                {/* macOS 走下方「配置状态」SetupGuide 统一展示，这里只在 Windows/其它
                 * 平台显示旧「发送能力」卡（Mac 上两者重复，已按用户要求移除）。 */}
                {!isMac ? (
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
                              : isWindows
                                ? 'Windows 通过本机微信发送接口工作，请先配置并检测接口端口。'
                                : '档案中的文字、图片和语音发送，以及定时日报发送，都会使用这项能力。'}
                          </p>
                        </div>
                        <Button variant="outline" size="sm" onClick={() => void detectCapability()}>
                          {detecting ? '刷新中…' : isWindows ? '重新检测' : '刷新状态'}
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
                  </>
                ) : null}

                {isWindows ? (
                  <>
                    <h2 className="settings-section-heading">Windows 接口配置</h2>
                    <section className="settings-card tts-runtime-card">
                      <div className="tts-runtime-summary">
                        <span className="settings-card-kicker">Windows</span>
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
                    <SendCapabilityAuthorizationCard />
                  </>
                ) : isMac ? (
                  <>
                    {/* 发送能力授权卡片：仅在加载了发送组件的档位渲染。
                        OSS（runtime_missing）下不渲染，保证免费版不出现授权入口。 */}
                    {macRuntimeAvailability?.state === 'available' ? (
                      <MacNativeLicenseCard
                        onNotice={onNotice}
                        onStatusChange={setMacLicenseStatus}
                      />
                    ) : null}
                    <section
                      className="settings-card mac-wechat-environment-card"
                      aria-label="微信发送环境"
                    >
                      <header className="mac-wechat-environment-header">
                        <strong>微信发送环境</strong>
                        <span
                          className={`mac-wechat-environment-status ${macEnvironmentReady ? 'is-ready' : 'is-neutral'}`}
                        >
                          {loading
                            ? '正在检查环境'
                            : macUnavailable
                              ? '当前版本没有微信发送能力'
                              : macComponentError
                                ? '发送组件缺失或异常'
                                : macEnvironmentReady
                                  ? '运行环境已就绪'
                                  : '需要完成配置'}
                        </span>
                      </header>
                      <div className="mac-wechat-status-grid" aria-label="环境状态">
                        {[
                          ['运行时正常', Boolean(senderStatus?.runtimeReady)],
                          ['微信已绑定', macBound],
                          ['发送组件正常', Boolean(senderStatus?.canSend)]
                        ].map(([label, complete]) => (
                          <div className="mac-wechat-status-item" key={String(label)}>
                            <span
                              className={complete ? 'is-ready' : 'is-pending'}
                              aria-hidden="true"
                            >
                              {complete ? '✓' : '○'}
                            </span>
                            <strong>{label}</strong>
                            <small>{loading ? '检测中' : complete ? '正常' : '待完成'}</small>
                          </div>
                        ))}
                      </div>
                      {macSendPort && senderStatus?.endpointReady ? (
                        <p
                          className="mt-3 rounded-md border border-border-subtle p-3 text-sm"
                          role="status"
                        >
                          当前发送能力占用端口为 {macSendPort}（TM_WECHAT_HOST_PORT）。
                        </p>
                      ) : null}
                      <section
                        className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-subtle p-3"
                        aria-label="4290 端口状态"
                      >
                        <div>
                          <strong className="text-sm">4290 端口</strong>
                          <p className="mt-1 text-sm text-muted-foreground" role="status">
                            {mac4290PortStatus.state === 'loading'
                              ? '正在检查占用状态…'
                              : mac4290PortStatus.state === 'error'
                                ? '占用状态读取失败'
                                : mac4290PortStatus.state === 'available'
                                  ? '未被占用'
                                  : '已被占用：' +
                                    mac4290PortStatus.processes
                                      .map(({ name, pid }) => name + '（PID ' + pid + '）')
                                      .join('、')}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={macResidualBusy}
                          onClick={() => void refreshMac4290PortStatus()}
                        >
                          刷新端口状态
                        </Button>
                      </section>
                      {macWechatRebindRequired ? (
                        <div
                          className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
                          role="status"
                        >
                          微信进程已清理。请重新打开微信，然后点击“绑定微信”；绑定完成后此提示会自动消失。
                        </div>
                      ) : null}
                      {senderStatus && macRuntimeAvailability?.state === 'available' ? (
                        <div
                          className="mac-wechat-capability-details"
                          aria-label="文字、图片和语音能力"
                        >
                          {(
                            [
                              ['文字', senderStatus.canSendText],
                              ['图片', senderStatus.canSendImage],
                              ['语音', senderStatus.canSendVoice]
                            ] as const
                          ).map(([label, available]) => (
                            <span key={label} className={available ? 'is-ready' : 'is-pending'}>
                              {label} {available ? '可用' : '未就绪'}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      <button
                        type="button"
                        className="mac-wechat-setup-toggle"
                        aria-expanded={setupExpanded ?? !macEnvironmentReady}
                        aria-controls={setupBodyId}
                        onClick={() =>
                          setSetupExpanded((expanded) => !(expanded ?? !macEnvironmentReady))
                        }
                      >
                        <span>首次使用配置</span>
                        <span className="mac-wechat-setup-chevron" aria-hidden="true">
                          ⌄
                        </span>
                      </button>
                      <div
                        id={setupBodyId}
                        className="mac-wechat-setup-content"
                        hidden={!(setupExpanded ?? !macEnvironmentReady)}
                      >
                        {macRuntimeAvailability?.state === 'available' ? (
                          <PersonalWechatSetupGuide
                            senderStatus={senderStatus}
                            binding={binding}
                            detecting={detecting}
                            sessionBound={macBound}
                            showBindAction={false}
                            showCapabilityStatus={false}
                            showBindingInstructionsInInitialization
                            showAuthorizationWarning={false}
                            canBind={macPrimaryAction.action === 'bind'}
                            onStartSending={() =>
                              onNotice('微信消息发送能力已就绪，请在档案中选择会话开始发送。')
                            }
                            showStartSendingAction={false}
                            onOpenTextToSpeechSettings={onOpenTextToSpeechSettings}
                          />
                        ) : null}
                      </div>
                      <div className="mac-wechat-primary-action">
                        <Button
                          className="w-full"
                          disabled={macPrimaryAction.disabled}
                          onClick={() => {
                            if (macPrimaryAction.action === 'bind') {
                              void bindWechat()
                            } else if (macPrimaryAction.action === 'send') {
                              onNotice('微信消息发送能力已就绪，请在档案中选择会话开始发送。')
                            } else if (!macPrimaryAction.disabled) {
                              setSetupExpanded(true)
                            }
                          }}
                        >
                          {macPrimaryAction.label}
                        </Button>
                        <Button
                          className="mt-2 w-full"
                          variant="outline"
                          disabled={macResidualBusy}
                          onClick={() => void inspectMacResidualProcesses()}
                        >
                          {macResidualBusy ? '检查中…' : '清理残留以及微信进程'}
                        </Button>
                      </div>
                    </section>
                    {macUnavailable ? (
                      <>
                        <h2 className="settings-section-heading">发送能力授权</h2>
                        <SendCapabilityAuthorizationCard />
                      </>
                    ) : null}
                  </>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
      <AlertDialog open={macResidualDialogOpen} onOpenChange={setMacResidualDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>清理微信残留进程？</AlertDialogTitle>
            <AlertDialogDescription>
              将结束下面列出的微信进程、TraceMemo 发送 Host 和由 TraceMemo Runtime 启动的 Frida Helper。
              所有目标都退出后才会自动重启发送 Host；若列表包含微信，微信会关闭，之后需要重新打开微信并绑定。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="grid gap-2 rounded-md border border-border-subtle p-3 text-sm">
            {macResidualProcesses.map((item) => (
              <li key={item.pid} className="flex justify-between gap-4">
                <span className="break-all">{item.name}</span>
                <span className="shrink-0 text-muted-foreground">
                  PID {item.pid} ·{' '}
                  {item.targets
                    .map((target) =>
                      target === 'wechat'
                        ? '微信进程'
                        : target === 'host'
                          ? '发送 Host'
                          : target === 'frida_helper'
                            ? 'Frida Helper'
                            : '4290 端口'
                    )
                    .join('、')}
                  {item.uninterruptible
                    ? ` · 内核不可中断${item.state ? `（${item.state}）` : ''}`
                    : item.state
                      ? ` · 状态 ${item.state}`
                      : ''}
                </span>
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={macResidualBusy}>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={macResidualBusy}
              onClick={(event) => {
                event.preventDefault()
                void cleanupMacResidualProcesses()
              }}
            >
              {macResidualBusy ? '清理中…' : '确认结束进程'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
