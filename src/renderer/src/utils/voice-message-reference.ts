import type { Message } from '../../../shared/types'
import type {
  VoiceMessageReference,
  VoiceModelStatus,
  VoiceRecognitionResult
} from '../../../shared/voice-recognition'

export interface VoiceTranscriptionProgress {
  processed: number
  total: number
  succeeded: number
  failed: number
}

interface VoiceTranscriptionDependencies {
  getModelStatus: () => Promise<VoiceModelStatus>
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

  const hasPendingVoice = voiceItems.some(
    (item) => item.reference && !item.message.voiceTranscript?.trim()
  )
  if (hasPendingVoice) {
    const modelStatus = await dependencies.getModelStatus()
    if (modelStatus.state !== 'ready') {
      throw new Error('请先在设置中准备离线语音识别模型，再生成包含语音转写的日报')
    }
  }

  const result = messages.map((message) => ({ ...message }))
  for (const item of voiceItems) {
    const cachedTranscript = item.message.voiceTranscript?.trim()
    if (cachedTranscript) {
      result[item.index].voiceTranscript = cachedTranscript
      progress.succeeded += 1
    } else if (!item.reference) {
      result[item.index].voiceTranscriptError = '语音标识不完整，无法定位本地语音'
      progress.failed += 1
    } else {
      const recognition = await dependencies.recognize(item.reference)
      const transcript = recognition.transcript?.trim()
      if (recognition.success && transcript) {
        result[item.index].voiceTranscript = transcript
        result[item.index].voiceTranscriptError = undefined
        progress.succeeded += 1
      } else {
        result[item.index].voiceTranscriptError = recognition.error || '语音转写失败'
        progress.failed += 1
      }
    }
    progress.processed += 1
    dependencies.onProgress({ ...progress })
  }
  return result
}
