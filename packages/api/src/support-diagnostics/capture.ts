import type {
  PendingSupportDiagnosticEvent,
  SupportDiagnosticCapture,
  SupportDiagnosticLevel,
  SupportDiagnosticsStore,
} from './types.js'
import { sanitizeDiagnosticArgs } from './sanitize.js'

type QueuedEvent = {
  captureId: string
  event: PendingSupportDiagnosticEvent
}

const FLUSH_INTERVAL_MS = 1_000
const MAX_QUEUE_LENGTH = 1_000

export class SupportDiagnosticsCaptureManager {
  private active: SupportDiagnosticCapture | null = null
  private queue: QueuedEvent[] = []
  private flushTimer: NodeJS.Timeout | null = null
  private expiryTimer: NodeJS.Timeout | null = null
  private flushing: Promise<void> | null = null
  private installed = false

  private readonly originals = {
    debug: console.debug,
    log: console.log,
    warn: console.warn,
    error: console.error,
  }

  constructor(private readonly store: SupportDiagnosticsStore) {}

  async start(): Promise<void> {
    if (this.installed) return
    this.active = await this.store.getAnyActive()
    this.installConsoleMirror()
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS)
    this.flushTimer.unref()
    this.expiryTimer = setInterval(() => void this.expireCaptures(), 30_000)
    this.expiryTimer.unref()
  }

  activate(capture: SupportDiagnosticCapture): void {
    this.active = capture
  }

  getActiveCapture(): SupportDiagnosticCapture | null {
    if (this.active && this.active.expiresAt.getTime() <= Date.now()) {
      this.active = null
    }
    return this.active
  }

  async deactivate(captureId: string): Promise<void> {
    await this.flush()
    if (this.active?.id === captureId) this.active = null
    this.queue = this.queue.filter((item) => item.captureId !== captureId)
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing
    if (this.queue.length === 0) return
    const queued = this.queue
    this.queue = []
    this.flushing = (async () => {
      const byCapture = new Map<string, PendingSupportDiagnosticEvent[]>()
      for (const item of queued) {
        const batch = byCapture.get(item.captureId) ?? []
        batch.push(item.event)
        byCapture.set(item.captureId, batch)
      }
      for (const [captureId, events] of byCapture) {
        try {
          await this.store.appendEvents(captureId, events)
        } catch (error) {
          this.originals.error('[support-diagnostics] failed to persist sanitized events:', error)
        }
      }
    })().finally(() => {
      this.flushing = null
    })
    return this.flushing
  }

  async stop(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer)
    if (this.expiryTimer) clearInterval(this.expiryTimer)
    this.flushTimer = null
    this.expiryTimer = null
    await this.flush()
    this.restoreConsole()
    this.active = null
  }

  private installConsoleMirror(): void {
    if (this.installed) return
    const wrap = (level: SupportDiagnosticLevel) => (...args: unknown[]) => {
      this.originals[level](...args)
      const capture = this.getActiveCapture()
      if (!capture) return
      const sanitized = sanitizeDiagnosticArgs(args, capture.pseudonymSalt)
      this.queue.push({
        captureId: capture.id,
        event: { level, ...sanitized, createdAt: new Date() },
      })
      if (this.queue.length > MAX_QUEUE_LENGTH) {
        this.queue.splice(0, this.queue.length - MAX_QUEUE_LENGTH)
      }
    }
    console.debug = wrap('debug')
    console.log = wrap('log')
    console.warn = wrap('warn')
    console.error = wrap('error')
    this.installed = true
  }

  private restoreConsole(): void {
    if (!this.installed) return
    console.debug = this.originals.debug
    console.log = this.originals.log
    console.warn = this.originals.warn
    console.error = this.originals.error
    this.installed = false
  }

  private async expireCaptures(): Promise<void> {
    const expiredIds = await this.store.deleteExpired()
    if (this.active && expiredIds.includes(this.active.id)) {
      this.queue = this.queue.filter((item) => item.captureId !== this.active?.id)
      this.active = null
    }
  }
}
