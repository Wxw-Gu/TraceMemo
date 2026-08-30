import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  PersonalWechatSendRequest,
  PersonalWechatSenderStatus
} from '../../../../shared/personal-wechat'
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui'
import { PersonalWechatChatComposer, type ChatMessage } from './PersonalWechatChatComposer'
import type { PersonalWechatSendDialogProps } from './PersonalWechatSendDialog'

function fallbackStatus(error: unknown): PersonalWechatSenderStatus {
  return {
    state: 'error',
    platform: 'win32',
    arch: 'unknown',
    sipDisabled: true,
    wechatRunning: false,
    runtimeReady: true,
    endpoint: '',
    endpointReady: false,
    attachReady: true,
    baseAddressReady: true,
    textHookInstalled: false,
    textHookReady: false,
    imageHookInstalled: false,
    imageHookReady: false,
    messageListenerReady: false,
    canSend: false,
    canSendText: false,
    canSendImage: false,
    canSendVoice: false,
    message: '无法检测 Windows 微信发送能力',
    error: error instanceof Error ? error.message : String(error)
  }
}

function statusLabel(status: PersonalWechatSenderStatus | null): string {
  if (!status) return '正在检测'
  if (status.state === 'online' && status.canSend) return '微信发送能力已就绪'
  if (status.state === 'online') return '微信发送能力未就绪'
  if (status.state === 'hook_not_ready') return '微信发送能力初始化中'
  if (status.state === 'wechat_not_running') return '微信未运行'
  if (status.state === 'unsupported_version') return '微信版本不匹配'
  if (status.state === 'error') return '绑定异常'
  return '微信发送能力未配置'
}

function statusText(value: string): string {
  return value.replace(/OneBot|Hook/gi, '微信发送能力').replace(/个人微信发送组件/g, '微信发送能力')
}

function statusDescription(status: PersonalWechatSenderStatus | null): string {
  if (!status) return '正在检查本地 Windows 微信发送能力'
  return statusText(status.message)
}

export function PersonalWechatWindowsSendDialog({
  contact,
  isGroupChat,
  onClose,
  onOpenTextToSpeechSettings,
  onOpenPersonalWechatSettings,
  initialMode = 'text',
  initialImage = null
}: PersonalWechatSendDialogProps): React.ReactElement {
  const [status, setStatus] = useState<PersonalWechatSenderStatus | null>(null)
  const [detecting, setDetecting] = useState(true)
  const [sendBusy, setSendBusy] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const requestIdRef = useRef(0)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const closingRef = useRef(false)
  const displayName = contact.m_nsNickName || contact.m_nsUsrName || '未命名会话'
  const targetId = contact.m_nsUsrName

  const refreshStatus = useCallback(async (): Promise<void> => {
    const requestId = ++requestIdRef.current
    setDetecting(true)
    try {
      const nextStatus = await window.api.getPersonalWechatSenderStatus()
      if (requestId === requestIdRef.current) setStatus(nextStatus)
    } catch (error) {
      if (requestId === requestIdRef.current) setStatus(fallbackStatus(error))
    } finally {
      if (requestId === requestIdRef.current) setDetecting(false)
    }
  }, [])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  const handleClose = useCallback((): void => {
    if (sendBusy || closingRef.current) return
    closingRef.current = true
    const restoreFocus = restoreFocusRef.current
    restoreFocusRef.current = null
    onClose()
    queueMicrotask(() => restoreFocus?.focus())
  }, [onClose, sendBusy])

  const handleOpenPersonalWechatSettings = (): void => {
    if (!onOpenPersonalWechatSettings || sendBusy) return
    handleClose()
    onOpenPersonalWechatSettings()
  }

  const handleSend = async (
    request: PersonalWechatSendRequest
  ): Promise<{ success: boolean; error?: string }> => {
    setSendBusy(true)
    try {
      const response = await window.api.sendPersonalWechatMessage({ ...request, to: targetId })
      setStatus(response.status)
      return { success: response.success, error: response.error }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setStatus((current) => ({
        ...(current || fallbackStatus(error)),
        state: 'error',
        error: message
      }))
      return { success: false, error: message }
    } finally {
      setSendBusy(false)
    }
  }

  const statusTone = useMemo(() => {
    if (status?.state === 'online' && status.canSend) return 'ready'
    if (!status || status.state === 'checking' || status.state === 'starting') return 'checking'
    return 'blocked'
  }, [status])

  return (
    <Dialog open onOpenChange={(open) => !open && handleClose()}>
      <DialogContent
        className="personal-wechat-send-dialog max-h-[calc(100vh-2rem)] max-w-[620px] gap-4 overflow-y-auto p-[22px]"
        onOpenAutoFocus={() => {
          restoreFocusRef.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null
        }}
        onEscapeKeyDown={(event) => sendBusy && event.preventDefault()}
        onPointerDownOutside={(event) => sendBusy && event.preventDefault()}
      >
        <DialogHeader className="flex-row items-center justify-between space-y-0 pr-10">
          <div>
            <span className="text-[11px] font-bold tracking-normal text-primary">实验性功能</span>
            <DialogTitle className="mt-0.5 text-[19px] leading-[26px] tracking-normal">
              个人微信发送
            </DialogTitle>
          </div>
          <DialogDescription className="sr-only">
            向当前微信联系人或群聊发送文字、图片和语音。
          </DialogDescription>
        </DialogHeader>

        <div className="personal-wechat-send-device-note" role="note">
          <span aria-hidden>i</span>
          <p>
            <strong>请在其他设备确认发送结果</strong>
            语音、图片等消息请切换到手机、平板等其他设备确认是否送达。
          </p>
        </div>

        <div className="personal-wechat-send-target">
          <span>{isGroupChat ? '发送到群聊' : '发送给联系人'}</span>
          <strong>{displayName}</strong>
          <code>{targetId}</code>
        </div>

        <div className={`personal-wechat-send-status ${statusTone}`}>
          <span className="personal-wechat-send-status-dot" />
          <div>
            <strong>{statusLabel(status)}</strong>
            <p>{statusDescription(status)}</p>
            {status?.error ? <small className="error">{statusText(status.error)}</small> : null}
          </div>
          <div className="personal-wechat-send-status-actions">
            {status && !status.canSend && onOpenPersonalWechatSettings ? (
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0"
                onClick={handleOpenPersonalWechatSettings}
                disabled={sendBusy}
              >
                前往发送能力设置
              </Button>
            ) : null}
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0"
              onClick={() => void refreshStatus()}
              disabled={sendBusy || detecting}
            >
              {detecting ? '检测中…' : '重新检测'}
            </Button>
          </div>
        </div>

        {status ? (
          <>
            {messages.length > 0 ? (
              <div className="personal-wechat-message-list" aria-label="消息列表">
                {messages.map((message) => (
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
                ))}
              </div>
            ) : null}
            <PersonalWechatChatComposer
              status={status}
              targetId={targetId}
              isGroupChat={isGroupChat}
              initialMode={initialMode}
              initialImage={initialImage}
              className="personal-wechat-windows-composer"
              onOpenTextToSpeechSettings={onOpenTextToSpeechSettings}
              onCancel={handleClose}
              onSend={handleSend}
              onMessage={(message) => setMessages((current) => [...current, message])}
              busy={sendBusy}
            />
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
