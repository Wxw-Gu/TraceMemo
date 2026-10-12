import { createHash } from 'crypto'
import type { VoiceMessageReference } from '../../shared/voice-recognition'

/**
 * Stable, account-local identity for a source voice message. This is separate
 * from scheduler keys and is shared by every transcription entry point.
 */
export function voiceMessageIdentity(reference: VoiceMessageReference): string {
  return createHash('sha256')
    .update(
      `${reference.sessionId}|${reference.localId}|${reference.createTime}|${reference.svrId ?? ''}`
    )
    .digest('hex')
}

export function voiceAccountIdentity(accountRoot: string): string {
  return createHash('sha256')
    .update(
      accountRoot
        .trim()
        .replace(/[\\/]+$/, '')
        .toLowerCase()
    )
    .digest('hex')
}

/**
 * 从一条已格式化的消息里取出语音定位信息；不是语音或标识不完整时返回 undefined。
 * 本地 API 用它判断"这条消息能否转写"，与批量转写的口径一致。
 */
export function voiceMessageReferenceOf(message: {
  type?: string
  sessionId?: string
  localId?: number
  createTime?: number
  serverId?: string
}): VoiceMessageReference | undefined {
  if (
    message.type !== '语音' ||
    !message.sessionId ||
    message.localId === undefined ||
    !message.createTime
  ) {
    return undefined
  }
  return {
    sessionId: message.sessionId,
    localId: message.localId,
    createTime: message.createTime,
    svrId: message.serverId
  }
}
