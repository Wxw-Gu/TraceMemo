import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type {
  PersonalWechatSendCapability,
  PersonalWechatSenderStatus
} from '../../../../../shared/personal-wechat'
import type {
  PersonalWechatRuntimeProgressEvent,
  PersonalWechatRuntimeStatus
} from '../../../../../shared/personal-wechat-runtime'
import { Button, Skeleton } from '../../../components/ui'
import { PersonalWechatSetupGuide } from '../../../components/chat/PersonalWechatSetupGuide'

const capabilityLabel: Record<PersonalWechatSendCapability['status'], string> = {
  unsupported: '暂不支持',
  unconfigured: '尚未配置',
  needs_binding: '需要绑定',
  needs_verification: '需要检测',
  ready: '已就绪',
  error: '异常'
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

export function PersonalWechatSendPage({
  onNotice,
  onOpenTextToSpeechSettings
}: {
  onNotice: (message: string) => void
  onOpenTextToSpeechSettings?: () => void
}): ReactElement {
  const [capability, setCapability] = useState<PersonalWechatSendCapability | null>(null)
  const [senderStatus, setSenderStatus] = useState<PersonalWechatSenderStatus | null>(null)
  const [runtimeStatus, setRuntimeStatus] = useState<PersonalWechatRuntimeStatus | null>(null)
  const [runtimeProgress, setRuntimeProgress] = useState<PersonalWechatRuntimeProgressEvent | null>(
    null
  )
  const [loading, setLoading] = useState(true)
  const [runtimeBusy, setRuntimeBusy] = useState(false)
  const [binding, setBinding] = useState(false)
  const [detecting, setDetecting] = useState(false)
  const [detectionAttempted, setDetectionAttempted] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    setError('')
    try {
      const [nextCapability, nextSender, nextRuntime] = await Promise.all([
        window.api.getPersonalWechatSendCapability(),
        window.api.getPersonalWechatSenderStatus(),
        window.api.getPersonalWechatRuntimeStatus()
      ])
      setCapability(nextCapability)
      setSenderStatus(nextSender)
      setRuntimeStatus(nextRuntime)
      setRuntimeProgress(nextRuntime.state === 'downloading' ? nextRuntime : null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '微信发送能力读取失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const unsubscribe = window.api.onPersonalWechatRuntimeProgress((status) => {
      setRuntimeProgress(status)
      setRuntimeStatus(status)
      if (status.state === 'ready') void refresh()
    })
    return unsubscribe
  }, [refresh])

  const downloadRuntime = async (): Promise<void> => {
    if (runtimeBusy) return
    setRuntimeBusy(true)
    setError('')
    try {
      const result = await window.api.downloadPersonalWechatRuntime()
      setRuntimeStatus(result.status)
      if (!result.success) setError(result.error || '微信发送组件准备失败')
      else onNotice('微信发送组件已准备好')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '微信发送组件准备失败')
    } finally {
      setRuntimeBusy(false)
    }
  }

  const bindWechat = async (): Promise<void> => {
    if (binding) return
    setBinding(true)
    setError('')
    setDetectionAttempted(false)
    try {
      const nextStatus = await window.api.rebindPersonalWechatSender()
      setSenderStatus(nextStatus)
      const nextCapability = await window.api.getPersonalWechatSendCapability()
      setCapability(nextCapability)
      if (nextStatus.state !== 'online' && nextStatus.message) setError(nextStatus.message)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '个人微信绑定失败')
    } finally {
      setBinding(false)
    }
  }

  const detectCapability = async (): Promise<void> => {
    if (detecting) return
    setDetecting(true)
    setDetectionAttempted(true)
    try {
      await refresh()
    } finally {
      setDetecting(false)
    }
  }

  const status = capability?.status || 'error'
  const ready = capability?.ready === true

  return (
    <div className="settings-page personal-wechat-send-page">
      <header className="settings-page-header">
        <div>
          <h1>微信发送</h1>
          <p>管理个人微信消息发送能力，日报和档案发送都会使用这里的状态。</p>
        </div>
        <span
          className={`settings-status-badge ${loading ? 'checking' : ready ? '' : status === 'unsupported' ? 'unavailable' : 'warning'}`}
        >
          {loading ? '检测中' : capabilityLabel[status]}
        </span>
      </header>
      <div className="settings-page-scroll">
        <div className="settings-page-content">
          {loading && !capability ? (
            <Skeleton className="h-28 w-full" />
          ) : (
            <>
              <h2 className="settings-section-heading">发送能力</h2>
              <section className="settings-card">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <span className="settings-card-kicker">个人微信</span>
                    <strong className="mt-1 block text-base">
                      {capability?.message || '微信发送能力暂不可用'}
                    </strong>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {status === 'unsupported'
                        ? '微信消息发送目前仅支持 macOS。'
                        : '档案中的文字、图片和语音发送，以及定时日报发送，都会使用这项能力。'}
                    </p>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => void detectCapability()}>
                    {detecting ? '检测中…' : '重新检测'}
                  </Button>
                </div>
                <div className="mt-5 grid grid-cols-3 gap-2" aria-label="微信发送能力明细">
                  {(
                    [
                      ['文字', capability?.capabilities.text],
                      ['图片', capability?.capabilities.image],
                      ['语音', capability?.capabilities.voice]
                    ] as const
                  ).map(([label, available]) => (
                    <div key={label} className="rounded-lg border border-border-subtle px-3 py-2">
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

              <h2 className="settings-section-heading">配置与检测</h2>
              <PersonalWechatSetupGuide
                runtimeStatus={runtimeStatus}
                senderStatus={senderStatus}
                runtimeProgress={runtimeProgress}
                runtimeBusy={runtimeBusy}
                binding={binding}
                detecting={detecting}
                detectionAttempted={detectionAttempted}
                sessionBound={boundToCurrentWechat(senderStatus)}
                onDownloadRuntime={() => void downloadRuntime()}
                onBind={() => void bindWechat()}
                onDetect={() => void detectCapability()}
                onStartSending={() =>
                  onNotice('微信消息发送能力已就绪，请在档案中选择会话开始发送。')
                }
                onOpenTextToSpeechSettings={onOpenTextToSpeechSettings}
              />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
