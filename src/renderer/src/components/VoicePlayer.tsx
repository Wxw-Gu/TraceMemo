import { useState, useRef, useEffect, useCallback } from 'react'
import type { JSX } from 'react'

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
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const objectUrlRef = useRef<string | null>(null)

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

  const formatDuration = (seconds: number | undefined): string => {
    if (!seconds || !isFinite(seconds)) return '0:00'
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  if (loading) {
    return (
      <div className="voice-message voice-loading">
        <span className="voice-icon">▶</span>
        <span className="voice-loading-text">加载中...</span>
      </div>
    )
  }

  if (error && !audioUrl) {
    return (
      <div className="voice-message voice-error" onClick={handlePlayPause}>
        <span className="voice-icon">▶</span>
        <span className="voice-error-text">当前版本暂不支持播放</span>
      </div>
    )
  }

  return (
    <div className="voice-message" onClick={handlePlayPause}>
      <span className={`voice-icon ${isPlaying ? 'playing' : ''}`}>{isPlaying ? '⏸' : '▶'}</span>
      <div className="voice-bars" aria-hidden="true">
        <i></i>
        <i></i>
        <i></i>
      </div>
      <span className="voice-duration">{formatDuration(audioDuration)}</span>
    </div>
  )
}
