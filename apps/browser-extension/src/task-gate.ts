/**
 * Per-task consent, tab-scope enforcement, and persistent Stop.
 *
 * The server supplies the Browser profile's control mode on every command.
 * The extension keeps raw Chrome tab ids private and exposes only task-local
 * opaque handles to the model-facing tool surface.
 */
import { RESTRICTED_TAB_MESSAGE } from './tab-eligibility.js'
import type { LocalControlMode } from './protocol.js'

export const CONSENT_IDLE_RESET_MS = 10 * 60 * 1000
export const CONSENT_PROMPT_TIMEOUT_MS = 60_000
export const MAX_TASK_CREATED_TABS = 8

type ConsentDenialReason = 'denied' | 'restricted_url' | 'no_active_tab'

export type ConsentOutcome =
  | { allowed: true; tabId: number }
  | { allowed: false; reason: ConsentDenialReason }

export type ConsentPrompter = () => Promise<ConsentOutcome>

type TabOrigin = 'approved' | 'created' | 'full'
type TabEntry = { handle: string; tabId: number; origin: TabOrigin }

const DENIAL_ERRORS: Record<ConsentDenialReason, { code: string; message: string }> = {
  denied: {
    code: 'consent_denied',
    message: 'The user declined to let Use Brian act in this tab.',
  },
  restricted_url: { code: 'no_eligible_tab', message: RESTRICTED_TAB_MESSAGE },
  no_active_tab: {
    code: 'no_eligible_tab',
    message:
      'No web page is open in the browser. Ask the user to open the site they want Use Brian to work on, then try again.',
  },
}

function tabScopeError(): Error {
  return Object.assign(new Error('That tab is outside this browser profile\'s allowed task scope.'), {
    code: 'tab_not_allowed',
  })
}

export class TaskGate {
  private readonly tabs = new Map<string, TabEntry>()
  private readonly handleByTab = new Map<number, string>()
  private activeHandle: string | null = null
  private nextHandle = 1
  private mode: LocalControlMode = 'task_tabs'
  private stopped = false
  private stopGeneration = 0
  private lastCommandAt = 0
  private promptInFlight: Promise<ConsentOutcome> | null = null
  private promptStopGeneration = 0
  private readonly prompt: ConsentPrompter
  private readonly now: () => number

  constructor(opts: { prompt: ConsentPrompter; now?: () => number }) {
    this.prompt = opts.prompt
    this.now = opts.now ?? Date.now
  }

  /** Resolve the currently selected tab, prompting once when consent is stale. */
  async requireTab(mode: LocalControlMode = 'task_tabs'): Promise<number> {
    this.setMode(mode)
    const now = this.now()
    const current = this.currentEntry()
    if (!this.stopped && current && now - this.lastCommandAt <= CONSENT_IDLE_RESET_MS) {
      this.lastCommandAt = now
      return current.tabId
    }

    // Keep task-created tabs registered for later Stop cleanup. They are not
    // usable while no tab is selected; a fresh Allow reactivates the task.
    this.clearAuthorization(true)
    if (!this.promptInFlight) {
      this.promptStopGeneration = this.stopGeneration
      this.promptInFlight = this.prompt().finally(() => {
        this.promptInFlight = null
      })
    }
    const stopGeneration = this.promptStopGeneration
    const outcome = await this.promptInFlight
    if (!outcome.allowed) {
      const { code, message } = DENIAL_ERRORS[outcome.reason]
      throw Object.assign(new Error(message), { code })
    }
    if (this.stopGeneration !== stopGeneration) {
      throw Object.assign(new Error('The task stopped while browser permission was pending.'), {
        code: 'stopped',
      })
    }
    this.stopped = false
    const existing = this.entryForTab(outcome.tabId)
    if (existing) this.activeHandle = existing.handle
    else this.register(outcome.tabId, 'approved', true)
    this.lastCommandAt = this.now()
    return outcome.tabId
  }

  /** Apply a newly resolved server policy. Narrowing immediately drops full-scope tabs. */
  setMode(mode: LocalControlMode): void {
    this.mode = mode
    if (mode === 'full_browser') return
    for (const entry of [...this.tabs.values()]) {
      if (entry.origin === 'full') this.removeEntry(entry)
    }
    if (!this.currentEntry()) {
      this.activeHandle = this.firstAllowedHandle()
    }
  }

  registerCreatedTab(tabId: number, makeActive = true): string {
    const existing = this.entryForTab(tabId)
    if (existing) {
      if (makeActive) this.activeHandle = existing.handle
      return existing.handle
    }
    if (this.createdTabIds().length >= MAX_TASK_CREATED_TABS) {
      throw Object.assign(
        new Error(`A task may open at most ${MAX_TASK_CREATED_TABS} browser tabs.`),
        { code: 'tab_limit' },
      )
    }
    return this.register(tabId, 'created', makeActive).handle
  }

  /** Register an eligible pre-existing tab found while full-profile mode is active. */
  registerFullTab(tabId: number): string {
    const existing = this.entryForTab(tabId)
    if (existing) return existing.handle
    if (this.mode !== 'full_browser') throw tabScopeError()
    return this.register(tabId, 'full', false).handle
  }

  selectHandle(handle: string, mode: LocalControlMode = this.mode): number {
    this.setMode(mode)
    const entry = this.tabs.get(handle)
    if (!entry || (mode === 'task_tabs' && entry.origin === 'full')) throw tabScopeError()
    this.activeHandle = handle
    this.lastCommandAt = this.now()
    return entry.tabId
  }

  handleForTab(tabId: number): string | null {
    return this.handleByTab.get(tabId) ?? null
  }

  entries(mode: LocalControlMode = this.mode): ReadonlyArray<TabEntry> {
    this.setMode(mode)
    return [...this.tabs.values()].filter((entry) => mode === 'full_browser' || entry.origin !== 'full')
  }

  isAuthorizedTab(tabId: number): boolean {
    return !this.stopped && this.activeHandle != null && this.handleByTab.has(tabId)
  }

  isTaskOwnedTab(tabId: number): boolean {
    const entry = this.entryForTab(tabId)
    return Boolean(entry && entry.origin !== 'full')
  }

  canOpenTaskTab(): boolean {
    return this.createdTabIds().length < MAX_TASK_CREATED_TABS
  }

  /** Drop consent without latching Stop, so the next command asks again. */
  revokeConsent(): void {
    this.clearAuthorization(true)
    this.lastCommandAt = 0
  }

  /** Persistent Stop. Returns only task-created tabs for caller-side cleanup. */
  stop(): number[] {
    const created = this.createdTabIds()
    this.stopGeneration += 1
    this.stopped = true
    this.clearAuthorization(false)
    return created
  }

  /** Tab housekeeping. Returns true when the closed tab was selected. */
  onTabRemoved(tabId: number): boolean {
    const entry = this.entryForTab(tabId)
    if (!entry) return false
    const wasCurrent = this.activeHandle === entry.handle
    this.removeEntry(entry)
    if (wasCurrent) this.activeHandle = this.firstAllowedHandle()
    return wasCurrent
  }

  currentTab(): number | null {
    return this.currentEntry()?.tabId ?? null
  }

  currentHandle(): string | null {
    return this.currentEntry()?.handle ?? null
  }

  isStopped(): boolean {
    return this.stopped
  }

  private register(tabId: number, origin: TabOrigin, makeActive: boolean): TabEntry {
    const entry = { handle: `tab-${this.nextHandle++}`, tabId, origin }
    this.tabs.set(entry.handle, entry)
    this.handleByTab.set(tabId, entry.handle)
    if (makeActive) this.activeHandle = entry.handle
    return entry
  }

  private entryForTab(tabId: number): TabEntry | null {
    const handle = this.handleByTab.get(tabId)
    return handle ? this.tabs.get(handle) ?? null : null
  }

  private currentEntry(): TabEntry | null {
    return this.activeHandle ? this.tabs.get(this.activeHandle) ?? null : null
  }

  private firstAllowedHandle(): string | null {
    for (const entry of this.tabs.values()) {
      if (this.mode === 'full_browser' || entry.origin !== 'full') return entry.handle
    }
    return null
  }

  private createdTabIds(): number[] {
    return [...this.tabs.values()]
      .filter((entry) => entry.origin === 'created')
      .map((entry) => entry.tabId)
  }

  private removeEntry(entry: TabEntry): void {
    this.tabs.delete(entry.handle)
    this.handleByTab.delete(entry.tabId)
    if (this.activeHandle === entry.handle) this.activeHandle = null
  }

  private clearAuthorization(preserveCreated: boolean): void {
    if (preserveCreated) {
      for (const entry of [...this.tabs.values()]) {
        if (entry.origin !== 'created') this.removeEntry(entry)
      }
    } else {
      this.tabs.clear()
      this.handleByTab.clear()
    }
    this.activeHandle = null
  }
}
