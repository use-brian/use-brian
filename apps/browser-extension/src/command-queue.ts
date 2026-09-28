/** One bounded lane for browser commands and protected cleanup/recovery. */
export class CommandQueue {
  private waiting: Array<{ start: () => Promise<void>; cancel: () => void }> = []
  private active = false
  private generation = 0

  constructor(private readonly limit = 32) {}

  /** Reject waiting work immediately, but retain the active serialization barrier.
   * In-flight work must reach a checkpoint before it can observe cancellation.
   */
  cancel(): void {
    this.generation++
    for (const entry of this.waiting.splice(0)) entry.cancel()
  }

  run<T>(operation: (check: () => void) => Promise<T>): Promise<T> {
    if (this.waiting.length + Number(this.active) >= this.limit) {
      return Promise.reject(Object.assign(new Error('Browser command queue is full.'), { code: 'backend_error' }))
    }
    const generation = this.generation
    const stopped = () => Object.assign(new Error('The task ended before this browser operation completed.'), { code: 'stopped' })
    const check = () => {
      if (generation !== this.generation) throw stopped()
    }
    return new Promise<T>((resolve, reject) => {
      this.waiting.push({
        cancel: () => reject(stopped()),
        start: async () => {
          try {
            check()
            resolve(await operation(check))
          } catch (error) {
            reject(error)
          } finally {
            this.active = false
            this.drain()
          }
        },
      })
      this.drain()
    })
  }

  private drain(): void {
    if (this.active) return
    const entry = this.waiting.shift()
    if (!entry) return
    this.active = true
    void Promise.resolve().then(entry.start)
  }
}
