/**
 * Per-task consent + stop state (P1.7): the extension acts only in a tab the
 * user explicitly allowed for the current task, and a persistent Stop kills
 * everything in flight. Consent expires after inactivity so a forgotten
 * pairing can't act days later without a fresh allow.
 */

export const CONSENT_IDLE_RESET_MS = 10 * 60 * 1000
export const CONSENT_PROMPT_TIMEOUT_MS = 60_000

export type ConsentPrompter = () => Promise<{ allowed: boolean; tabId: number | null }>

export class TaskGate {
  private allowedTabId: number | null = null
  private stopped = false
  private lastCommandAt = 0
  private promptInFlight: Promise<{ allowed: boolean; tabId: number | null }> | null = null
  private readonly prompt: ConsentPrompter
  private readonly now: () => number

  constructor(opts: { prompt: ConsentPrompter; now?: () => number }) {
    this.prompt = opts.prompt
    this.now = opts.now ?? Date.now
  }

  /**
   * Resolve the tab this command may act in. Prompts the user (once —
   * concurrent commands share the prompt) when no live consent exists.
   * Throws coded errors the command loop returns verbatim.
   */
  async requireTab(): Promise<number> {
    if (this.stopped) {
      throw Object.assign(new Error('The user stopped the task. Ask them before continuing.'), {
        code: 'stopped',
      })
    }
    const now = this.now()
    if (this.allowedTabId != null && now - this.lastCommandAt <= CONSENT_IDLE_RESET_MS) {
      this.lastCommandAt = now
      return this.allowedTabId
    }
    this.allowedTabId = null
    this.promptInFlight ??= this.prompt().finally(() => {
      this.promptInFlight = null
    })
    const { allowed, tabId } = await this.promptInFlight
    if (!allowed || tabId == null) {
      throw Object.assign(new Error('The user declined to let Use Brian act in this tab.'), {
        code: 'consent_denied',
      })
    }
    this.stopped = false
    this.allowedTabId = tabId
    this.lastCommandAt = this.now()
    return tabId
  }

  /**
   * Drop consent without latching Stop, so the next command asks again.
   *
   * For refusals that came from Chrome's own debugging banner rather than our
   * UI: honouring them means not silently re-attaching, but `stop()` would be
   * disproportionate — it has no resume path, so one stray click would kill
   * browsing for the rest of the session.
   */
  revokeConsent(): void {
    this.allowedTabId = null
    this.lastCommandAt = 0
  }

  /** The persistent Stop: latches until the user allows a new task. */
  stop(): void {
    this.stopped = true
    this.allowedTabId = null
  }

  /** Tab-closed housekeeping. Returns true when the closed tab was the controlled one. */
  onTabRemoved(tabId: number): boolean {
    if (this.allowedTabId === tabId) {
      this.allowedTabId = null
      return true
    }
    return false
  }

  currentTab(): number | null {
    return this.allowedTabId
  }

  isStopped(): boolean {
    return this.stopped
  }
}
