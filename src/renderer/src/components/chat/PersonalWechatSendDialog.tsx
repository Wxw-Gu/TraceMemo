import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Contact } from '../../../../shared/types'
import type { PersonalWechatSenderStatus } from '../../../../shared/personal-wechat'
import type { TextToSpeechSettings, TextToSpeechVoice } from '../../../../shared/text-to-speech'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  SegmentedControl,
  SegmentedControlItem,
  Textarea
} from '../ui'

type SendMode = 'image' | 'voice'
type VoiceSource = 'generated' | 'file'
type SelectedLocalFile = { path: string; name: string }

interface PersonalWechatSendDialogProps {
  contact: Contact
  isGroupChat: boolean
  onClose: () => void
  onOpenTextToSpeechSettings?: () => void
  initialMode?: SendMode
  initialImage?: SelectedLocalFile | null
}

type GeneratedVoice = { filePath: string; audioDataUrl: string }
const SHOW_SUPPORTED_WECHAT_VERSIONS_KEY = 'wxe:show-supported-wechat-versions'

function formatAudioTime(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0:00'
  const seconds = Math.floor(value)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function statusLabel(status: PersonalWechatSenderStatus | null): string {
  if (!status) return '正在检测'
  if (status.state === 'online') return '个人微信已绑定'
  if (status.state === 'stopped') return '尚未绑定'
  if (status.state === 'runtime_missing') return '运行时未安装'
  if (status.state === 'hook_not_ready') return '已绑定，等待消息初始化'
  if (status.state === 'unsupported_version') return '微信版本不匹配'
  if (status.state === 'wechat_not_running') return '微信未运行'
  if (status.state === 'sip_enabled') return 'SIP 未关闭'
  if (status.state === 'unsupported_platform') return '当前平台不支持'
  if (status.state === 'starting') return '正在连接'
  if (status.state === 'rebinding') return '正在重新绑定'
  if (status.state === 'error') return '绑定异常'
  return '正在检测'
}

function readyText(ready: boolean, readyLabel = '正常', waitingLabel = '等待初始化'): string {
  return ready ? readyLabel : waitingLabel
}

function statusDescription(status: PersonalWechatSenderStatus | null): string {
  if (!status) return '正在检查微信版本、进程和 OneBot Hook…'
  if (status.state === 'unsupported_version') {
    return `当前微信版本 ${status.wechatVersion || '未知'} 暂不支持。请在设置中查看支持的微信版本，安装完全一致的版本后再试。`
  }
  if (status.state === 'runtime_missing') {
    return '微信发送组件尚未安装。请前往文字转语音设置下载组件后再试。'
  }
  return status.message
}

export function PersonalWechatSendDialog({
  contact,
  isGroupChat,
  onClose,
  onOpenTextToSpeechSettings,
  initialMode = 'image',
  initialImage = null
}: PersonalWechatSendDialogProps): React.ReactElement {
  const [status, setStatus] = useState<PersonalWechatSenderStatus | null>(null)
  const [mode, setMode] = useState<SendMode>(initialMode)
  const [image, setImage] = useState<SelectedLocalFile | null>(initialImage)
  const [voice, setVoice] = useState<SelectedLocalFile | null>(null)
  const [voiceSource, setVoiceSource] = useState<VoiceSource>('generated')
  const [voiceText, setVoiceText] = useState('1')
  const [ttsSettings, setTtsSettings] = useState<TextToSpeechSettings | null>(null)
  const [ttsVoices, setTtsVoices] = useState<TextToSpeechVoice[]>([])
  const [generatedVoice, setGeneratedVoice] = useState<GeneratedVoice | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false)
  const [previewCurrentTime, setPreviewCurrentTime] = useState(0)
  const [previewDuration, setPreviewDuration] = useState(0)
  const [isSending, setIsSending] = useState(false)
  const [isRebinding, setIsRebinding] = useState(false)
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null)
  const generatedVoiceRef = useRef<GeneratedVoice | null>(null)
  const generatedAudioRef = useRef<HTMLAudioElement | null>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const closingRef = useRef(false)
  const displayName = contact.m_nsNickName || contact.m_nsUsrName || '未命名会话'
  const targetId = contact.m_nsUsrName
  const selectedTypeReady = mode === 'voice' ? status?.canSendVoice : status?.canSendImage
  const hasContent =
    mode === 'voice'
      ? voiceSource === 'file'
        ? Boolean(voice?.path)
        : Boolean(voiceText.trim())
      : Boolean(image?.path)
  const isBusy = isSending || isGenerating || isRebinding
  const generatedVoiceReady = Boolean(
    ttsSettings?.hasApiKey && ttsSettings.selectedVoiceId && voiceText.trim()
  )
  const canSubmit = Boolean(
    selectedTypeReady && hasContent && !isBusy && (mode !== 'voice' || voiceSource !== 'generated')
  )
  const canGenerate = Boolean(generatedVoiceReady && !isBusy)
  const canSendGenerated = Boolean(status?.canSendVoice && generatedVoice && !isBusy)
  const previewProgress = previewDuration > 0 ? (previewCurrentTime / previewDuration) * 100 : 0
  const selectedTtsVoice = ttsVoices.find((item) => item.id === ttsSettings?.selectedVoiceId)
  const statusTone = useMemo(() => {
    if (status?.attachReady && status.baseAddressReady) return 'ready'
    if (!status || status.state === 'checking' || status.state === 'starting') return 'checking'
    return 'blocked'
  }, [status])

  const clearGeneratedVoice = useCallback((removeFile = true): void => {
    const current = generatedVoiceRef.current
    generatedVoiceRef.current = null
    generatedAudioRef.current?.pause()
    setGeneratedVoice(null)
    setIsPreviewPlaying(false)
    setPreviewCurrentTime(0)
    setPreviewDuration(0)
    if (removeFile && current?.filePath) {
      void window.api.removeGeneratedTextToSpeechAudio(current.filePath).catch(() => undefined)
    }
  }, [])

  const handleClose = useCallback((): void => {
    if (isBusy || closingRef.current) return
    closingRef.current = true
    const restoreFocus = restoreFocusRef.current
    restoreFocusRef.current = null
    clearGeneratedVoice()
    onClose()
    queueMicrotask(() => restoreFocus?.focus())
  }, [clearGeneratedVoice, isBusy, onClose])

  const handleOpenTextToSpeechSettings = (showSupportedVersions = false): void => {
    if (!onOpenTextToSpeechSettings || isBusy) return
    if (showSupportedVersions) {
      try {
        sessionStorage.setItem(SHOW_SUPPORTED_WECHAT_VERSIONS_KEY, '1')
      } catch {
        // The settings page can still open if session storage is unavailable.
      }
    }
    clearGeneratedVoice()
    onClose()
    onOpenTextToSpeechSettings()
  }

  const refreshStatus = useCallback(async (): Promise<void> => {
    setResult(null)
    try {
      setStatus(await window.api.getPersonalWechatSenderStatus())
    } catch (error) {
      setStatus({
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
      })
    }
  }, [])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  useEffect(() => {
    let active = true
    void window.api
      .getTextToSpeechSettings()
      .then(async (response) => {
        if (!active) return
        setTtsSettings(response.settings)
        if (!response.settings.hasApiKey) return
        const voicesResponse = await window.api.listTextToSpeechVoices({
          pageNumber: 1,
          pageSize: 24
        })
        if (!active || !voicesResponse.success) return
        setTtsVoices(voicesResponse.items)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    return () => {
      const current = generatedVoiceRef.current
      generatedVoiceRef.current = null
      if (current?.filePath) {
        void window.api.removeGeneratedTextToSpeechAudio(current.filePath).catch(() => undefined)
      }
    }
  }, [])

  useEffect(() => {
    const audio = generatedAudioRef.current
    return () => audio?.pause()
  }, [generatedVoice])

  const handleRebind = async (): Promise<void> => {
    if (isBusy) return
    setIsRebinding(true)
    setResult(null)
    try {
      const nextStatus = await window.api.rebindPersonalWechatSender()
      setStatus(nextStatus)
      setResult({
        success: nextStatus.attachReady && nextStatus.baseAddressReady,
        message: nextStatus.message
      })
    } catch (error) {
      setResult({ success: false, message: error instanceof Error ? error.message : String(error) })
    } finally {
      setIsRebinding(false)
    }
  }

  const handleSelectImage = async (): Promise<void> => {
    if (isBusy) return
    const selection = await window.api.selectPersonalWechatImage()
    if (!selection.canceled && selection.path) {
      setImage({ path: selection.path, name: selection.name || selection.path.split('/').pop()! })
      setResult(null)
    }
  }

  const handleSelectVoice = async (): Promise<void> => {
    if (isBusy) return
    const selection = await window.api.selectPersonalWechatVoice()
    if (!selection.canceled && selection.path) {
      setVoice({ path: selection.path, name: selection.name || selection.path.split('/').pop()! })
      setResult(null)
    }
  }

  const changeMode = (nextMode: SendMode): void => {
    if (mode === 'voice' && voiceSource === 'generated' && nextMode !== 'voice') {
      clearGeneratedVoice()
    }
    setMode(nextMode)
    setResult(null)
  }

  const changeVoiceSource = (nextSource: VoiceSource): void => {
    if (voiceSource === 'generated' && nextSource !== 'generated') clearGeneratedVoice()
    setVoiceSource(nextSource)
    setResult(null)
  }

  const changeVoiceText = (nextText: string): void => {
    if (generatedVoiceRef.current) clearGeneratedVoice()
    setVoiceText(nextText)
    setResult(null)
  }

  const handleGenerateVoice = async (): Promise<void> => {
    if (!canGenerate) return
    clearGeneratedVoice()
    setIsGenerating(true)
    setResult(null)
    try {
      const generated = await window.api.synthesizeTextToSpeech({
        text: voiceText.trim(),
        referenceId: ttsSettings!.selectedVoiceId
      })
      if (!generated.success || !generated.filePath || !generated.audioDataUrl) {
        setResult({ success: false, message: generated.error || '语音生成失败' })
        return
      }
      const nextVoice = {
        filePath: generated.filePath,
        audioDataUrl: generated.audioDataUrl
      }
      generatedVoiceRef.current = nextVoice
      setGeneratedVoice(nextVoice)
      setResult({ success: true, message: '语音已生成，可以先试听，确认后再发送' })
    } catch (error) {
      setResult({ success: false, message: error instanceof Error ? error.message : String(error) })
    } finally {
      setIsGenerating(false)
    }
  }

  const handleToggleGeneratedPreview = async (): Promise<void> => {
    const audio = generatedAudioRef.current
    if (!audio) return
    if (!audio.paused) {
      audio.pause()
      setIsPreviewPlaying(false)
      return
    }
    try {
      await audio.play()
      setIsPreviewPlaying(true)
    } catch {
      setResult({ success: false, message: '语音试听播放失败' })
    }
  }

  const handleSendGeneratedVoice = async (): Promise<void> => {
    const current = generatedVoiceRef.current
    if (!canSendGenerated || !current) return
    setIsSending(true)
    setResult(null)
    generatedAudioRef.current?.pause()
    setIsPreviewPlaying(false)
    try {
      const response = await window.api.sendPersonalWechatMessage({
        type: 'voice',
        to: targetId,
        filePath: current.filePath,
        isGroup: isGroupChat
      })
      setStatus(response.status)
      setResult({
        success: response.success,
        message: response.success
          ? '语音已提交给微信；请从另一设备或群成员处确认实际送达'
          : response.error || '发送失败'
      })
      if (response.success) clearGeneratedVoice()
    } catch (error) {
      setResult({ success: false, message: error instanceof Error ? error.message : String(error) })
    } finally {
      setIsSending(false)
    }
  }

  const handleSend = async (): Promise<void> => {
    if (!canSubmit || (mode === 'voice' && voiceSource === 'generated')) return
    setIsSending(true)
    setResult(null)
    try {
      const response = await window.api.sendPersonalWechatMessage(
        mode === 'voice'
          ? { type: 'voice', to: targetId, filePath: voice!.path, isGroup: isGroupChat }
          : { type: 'image', to: targetId, filePath: image!.path, isGroup: isGroupChat }
      )
      setStatus(response.status)
      setResult({
        success: response.success,
        message: response.success
          ? `${mode === 'voice' ? '语音' : '图片'}已提交给微信；请从另一设备或群成员处确认实际送达`
          : response.error || '发送失败'
      })
    } catch (error) {
      setResult({ success: false, message: error instanceof Error ? error.message : String(error) })
    } finally {
      setIsSending(false)
    }
  }

  const statusItems = [
    ['微信进程', status?.wechatPid ? `PID ${status.wechatPid}` : '未检测到'],
    [
      'OneBot',
      status?.oneBotPid
        ? `PID ${status.oneBotPid}${status.boundWechatPid ? ` · 绑定 ${status.boundWechatPid}` : ''}`
        : '未启动'
    ],
    [
      '接口',
      `${status?.endpoint || '127.0.0.1:58080'} · ${readyText(Boolean(status?.endpointReady), '监听中', '未监听')}`
    ],
    ['基址扫描', status?.baseAddress || readyText(Boolean(status?.baseAddressReady))],
    ['图片 Hook', readyText(Boolean(status?.imageHookReady), '已捕获，可发送', '等待手动发图片')],
    ['语音能力', readyText(Boolean(status?.canSendVoice), '可发送', '等待媒体 Hook 初始化')],
    ['消息监听', readyText(Boolean(status?.messageListenerReady), '正常', '等待收到微信消息')]
  ]

  return (
    <Dialog open onOpenChange={(open) => !open && handleClose()}>
      <DialogContent
        className="personal-wechat-send-dialog max-h-[calc(100vh-3rem)] max-w-[620px] gap-4 overflow-y-auto p-[22px]"
        onOpenAutoFocus={() => {
          restoreFocusRef.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null
        }}
        onEscapeKeyDown={(event) => isBusy && event.preventDefault()}
        onPointerDownOutside={(event) => isBusy && event.preventDefault()}
      >
        <DialogHeader className="flex-row items-center justify-between space-y-0 pr-10">
          <div>
            <span className="text-[11px] font-bold tracking-normal text-primary">实验性功能</span>
            <DialogTitle className="mt-0.5 text-[19px] leading-[26px] tracking-normal">
              个人微信测试发送
            </DialogTitle>
          </div>
          <DialogDescription className="sr-only">
            向当前微信联系人或群聊测试发送图片和语音。
          </DialogDescription>
        </DialogHeader>

        <div className="personal-wechat-send-device-note" role="note">
          <span aria-hidden>i</span>
          <p>
            <strong>请在其他设备确认发送结果</strong>
            通过测试功能发送的消息不会显示在本机微信会话中，请切换到手机、平板等其他设备确认是否送达。
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
            {status?.wechatVersion && <small>微信版本：{status.wechatVersion}</small>}
            {status?.error &&
              status.state !== 'unsupported_version' &&
              status.state !== 'runtime_missing' && <small className="error">{status.error}</small>}
          </div>
          <div className="personal-wechat-send-status-actions">
            {(status?.state === 'unsupported_version' || status?.state === 'runtime_missing') &&
            onOpenTextToSpeechSettings ? (
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0"
                onClick={() =>
                  handleOpenTextToSpeechSettings(status.state === 'unsupported_version')
                }
                disabled={isBusy}
              >
                {status.state === 'runtime_missing' ? '前往下载组件' : '查看支持版本'}
              </Button>
            ) : null}
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0"
              onClick={() => void refreshStatus()}
              disabled={isBusy}
            >
              重新检测
            </Button>
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0"
              onClick={() => void handleRebind()}
              disabled={isBusy}
            >
              {isRebinding ? '绑定中…' : '尝试重新绑定'}
            </Button>
          </div>
        </div>

        <dl className="personal-wechat-send-diagnostics">
          {statusItems.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>

        <SegmentedControl
          className="personal-wechat-send-mode grid w-full grid-cols-2"
          aria-label="测试消息类型"
          value={mode}
          onValueChange={(value) => changeMode(value as SendMode)}
          disabled={isBusy}
        >
          <SegmentedControlItem value="image" className="w-full">
            图片
          </SegmentedControlItem>
          <SegmentedControlItem value="voice" className="w-full">
            语音
          </SegmentedControlItem>
        </SegmentedControl>

        {mode === 'image' ? (
          <div className="personal-wechat-send-image-picker">
            <span>图片</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleSelectImage()}
              disabled={isBusy}
            >
              {image ? '重新选择图片' : '选择图片'}
            </Button>
            {image ? (
              <div>
                <strong>{image.name}</strong>
                <small>{image.path}</small>
              </div>
            ) : (
              <small>支持 PNG、JPG、GIF 和 WebP，最大 20 MB</small>
            )}
          </div>
        ) : (
          <div className="personal-wechat-voice-composer">
            <SegmentedControl
              className="personal-wechat-voice-source grid w-full grid-cols-2"
              aria-label="语音来源"
              value={voiceSource}
              onValueChange={(value) => changeVoiceSource(value as VoiceSource)}
              disabled={isBusy}
            >
              <SegmentedControlItem value="generated" className="w-full">
                输入文字生成
              </SegmentedControlItem>
              <SegmentedControlItem value="file" className="w-full">
                选择本地文件
              </SegmentedControlItem>
            </SegmentedControl>

            {voiceSource === 'generated' ? (
              <div className="personal-wechat-generated-voice">
                <div className="personal-wechat-generated-voice-heading">
                  <div>
                    <span>文字生成语音</span>
                    <strong>{selectedTtsVoice?.name || '尚未选择音色'}</strong>
                  </div>
                  {onOpenTextToSpeechSettings ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleOpenTextToSpeechSettings()}
                    >
                      前往文字转语音设置
                    </Button>
                  ) : null}
                </div>
                <label className="personal-wechat-send-editor">
                  <span>要生成的文字</span>
                  <Textarea
                    aria-label="要生成的文字"
                    value={voiceText}
                    maxLength={1000}
                    rows={3}
                    disabled={isBusy}
                    onChange={(event) => changeVoiceText(event.target.value)}
                  />
                  <small>{voiceText.length} / 1000</small>
                </label>
                <div
                  className={`personal-wechat-tts-readiness ${ttsSettings?.hasApiKey ? 'ready' : ''}`}
                >
                  <strong>
                    {generatedVoiceReady
                      ? 'API Key 与音色已准备'
                      : ttsSettings?.hasApiKey
                        ? '还需要在设置中选择音色'
                        : '还需要配置语音服务 API Key'}
                  </strong>
                  <span>点击右下角“生成语音”，生成完成后可以试听，再决定是否发送。</span>
                </div>
                {isGenerating ? (
                  <div className="personal-wechat-generation-progress" aria-live="polite">
                    <div>
                      <strong>正在生成语音…</strong>
                      <span>通常需要几秒，请稍候</span>
                    </div>
                    <div className="personal-wechat-generation-track">
                      <span />
                    </div>
                  </div>
                ) : generatedVoice ? (
                  <div className="personal-wechat-generated-result">
                    <audio
                      ref={generatedAudioRef}
                      src={generatedVoice.audioDataUrl}
                      preload="metadata"
                      onLoadedMetadata={(event) => setPreviewDuration(event.currentTarget.duration)}
                      onTimeUpdate={(event) =>
                        setPreviewCurrentTime(event.currentTarget.currentTime)
                      }
                      onPause={() => setIsPreviewPlaying(false)}
                      onPlay={() => setIsPreviewPlaying(true)}
                      onEnded={() => {
                        setIsPreviewPlaying(false)
                        setPreviewCurrentTime(0)
                      }}
                    />
                    <div className="personal-wechat-generated-result-copy">
                      <strong>语音生成完成</strong>
                      <span>
                        {formatAudioTime(previewCurrentTime)} / {formatAudioTime(previewDuration)}
                      </span>
                      <div className="personal-wechat-preview-track">
                        <span style={{ width: `${Math.min(100, previewProgress)}%` }} />
                      </div>
                    </div>
                    <div className="personal-wechat-generated-result-actions">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handleToggleGeneratedPreview()}
                        disabled={isSending}
                      >
                        {isPreviewPlaying ? '暂停' : '播放'}
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => void handleSendGeneratedVoice()}
                        disabled={!canSendGenerated}
                      >
                        {isSending ? '正在发送…' : `发送到${isGroupChat ? '群聊' : '联系人'}`}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="personal-wechat-send-image-picker">
                <span>本地语音文件</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleSelectVoice()}
                  disabled={isBusy}
                >
                  {voice ? '重新选择语音' : '选择语音'}
                </Button>
                {voice ? (
                  <div>
                    <strong>{voice.name}</strong>
                    <small>{voice.path}</small>
                  </div>
                ) : (
                  <small>支持 SILK、MP3、WAV、M4A、AAC、OGG 和 FLAC，最大 20 MB</small>
                )}
              </div>
            )}
          </div>
        )}

        <p className="personal-wechat-send-note">
          {mode === 'voice' && voiceSource === 'generated'
            ? '文字生成语音会复用现有媒体上传能力；请先在微信中给任意好友手动发送一张普通图片，再点击重新检测。'
            : mode === 'voice'
              ? '本地语音复用媒体上传 Hook，请先在微信中给任意好友手动发送一张普通图片，再点击重新检测。'
              : '如果想测试图片，请先在微信中给任意好友手动发送一张普通图片，再点击重新检测。'}
          微信重新登录导致 PID 改变时，请点击“尝试重新绑定”。
        </p>

        {result && (
          <div className={`personal-wechat-send-result ${result.success ? 'success' : 'error'}`}>
            {result.message}
          </div>
        )}

        <footer>
          <Button variant="outline" onClick={handleClose} disabled={isBusy}>
            取消
          </Button>
          {mode === 'voice' && voiceSource === 'generated' ? (
            <Button disabled={!canGenerate} onClick={() => void handleGenerateVoice()}>
              {isGenerating ? '正在生成语音…' : generatedVoice ? '重新生成语音' : '生成语音'}
            </Button>
          ) : (
            <Button disabled={!canSubmit} onClick={handleSend}>
              {isSending
                ? '正在发送…'
                : `测试发送${mode === 'voice' ? '语音' : '图片'}到${isGroupChat ? '群聊' : '联系人'}`}
            </Button>
          )}
        </footer>
      </DialogContent>
    </Dialog>
  )
}
