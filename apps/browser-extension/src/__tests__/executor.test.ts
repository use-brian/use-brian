/**
 * CDP executor — attachment lifecycle.
 *
 * The bug these cover (prod, 2026-07-22): Chrome dropped the debugger session
 * mid-task and the executor kept believing it was attached, because
 * `attach()` short-circuits on the cached tab id. Every later CDP op failed
 * with a raw `Debugger is not attached to the tab with id: N` under the
 * generic `backend_error` code, forever, while `currentUrl` (chrome.tabs, no
 * CDP) kept succeeding — so the model saw a half-working browser and blamed
 * the site. Spec: docs/architecture/engine/computer-use.md §5.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { TabExecutor, ExecutorError, isDetachedError, retryableAfterReattach, hostMatchesSite } from '../executor.js'

type Stub = {
  attach: ReturnType<typeof vi.fn>
  detach: ReturnType<typeof vi.fn>
  sendCommand: ReturnType<typeof vi.fn>
}

let dbg: Stub
let tabsGet: ReturnType<typeof vi.fn>

function installChrome(): void {
  dbg = {
    attach: vi.fn(async () => {}),
    detach: vi.fn(async () => {}),
    sendCommand: vi.fn(async () => ({ nodes: [] })),
  }
  tabsGet = vi.fn(async () => ({ url: 'https://luma.com/x', title: 'Luma', status: 'complete' }))
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    debugger: dbg,
    tabs: {
      get: tabsGet,
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  }
}

beforeEach(installChrome)

/**
 * The hole this suite had until 2026-08-04: `dbg.attach` was mocked as
 * always-resolving, so nothing here ever exercised `chrome.debugger.attach`
 * REJECTING — which is the one Chrome call that sat outside the `cdp()`
 * translation wrapper. A user's assistant read Chrome's raw
 * `Cannot access a chrome-extension:// URL` off a tool result and reported it
 * to them as a system permission error.
 */
describe('[COMP:ext/agent] Attach failure translation', () => {
  it('never lets Chrome’s own wording escape attach', async () => {
    dbg.attach = vi.fn(async () => {
      throw new Error('Cannot access a chrome-extension:// URL')
    })
    const executor = new TabExecutor()
    const err = await executor.attach(42).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ExecutorError)
    expect((err as ExecutorError).code).toBe('no_eligible_tab')
    // The assertion that matters: the message the model receives is ours.
    expect((err as ExecutorError).message).not.toMatch(/chrome-extension:\/\//)
    expect((err as ExecutorError).message).toMatch(/switch to the website/i)
    // Chrome's text survives for debugging, off the wire — `background.ts`
    // sends `err.message`, never `err.cause`.
    expect(((err as ExecutorError).cause as Error).message).toBe(
      'Cannot access a chrome-extension:// URL',
    )
  })

  it('translates a chrome:// refusal the same way', async () => {
    dbg.attach = vi.fn(async () => {
      throw new Error('Cannot access a chrome:// URL')
    })
    const executor = new TabExecutor()
    const err = (await executor.attach(7).catch((e: unknown) => e)) as ExecutorError
    expect(err.code).toBe('no_eligible_tab')
    expect(err.message).not.toMatch(/chrome:\/\//)
  })

  it('falls back to our own sentence for a refusal we cannot name', async () => {
    dbg.attach = vi.fn(async () => {
      throw new Error('Some future Chrome wording we have never seen')
    })
    const executor = new TabExecutor()
    const err = (await executor.attach(7).catch((e: unknown) => e)) as ExecutorError
    // The default must be OURS. An unmatched phrasing leaking through is the
    // whole failure mode, and Chrome's wording is not a fixed contract.
    expect(err.code).toBe('backend_error')
    expect(err.message).not.toMatch(/future Chrome wording/)
    expect(err.message).toMatch(/refused to hand Use Brian control/i)
  })

  it('still reports a detach at attach time as detached, not unattachable', async () => {
    dbg.attach = vi.fn(async () => {
      throw new Error('Debugger is not attached to the tab with id: 42.')
    })
    const executor = new TabExecutor()
    const err = (await executor.attach(42).catch((e: unknown) => e)) as ExecutorError
    expect(err.code).toBe('detached')
  })

  it('leaves no cached attachment behind after a failed attach', async () => {
    dbg.attach = vi.fn(async () => {
      throw new Error('Cannot access a chrome-extension:// URL')
    })
    const executor = new TabExecutor()
    await executor.attach(42).catch(() => {})
    // Recording the tab id on a failed attach would make the next attach
    // short-circuit and every CDP op fail forever — the half-dead state the
    // detach path exists to prevent.
    expect(executor.attachedTab()).toBeNull()
  })
})

describe('[COMP:ext/agent] CDP attachment lifecycle', () => {
  it('re-attaches on the next op after Chrome detaches the debugger', async () => {
    const executor = new TabExecutor()
    await executor.attach(42)
    expect(dbg.attach).toHaveBeenCalledTimes(1)

    // Chrome dropped the session (banner cancelled, tab crashed, DevTools).
    executor.onDetached(42)

    await executor.attach(42)
    expect(dbg.attach).toHaveBeenCalledTimes(2)
  })

  it('ignores a detach for a tab it is not driving', async () => {
    const executor = new TabExecutor()
    await executor.attach(42)
    expect(executor.onDetached(999)).toBe(false)
    await executor.attach(42)
    expect(dbg.attach).toHaveBeenCalledTimes(1)
  })

  it('drops the snapshot on detach so stale refs cannot resolve', async () => {
    const executor = new TabExecutor()
    await executor.attach(42)
    dbg.sendCommand.mockResolvedValueOnce({
      nodes: [
        {
          nodeId: '1',
          backendDOMNodeId: 7,
          role: { value: 'button' },
          name: { value: 'Register' },
          ignored: false,
        },
      ],
    })
    const snap = await executor.snapshot()
    const ref = snap.nodes[0]?.ref
    expect(ref).toBeTruthy()

    executor.onDetached(42)
    await executor.attach(42)

    await expect(executor.click(String(ref))).rejects.toMatchObject({ code: 'stale_ref' })
  })

  it('reports a lost debugger session as `detached`, not a raw CDP string', async () => {
    const executor = new TabExecutor()
    await executor.attach(42)
    dbg.sendCommand.mockRejectedValueOnce(
      new Error('Debugger is not attached to the tab with id: 38686551.'),
    )

    const err = (await executor.snapshot().catch((e: unknown) => e)) as ExecutorError
    expect(err).toBeInstanceOf(ExecutorError)
    expect(err.code).toBe('detached')
    // The message must tell the model what to do, not leak a Chrome internal.
    expect(err.message).toMatch(/Chrome/i)
  })

  it('forgets the attachment when a CDP call reveals the session is gone', async () => {
    const executor = new TabExecutor()
    await executor.attach(42)
    dbg.sendCommand.mockRejectedValueOnce(new Error('Debugger is not attached to the tab with id: 42.'))
    await executor.snapshot().catch(() => {})

    await executor.attach(42)
    expect(dbg.attach).toHaveBeenCalledTimes(2)
  })
})

describe('[COMP:ext/agent] Native dropdown option clicks', () => {
  it('selects an option through its owning select when the option has no box model', async () => {
    const executor = new TabExecutor()
    await executor.attach(42)
    dbg.sendCommand.mockImplementation(async (_target, method, params) => {
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            {
              nodeId: 'station-option',
              backendDOMNodeId: 7,
              role: { value: 'option' },
              name: { value: 'Olympic' },
              ignored: false,
            },
          ],
        }
      }
      if (method === 'DOM.scrollIntoViewIfNeeded' && params?.backendNodeId === 7) {
        throw new Error('Could not compute box model.')
      }
      if (method === 'DOM.getBoxModel' && params?.backendNodeId === 7) {
        throw new Error('Could not compute box model.')
      }
      if (method === 'DOM.resolveNode') return { object: { objectId: 'option-object' } }
      if (method === 'Runtime.callFunctionOn' && params?.returnByValue === true) {
        // Disabled line-heading options are excluded, so Olympic is the third selectable item.
        return { result: { value: { disabled: false, enabledIndex: 2, multiple: false } } }
      }
      if (method === 'Runtime.callFunctionOn') return { result: { objectId: 'select-object' } }
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 8 } }
      if (method === 'DOM.getBoxModel' && params?.backendNodeId === 8) {
        return { model: { content: [0, 0, 100, 0, 100, 20, 0, 20] } }
      }
      return {}
    })

    const snapshot = await executor.snapshot()
    await expect(executor.click(snapshot.nodes[0]!.ref)).resolves.toBeUndefined()

    const mouse = dbg.sendCommand.mock.calls.filter((call) => call[1] === 'Input.dispatchMouseEvent')
    expect(mouse).toHaveLength(3)
    expect(mouse[1]?.[2]).toMatchObject({ type: 'mousePressed', x: 50, y: 10 })
    const keys = dbg.sendCommand.mock.calls
      .filter((call) => call[1] === 'Input.dispatchKeyEvent' && call[2]?.type === 'keyDown')
      .map((call) => call[2]?.key)
    expect(keys).toEqual(['Home', 'ArrowDown', 'ArrowDown', 'Enter'])
  })

  it('keeps an ordinary box-model failure actionable instead of leaking Chrome wording', async () => {
    const executor = new TabExecutor()
    await executor.attach(42)
    dbg.sendCommand.mockImplementation(async (_target, method) => {
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [{
            nodeId: 'button', backendDOMNodeId: 9, role: { value: 'button' },
            name: { value: 'Search' }, ignored: false,
          }],
        }
      }
      if (method === 'DOM.getBoxModel') throw new Error('Could not compute box model.')
      return {}
    })
    const snapshot = await executor.snapshot()

    const err = (await executor.click(snapshot.nodes[0]!.ref).catch((error: unknown) => error)) as ExecutorError
    expect(err.message).toBe(`Ref ${snapshot.nodes[0]!.ref} is not visible on the page.`)
    expect(err.message).not.toMatch(/box model/i)
  })
})

describe('[COMP:ext/agent] Detach recovery policy', () => {
  it('recognises the Chrome detach message however it is phrased', () => {
    expect(isDetachedError(new Error('Debugger is not attached to the tab with id: 1.'))).toBe(true)
    expect(isDetachedError(new ExecutorError('lost it', 'detached'))).toBe(true)
    expect(isDetachedError(new Error('Ref @e3 is not visible on the page.'))).toBe(false)
  })

  it('retries only the ops that cannot double-fire', () => {
    // A detach can land after the input event was delivered; replaying it
    // would click or type twice. Read-only ops are always safe to redo.
    expect(retryableAfterReattach('snapshot')).toBe(true)
    expect(retryableAfterReattach('currentUrl')).toBe(true)
    expect(retryableAfterReattach('navigate')).toBe(true)
    expect(retryableAfterReattach('captureFrame')).toBe(true)
    expect(retryableAfterReattach('click')).toBe(false)
    expect(retryableAfterReattach('type')).toBe(false)
  })
})

describe('[COMP:ext/agent] Local Take-Over', () => {
  it('captures a bounded frame and rescales trusted clicks to the CSS viewport', async () => {
    const executor = new TabExecutor()
    await executor.attach(42)
    dbg.sendCommand.mockImplementation(async (_target, method) => {
      if (method === 'Page.captureScreenshot') return { data: 'jpeg-data' }
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { clientWidth: 1000, clientHeight: 500 } }
      }
      return {}
    })

    await expect(executor.captureFrame()).resolves.toEqual({
      data: 'jpeg-data',
      mimeType: 'image/jpeg',
    })
    await executor.takeoverInput({ kind: 'click', x: 100, y: 50, frameW: 200, frameH: 100 })

    const mouse = dbg.sendCommand.mock.calls.filter((call) => call[1] === 'Input.dispatchMouseEvent')
    expect(mouse).toHaveLength(3)
    expect(mouse[1]?.[2]).toMatchObject({ type: 'mousePressed', x: 500, y: 250 })
  })

  it('rejects non-http Take-Over navigation below the API seam', async () => {
    const executor = new TabExecutor()
    await executor.attach(42)
    await expect(
      executor.takeoverInput({ kind: 'navigate', action: 'goto', url: 'file:///etc/passwd' }),
    ).rejects.toMatchObject({ code: 'backend_error' })
  })

  it('keeps the trusted mouse button down until a separate pointer-up event', async () => {
    const executor = new TabExecutor()
    await executor.attach(42)
    dbg.sendCommand.mockImplementation(async (_target, method) => {
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { clientWidth: 1000, clientHeight: 500 } }
      }
      return {}
    })

    await executor.takeoverInput({
      kind: 'pointer', action: 'down', x: 100, y: 50, frameW: 200, frameH: 100,
    })
    let mouse = dbg.sendCommand.mock.calls.filter((call) => call[1] === 'Input.dispatchMouseEvent')
    expect(mouse.map((call) => call[2]?.type)).toEqual(['mouseMoved', 'mousePressed'])
    expect(mouse[0]?.[2]).toMatchObject({ buttons: 0 })
    expect(mouse[1]?.[2]).toMatchObject({ buttons: 1 })

    await executor.takeoverInput({
      kind: 'pointer', action: 'move', x: 120, y: 60, frameW: 200, frameH: 100,
    })
    mouse = dbg.sendCommand.mock.calls.filter((call) => call[1] === 'Input.dispatchMouseEvent')
    expect(mouse.at(-1)?.[2]).toMatchObject({ type: 'mouseMoved', x: 600, y: 300, buttons: 1 })

    await executor.takeoverInput({
      kind: 'pointer', action: 'up', x: 120, y: 60, frameW: 200, frameH: 100,
    })
    mouse = dbg.sendCommand.mock.calls.filter((call) => call[1] === 'Input.dispatchMouseEvent')
    expect(mouse.map((call) => call[2]?.type)).toEqual([
      'mouseMoved', 'mousePressed', 'mouseMoved', 'mouseMoved', 'mouseReleased',
    ])
    expect(mouse.at(-2)?.[2]).toMatchObject({ buttons: 1 })
    expect(mouse.at(-1)?.[2]).toMatchObject({ buttons: 0 })
  })

  it('releases a held pointer before detaching browser control', async () => {
    const executor = new TabExecutor()
    await executor.attach(42)
    dbg.sendCommand.mockImplementation(async (_target, method) => {
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { clientWidth: 1000, clientHeight: 500 } }
      }
      return {}
    })
    await executor.takeoverInput({ kind: 'pointer', action: 'down', x: 100, y: 50 })
    await executor.detach()

    const mouse = dbg.sendCommand.mock.calls.filter((call) => call[1] === 'Input.dispatchMouseEvent')
    expect(mouse.at(-1)?.[2]).toMatchObject({ type: 'mouseReleased', buttons: 0 })
  })
})

describe('[COMP:ext/agent] Site suffix match', () => {
  it('matches the exact site and its subdomains', () => {
    expect(hostMatchesSite('example.com', 'example.com')).toBe(true)
    expect(hostMatchesSite('login.example.com', 'example.com')).toBe(true)
    expect(hostMatchesSite('www.example.com', 'example.com')).toBe(true)
  })

  it('rejects a different site, even one that merely contains the name', () => {
    expect(hostMatchesSite('notexample.com', 'example.com')).toBe(false)
    expect(hostMatchesSite('example.com.evil.example', 'example.com')).toBe(false)
    expect(hostMatchesSite('example.net', 'example.com')).toBe(false)
    expect(hostMatchesSite('', 'example.com')).toBe(false)
  })

  it('strips a leading dot from either side', () => {
    expect(hostMatchesSite('.example.com', 'example.com')).toBe(true)
    expect(hostMatchesSite('example.com', '.example.com')).toBe(true)
  })
})

describe('[COMP:sandbox/session-capture] Session capture (D2/D3)', () => {
  function mockCdp(handlers: Record<string, unknown>): void {
    dbg.sendCommand.mockImplementation(async (_target, method) => {
      if (method in handlers) return handlers[method]
      return {}
    })
  }

  it('filters captured cookies to the requested site, dropping every other site’s cookies', async () => {
    tabsGet.mockResolvedValue({ url: 'https://app.example.com/dashboard', title: 'Example', status: 'complete' })
    mockCdp({
      'Network.getAllCookies': {
        cookies: [
          { name: 'session', value: 'abc', domain: '.example.com', path: '/', expires: -1, httpOnly: true, secure: true },
          { name: 'sub', value: 'def', domain: 'login.example.com', path: '/app', expires: 1893456000, httpOnly: false, secure: true },
          { name: 'other', value: 'xyz', domain: 'unrelated.example.net', path: '/', expires: -1 },
        ],
      },
      'Runtime.evaluate': { result: { value: [] } },
    })
    const executor = new TabExecutor()
    await executor.attach(42)

    const bundle = await executor.captureState('example.com')

    expect(bundle.site).toBe('example.com')
    expect(bundle.cookies).toEqual([
      { name: 'session', value: 'abc', domain: '.example.com', path: '/', expires: -1, httpOnly: true, secure: true },
      { name: 'sub', value: 'def', domain: 'login.example.com', path: '/app', expires: 1893456000, httpOnly: false, secure: true },
    ])
  })

  it('emits Playwright storageState cookies, not the raw CDP shape', async () => {
    // The captured array is written VERBATIM into the file AGENT_BROWSER_STATE
    // loads at daemon launch, so a CDP-only field riding along breaks replay
    // inside the sandbox while the capture itself still looks successful.
    // Asserting the exact key set is what keeps that failure from being latent.
    tabsGet.mockResolvedValue({ url: 'https://app.example.com/dashboard', title: 'Example', status: 'complete' })
    mockCdp({
      'Network.getAllCookies': {
        cookies: [
          {
            name: 'session',
            value: 'abc',
            domain: '.example.com',
            path: '/',
            expires: -1,
            httpOnly: true,
            secure: true,
            sameSite: 'Lax',
            // CDP-only fields storageState does not define:
            session: true,
            size: 42,
            priority: 'Medium',
            sourceScheme: 'Secure',
            sourcePort: 443,
          },
        ],
      },
      'Runtime.evaluate': { result: { value: [] } },
    })
    const executor = new TabExecutor()
    await executor.attach(42)

    const [cookie] = (await executor.captureState('example.com')).cookies as Array<Record<string, unknown>>

    expect(Object.keys(cookie).sort()).toEqual(
      ['domain', 'expires', 'httpOnly', 'name', 'path', 'sameSite', 'secure', 'value'].sort(),
    )
    expect(cookie.sameSite).toBe('Lax')
  })

  it('omits sameSite entirely when CDP reported none', async () => {
    tabsGet.mockResolvedValue({ url: 'https://app.example.com/dashboard', title: 'Example', status: 'complete' })
    mockCdp({
      'Network.getAllCookies': {
        cookies: [{ name: 'plain', value: 'v', domain: 'example.com', path: '/', expires: -1 }],
      },
      'Runtime.evaluate': { result: { value: [] } },
    })
    const executor = new TabExecutor()
    await executor.attach(42)

    const [cookie] = (await executor.captureState('example.com')).cookies as Array<Record<string, unknown>>

    expect('sameSite' in cookie).toBe(false)
  })

  it('folds the attached page’s localStorage into the origin map', async () => {
    tabsGet.mockResolvedValue({ url: 'https://app.example.com/dashboard', title: 'Example', status: 'complete' })
    mockCdp({
      'Network.getAllCookies': { cookies: [] },
      'Runtime.evaluate': {
        result: {
          value: [
            ['token', 't1'],
            ['flag', 'on'],
          ],
        },
      },
    })
    const executor = new TabExecutor()
    await executor.attach(42)

    const bundle = await executor.captureState('example.com')

    expect(bundle.localStorage).toEqual({
      'https://app.example.com': { token: 't1', flag: 'on' },
    })
  })

  it('refuses with site_mismatch when the attached tab is on a different site, before capturing anything', async () => {
    tabsGet.mockResolvedValue({ url: 'https://other.example.org/page', title: 'Other', status: 'complete' })
    const executor = new TabExecutor()
    await executor.attach(42)

    await expect(executor.captureState('example.com')).rejects.toMatchObject({ code: 'site_mismatch' })
    const cookieCalls = dbg.sendCommand.mock.calls.filter((call) => call[1] === 'Network.getAllCookies')
    expect(cookieCalls).toHaveLength(0)
  })

  it('maps a lost debugger session to `detached`, like every other op', async () => {
    tabsGet.mockResolvedValue({ url: 'https://app.example.com/dashboard', title: 'Example', status: 'complete' })
    const executor = new TabExecutor()
    await executor.attach(42)
    // The session drops on the first CDP call captureState makes (Network.enable).
    dbg.sendCommand.mockRejectedValueOnce(new Error('Debugger is not attached to the tab with id: 42.'))

    const err = (await executor.captureState('example.com').catch((e: unknown) => e)) as ExecutorError
    expect(err).toBeInstanceOf(ExecutorError)
    expect(err.code).toBe('detached')
  })
})
