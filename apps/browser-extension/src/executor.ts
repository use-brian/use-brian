/**
 * CDP executor (P1.5/P1.6): implements the discrete browser ops against the
 * one user-allowed tab via chrome.debugger. Refs resolve against the LATEST
 * snapshot only — anything older returns `stale_ref` and the agent must
 * re-snapshot.
 */
import { buildSnapshot, type BuiltSnapshot, type CdpAXNode } from './snapshot.js'

export class ExecutorError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'ExecutorError'
  }
}

const NAVIGATE_TIMEOUT_MS = 20_000

/** What the user must do when Chrome takes the debugger away mid-task. */
const DETACHED_MESSAGE =
  'Chrome ended the debugging session for this tab, so the browser is no longer under control. ' +
  'This happens when the "Use Brian is debugging this browser" banner is dismissed, DevTools opens on the tab, or the page crashes. ' +
  'Retry the step: the user will be asked to allow the tab again. Do not assume the website blocked you.'

/**
 * True when Chrome is telling us the CDP session is gone. Chrome reports this
 * as a plain Error whose message is the only signal — there is no code on it,
 * which is why every one of these surfaced as `backend_error` in prod.
 */
export function isDetachedError(err: unknown): boolean {
  if (err instanceof ExecutorError) return err.code === 'detached'
  const message = err instanceof Error ? err.message : String(err)
  return /debugger is not attached|detached from the target/i.test(message)
}

/**
 * Whether an op may be replayed after a transparent re-attach.
 *
 * A detach can land *after* the input event was already delivered to the page,
 * so replaying `click`/`type` risks a double submit — on a registration form
 * that is a real, user-visible mistake. Read-only ops and `navigate` (which
 * lands on the same URL) are safe to redo.
 */
export function retryableAfterReattach(op: string): boolean {
  return op === 'snapshot' || op === 'currentUrl' || op === 'navigate'
}

async function sendCdp<T = unknown>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
  return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T
}

export class TabExecutor {
  private attachedTabId: number | null = null
  private lastSnapshot: BuiltSnapshot | null = null

  async attach(tabId: number): Promise<void> {
    if (this.attachedTabId === tabId) return
    await this.detach()
    await chrome.debugger.attach({ tabId }, '1.3')
    this.attachedTabId = tabId
    await this.cdp(tabId, 'Accessibility.enable')
  }

  async detach(): Promise<void> {
    const tabId = this.attachedTabId
    this.attachedTabId = null
    this.lastSnapshot = null
    if (tabId != null) {
      try {
        await chrome.debugger.detach({ tabId })
      } catch {
        // tab already gone
      }
    }
  }

  attachedTab(): number | null {
    return this.attachedTabId
  }

  /**
   * Chrome took the debugger away (banner cancelled, tab crashed, DevTools
   * opened). Forget the attachment so the next op re-attaches instead of
   * issuing CDP calls into a dead session forever — `attach()` short-circuits
   * on the cached id, so without this the executor never recovers.
   *
   * Returns true when the detach was for the tab we were driving.
   */
  onDetached(tabId: number): boolean {
    if (this.attachedTabId !== tabId) return false
    this.attachedTabId = null
    this.lastSnapshot = null
    return true
  }

  /**
   * Every CDP call goes through here so a lost session is self-healing: the
   * stale attachment is dropped and the failure carries the `detached` code
   * with an actionable message rather than a raw Chrome string.
   */
  private async cdp<T = unknown>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    try {
      return await sendCdp<T>(tabId, method, params)
    } catch (err) {
      if (isDetachedError(err)) {
        this.onDetached(tabId)
        throw new ExecutorError(DETACHED_MESSAGE, 'detached')
      }
      throw err
    }
  }

  /** Accessible name of a ref from the latest snapshot (approval previews ride this server-side too). */
  refName(ref: string): string | null {
    return this.lastSnapshot?.refToName.get(ref) ?? null
  }

  private mustTab(): number {
    if (this.attachedTabId == null) {
      throw new ExecutorError('No controlled tab. The task needs the user to allow a tab first.', 'tab_closed')
    }
    return this.attachedTabId
  }

  private resolveRef(ref: string): number {
    const snapshot = this.lastSnapshot
    const backendNodeId = snapshot?.refToBackendNodeId.get(ref)
    if (backendNodeId == null) {
      throw new ExecutorError(
        `Unknown ref ${ref} — refs are valid for the latest snapshot only. Take a fresh browserSnapshot.`,
        'stale_ref',
      )
    }
    return backendNodeId
  }

  async navigate(url: string): Promise<{ url: string }> {
    const tabId = this.mustTab()
    this.lastSnapshot = null
    await this.cdp(tabId, 'Page.enable')
    await this.cdp(tabId, 'Page.navigate', { url })
    await waitForTabComplete(tabId, NAVIGATE_TIMEOUT_MS)
    const tab = await chrome.tabs.get(tabId)
    return { url: tab.url ?? url }
  }

  async snapshot(): Promise<{ url: string; title: string; nodes: BuiltSnapshot['nodes'] }> {
    const tabId = this.mustTab()
    const res = await this.cdp<{ nodes: CdpAXNode[] }>(tabId, 'Accessibility.getFullAXTree')
    this.lastSnapshot = buildSnapshot(res.nodes ?? [])
    const tab = await chrome.tabs.get(tabId)
    return { url: tab.url ?? '', title: tab.title ?? '', nodes: this.lastSnapshot.nodes }
  }

  async click(ref: string): Promise<void> {
    const tabId = this.mustTab()
    const backendNodeId = this.resolveRef(ref)
    try {
      await sendCdp(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId })
    } catch {
      // Best effort — some nodes reject it; the click may still land.
    }
    const box = await this.cdp<{ model?: { content?: number[] } }>(tabId, 'DOM.getBoxModel', { backendNodeId })
    const quad = box.model?.content
    if (!quad || quad.length < 8) {
      throw new ExecutorError(`Ref ${ref} is not visible on the page.`, 'backend_error')
    }
    const x = (quad[0] + quad[4]) / 2
    const y = (quad[1] + quad[5]) / 2
    const base = { x, y, button: 'left', clickCount: 1 } as const
    await this.cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await this.cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
    await this.cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
  }

  async type(ref: string, text: string): Promise<void> {
    const tabId = this.mustTab()
    const backendNodeId = this.resolveRef(ref)
    await this.cdp(tabId, 'DOM.focus', { backendNodeId })
    await this.cdp(tabId, 'Input.insertText', { text })
  }

  async currentUrl(): Promise<{ url: string; title: string }> {
    const tabId = this.mustTab()
    const tab = await chrome.tabs.get(tabId)
    return { url: tab.url ?? '', title: tab.title ?? '' }
  }
}

function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      chrome.tabs.onUpdated.removeListener(listener)
      clearTimeout(timer)
      resolve()
    }
    const listener = (updatedTabId: number, info: { status?: string }) => {
      if (updatedTabId === tabId && info.status === 'complete') finish()
    }
    const timer = setTimeout(finish, timeoutMs)
    chrome.tabs.onUpdated.addListener(listener)
    // The tab may already be complete (same-page anchors, instant loads).
    void chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') {
        // Give the navigation a beat to actually start before declaring done.
        setTimeout(() => {
          void chrome.tabs.get(tabId).then((t) => {
            if (t.status === 'complete') finish()
          })
        }, 500)
      }
    })
  })
}
