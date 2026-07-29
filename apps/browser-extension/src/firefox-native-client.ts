/** Request/response transport to the Use Brian desktop native host. */
const HOST_NAME = 'ai.usebrian.browser'

type NativeResponse = {
  id: string | null
  ok: boolean
  data?: unknown
  error?: string
  code?: string
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

export class FirefoxNativeError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'FirefoxNativeError'
  }
}

export class FirefoxNativeClient {
  private port: chrome.runtime.Port | null = null
  private counter = 0
  private pending = new Map<string, Pending>()
  private generation = 0

  connectionGeneration(): number {
    return this.generation
  }

  private connect(): chrome.runtime.Port {
    if (this.port) return this.port
    const port = chrome.runtime.connectNative(HOST_NAME)
    this.port = port
    this.generation += 1
    port.onMessage.addListener((message: unknown) => {
      const response = message as Partial<NativeResponse>
      if (typeof response.id !== 'string') return
      const pending = this.pending.get(response.id)
      if (!pending) return
      this.pending.delete(response.id)
      if (response.ok) pending.resolve(response.data)
      else pending.reject(new FirefoxNativeError(response.error ?? 'Firefox companion failed.', response.code ?? 'backend_error'))
    })
    port.onDisconnect.addListener(() => {
      const message = chrome.runtime.lastError?.message ?? 'Use Brian desktop companion disconnected.'
      this.port = null
      for (const pending of this.pending.values()) {
        pending.reject(new FirefoxNativeError(message, 'firefox_companion_missing'))
      }
      this.pending.clear()
    })
    return port
  }

  request(type: 'status' | 'bind' | 'execute' | 'stop' | 'openDesktop', payload: Record<string, unknown> = {}): Promise<unknown> {
    const id = `fx-${Date.now()}-${++this.counter}`
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.connect().postMessage({ id, type, ...payload })
      } catch (error) {
        this.pending.delete(id)
        reject(new FirefoxNativeError(error instanceof Error ? error.message : String(error), 'firefox_companion_missing'))
      }
    })
  }

  async status(): Promise<{ ready: boolean; reason?: string }> {
    try {
      return (await this.request('status')) as { ready: boolean; reason?: string }
    } catch (error) {
      return {
        ready: false,
        reason: error instanceof FirefoxNativeError ? error.code : 'firefox_companion_missing',
      }
    }
  }
}
