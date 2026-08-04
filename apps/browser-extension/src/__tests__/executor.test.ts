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
import { TabExecutor, ExecutorError, isDetachedError, retryableAfterReattach } from '../executor.js'

type Stub = {
  attach: ReturnType<typeof vi.fn>
  detach: ReturnType<typeof vi.fn>
  sendCommand: ReturnType<typeof vi.fn>
}

let dbg: Stub

function installChrome(): void {
  dbg = {
    attach: vi.fn(async () => {}),
    detach: vi.fn(async () => {}),
    sendCommand: vi.fn(async () => ({ nodes: [] })),
  }
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    debugger: dbg,
    tabs: {
      get: vi.fn(async () => ({ url: 'https://luma.com/x', title: 'Luma', status: 'complete' })),
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
