export const VOICE_SAMPLE_RATE = 16_000
export const VOICE_CHANNELS = 1
export const VOICE_SAMPLE_BYTES = 2
export const VOICE_FRAME_MS = 20
export const VOICE_MIN_PCM_BYTES =
  (VOICE_SAMPLE_RATE * VOICE_CHANNELS * VOICE_SAMPLE_BYTES * VOICE_FRAME_MS) / 1000
export const VOICE_FRAME_BYTES = VOICE_MIN_PCM_BYTES

export interface VoicePcmMetadata {
  pcmSize: number
  sampleRate: number
  channels: number
  durationMs: number
}

export interface VoiceSilkMetadata {
  silkSize: number
  durationMs: number
}

/**
 * Validate the exact PCM contract consumed by the bundled OneBot encoder.
 * The Go Silk encoder emits a header-only payload for sub-frame input, which
 * is accepted by the old path but produces an unplayable WeChat voice.
 */
export function validateVoicePcm(
  pcm: Uint8Array,
  sampleRate = VOICE_SAMPLE_RATE,
  channels = VOICE_CHANNELS
): VoicePcmMetadata {
  if (sampleRate !== VOICE_SAMPLE_RATE || channels !== VOICE_CHANNELS) {
    throw new Error('语音 PCM 必须是 16kHz 单声道')
  }
  if (pcm.byteLength === 0) throw new Error('语音 PCM 为空')
  if (pcm.byteLength % VOICE_SAMPLE_BYTES !== 0) throw new Error('语音 PCM 长度无效')
  if (pcm.byteLength < VOICE_MIN_PCM_BYTES) {
    throw new Error('语音时长过短，至少需要 20 毫秒')
  }
  const durationMs = Math.floor(
    (pcm.byteLength * 1000) / (sampleRate * channels * VOICE_SAMPLE_BYTES)
  )
  if (durationMs <= 0) throw new Error('语音时长无效')
  return { pcmSize: pcm.byteLength, sampleRate, channels, durationMs }
}

export function validateVoiceSilk(
  silk: Uint8Array,
  durationMs: number,
  silkHeader = '\x02#!SILK_V3'
): VoiceSilkMetadata {
  const header = new TextEncoder().encode(silkHeader)
  if (silk.byteLength <= header.byteLength) throw new Error('Silk 音频为空或只有文件头')
  for (let index = 0; index < header.length; index += 1) {
    if (silk[index] !== header[index]) throw new Error('Silk 音频头无效')
  }
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('Silk 时长无效')
  return { silkSize: silk.byteLength, durationMs: Math.floor(durationMs) }
}

export function validateVoiceSilkMetadata(silkSize: number, durationMs: number): VoiceSilkMetadata {
  if (!Number.isInteger(silkSize) || silkSize <= 10) {
    throw new Error('Silk 音频为空或只有文件头')
  }
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('Silk 时长无效')
  return { silkSize, durationMs: Math.floor(durationMs) }
}
