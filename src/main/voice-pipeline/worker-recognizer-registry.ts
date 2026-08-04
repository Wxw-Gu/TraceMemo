export interface WorkerRecognizerInput {
  samples: Float32Array
  sampleRate: number
  modelPath: string
  tokensPath: string
  modelFingerprint: string
}

export interface WorkerRecognizerEngine {
  readonly id: string
  recognize(input: WorkerRecognizerInput): Promise<{ transcript: string; language?: string }>
}

export class WorkerRecognizerRegistry {
  private readonly engines = new Map<string, WorkerRecognizerEngine>()

  register(engine: WorkerRecognizerEngine): this {
    if (this.engines.has(engine.id))
      throw new Error(`Worker recognizer already registered: ${engine.id}`)
    this.engines.set(engine.id, engine)
    return this
  }

  get(id: string): WorkerRecognizerEngine {
    const engine = this.engines.get(id)
    if (!engine) throw new Error(`Worker recognizer is not registered: ${id}`)
    return engine
  }
}
