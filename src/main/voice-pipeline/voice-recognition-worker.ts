import { SenseVoiceRecognizer } from './sensevoice-recognizer'
import { WorkerRecognizerRegistry } from './worker-recognizer-registry'
import {
  VOICE_WORKER_PROTOCOL_VERSION,
  type WorkerRecognitionRequest,
  type WorkerRecognitionResponse
} from './worker-protocol'

const recognizers = new WorkerRecognizerRegistry().register(new SenseVoiceRecognizer())

function send(response: WorkerRecognitionResponse): void {
  if (process.send) process.send(response)
}

process.on('message', async (message: WorkerRecognitionRequest) => {
  if (
    message?.version !== VOICE_WORKER_PROTOCOL_VERSION ||
    message.type !== 'recognize' ||
    !message.requestId
  ) {
    return
  }

  try {
    const fakeTranscript = process.env.WXE_VOICE_RECOGNITION_FAKE_TEXT
    const result = fakeTranscript
      ? { transcript: fakeTranscript, language: 'zh' }
      : await recognizers.get(message.payload.recognizerId).recognize(message.payload)
    send({
      version: VOICE_WORKER_PROTOCOL_VERSION,
      type: 'result',
      requestId: message.requestId,
      ...result
    })
  } catch (error) {
    send({
      version: VOICE_WORKER_PROTOCOL_VERSION,
      type: 'error',
      requestId: message.requestId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
})
