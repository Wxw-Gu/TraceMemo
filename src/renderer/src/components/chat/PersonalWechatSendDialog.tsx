import { useCallback, useEffect, useRef, useState } from 'react'
import type { Contact } from '../../../../shared/types'
import type {
  PersonalWechatSendRequest,
  PersonalWechatSenderStatus,
  PersonalWechatVoiceDiagnostic
} from '../../../../shared/personal-wechat'
import type {
  PersonalWechatRuntimeProgressEvent,
  PersonalWechatRuntimeStatus
} from '../../../../shared/personal-wechat-runtime'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Switch
} from '../ui'
import { isMac, isWindows } from '../../utils/runtime-environment'
import {
  PersonalWechatChatComposer,
  type ChatMessage,
  type PersonalWechatComposerMode
} from './PersonalWechatChatComposer'
import { PersonalWechatSetupGuide } from './PersonalWechatSetupGuide'
import { PersonalWechatVoiceDiagnosticDialog } from './PersonalWechatVoiceDiagnosticDialog'
import { PersonalWechatWindowsSendDialog } from './PersonalWechatWindowsSendDialog'

type SelectedLocalFile = { path: string; name: string }

export interface PersonalWechatSendDialogProps {
  contact: Contact
  isGroupChat: boolean
  onClose: () => void
  onOpenTextToSpeechSettings?: () => void
  onOpenPersonalWechatSettings?: () => void
  initialMode?: PersonalWechatComposerMode
  initialImage?: SelectedLocalFile | null
}

function fallbackStatus(error: unknown): PersonalWechatSenderStatus {
  return {
    state: 'error',
    platform: 'unknown',
    arch: 'unknown',
    sipDisabled: false,
    wechatRunning: false,
    runtimeReady: false,
    endpoint: '127.0.0.1:58080',
    endpointReady: false,
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
    message: '无法检测个人微信发送服务',
    error: error instanceof Error ? error.message : String(error)
  }
}

export function PersonalWechatSendDialog(props: PersonalWechatSendDialogProps): React.ReactElement {
  if (isWindows) return <PersonalWechatWindowsSendDialog {...props} />
  return <PersonalWechatMacSendDialog {...props} />
}

function PersonalWechatMacSendDialog({
  contact,
  isGroupChat,
  onClose,
  onOpenTextToSpeechSettings,
  initialMode = 'text',
  initialImage = null
}: PersonalWechatSendDialogProps): React.ReactElement {
  const [senderStatus, setSenderStatus] = useState<PersonalWechatSenderStatus | null>(null)
  const [runtimeStatus, setRuntimeStatus] = useState<PersonalWechatRuntimeStatus | null>(null)
  const [runtimeProgress, setRuntimeProgress] = useState<PersonalWechatRuntimeProgressEvent | null>(
    null
  )
  const [detecting, setDetecting] = useState(true)
  const [binding, setBinding] = useState(false)
  const [runtimeBusy, setRuntimeBusy] = useState(false)
  const [sendBusy, setSendBusy] = useState(false)
  const [detectionAttempted, setDetectionAttempted] = useState(false)
  // Status can be reconstructed from a previous OneBot process/log. These
  // session gates ensure the user explicitly binds and detects after opening
  // the flow instead of inheriting stale readiness.
  const [sessionBound, setSessionBound] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sendError, setSendError] = useState<string | null>(null)
  const [voiceDiagnostic, setVoiceDiagnostic] = useState<PersonalWechatVoiceDiagnostic | null>(null)
  const [voiceDiagnosticOpen, setVoiceDiagnosticOpen] = useState(false)
  const [keepOneBotProcess, setKeepOneBotProcess] = useState(false)
  const [composerStarted, setComposerStarted] = useState(Boolean(initialImage))
  const requestIdRef = useRef(0)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const closingRef = useRef(false)
  const displayName = contact.m_nsNickName || contact.m_nsUsrName || '未命名会话'
  const targetId = contact.m_nsUsrName
  const isBusy = binding || runtimeBusy || sendBusy
  const setupReady = Boolean(
    sessionBound &&
    detectionAttempted &&
    senderStatus?.canSendText &&
    (senderStatus?.canSendImage || senderStatus?.canSendVoice)
  )

  const refreshStatus = useCallback(async (): Promise<void> => {
    const requestId = ++requestIdRef.current
    setDetecting(true)
    setSendError(null)
    try {
      const [nextRuntime, nextSender] = await Promise.all([
        isMac
          ? window.api.getPersonalWechatRuntimeStatus?.() || Promise.resolve(null)
          : Promise.resolve(null),
        window.api.getPersonalWechatSenderStatus()
      ])
      if (requestId !== requestIdRef.current) return
      setRuntimeStatus(nextRuntime)
      setRuntimeProgress(nextRuntime?.state === 'downloading' ? nextRuntime : null)
      setSenderStatus(nextSender)
      setSessionBound(
        nextSender.state === 'online' ||
          Boolean(
            nextSender.wechatPid &&
            nextSender.boundWechatPid === nextSender.wechatPid &&
            nextSender.attachReady &&
            nextSender.baseAddressReady
          )
      )
    } catch (error) {
      if (requestId === requestIdRef.current) setSenderStatus(fallbackStatus(error))
    } finally {
      if (requestId === requestIdRef.current) setDetecting(false)
    }
  }, [])

  useEffect(() => {
    void refreshStatus()
    if (!isMac) return undefined
    const unsubscribe = window.api.onPersonalWechatRuntimeProgress?.((status) => {
      setRuntimeProgress(status)
      setRuntimeStatus(status)
      if (status.state === 'ready') void refreshStatus()
    })
    return unsubscribe
  }, [refreshStatus])

  useEffect(() => {
    if (!isMac) return undefined
    let active = true
    const readKeepProcess = window.api.getPersonalWechatKeepOneBotProcess
    if (!readKeepProcess) return undefined
    void readKeepProcess().then((keep) => {
      if (active && typeof keep === 'boolean') setKeepOneBotProcess(keep)
    })
    return () => {
      active = false
    }
  }, [])

  const handleKeepOneBotProcessChange = async (keep: boolean): Promise<void> => {
    if (!isMac) return
    const saveKeepProcess = window.api.setPersonalWechatKeepOneBotProcess
    if (!saveKeepProcess) {
      setSendError('请重启 TraceMemo 后再使用“保留 OneBot 进程”')
      return
    }
    setKeepOneBotProcess(keep)
    try {
      const saved = await saveKeepProcess(keep)
      if (typeof saved === 'boolean') setKeepOneBotProcess(saved)
    } catch (error) {
      setKeepOneBotProcess(!keep)
      setSendError(error instanceof Error ? error.message : String(error))
    }
  }

  const handleDownloadRuntime = async (): Promise<void> => {
    if (runtimeBusy) return
    setRuntimeBusy(true)
    setSendError(null)
    try {
      const result = await window.api.downloadPersonalWechatRuntime()
      setRuntimeStatus(result.status)
      if (!result.success && result.error) setSendError(result.error)
      if (result.success) await refreshStatus()
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error))
    } finally {
      setRuntimeBusy(false)
    }
  }

  const handleBind = async (): Promise<void> => {
    if (binding) return
    setBinding(true)
    setDetectionAttempted(false)
    setSendError(null)
    try {
      const nextStatus = await window.api.rebindPersonalWechatSender()
      setSenderStatus(nextStatus)
      setSessionBound(
        nextStatus.state === 'online' ||
          Boolean(
            nextStatus.wechatPid &&
            nextStatus.boundWechatPid === nextStatus.wechatPid &&
            nextStatus.attachReady &&
            nextStatus.baseAddressReady
          )
      )
      if (nextStatus.state !== 'online' && nextStatus.message) setSendError(nextStatus.message)
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error))
    } finally {
      setBinding(false)
    }
  }

  const handleDetect = async (): Promise<void> => {
    setDetectionAttempted(true)
    await refreshStatus()
  }

  const handleClose = (): void => {
    if (isBusy || closingRef.current) return
    closingRef.current = true
    const restoreFocus = restoreFocusRef.current
    restoreFocusRef.current = null
    onClose()
    queueMicrotask(() => restoreFocus?.focus())
  }

  const handleOpenSettings = (): void => {
    if (!onOpenTextToSpeechSettings || isBusy) return
    handleClose()
    onOpenTextToSpeechSettings()
  }

  const handleSend = async (
    request: PersonalWechatSendRequest
  ): Promise<{ success: boolean; error?: string }> => {
    setSendBusy(true)
    setSendError(null)
    try {
      const response = await window.api.sendPersonalWechatMessage({ ...request, to: targetId })
      setSenderStatus(response.status)
      if (!response.success) setSendError(response.error || '发送失败')
      return { success: response.success, error: response.error }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setSendError(message)
      return { success: false, error: message }
    } finally {
      setSendBusy(false)
    }
  }

  const handleOpenVoiceDiagnostic = async (): Promise<void> => {
    if (!isMac) return
    const diagnostic = await window.api.getPersonalWechatVoiceDiagnostic()
    setVoiceDiagnostic(diagnostic)
    setVoiceDiagnosticOpen(true)
  }

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && handleClose()}>
        <DialogContent
          className="personal-wechat-send-dialog max-h-[calc(100vh-2rem)] max-w-[720px] gap-0 overflow-y-auto p-0"
          onOpenAutoFocus={() => {
            restoreFocusRef.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null
          }}
          onEscapeKeyDown={(event) => isBusy && event.preventDefault()}
          onPointerDownOutside={(event) => isBusy && event.preventDefault()}
        >
          <DialogHeader className="personal-wechat-chat-header">
            <div className="personal-wechat-chat-avatar" aria-hidden>
              {displayName.slice(0, 1)}
            </div>
            <div className="personal-wechat-chat-heading">
              <DialogTitle>{displayName}</DialogTitle>
              <DialogDescription>
                {isGroupChat ? '群聊' : '联系人'} · {setupReady ? '微信已连接' : '配置微信消息发送'}
              </DialogDescription>
            </div>
            <span
              className={`personal-wechat-connection-dot ${setupReady ? 'is-online' : ''}`}
              aria-label={setupReady ? '微信已连接' : '微信尚未配置'}
            />
          </DialogHeader>

          <div className="personal-wechat-chat-body">
            {setupReady && composerStarted && (
              <div className="personal-wechat-message-list" aria-label="消息列表">
                {messages.length === 0 ? (
                  <div className="personal-wechat-empty-message">还没有发送消息。</div>
                ) : (
                  messages.map((message) => (
                    <div
                      key={message.id}
                      className={`personal-wechat-message-bubble ${message.outgoing ? 'is-outgoing' : ''}`}
                    >
                      <span className="personal-wechat-message-kind">
                        {message.type === 'text'
                          ? '文字'
                          : message.type === 'image'
                            ? '图片'
                            : '语音'}
                      </span>
                      <span>{message.text || message.fileName}</span>
                    </div>
                  ))
                )}
              </div>
            )}

            {(!setupReady || !composerStarted) && senderStatus && (
              <PersonalWechatSetupGuide
                runtimeStatus={runtimeStatus}
                senderStatus={senderStatus}
                runtimeProgress={runtimeProgress}
                runtimeBusy={runtimeBusy}
                binding={binding}
                detecting={detecting}
                sessionBound={sessionBound}
                onDownloadRuntime={() => void handleDownloadRuntime()}
                onBind={() => void handleBind()}
                detectionAttempted={detectionAttempted}
                onDetect={() => void handleDetect()}
                onStartSending={() => setComposerStarted(true)}
                onOpenTextToSpeechSettings={handleOpenSettings}
              />
            )}

            {setupReady && composerStarted && (
              <PersonalWechatChatComposer
                status={senderStatus!}
                targetId={targetId}
                isGroupChat={isGroupChat}
                initialMode={initialMode}
                initialImage={initialImage}
                onOpenTextToSpeechSettings={handleOpenSettings}
                onCancel={handleClose}
                onSend={handleSend}
                onMessage={(message) => setMessages((current) => [...current, message])}
                busy={sendBusy}
              />
            )}
            {sendError && (
              <div className="personal-wechat-global-error" role="alert">
                {sendError}
              </div>
            )}
          </div>
          {setupReady && composerStarted && isMac && (
            <div className="personal-wechat-chat-footer flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>保留 OneBot 进程</span>
                <Switch
                  checked={keepOneBotProcess}
                  onCheckedChange={(checked) => void handleKeepOneBotProcessChange(checked)}
                  aria-label="保留 OneBot 进程"
                />
              </div>
              <Button variant="link" size="sm" onClick={() => void handleOpenVoiceDiagnostic()}>
                语音发送诊断
              </Button>
            </div>
          )}
          {(!setupReady || !composerStarted) && (
            <div
              className={`personal-wechat-chat-footer flex items-center ${isMac ? 'justify-between' : 'justify-end'}`}
            >
              {isMac && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>保留 OneBot 进程</span>
                  <Switch
                    checked={keepOneBotProcess}
                    onCheckedChange={(checked) => void handleKeepOneBotProcessChange(checked)}
                    aria-label="保留 OneBot 进程"
                  />
                </div>
              )}
              <Button variant="outline" onClick={handleClose} disabled={isBusy}>
                关闭
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <PersonalWechatVoiceDiagnosticDialog
        open={voiceDiagnosticOpen}
        diagnostic={voiceDiagnostic}
        onOpenChange={setVoiceDiagnosticOpen}
      />
    </>
  )
}
