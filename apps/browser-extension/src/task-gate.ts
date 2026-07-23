/**
 * Per-task consent + stop state (P1.7): the extension acts only in a tab the
 * user explicitly allowed for the current task, and a persistent Stop kills
 * everything in flight. Consent expires after inactivity so a forgotten
 * pairing can't act days later without a fresh allow.
 */

export const CONSENT_IDLE_RESET_MS = 10 * 60 * 1000
export const CONSENT_PROMPT_TIMEOUT_MS = 60_000

/**
 * Why a prompt did not yield a tab. `denied` is a human decision; the other two
 * are structural — Chrome will not attach the debugger, so no prompt was ever
 * shown. Collapsing them into one code told users they had declined something
 * they were never asked, and pointed the model at the wrong remedy.
 */
type ConsentDenialReason = 'denied' | 'restricted_url' | 'no_active_tab'

/**
 * A union rather than `{ allowed, tabId }` so "allowed but no tab" cannot be
 * expressed — the old shape needed a runtime guard against exactly that.
 */
export type ConsentOutcome =
  | { allowed: true; tabId: number }
  | { allowed: false; reason: ConsentDenialReason }

export type ConsentPrompter = () => Promise<ConsentOutcome>

const DENIAL_ERRORS: Record<ConsentDenialReason, { code: string; message: string }> = {
  denied: {
    code: 'consent_denied',
    message: 'The user declined to let Use Brian act in this tab.',
  },
  restricted_url: {
    code: 'no_eligible_tab',
    message:
      'Use Brian cannot act on a browser settings or extension page. Ask the user to switch to the website they want it to work on, then try again.',
  },
  no_active_tab: {
    code: 'no_eligible_tab',
    message:
      'No web page is open in the browser. Ask the user to open the site they want Use Brian to work on, then try again.',
  },
}

export class TaskGate {
  private allowedTabId: number | null = null
  private stopped = false
  private lastCommandAt = 0
  private promptInFlight: Promise<ConsentOutcome> | null = null
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
    const now = this.now()
    // A live Stop suppresses the consent fast path but does NOT short-circuit
    // the prompt. Throwing here instead made `stopped = false` below
    // unreachable, so one click of Stop bricked the extension until it was
    // reloaded — the popup neither showed the state nor offered a way out,
    // and the relay keepalive stops the service worker from recycling and
    // clearing it by accident. Releasing the kill switch takes a fresh human
    // Allow: the model can never walk through a Stop, and the human is never
    // stranded behind one.
    if (
      !this.stopped &&
      this.allowedTabId != null &&
      now - this.lastCommandAt <= CONSENT_IDLE_RESET_MS
    ) {
      this.lastCommandAt = now
      return this.allowedTabId
    }
    this.allowedTabId = null
    this.promptInFlight ??= this.prompt().finally(() => {
      this.promptInFlight = null
    })
    const outcome = await this.promptInFlight
    if (!outcome.allowed) {
      // Only a human Allow clears `stopped`. A structural failure leaves the
      // latch exactly as it found it, so the kill switch cannot come undone by
      // landing on the wrong kind of page.
      const { code, message } = DENIAL_ERRORS[outcome.reason]
      throw Object.assign(new Error(message), { code })
    }
    this.stopped = false
    this.allowedTabId = outcome.tabId
    this.lastCommandAt = this.now()
    return outcome.tabId
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
