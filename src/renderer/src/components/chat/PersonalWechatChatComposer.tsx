import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  PersonalWechatSendRequest,
  PersonalWechatSenderStatus
} from '../../../../shared/personal-wechat'
import type { TextToSpeechSettings, TextToSpeechVoice } from '../../../../shared/text-to-speech'
import { Button, SegmentedControl, SegmentedControlItem, Textarea } from '../ui'

type GeneratedVoice = { filePath: string; audioDataUrl: string }
export type PersonalWechatComposerMode = 'text' | 'voice'

export type ChatMessage = {
  id: string
  type: PersonalWechatSendRequest['type'] | 'system'
  text?: string
  fileName?: string
  outgoing: boolean
}

interface PersonalWechatChatComposerProps {
  className?: string
  status: PersonalWechatSenderStatus
  targetId: string
  isGroupChat: boolean
  initialMode?: PersonalWechatComposerMode
  onOpenTextToSpeechSettings?: () => void
  onCancel: () => void
  onSend: (
    request: PersonalWechatSendRequest,
    displayText: string
  ) => Promise<{ success: boolean; error?: string }>
  onMessage: (message: ChatMessage) => void
  busy: boolean
}

function formatAudioTime(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0:00'
  const seconds = Math.floor(value)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function PersonalWechatChatComposer({
  className,
  status,
  targetId,
  isGroupChat,
  initialMode,
  onOpenTextToSpeechSettings,
  onCancel,
  onSend,
  onMessage,
  busy
}: PersonalWechatChatComposerProps): React.ReactElement {
  const [mode, setMode] = useState<PersonalWechatComposerMode>(
    initialMode || (status.canSendText ? 'text' : 'voice')
  )
  const [text, setText] = useState('')
  const [voiceText, setVoiceText] = useState('')
  const [ttsSettings, setTtsSettings] = useState<TextToSpeechSettings | null>(null)
  const [ttsVoices, setTtsVoices] = useState<TextToSpeechVoice[]>([])
  const [generatedVoice, setGeneratedVoice] = useState<GeneratedVoice | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false)
  const [previewCurrentTime, setPreviewCurrentTime] = useState(0)
  const [previewDuration, setPreviewDuration] = useState(0)
  const [feedback, setFeedback] = useState<{ success: boolean; message: string } | null>(null)
  const generatedVoiceRef = useRef<GeneratedVoice | null>(null)
  const generatedAudioRef = useRef<HTMLAudioElement | null>(null)
  const isBusy = busy || isGenerating
  const selectedTtsVoice = ttsVoices.find((item) => item.id === ttsSettings?.selectedVoiceId)

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
        if (active && voicesResponse.success) setTtsVoices(voicesResponse.items)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  const clearGeneratedVoice = useCallback((): void => {
    const current = generatedVoiceRef.current
    generatedVoiceRef.current = null
    generatedAudioRef.current?.pause()
    setGeneratedVoice(null)
    setIsPreviewPlaying(false)
    setPreviewCurrentTime(0)
    setPreviewDuration(0)
    if (current?.filePath) {
      void window.api.removeGeneratedTextToSpeechAudio(current.filePath).catch(() => undefined)
    }
  }, [])

  useEffect(() => () => clearGeneratedVoice(), [clearGeneratedVoice])

  const send = async (
    request: PersonalWechatSendRequest,
    displayText: string
  ): Promise<boolean> => {
    const selectedTypeReady = request.type === 'text' ? status.canSendText : status.canSendVoice
    if (isBusy || !selectedTypeReady) return false
    setFeedback(null)
    const result = await onSend(request, displayText)
    setFeedback({
      success: result.success,
      message: result.success ? '发送成功，请在微信中确认消息已送达' : result.error || '发送失败'
    })
    if (result.success) {
      onMessage({
        id: `${Date.now()}-${Math.random()}`,
        type: request.type,
        text: request.type === 'text' ? request.text : displayText,
        fileName: request.type === 'voice' ? displayText : undefined,
        outgoing: true
      })
    }
    return result.success
  }

  const sendText = async (): Promise<void> => {
    const value = text.trim()
    if (!value || !targetId || !status.canSendText) return
    await send({ type: 'text', to: targetId, text: value, isGroup: isGroupChat }, value)
  }

  const generateVoice = async (): Promise<void> => {
    if (isBusy || !ttsSettings?.hasApiKey || !ttsSettings.selectedVoiceId || !voiceText.trim()) {
      return
    }
    clearGeneratedVoice()
    setIsGenerating(true)
    setFeedback(null)
    try {
      const generated = await window.api.synthesizeTextToSpeech({
        text: voiceText.trim(),
        referenceId: ttsSettings.selectedVoiceId
      })
      if (!generated.success || !generated.filePath || !generated.audioDataUrl) {
        setFeedback({ success: false, message: generated.error || '语音生成失败' })
        return
      }
      const nextVoice = { filePath: generated.filePath, audioDataUrl: generated.audioDataUrl }
      generatedVoiceRef.current = nextVoice
      setGeneratedVoice(nextVoice)
    } catch (error) {
      setFeedback({
        success: false,
        message: error instanceof Error ? error.message : String(error)
      })
    } finally {
      setIsGenerating(false)
    }
  }

  const sendGenerated = async (): Promise<void> => {
    const current = generatedVoiceRef.current
    if (!current || isBusy || !status.canSendVoice) return
    const displayText = voiceText.trim() || '语音消息'
    await send(
      { type: 'voice', to: targetId, filePath: current.filePath, isGroup: isGroupChat },
      displayText
    )
  }

  const generatedReady = Boolean(
    ttsSettings?.hasApiKey && ttsSettings.selectedVoiceId && voiceText.trim()
  )
  const canSendVoice = Boolean(targetId && status.canSendVoice && !isBusy && generatedVoice)
  const canSendText = Boolean(targetId && status.canSendText && !isBusy && text.trim())
  const previewProgress = previewDuration > 0 ? (previewCurrentTime / previewDuration) * 100 : 0

  return (
    <section
      className={`personal-wechat-composer${className ? ` ${className}` : ''}`}
      aria-label="发送消息"
    >
      <SegmentedControl
        className="personal-wechat-composer-mode"
        aria-label="消息类型"
        value={mode}
        onValueChange={(value) => {
          setMode(value as PersonalWechatComposerMode)
          setFeedback(null)
        }}
        disabled={isBusy}
      >
        <SegmentedControlItem value="text">文字</SegmentedControlItem>
        <SegmentedControlItem value="voice">文字转语音</SegmentedControlItem>
      </SegmentedControl>

      {mode === 'text' ? (
        <div className="personal-wechat-text-editor">
          <Textarea
            aria-label="消息内容"
            placeholder="输入要发送的文字"
            value={text}
            maxLength={2000}
            rows={5}
            disabled={isBusy || !status.canSendText}
            onChange={(event) => {
              setText(event.target.value)
              setFeedback(null)
            }}
          />
          <span>{text.length} / 2000</span>
        </div>
      ) : (
        <div className="personal-wechat-voice-editor">
          <div className="personal-wechat-voice-heading">
            <span>{selectedTtsVoice?.name || '尚未选择音色'}</span>
            {onOpenTextToSpeechSettings && (
              <Button
                variant="link"
                size="sm"
                onClick={onOpenTextToSpeechSettings}
                disabled={isBusy}
              >
                语音设置
              </Button>
            )}
          </div>
          <Textarea
            aria-label="语音文字"
            placeholder="输入要生成的文字"
            value={voiceText}
            maxLength={1000}
            rows={4}
            disabled={isBusy}
            onChange={(event) => {
              clearGeneratedVoice()
              setVoiceText(event.target.value)
              setFeedback(null)
            }}
          />
          {generatedVoice ? (
            <div className="personal-wechat-generated-result">
              <audio
                ref={generatedAudioRef}
                src={generatedVoice.audioDataUrl}
                preload="metadata"
                onLoadedMetadata={(event) => setPreviewDuration(event.currentTarget.duration)}
                onTimeUpdate={(event) => setPreviewCurrentTime(event.currentTarget.currentTime)}
                onPause={() => setIsPreviewPlaying(false)}
                onPlay={() => setIsPreviewPlaying(true)}
                onEnded={() => {
                  setIsPreviewPlaying(false)
                  setPreviewCurrentTime(0)
                }}
              />
              <div>
                <strong>语音已生成</strong>
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
                  onClick={async () => {
                    const audio = generatedAudioRef.current
                    if (!audio) return
                    if (audio.paused) {
                      await audio.play()
                      setIsPreviewPlaying(true)
                    } else {
                      audio.pause()
                    }
                  }}
                  disabled={busy}
                >
                  {isPreviewPlaying ? '暂停' : '试听'}
                </Button>
                <Button
                  size="sm"
                  onClick={() => void sendGenerated()}
                  disabled={!canSendVoice}
                  aria-label="发送到微信"
                >
                  {busy ? '发送中…' : '发送到微信'}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              size="sm"
              onClick={() => void generateVoice()}
              disabled={!generatedReady || isBusy}
            >
              {isGenerating ? '正在生成…' : '生成语音'}
            </Button>
          )}
        </div>
      )}

      <div className="personal-wechat-composer-footer">
        {feedback && (
          <span className={feedback.success ? 'is-success' : 'is-error'}>{feedback.message}</span>
        )}
        <Button variant="outline" size="sm" onClick={onCancel} disabled={isBusy}>
          取消
        </Button>
        {mode === 'text' && (
          <Button size="sm" onClick={() => void sendText()} disabled={!canSendText}>
            {busy ? '发送中…' : '发送文字'}
          </Button>
        )}
      </div>
    </section>
  )
}
