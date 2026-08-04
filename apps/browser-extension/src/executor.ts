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
  return op === 'snapshot' || op === 'currentUrl' || op === 'navigate' || op === 'captureFrame'
}

type TakeoverInput =
  | { kind: 'click'; x: number; y: number; frameW?: number; frameH?: number }
  | { kind: 'pointer'; action: 'down' | 'move' | 'up'; x: number; y: number; frameW?: number; frameH?: number }
  | { kind: 'key'; text: string }
  | { kind: 'scroll'; deltaY: number }
  | { kind: 'navigate'; action: 'back' | 'forward' | 'reload' | 'goto'; url?: string }

const TAKEOVER_KEYS: Record<
  string,
  { key: string; code: string; windowsVirtualKeyCode: number; text?: string }
> = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
}

async function sendCdp<T = unknown>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
  return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T
}

/**
 * Registrable-host suffix match used to filter captured cookies to the site
 * the caller asked for (D3: filtering happens INSIDE the extension, before
 * anything crosses the wire — this is a security requirement, not an
 * optimisation). A host matches when it equals `site` outright or is a
 * subdomain of it: `login.example.com` matches `example.com`, but
 * `notexample.com` and `example.com.evil.example` do not. Exported so it can
 * be unit-tested directly without going through CDP.
 */
export function hostMatchesSite(host: string, site: string): boolean {
  const normalizedHost = host.replace(/^\./, '').toLowerCase()
  const normalizedSite = site.replace(/^\./, '').toLowerCase()
  if (!normalizedHost || !normalizedSite) return false
  return normalizedHost === normalizedSite || normalizedHost.endsWith(`.${normalizedSite}`)
}

/**
 * CDP cookie → Playwright `storageState` cookie.
 *
 * `Network.getAllCookies` returns fields storageState never defines (`session`,
 * `size`, `priority`, `sourceScheme`, `sourcePort`, sometimes `partitionKey`),
 * and the E2B provider writes `{cookies, origins}` VERBATIM into the file
 * AGENT_BROWSER_STATE loads at daemon launch. Passing the raw CDP shape
 * through therefore fails at *replay*, inside the sandbox — the one step this
 * whole path exists to make work — while the capture itself looks green
 * everywhere it is visible: bundle stored, vault row written, UI happy.
 *
 * `expires: -1` is the session-cookie sentinel in both shapes, so it is kept
 * as-is rather than invented. `sameSite` is omitted when CDP gave none — an
 * absent value and a defaulted one are not the same cookie.
 */
function toStorageStateCookie(c: Record<string, unknown>): Record<string, unknown> {
  const sameSite = typeof c.sameSite === 'string' ? c.sameSite : undefined
  return {
    name: String(c.name ?? ''),
    value: String(c.value ?? ''),
    domain: String(c.domain ?? ''),
    path: String(c.path ?? '/'),
    expires: typeof c.expires === 'number' ? c.expires : -1,
    httpOnly: c.httpOnly === true,
    secure: c.secure === true,
    ...(sameSite ? { sameSite } : {}),
  }
}

function parsedTabUrl(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

export class TabExecutor {
  private attachedTabId: number | null = null
  private lastSnapshot: BuiltSnapshot | null = null
  private takeoverPointer: { x: number; y: number } | null = null

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
    const pressed = this.takeoverPointer
    this.takeoverPointer = null
    if (tabId != null) {
      if (pressed) {
        try {
          await sendCdp(tabId, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: pressed.x,
            y: pressed.y,
            button: 'left',
            buttons: 0,
            clickCount: 1,
            pointerType: 'mouse',
          })
        } catch {
          // The debugger may already be gone; detach still clears browser input state.
        }
      }
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
    this.takeoverPointer = null
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

  /**
   * Capture the allowed tab's authenticated session for `site` (D2/D3): the
   * cookies + localStorage for a login the user already has in their own
   * Chrome, so it can be replayed into the profile vault. User-initiated
   * only — there is no tool over this, only the Settings "Save this login"
   * route calls it (D4).
   */
  async captureState(site: string): Promise<{
    site: string
    cookies: unknown[]
    localStorage: Record<string, Record<string, string>>
    capturedAt: string
  }> {
    const tabId = this.mustTab()
    const tab = await chrome.tabs.get(tabId)
    const parsed = parsedTabUrl(tab.url ?? '')
    const host = parsed?.hostname ?? ''
    // Capture is not a navigation: it must refuse rather than silently
    // succeed against whatever tab happens to be allowed (D3).
    if (!hostMatchesSite(host, site)) {
      throw new ExecutorError(
        `The allowed tab is on ${host || 'a page with no URL'}, not ${site}. Switch the allowed tab to ${site} and retry.`,
        'site_mismatch',
      )
    }

    await this.cdp(tabId, 'Network.enable')
    const { cookies } = await this.cdp<{ cookies: Array<Record<string, unknown>> }>(tabId, 'Network.getAllCookies')
    // Drop everything but the requested site's cookies BEFORE building the
    // result — the relay, the API, and the database must never see cookies
    // for sites the user did not name.
    const siteCookies = cookies.filter((c) => hostMatchesSite(String(c.domain ?? ''), site)).map(toStorageStateCookie)

    const evaluated = await this.cdp<{ result?: { value?: Array<[string, string]> } }>(tabId, 'Runtime.evaluate', {
      expression: 'Object.entries(localStorage)',
      returnByValue: true,
    })
    const origin = parsed?.origin ?? ''
    const localStorage: Record<string, Record<string, string>> = {
      [origin]: Object.fromEntries(evaluated.result?.value ?? []),
    }

    return { site, cookies: siteCookies, localStorage, capturedAt: new Date().toISOString() }
  }

  async captureFrame(): Promise<{ data: string; mimeType: string }> {
    const tabId = this.mustTab()
    await this.cdp(tabId, 'Page.enable')
    const metrics = await this.cdp<{
      cssVisualViewport?: { pageX?: number; pageY?: number; clientWidth?: number; clientHeight?: number }
      visualViewport?: { pageX?: number; pageY?: number; clientWidth?: number; clientHeight?: number }
    }>(tabId, 'Page.getLayoutMetrics')
    const viewport = metrics.cssVisualViewport ?? metrics.visualViewport
    const width = Math.max(1, viewport?.clientWidth ?? 1280)
    const height = Math.max(1, viewport?.clientHeight ?? 720)
    const scale = Math.min(1, 1280 / width)
    const frame = await this.cdp<{ data?: string }>(tabId, 'Page.captureScreenshot', {
      format: 'jpeg',
      quality: 55,
      fromSurface: true,
      captureBeyondViewport: false,
      clip: {
        x: viewport?.pageX ?? 0,
        y: viewport?.pageY ?? 0,
        width,
        height,
        scale,
      },
    })
    if (!frame.data) throw new ExecutorError('Chrome returned an empty browser frame.', 'backend_error')
    return { data: frame.data, mimeType: 'image/jpeg' }
  }

  async takeoverInput(event: TakeoverInput): Promise<void> {
    const tabId = this.mustTab()
    if (event.kind === 'click' || event.kind === 'pointer') {
      if (![event.x, event.y].every(Number.isFinite)) {
        throw new ExecutorError('Invalid Take-Over click coordinates.', 'backend_error')
      }
      const metrics = await this.cdp<{
        cssVisualViewport?: { clientWidth?: number; clientHeight?: number }
        visualViewport?: { clientWidth?: number; clientHeight?: number }
      }>(tabId, 'Page.getLayoutMetrics')
      const viewport = metrics.cssVisualViewport ?? metrics.visualViewport
      const width = viewport?.clientWidth ?? event.frameW ?? 1
      const height = viewport?.clientHeight ?? event.frameH ?? 1
      const x = event.frameW && event.frameW > 0 ? (event.x * width) / event.frameW : event.x
      const y = event.frameH && event.frameH > 0 ? (event.y * height) / event.frameH : event.y
      const base = { x, y, button: 'left', clickCount: 1, pointerType: 'mouse' } as const
      await this.cdp(tabId, 'Input.dispatchMouseEvent', {
        ...base,
        type: 'mouseMoved',
        button: 'none',
        buttons: event.kind === 'pointer' && event.action !== 'down' ? 1 : 0,
      })
      if (event.kind === 'click' || event.action === 'down') {
        await this.cdp(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1 })
        if (event.kind === 'pointer') this.takeoverPointer = { x, y }
      }
      if (event.kind === 'pointer' && event.action === 'move') this.takeoverPointer = { x, y }
      if (event.kind === 'click' || event.action === 'up') {
        await this.cdp(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 })
        if (event.kind === 'pointer') this.takeoverPointer = null
      }
      return
    }
    if (event.kind === 'key') {
      if (event.text.length === 1) {
        await this.cdp(tabId, 'Input.insertText', { text: event.text })
      } else {
        const key = TAKEOVER_KEYS[event.text]
        if (!key) return
        await this.cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...key })
        await this.cdp(tabId, 'Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: key.key,
          code: key.code,
          windowsVirtualKeyCode: key.windowsVirtualKeyCode,
        })
      }
      return
    }
    if (event.kind === 'scroll') {
      if (!Number.isFinite(event.deltaY)) {
        throw new ExecutorError('Invalid Take-Over scroll distance.', 'backend_error')
      }
      const metrics = await this.cdp<{
        cssVisualViewport?: { clientWidth?: number; clientHeight?: number }
        visualViewport?: { clientWidth?: number; clientHeight?: number }
      }>(tabId, 'Page.getLayoutMetrics')
      const viewport = metrics.cssVisualViewport ?? metrics.visualViewport
      await this.cdp(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: Math.round((viewport?.clientWidth ?? 1280) / 2),
        y: Math.round((viewport?.clientHeight ?? 720) / 2),
        deltaX: 0,
        deltaY: event.deltaY,
        pointerType: 'mouse',
      })
      return
    }
    if (event.action === 'reload') {
      await this.cdp(tabId, 'Page.reload')
    } else if (event.action === 'goto') {
      if (!event.url || !/^https?:\/\//i.test(event.url)) {
        throw new ExecutorError('Take-Over navigation accepts only http(s) URLs.', 'backend_error')
      }
      this.lastSnapshot = null
      await this.cdp(tabId, 'Page.navigate', { url: event.url })
    } else {
      const history = await this.cdp<{
        currentIndex: number
        entries: Array<{ id: number }>
      }>(tabId, 'Page.getNavigationHistory')
      const target = history.entries[history.currentIndex + (event.action === 'back' ? -1 : 1)]
      if (target) await this.cdp(tabId, 'Page.navigateToHistoryEntry', { entryId: target.id })
    }
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
