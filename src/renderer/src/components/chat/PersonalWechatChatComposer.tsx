import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  PersonalWechatSendRequest,
  PersonalWechatSenderStatus
} from '../../../../shared/personal-wechat'
import type { TextToSpeechSettings, TextToSpeechVoice } from '../../../../shared/text-to-speech'
import { Button, SegmentedControl, SegmentedControlItem, Textarea } from '../ui'

export type PersonalWechatComposerMode = 'text' | 'image' | 'voice'
type VoiceSource = 'generated' | 'file'
type SelectedLocalFile = { path: string; name: string }
type GeneratedVoice = { filePath: string; audioDataUrl: string }

export type ChatMessage = {
  id: string
  type: PersonalWechatComposerMode | 'system'
  text?: string
  fileName?: string
  outgoing: boolean
}

interface PersonalWechatChatComposerProps {
  status: PersonalWechatSenderStatus
  targetId: string
  isGroupChat: boolean
  initialMode?: PersonalWechatComposerMode
  initialImage?: SelectedLocalFile | null
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
  status,
  targetId,
  isGroupChat,
  initialMode = 'text',
  initialImage = null,
  onOpenTextToSpeechSettings,
  onCancel,
  onSend,
  onMessage,
  busy
}: PersonalWechatChatComposerProps): React.ReactElement {
  const [mode, setMode] = useState<PersonalWechatComposerMode>(initialMode)
  const [text, setText] = useState('')
  const [image, setImage] = useState<SelectedLocalFile | null>(initialImage)
  const [voice, setVoice] = useState<SelectedLocalFile | null>(null)
  const [voiceSource, setVoiceSource] = useState<VoiceSource>('generated')
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
  const selectedTypeReady =
    mode === 'text'
      ? status.canSendText
      : mode === 'image'
        ? status.canSendImage
        : status.canSendVoice
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
    if (current?.filePath)
      void window.api.removeGeneratedTextToSpeechAudio(current.filePath).catch(() => undefined)
  }, [])

  useEffect(() => () => clearGeneratedVoice(), [clearGeneratedVoice])

  const selectImage = async (): Promise<void> => {
    if (isBusy) return
    const selection = await window.api.selectPersonalWechatImage()
    if (!selection.canceled && selection.path) {
      setImage({
        path: selection.path,
        name: selection.name || selection.path.split(/[\\/]/).pop() || '图片'
      })
      setFeedback(null)
    }
  }

  const selectVoice = async (): Promise<void> => {
    if (isBusy) return
    const selection = await window.api.selectPersonalWechatVoice()
    if (!selection.canceled && selection.path) {
      setVoice({
        path: selection.path,
        name: selection.name || selection.path.split(/[\\/]/).pop() || '语音'
      })
      setFeedback(null)
    }
  }

  const send = async (
    request: PersonalWechatSendRequest,
    displayText: string
  ): Promise<boolean> => {
    if (isBusy || !selectedTypeReady) return false
    setFeedback(null)
    const result = await onSend(request, displayText)
    setFeedback({
      success: result.success,
      message: result.success ? '已发送' : result.error || '发送失败'
    })
    if (result.success)
      onMessage({
        id: `${Date.now()}-${Math.random()}`,
        type: request.type,
        text: request.type === 'text' ? request.text : displayText,
        fileName: request.type === 'text' ? undefined : displayText,
        outgoing: true
      })
    return result.success
  }

  const generateVoice = async (): Promise<void> => {
    if (isBusy || !ttsSettings?.hasApiKey || !ttsSettings.selectedVoiceId || !voiceText.trim())
      return
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

  const sendCurrent = async (): Promise<void> => {
    if (mode === 'text') {
      const value = text.trim()
      if (value)
        await send({ type: 'text', to: targetId, text: value, isGroup: isGroupChat }, value)
    } else if (mode === 'image' && image) {
      await send(
        { type: 'image', to: targetId, filePath: image.path, isGroup: isGroupChat },
        image.name
      )
    } else if (mode === 'voice' && voiceSource === 'file' && voice) {
      await send(
        { type: 'voice', to: targetId, filePath: voice.path, isGroup: isGroupChat },
        voice.name
      )
    }
  }

  const sendGenerated = async (): Promise<void> => {
    if (!generatedVoiceRef.current) return
    await send(
      {
        type: 'voice',
        to: targetId,
        filePath: generatedVoiceRef.current.filePath,
        isGroup: isGroupChat
      },
      voiceText.trim() || '语音消息'
    )
  }

  const sendGeneratedAlternative = async (): Promise<void> => {
    if (!generatedVoiceRef.current) return
    await send(
      {
        type: 'voice',
        to: targetId,
        filePath: generatedVoiceRef.current.filePath,
        isGroup: isGroupChat,
        voiceSendMode: 'legacy'
      },
      voiceText.trim() || '语音消息'
    )
  }

  const canSend = Boolean(
    selectedTypeReady &&
    !isBusy &&
    ((mode === 'text' && text.trim()) ||
      (mode === 'image' && image) ||
      (mode === 'voice' &&
        ((voiceSource === 'file' && voice) || (voiceSource === 'generated' && generatedVoice))))
  )
  const generatedReady = Boolean(
    ttsSettings?.hasApiKey && ttsSettings.selectedVoiceId && voiceText.trim()
  )
  const previewProgress = previewDuration > 0 ? (previewCurrentTime / previewDuration) * 100 : 0

  return (
    <section className="personal-wechat-composer" aria-label="发送消息">
      <SegmentedControl
        className="personal-wechat-composer-mode"
        aria-label="消息类型"
        value={mode}
        onValueChange={(value) => {
          clearGeneratedVoice()
          setMode(value as PersonalWechatComposerMode)
          setFeedback(null)
        }}
        disabled={isBusy}
      >
        <SegmentedControlItem value="text">文字</SegmentedControlItem>
        <SegmentedControlItem value="image">图片</SegmentedControlItem>
        <SegmentedControlItem value="voice">语音</SegmentedControlItem>
      </SegmentedControl>

      {mode === 'text' && (
        <div className="personal-wechat-text-editor">
          <Textarea
            aria-label="消息内容"
            placeholder="输入消息"
            value={text}
            maxLength={2000}
            rows={3}
            disabled={isBusy}
            onChange={(event) => {
              setText(event.target.value)
              setFeedback(null)
            }}
          />
          <span>{text.length} / 2000</span>
        </div>
      )}

      {mode === 'image' && (
        <div className="personal-wechat-file-editor">
          <div>
            <strong>{image?.name || '还没有选择图片'}</strong>
            <small>{image ? image.path : '支持 PNG、JPG、GIF 和 WebP，最大 20 MB'}</small>
          </div>
          <Button variant="outline" size="sm" onClick={() => void selectImage()} disabled={isBusy}>
            {image ? '重新选择' : '选择图片'}
          </Button>
        </div>
      )}

      {mode === 'voice' && (
        <div className="personal-wechat-voice-editor">
          <SegmentedControl
            aria-label="语音来源"
            value={voiceSource}
            onValueChange={(value) => {
              clearGeneratedVoice()
              setVoiceSource(value as VoiceSource)
              setFeedback(null)
            }}
            disabled={isBusy}
          >
            <SegmentedControlItem value="generated">输入文字生成</SegmentedControlItem>
            <SegmentedControlItem value="file">选择本地文件</SegmentedControlItem>
          </SegmentedControl>
          {voiceSource === 'generated' ? (
            <>
              <div className="personal-wechat-voice-heading">
                <span>{selectedTtsVoice?.name || '尚未选择音色'}</span>
                {onOpenTextToSpeechSettings && (
                  <Button variant="link" size="sm" onClick={onOpenTextToSpeechSettings}>
                    语音设置
                  </Button>
                )}
              </div>
              <Textarea
                aria-label="语音文字"
                placeholder="输入要生成的文字"
                value={voiceText}
                maxLength={1000}
                rows={2}
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
                    <Button size="sm" onClick={() => void sendGenerated()} disabled={!canSend}>
                      {busy ? '发送中…' : '发送'}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void sendGeneratedAlternative()}
                      disabled={!canSend}
                      title="使用另一条语音发送路径"
                    >
                      {busy ? '发送中…' : '空白语音？重新处理'}
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
            </>
          ) : (
            <div className="personal-wechat-file-editor">
              <div>
                <strong>{voice?.name || '还没有选择语音文件'}</strong>
                <small>{voice ? voice.path : '支持 SILK、MP3、WAV、M4A、AAC、OGG 和 FLAC'}</small>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void selectVoice()}
                disabled={isBusy}
              >
                {voice ? '重新选择' : '选择语音'}
              </Button>
            </div>
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
        {!(mode === 'voice' && voiceSource === 'generated' && generatedVoice) && (
          <Button size="sm" onClick={() => void sendCurrent()} disabled={!canSend}>
            {busy ? '正在发送…' : '发送消息'}
          </Button>
        )}
      </div>
    </section>
  )
}
