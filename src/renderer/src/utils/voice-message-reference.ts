import type { Message } from '../../../shared/types'
import type {
  VoiceMessageReference,
  VoiceModelStatus,
  VoiceRecognitionResult,
  VoiceTranscriptSnapshot
} from '../../../shared/voice-recognition'

export interface VoiceTranscriptionProgress {
  processed: number
  total: number
  succeeded: number
  failed: number
}

interface VoiceTranscriptionDependencies {
  getModelStatus: () => Promise<VoiceModelStatus>
  getCachedTranscript?: (reference: VoiceMessageReference) => Promise<VoiceTranscriptSnapshot>
  recognize: (reference: VoiceMessageReference) => Promise<VoiceRecognitionResult>
  onProgress: (progress: VoiceTranscriptionProgress) => void
}

export function toVoiceMessageReference(message: Message): VoiceMessageReference | null {
  if (
    (message.type !== '语音' && message.contentData?.type !== 'voice') ||
    !message.sessionId ||
    message.localId === undefined ||
    !message.createTime
  ) {
    return null
  }
  return {
    sessionId: message.sessionId,
    localId: message.localId,
    createTime: message.createTime,
    svrId: message.serverId
  }
}

export async function transcribeVoiceMessages(
  messages: Message[],
  dependencies: VoiceTranscriptionDependencies
): Promise<Message[]> {
  const voiceItems = messages
    .map((message, index) => ({ message, index, reference: toVoiceMessageReference(message) }))
    .filter((item) => item.message.type === '语音' || item.message.contentData?.type === 'voice')
  if (!voiceItems.length) return messages

  const progress: VoiceTranscriptionProgress = {
    processed: 0,
    total: voiceItems.length,
    succeeded: 0,
    failed: 0
  }
  dependencies.onProgress({ ...progress })

  const result = messages.map((message) => ({ ...message }))
  const pendingItems: typeof voiceItems = []
  for (const item of voiceItems) {
    if (!result[item.index].contentData) {
      result[item.index].contentData = { type: 'voice' }
    }
    const cachedTranscript = item.message.voiceTranscript?.trim()
    if (cachedTranscript) {
      result[item.index].voiceTranscript = cachedTranscript
      progress.succeeded += 1
    } else if (!item.reference) {
      result[item.index].voiceTranscriptError = '语音标识不完整，无法定位本地语音'
      progress.failed += 1
    } else {
      const snapshot = await dependencies.getCachedTranscript?.(item.reference)
      if (snapshot?.state === 'transcribed' && snapshot.transcript?.trim()) {
        result[item.index].voiceTranscript = snapshot.transcript.trim()
        result[item.index].voiceTranscriptError = undefined
        progress.succeeded += 1
      } else {
        pendingItems.push(item)
        continue
      }
    }
    progress.processed += 1
    dependencies.onProgress({ ...progress })
  }

  if (pendingItems.length) {
    const modelStatus = await dependencies.getModelStatus()
    if (modelStatus.state !== 'ready') {
      throw new Error('请先在设置中准备离线语音识别模型，再生成包含语音转写的日报')
    }
  }

  for (const item of pendingItems) {
    const recognition = await dependencies.recognize(item.reference!)
    const transcript = recognition.transcript?.trim()
    if (recognition.success && transcript) {
      result[item.index].voiceTranscript = transcript
      result[item.index].voiceTranscriptError = undefined
      progress.succeeded += 1
    } else {
      result[item.index].voiceTranscriptError = recognition.error || '语音转写失败'
      progress.failed += 1
    }
    dependencies.onProgress({ ...progress, processed: progress.processed + 1 })
    progress.processed += 1
  }
  return result
}
