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
    expect(retryableAfterReattach('click')).toBe(false)
    expect(retryableAfterReattach('type')).toBe(false)
  })
})
