import { useCallback, useEffect, useRef, useState } from 'react'
import type { Contact } from '../../../../shared/types'
import type {
  PersonalWechatSendRequest,
  PersonalWechatSenderStatus,
  PersonalWechatVoiceDiagnostic
} from '../../../../shared/personal-wechat'
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui'
import { isMac, isWindows } from '../../utils/runtime-environment'
import { PersonalWechatChatComposer, type ChatMessage } from './PersonalWechatChatComposer'
import { PersonalWechatSetupGuide } from './PersonalWechatSetupGuide'
import { PersonalWechatVoiceDiagnosticDialog } from './PersonalWechatVoiceDiagnosticDialog'
import { PersonalWechatWindowsSendDialog } from './PersonalWechatWindowsSendDialog'
import { ReportImagePostfixInput } from './ReportImagePostfixInput'
import { useReportImagePostfixSetting } from './useReportImagePostfixSetting'

type SelectedLocalFile = { path: string; name: string }

export interface PersonalWechatSendDialogProps {
  contact: Contact
  isGroupChat: boolean
  onClose: () => void
  onOpenTextToSpeechSettings?: () => void
  onOpenPersonalWechatSettings?: () => void
  initialMode?: 'text' | 'image' | 'voice'
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
    endpoint: '',
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
  initialImage = null
}: PersonalWechatSendDialogProps): React.ReactElement {
  const [senderStatus, setSenderStatus] = useState<PersonalWechatSenderStatus | null>(null)
  const [detecting, setDetecting] = useState(true)
  const [binding, setBinding] = useState(false)
  const [sendBusy, setSendBusy] = useState(false)
  // 发送入口只信任当前 native runtime 上报的能力状态。
  const [sessionBound, setSessionBound] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sendError, setSendError] = useState<string | null>(null)
  const [sendSuccess, setSendSuccess] = useState<string | null>(null)
  const [voiceDiagnostic, setVoiceDiagnostic] = useState<PersonalWechatVoiceDiagnostic | null>(null)
  const [voiceDiagnosticOpen, setVoiceDiagnosticOpen] = useState(false)
  const requestIdRef = useRef(0)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const closingRef = useRef(false)
  const displayName = contact.m_nsNickName || contact.m_nsUsrName || '未命名会话'
  const targetId = contact.m_nsUsrName
  const isBusy = binding || sendBusy
  const setupReady = Boolean(initialImage ? senderStatus?.canSendImage : senderStatus?.canSendVoice)
  const { postfixText, setPostfixText, persistPostfixText } = useReportImagePostfixSetting(
    Boolean(initialImage)
  )

  const refreshStatus = useCallback(async (): Promise<void> => {
    const requestId = ++requestIdRef.current
    setDetecting(true)
    setSendError(null)
    try {
      const nextSender = await window.api.getPersonalWechatSenderStatus()
      if (requestId !== requestIdRef.current) return
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
  }, [refreshStatus])

  useEffect(() => {
    if (!senderStatus || senderStatus.canSend || senderStatus.state === 'error') return undefined
    const bound =
      senderStatus.state === 'online' ||
      Boolean(
        senderStatus.wechatPid &&
        senderStatus.boundWechatPid === senderStatus.wechatPid &&
        senderStatus.attachReady &&
        senderStatus.baseAddressReady
      )
    if (!bound) return undefined
    const timer = window.setInterval(() => void refreshStatus(), 1_000)
    return () => window.clearInterval(timer)
  }, [refreshStatus, senderStatus])

  const handleBind = async (): Promise<void> => {
    if (binding) return
    setBinding(true)
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
      if (nextStatus.state === 'error' && nextStatus.message) setSendError(nextStatus.message)
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error))
    } finally {
      setBinding(false)
    }
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

  const handleSend = async (filePath: string): Promise<{ success: boolean; error?: string }> => {
    setSendBusy(true)
    setSendError(null)
    try {
      const response = await window.api.sendGeneratedTtsVoice({
        to: targetId,
        isGroup: isGroupChat,
        filePath
      })
      setSenderStatus(response.status)
      const success = response.action.status === 'sent'
      const error = success
        ? undefined
        : response.action.errorCode === 'SEND_CAPABILITY_UNAVAILABLE'
          ? '当前微信发送能力不可用'
          : response.action.reason || '发送失败，请重试'
      if (error) setSendError(error)
      return { success, error }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setSendError(message)
      return { success: false, error: message }
    } finally {
      setSendBusy(false)
    }
  }

  const handleSendReportImage = async (): Promise<void> => {
    if (!initialImage || !senderStatus?.canSendImage || sendBusy) return
    setSendBusy(true)
    setSendError(null)
    setSendSuccess(null)
    try {
      await persistPostfixText()
      const response = await window.api.sendPersonalWechatMessage({
        type: 'image',
        to: targetId,
        isGroup: isGroupChat,
        filePath: initialImage.path,
        postfixText
      } satisfies PersonalWechatSendRequest)
      setSenderStatus(response.status)
      if (!response.success) {
        setSendError(response.error || '日报图片发送失败')
        return
      }
      if (response.postfixError) {
        setSendError(`日报图片已发送，但${response.postfixError}`)
        setSendSuccess('日报图片发送成功')
      } else {
        setSendSuccess(postfixText.trim() ? '日报图片和后置词发送成功' : '日报图片发送成功')
      }
      setMessages((current) => [
        ...current,
        {
          id: `${Date.now()}-${Math.random()}`,
          type: 'system',
          text: initialImage.name,
          fileName: initialImage.name,
          outgoing: true
        }
      ])
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error))
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
          aria-label={displayName}
          aria-labelledby={undefined}
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
              <DialogTitle>{initialImage ? '发送日报图片' : '文字转语音'}</DialogTitle>
              <DialogDescription>
                发送给 {displayName} · {setupReady ? '微信已连接' : '配置微信发送能力'}
              </DialogDescription>
            </div>
            <span
              className={`personal-wechat-connection-dot ${setupReady ? 'is-online' : ''}`}
              aria-label={setupReady ? '微信已连接' : '微信尚未配置'}
            />
          </DialogHeader>

          <div className="personal-wechat-chat-body">
            {setupReady && !initialImage && (
              <div className="personal-wechat-message-list" aria-label="消息列表">
                {messages.length === 0 ? (
                  <div className="personal-wechat-empty-message">还没有发送消息。</div>
                ) : (
                  messages.map((message) => (
                    <div
                      key={message.id}
                      className={`personal-wechat-message-bubble ${message.outgoing ? 'is-outgoing' : ''}`}
                    >
                      <span className="personal-wechat-message-kind">语音</span>
                      <span>{message.text || message.fileName}</span>
                    </div>
                  ))
                )}
              </div>
            )}

            {!setupReady && senderStatus && (
              <PersonalWechatSetupGuide
                senderStatus={senderStatus}
                binding={binding}
                detecting={detecting}
                sessionBound={sessionBound}
                onBind={() => void handleBind()}
                onStartSending={() => undefined}
                onOpenTextToSpeechSettings={handleOpenSettings}
              />
            )}

            {setupReady && initialImage && (
              <section className="personal-wechat-composer" aria-label="日报图片发送">
                <p>已准备日报图片：{initialImage.name}</p>
                <ReportImagePostfixInput
                  value={postfixText}
                  onChange={setPostfixText}
                  onBlur={() =>
                    void persistPostfixText().catch((error) =>
                      setSendError(error instanceof Error ? error.message : '发送后置词保存失败')
                    )
                  }
                  disabled={sendBusy}
                />
                <Button size="sm" onClick={() => void handleSendReportImage()} disabled={sendBusy}>
                  {sendBusy ? '发送中…' : '发送日报图片'}
                </Button>
              </section>
            )}

            {setupReady && !initialImage && (
              <PersonalWechatChatComposer
                status={senderStatus!}
                targetId={targetId}
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
            {sendSuccess && (
              <div className="personal-wechat-global-success" role="status">
                {sendSuccess}
              </div>
            )}
          </div>
          {setupReady && isMac && !initialImage && (
            <div className="personal-wechat-chat-footer flex items-center justify-end">
              <Button variant="link" size="sm" onClick={() => void handleOpenVoiceDiagnostic()}>
                语音发送诊断
              </Button>
            </div>
          )}
          {!setupReady && (
            <div className="personal-wechat-chat-footer flex items-center justify-end">
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
