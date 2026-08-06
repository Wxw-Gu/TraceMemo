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
