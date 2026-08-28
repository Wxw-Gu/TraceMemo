import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import type { JSX, MouseEvent as ReactMouseEvent } from 'react'
import type { VoiceMessageReference, VoiceModelStatus } from '../../../shared/voice-recognition'

interface VoicePlayerProps {
  sessionId: string
  localId: number
  createTime: number
  svrId?: string | number
  duration?: number
}

let globalCurrentAudio: HTMLAudioElement | null = null
let globalStopCallback: (() => void) | null = null

export function VoicePlayer({
  sessionId,
  localId,
  createTime,
  svrId,
  duration
}: VoicePlayerProps): JSX.Element {
  const [isPlaying, setIsPlaying] = useState(false)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [audioDuration, setAudioDuration] = useState<number | undefined>(duration)
  const [modelStatus, setModelStatus] = useState<VoiceModelStatus | null>(null)
  const [transcribing, setTranscribing] = useState(false)
  const [transcript, setTranscript] = useState<string | null>(null)
  const [transcriptError, setTranscriptError] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const objectUrlRef = useRef<string | null>(null)
  const voiceReference = useMemo<VoiceMessageReference>(
    () => ({ sessionId, localId, createTime, svrId }),
    [createTime, localId, sessionId, svrId]
  )

  const stopCurrentAndPlay = useCallback((audio: HTMLAudioElement) => {
    if (globalCurrentAudio && globalCurrentAudio !== audio) {
      globalCurrentAudio.pause()
      globalCurrentAudio.currentTime = 0
      globalStopCallback?.()
    }
    globalCurrentAudio = audio
  }, [])

  const playAudio = useCallback(
    async (audio: HTMLAudioElement): Promise<void> => {
      stopCurrentAndPlay(audio)
      try {
        await audio.play()
        setError(null)
        setIsPlaying(true)
        globalStopCallback = () => {
          setIsPlaying(false)
          audio.currentTime = 0
        }
      } catch (playError) {
        if (globalCurrentAudio === audio) {
          globalCurrentAudio = null
          globalStopCallback = null
        }
        setIsPlaying(false)
        setError('语音播放失败，请重试')
        console.warn('[VoicePlayer] play failed:', playError)
      }
    },
    [stopCurrentAndPlay]
  )

  const createAudio = useCallback((blobUrl: string): HTMLAudioElement => {
    const audio = new Audio()
    audio.preload = 'auto'
    audio.src = blobUrl
    audio.onloadedmetadata = () => {
      if (Number.isFinite(audio.duration)) setAudioDuration(audio.duration)
    }
    audio.ontimeupdate = () => {
      if (Number.isFinite(audio.duration)) setAudioDuration(audio.duration)
    }
    audio.onended = () => {
      setIsPlaying(false)
      if (globalCurrentAudio === audio) {
        globalCurrentAudio = null
        globalStopCallback = null
      }
    }
    audioRef.current = audio
    objectUrlRef.current = blobUrl
    return audio
  }, [])

  const handlePlayPause = useCallback(async () => {
    if (loading) return

    let audio = audioRef.current
    if (!audio) {
      setLoading(true)
      setError(null)
      try {
        const result = await window.api.getVoiceData(sessionId, localId, createTime, svrId)
        if (result.success && result.data) {
          const byteCharacters = atob(result.data)
          const byteArray = new Uint8Array(byteCharacters.length)
          for (let i = 0; i < byteCharacters.length; i++) {
            byteArray[i] = byteCharacters.charCodeAt(i)
          }
          const blob = new Blob([byteArray], { type: 'audio/wav' })
          const blobUrl = URL.createObjectURL(blob)
          setAudioUrl(blobUrl)
          audio = createAudio(blobUrl)
          await playAudio(audio)
        } else {
          setError(result.error || '获取语音数据失败')
        }
      } catch (loadError) {
        console.warn('[VoicePlayer] load failed:', loadError)
        setError('加载语音失败')
      } finally {
        setLoading(false)
      }
      return
    }

    if (isPlaying) {
      audio.pause()
      setIsPlaying(false)
      if (globalCurrentAudio === audio) {
        globalCurrentAudio = null
        globalStopCallback = null
      }
    } else {
      await playAudio(audio)
    }
  }, [createAudio, createTime, isPlaying, loading, localId, playAudio, sessionId, svrId])

  useEffect(() => {
    return () => {
      const audio = audioRef.current
      if (audio) {
        audio.pause()
        audio.removeAttribute('src')
        audio.load()
      }
      if (globalCurrentAudio === audio) {
        globalCurrentAudio = null
        globalStopCallback = null
      }
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
      audioRef.current = null
    }
  }, [])

  const handleTranscribe = useCallback(
    async (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      setTranscriptError(null)
      const status = await window.api.getVoiceModelStatus()
      setModelStatus(status)
      if (status.state !== 'ready') return

      setTranscribing(true)
      try {
        const result = await window.api.recognizeVoice(voiceReference)
        if (result.success) {
          setTranscript(result.transcript?.trim() || '未识别出文字')
          setModelStatus(null)
        } else if (result.code !== 'CANCELLED') {
          setTranscriptError(result.error || '语音识别失败')
        }
      } catch (recognitionError) {
        console.warn('[VoicePlayer] recognition failed:', recognitionError)
        setTranscriptError('语音识别失败，请重试')
      } finally {
        setTranscribing(false)
      }
    },
    [voiceReference]
  )

  const handleCancelRecognition = useCallback(
    async (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      await window.api.cancelVoiceRecognition(voiceReference)
    },
    [voiceReference]
  )

  const handleOpenVoiceSettings = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    window.dispatchEvent(new Event('wxe:open-voice-recognition-settings'))
  }, [])

  const handleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault()
      event.stopPropagation()
      void window.api.showVoiceSourceContextMenu(voiceReference)
    },
    [voiceReference]
  )

  const formatDuration = (seconds: number | undefined): string => {
    if (!seconds || !isFinite(seconds)) return '0:00'
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  return (
    <div className="voice-player">
      <div
        className={`voice-message ${loading ? 'voice-loading' : ''} ${error && !audioUrl ? 'voice-error' : ''}`}
        onClick={handlePlayPause}
        onContextMenu={handleContextMenu}
      >
        <span className={`voice-icon ${isPlaying ? 'playing' : ''}`}>{isPlaying ? '⏸' : '▶'}</span>
        {loading ? (
          <span className="voice-loading-text">加载中...</span>
        ) : error && !audioUrl ? (
          <span className="voice-error-text">当前语音暂不支持播放</span>
        ) : (
          <>
            <div className="voice-bars" aria-hidden="true">
              <i></i>
              <i></i>
              <i></i>
            </div>
            <span className="voice-duration">{formatDuration(audioDuration)}</span>
          </>
        )}
        {transcribing ? (
          <button className="voice-text-action" type="button" onClick={handleCancelRecognition}>
            取消识别
          </button>
        ) : (
          <button className="voice-text-action" type="button" onClick={handleTranscribe}>
            {transcript ? '重新识别' : '转文字'}
          </button>
        )}
      </div>
      {modelStatus && modelStatus.state !== 'ready' && (
        <div className="voice-model-panel" onClick={(event) => event.stopPropagation()}>
          <span>
            {modelStatus.state === 'downloading'
              ? `离线模型正在下载 ${Math.round(modelStatus.progress * 100)}%`
              : modelStatus.state === 'unsupported'
                ? '当前系统暂不支持语音转文字'
                : '请先在设置中准备离线语音模型'}
          </span>
          <button type="button" onClick={handleOpenVoiceSettings}>
            前往设置
          </button>
        </div>
      )}
      {transcribing && <div className="voice-transcript-status">正在识别...</div>}
      {transcript && <div className="voice-transcript">{transcript}</div>}
      {transcriptError && <div className="voice-transcript-error">{transcriptError}</div>}
    </div>
  )
}
