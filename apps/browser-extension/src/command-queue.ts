/** Serializes CDP operations without letting polling reject user actions. */
export class CommandQueue {
  private tail: Promise<unknown> = Promise.resolve()
  private pending = 0
  private generation = 0

  constructor(private readonly limit = 32) {}

  /** Stop/transport loss invalidates both waiting work and in-flight checkpoints. */
  cancel(): void {
    this.generation++
  }

  async run<T>(operation: (check: () => void) => Promise<T>): Promise<T> {
    if (this.pending >= this.limit) {
      throw Object.assign(new Error('Browser command queue is full.'), { code: 'backend_error' })
    }
    const generation = this.generation
    const check = () => {
      if (generation !== this.generation) {
        throw Object.assign(new Error('The task ended before this browser operation completed.'), { code: 'stopped' })
      }
    }
    this.pending++
    const result = this.tail.then(() => {
      check()
      return operation(check)
    })
    this.tail = result.catch(() => undefined)
    try {
      return await result
    } finally {
      this.pending--
    }
  }
}
