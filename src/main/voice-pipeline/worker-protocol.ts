export const VOICE_WORKER_PROTOCOL_VERSION = 1

export interface WorkerRecognitionRequest {
  version: typeof VOICE_WORKER_PROTOCOL_VERSION
  type: 'recognize'
  requestId: string
  payload: {
    recognizerId: string
    samples: Float32Array
    sampleRate: number
    modelPath: string
    tokensPath: string
    modelFingerprint: string
  }
}

export type WorkerRecognitionResponse =
  | {
      version: typeof VOICE_WORKER_PROTOCOL_VERSION
      type: 'result'
      requestId: string
      transcript: string
      language?: string
    }
  | {
      version: typeof VOICE_WORKER_PROTOCOL_VERSION
      type: 'error'
      requestId: string
      error: string
    }
