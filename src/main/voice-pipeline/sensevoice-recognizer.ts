import { createRequire } from 'module'
import type { WorkerRecognizerEngine, WorkerRecognizerInput } from './worker-recognizer-registry'

const nodeRequire = createRequire(import.meta.url)

interface OfflineRecognitionResult {
  text?: string
  lang?: string
}

interface OfflineStream {
  acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void
}

interface OfflineRecognizerInstance {
  createStream(): OfflineStream
  decodeAsync(stream: OfflineStream): Promise<OfflineRecognitionResult>
}

interface OfflineRecognizerConstructor {
  createAsync(config: Record<string, unknown>): Promise<OfflineRecognizerInstance>
}

export class SenseVoiceRecognizer implements WorkerRecognizerEngine {
  readonly id = 'sensevoice'
  private recognizer: OfflineRecognizerInstance | null = null
  private fingerprint = ''

  async recognize(
    input: WorkerRecognizerInput
  ): Promise<{ transcript: string; language?: string }> {
    if (!this.recognizer || this.fingerprint !== input.modelFingerprint) {
      const sherpa = nodeRequire('sherpa-onnx-node') as {
        OfflineRecognizer: OfflineRecognizerConstructor
      }
      this.recognizer = await sherpa.OfflineRecognizer.createAsync({
        featConfig: { sampleRate: input.sampleRate, featureDim: 80 },
        modelConfig: {
          senseVoice: {
            model: input.modelPath,
            language: 'auto',
            useInverseTextNormalization: 1
          },
          tokens: input.tokensPath,
          numThreads: Math.max(1, Math.min(4, Number(process.env.WXE_VOICE_THREADS) || 2)),
          provider: 'cpu',
          debug: 0
        }
      })
      this.fingerprint = input.modelFingerprint
    }

    const stream = this.recognizer.createStream()
    stream.acceptWaveform({ samples: input.samples, sampleRate: input.sampleRate })
    const result = await this.recognizer.decodeAsync(stream)
    return { transcript: String(result.text || '').trim(), language: result.lang || undefined }
  }
}
