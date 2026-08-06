type ScheduledTask<T> = {
  key: string
  priority: number
  run: (signal: AbortSignal) => Promise<T>
  controller: AbortController
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

export class VoiceTaskScheduler {
  private readonly queue: ScheduledTask<unknown>[] = []
  private active: ScheduledTask<unknown> | null = null

  schedule<T>(
    key: string,
    run: (signal: AbortSignal) => Promise<T>,
    options?: { priority?: 'interactive' | 'background' }
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // A batch task is deliberately interruptible. The caller can resume its
      // next item after cancellation, while an explicit chat-bubble request
      // never waits behind a long background transcription.
      if (options?.priority !== 'background' && this.active?.priority === 0) {
        this.active.controller.abort()
      }
      this.queue.push({
        key,
        priority: options?.priority === 'background' ? 0 : 1,
        run,
        controller: new AbortController(),
        resolve: resolve as (value: unknown) => void,
        reject
      })
      this.queue.sort((left, right) => right.priority - left.priority)
      this.pump()
    })
  }

  cancel(key: string): boolean {
    if (this.active?.key === key) {
      this.active.controller.abort()
      return true
    }
    const index = this.queue.findIndex((task) => task.key === key)
    if (index < 0) return false
    const [task] = this.queue.splice(index, 1)
    task.controller.abort()
    task.reject(new DOMException('Recognition cancelled', 'AbortError'))
    return true
  }

  cancelAll(): void {
    this.active?.controller.abort()
    while (this.queue.length) {
      const task = this.queue.shift()
      task?.controller.abort()
      task?.reject(new DOMException('Recognition cancelled', 'AbortError'))
    }
  }

  private pump(): void {
    if (this.active || this.queue.length === 0) return
    const task = this.queue.shift()
    if (!task) return
    this.active = task
    void task
      .run(task.controller.signal)
      .then(task.resolve, task.reject)
      .finally(() => {
        this.active = null
        this.pump()
      })
  }
}
