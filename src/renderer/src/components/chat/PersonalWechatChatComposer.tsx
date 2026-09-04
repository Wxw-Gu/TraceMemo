import { useCallback, useEffect, useRef, useState } from 'react'
import type { PersonalWechatSenderStatus } from '../../../../shared/personal-wechat'
import type { TextToSpeechSettings, TextToSpeechVoice } from '../../../../shared/text-to-speech'
import { Button, Textarea } from '../ui'

type GeneratedVoice = { filePath: string; audioDataUrl: string }

export type ChatMessage = {
  id: string
  type: 'voice' | 'system'
  text?: string
  fileName?: string
  outgoing: boolean
}

interface PersonalWechatChatComposerProps {
  className?: string
  status: PersonalWechatSenderStatus
  targetId: string
  onOpenTextToSpeechSettings?: () => void
  onCancel: () => void
  onSend: (filePath: string, displayText: string) => Promise<{ success: boolean; error?: string }>
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
  onOpenTextToSpeechSettings,
  onCancel,
  onSend,
  onMessage,
  busy
}: PersonalWechatChatComposerProps): React.ReactElement {
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
    setFeedback(null)
    const displayText = voiceText.trim() || '语音消息'
    const result = await onSend(current.filePath, displayText)
    setFeedback({
      success: result.success,
      message: result.success
        ? '发送成功, 可使用另一设备查看发送的消息'
        : result.error || '发送失败'
    })
    if (result.success) {
      onMessage({
        id: `${Date.now()}-${Math.random()}`,
        type: 'voice',
        text: displayText,
        fileName: displayText,
        outgoing: true
      })
    }
  }

  const generatedReady = Boolean(
    ttsSettings?.hasApiKey && ttsSettings.selectedVoiceId && voiceText.trim()
  )
  const canSend = Boolean(targetId && status.canSendVoice && !isBusy && generatedVoice)
  const previewProgress = previewDuration > 0 ? (previewCurrentTime / previewDuration) * 100 : 0

  return (
    <section
      className={`personal-wechat-composer${className ? ` ${className}` : ''}`}
      aria-label="文字转语音"
    >
      <div className="personal-wechat-voice-editor">
        <div className="personal-wechat-voice-heading">
          <span>{selectedTtsVoice?.name || '尚未选择音色'}</span>
          {onOpenTextToSpeechSettings && (
            <Button variant="link" size="sm" onClick={onOpenTextToSpeechSettings} disabled={isBusy}>
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
                disabled={!canSend}
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

      <div className="personal-wechat-composer-footer">
        {feedback && (
          <span className={feedback.success ? 'is-success' : 'is-error'}>{feedback.message}</span>
        )}
        <Button variant="outline" size="sm" onClick={onCancel} disabled={isBusy}>
          取消
        </Button>
      </div>
    </section>
  )
}
