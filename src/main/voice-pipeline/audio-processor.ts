import type { AudioProcessor, PipelineAudio } from './types'

export const VOICE_PROCESSOR_VERSION = 'pcm16-mono-16k-v1'

export interface PcmProcessorOptions {
  targetSampleRate?: number
  silenceThreshold?: number
  silencePaddingMs?: number
  normalizePeak?: number
}

export class PcmAudioProcessor implements AudioProcessor {
  readonly version = VOICE_PROCESSOR_VERSION
  private readonly targetSampleRate: number
  private readonly silenceThreshold: number
  private readonly silencePaddingMs: number
  private readonly normalizePeak: number

  constructor(options: PcmProcessorOptions = {}) {
    this.targetSampleRate = options.targetSampleRate ?? 16000
    this.silenceThreshold = options.silenceThreshold ?? 0.008
    this.silencePaddingMs = options.silencePaddingMs ?? 80
    this.normalizePeak = options.normalizePeak ?? 0.92
  }

  process(input: {
    pcm: Buffer
    sampleRate: number
    channels: number
    sourceHash: string
  }): PipelineAudio {
    if (input.channels !== 1) throw new Error('Only mono PCM is supported')
    if (input.pcm.length < 2) throw new Error('PCM audio is empty')

    const decoded = this.decodePcm16(input.pcm)
    const trimmed = this.trimSilence(decoded, input.sampleRate)
    const resampled = this.resample(trimmed, input.sampleRate, this.targetSampleRate)
    const normalized = this.normalize(resampled)

    return {
      samples: normalized,
      sampleRate: this.targetSampleRate,
      channels: 1,
      sourceHash: input.sourceHash,
      processorVersion: VOICE_PROCESSOR_VERSION,
      durationMs: Math.round((normalized.length / this.targetSampleRate) * 1000)
    }
  }

  private decodePcm16(buffer: Buffer): Float32Array {
    const output = new Float32Array(Math.floor(buffer.length / 2))
    for (let index = 0; index < output.length; index += 1) {
      output[index] = buffer.readInt16LE(index * 2) / 32768
    }
    return output
  }

  private trimSilence(samples: Float32Array, sampleRate: number): Float32Array {
    let first = 0
    while (first < samples.length && Math.abs(samples[first]) < this.silenceThreshold) first += 1
    if (first === samples.length) return new Float32Array(0)

    let last = samples.length - 1
    while (last > first && Math.abs(samples[last]) < this.silenceThreshold) last -= 1
    const padding = Math.round((sampleRate * this.silencePaddingMs) / 1000)
    return samples.slice(Math.max(0, first - padding), Math.min(samples.length, last + padding + 1))
  }

  private resample(samples: Float32Array, sourceRate: number, targetRate: number): Float32Array {
    if (sourceRate === targetRate || samples.length === 0) return samples.slice()
    const outputLength = Math.max(1, Math.round((samples.length * targetRate) / sourceRate))
    const output = new Float32Array(outputLength)
    const ratio = sourceRate / targetRate
    for (let index = 0; index < outputLength; index += 1) {
      const position = index * ratio
      const left = Math.min(samples.length - 1, Math.floor(position))
      const right = Math.min(samples.length - 1, left + 1)
      const fraction = position - left
      output[index] = samples[left] + (samples[right] - samples[left]) * fraction
    }
    return output
  }

  private normalize(samples: Float32Array): Float32Array {
    let peak = 0
    for (const sample of samples) peak = Math.max(peak, Math.abs(sample))
    if (peak < 0.001 || peak <= this.normalizePeak) return samples
    const scale = this.normalizePeak / peak
    return samples.map((sample) => sample * scale)
  }
}
