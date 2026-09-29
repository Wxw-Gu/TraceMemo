import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type {
  PersonalWechatSendCapability,
  PersonalWechatSenderStatus
} from '../../../../../shared/personal-wechat'
import { Button, Input, Skeleton } from '../../../components/ui'
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
  const refresh = useCallback(async (): Promise<void> => {
    if (isWindows) {
      setLoading(false)
      return
    }
    setError('')
    try {
      const [nextCapability, nextSender] = await Promise.all([
        window.api.getPersonalWechatSendCapability(),
        window.api.getPersonalWechatSenderStatus()
      ])
      setCapability(nextCapability)
      setSenderStatus(nextSender)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '微信发送能力读取失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isWindows) return
    void refresh()
  }, [refresh])

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
  const macUnavailable = isMac && senderStatus?.state === 'runtime_missing'

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
            {loading ? '检测中' : macUnavailable ? '暂不可用' : capabilityLabel[pageStatus]}
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
                    <h2 className="settings-section-heading">配置状态</h2>
                    <PersonalWechatSetupGuide
                      senderStatus={senderStatus}
                      binding={binding}
                      detecting={detecting}
                      sessionBound={boundToCurrentWechat(senderStatus)}
                      onBind={() => void bindWechat()}
                      onStartSending={() =>
                        onNotice('微信消息发送能力已就绪，请在档案中选择会话开始发送。')
                      }
                      onOpenTextToSpeechSettings={onOpenTextToSpeechSettings}
                    />
                  </>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
