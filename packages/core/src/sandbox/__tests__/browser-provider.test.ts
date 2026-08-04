import { describe, it, expect } from 'vitest'
import { createLocalBrowserProvider } from '../local-browser-provider.js'
import { createCloudBrowserProvider } from '../cloud-browser-provider.js'
import { StubSandboxProvider } from '../providers/stub.js'
import { STALE_EXTENSION_REMEDY } from '@use-brian/shared'
import {
  BrowserBackendError,
  BROWSER_BACKEND_ERROR_CODES,
  NO_EXTENSION_MESSAGE,
  NO_EXTENSION_REMEDY,
  type BrowserCallContext,
  type RelayCommandResult,
  type RelayCommandTransport,
} from '../types.js'

const CTX: BrowserCallContext = {
  userId: 'user-1',
  workspaceId: 'ws-1',
  sessionId: 'sess-1',
}

// ── LocalBrowserProvider: op → relay-command serialization ─────

function transportRecording(
  respond: (op: string) => RelayCommandResult,
): { transport: RelayCommandTransport; sent: Array<{ userId: string; op: string; args?: Record<string, unknown> }> } {
  const sent: Array<{ userId: string; op: string; args?: Record<string, unknown> }> = []
  return {
    sent,
    transport: {
      async send(params) {
        sent.push(params)
        return respond(params.op)
      },
    },
  }
}

describe('[COMP:sandbox/local-browser] LocalBrowserProvider', () => {
  it('serializes each tool op to the P1.2 command envelope with the caller user id', async () => {
    const { transport, sent } = transportRecording((op) => {
      if (op === 'navigate') return { ok: true, data: { url: 'https://example.com/' } }
      if (op === 'snapshot') {
        return {
          ok: true,
          data: {
            url: 'https://example.com/',
            title: 'Example',
            nodes: [{ ref: '@e1', role: 'button', name: 'Send' }],
          },
        }
      }
      if (op === 'currentUrl') return { ok: true, data: { url: 'https://example.com/', title: 'Example' } }
      if (op === 'captureFrame') return { ok: true, data: { data: 'jpeg-data', mimeType: 'image/jpeg' } }
      return { ok: true }
    })
    const provider = createLocalBrowserProvider({ transport })

    await provider.navigate(CTX, 'https://example.com/')
    const snap = await provider.snapshot(CTX)
    await provider.click(CTX, '@e1')
    await provider.type(CTX, '@e2', 'hello there')
    await provider.currentUrl(CTX)
    const frame = await provider.nextTakeoverFrame?.(CTX)
    await provider.sendTakeoverInput?.(CTX, { kind: 'click', x: 20, y: 10, frameW: 200, frameH: 100 })
    await provider.stop(CTX)

    expect(sent.map((s) => s.op)).toEqual([
      'navigate',
      'snapshot',
      'click',
      'type',
      'currentUrl',
      'captureFrame',
      'takeoverInput',
      'stop',
    ])
    expect(sent.every((s) => s.userId === 'user-1')).toBe(true)
    expect(sent[0]?.args).toEqual({ url: 'https://example.com/' })
    expect(sent[2]?.args).toEqual({ ref: '@e1' })
    expect(sent[3]?.args).toEqual({ ref: '@e2', text: 'hello there' })
    expect(sent[6]?.args).toEqual({
      event: { kind: 'click', x: 20, y: 10, frameW: 200, frameH: 100 },
    })
    expect(snap.nodes[0]).toMatchObject({ ref: '@e1', role: 'button', name: 'Send' })
    expect(frame).toEqual({ data: 'jpeg-data', mimeType: 'image/jpeg' })
  })

  it('falls back to the full open-Chrome instruction when the relay gives no reason (P1.4)', async () => {
    const { transport } = transportRecording(() => ({ ok: false, error: '', code: 'no_extension' }))
    const provider = createLocalBrowserProvider({ transport })
    const err = await provider.snapshot(CTX).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BrowserBackendError)
    expect((err as BrowserBackendError).code).toBe('no_extension')
    expect((err as BrowserBackendError).message).toBe(NO_EXTENSION_MESSAGE)
  })

  it('keeps the relay’s reason for a no_extension, and still says what to do', async () => {
    // The relay distinguishes three situations under this one code: never
    // connected, disconnected, and evicted by a newer pairing. Overwriting all
    // three with one sentence made an eviction storm byte-identical to a
    // missing install in the database, so it could not be diagnosed after the
    // fact — and it told users whose extension was open to go install it.
    const { transport } = transportRecording(() => ({
      ok: false,
      error: 'Extension connection was replaced by a newer pairing.',
      code: 'no_extension',
    }))
    const provider = createLocalBrowserProvider({ transport })
    const err = await provider.snapshot(CTX).catch((e: unknown) => e)
    const message = (err as BrowserBackendError).message
    expect(message).toContain('replaced by a newer pairing')
    expect(message).toContain(NO_EXTENSION_REMEDY)
  })

  it('passes no_eligible_tab through rather than flattening it to backend_error', async () => {
    // An unrecognised code becomes `backend_error`, which is how four
    // unrelated failures came to share one bucket in prod. A tab the debugger
    // cannot attach to has its own remedy, so it keeps its own code.
    const { transport } = transportRecording(() => ({
      ok: false,
      error: 'Use Brian cannot act on a browser settings page.',
      code: 'no_eligible_tab',
    }))
    const provider = createLocalBrowserProvider({ transport })
    const err = await provider.snapshot(CTX).catch((e: unknown) => e)
    expect((err as BrowserBackendError).code).toBe('no_eligible_tab')
    expect((err as BrowserBackendError).message).toContain('browser settings page')
  })

  it('passes no_browser_permission through rather than flattening it to backend_error', async () => {
    // The extension throws this for "the user has not granted browser control
    // yet" — the one browser failure with an obvious remedy. The accept-set
    // was a second, hand-written copy of the code union and had never heard of
    // it, so it arrived at the model indistinguishable from an unknown
    // failure. The set is now derived from BROWSER_BACKEND_ERROR_CODES.
    const { transport } = transportRecording(() => ({
      ok: false,
      error: 'Use Brian is not allowed to manage this browser yet.',
      code: 'no_browser_permission',
    }))
    const provider = createLocalBrowserProvider({ transport })
    const err = await provider.snapshot(CTX).catch((e: unknown) => e)
    expect((err as BrowserBackendError).code).toBe('no_browser_permission')
  })

  it('accepts every code the union declares, with no second list to drift', async () => {
    // The guard on the drift itself: if a code is added to the union and the
    // accept-set is somehow reintroduced by hand, this fails.
    for (const code of BROWSER_BACKEND_ERROR_CODES) {
      const { transport } = transportRecording(() => ({ ok: false, error: 'x', code }))
      const provider = createLocalBrowserProvider({ transport })
      const err = await provider.snapshot(CTX).catch((e: unknown) => e)
      expect((err as BrowserBackendError).code).toBe(code)
    }
  })

  it('appends the stale-extension remedy to a failure, without losing the failure', async () => {
    // Ordering is the point: the model still reports what actually broke, and
    // the thing the user can act on rides along. A stale extension is why the
    // 2026-08-03 report was unactionable — nothing anywhere said the build was
    // eleven days old.
    const { transport } = transportRecording(() => ({
      ok: false,
      error: 'Something specific went wrong.',
      code: 'backend_error',
      staleBuild: true,
    }))
    const provider = createLocalBrowserProvider({ transport })
    const err = await provider.snapshot(CTX).catch((e: unknown) => e)
    const message = (err as BrowserBackendError).message
    expect(message).toContain('Something specific went wrong.')
    expect(message).toContain(STALE_EXTENSION_REMEDY)
  })

  it('says nothing about staleness when the relay did not flag it', async () => {
    const { transport } = transportRecording(() => ({
      ok: false,
      error: 'Something specific went wrong.',
      code: 'backend_error',
    }))
    const provider = createLocalBrowserProvider({ transport })
    const err = await provider.snapshot(CTX).catch((e: unknown) => e)
    expect((err as BrowserBackendError).message).toBe('Something specific went wrong.')
  })

  it('reports not_configured when no relay transport is wired (open-core boot)', async () => {
    const provider = createLocalBrowserProvider({ transport: null })
    const err = await provider.navigate(CTX, 'https://example.com/').catch((e: unknown) => e)
    expect((err as BrowserBackendError).code).toBe('not_configured')
  })

  it('passes through known backend error codes (user Stop)', async () => {
    const { transport } = transportRecording(() => ({ ok: false, error: 'user stopped the task', code: 'stopped' }))
    const provider = createLocalBrowserProvider({ transport })
    const err = await provider.click(CTX, '@e1').catch((e: unknown) => e)
    expect((err as BrowserBackendError).code).toBe('stopped')
  })

  it('passes through the extension refusal codes instead of flattening them', async () => {
    // `detached` (Chrome ended the CDP session) and `consent_denied` (the user
    // said no in the Allow window) are both actionable states with distinct
    // recoveries. Collapsing them into `backend_error` is what let a prod
    // browse read as a site problem: the model told the user Luma was blocking
    // automation when Chrome had simply dropped the debugger.
    for (const code of ['detached', 'consent_denied'] as const) {
      const { transport } = transportRecording(() => ({ ok: false, error: `nope: ${code}`, code }))
      const provider = createLocalBrowserProvider({ transport })
      const err = await provider.snapshot(CTX).catch((e: unknown) => e)
      expect((err as BrowserBackendError).code).toBe(code)
    }
  })

  it('preserves Firefox setup failures so the user gets the right remedy', async () => {
    for (const code of [
      'firefox_companion_missing',
      'firefox_restart_required',
      'unsupported_browser',
    ] as const) {
      const { transport } = transportRecording(() => ({ ok: false, error: `nope: ${code}`, code }))
      const provider = createLocalBrowserProvider({ transport })
      const err = await provider.snapshot(CTX).catch((e: unknown) => e)
      expect((err as BrowserBackendError).code).toBe(code)
    }
  })

  it('rejects a malformed snapshot payload at the zod boundary', async () => {
    const { transport } = transportRecording(() => ({ ok: true, data: { nodes: 'nope' } }))
    const provider = createLocalBrowserProvider({ transport })
    await expect(provider.snapshot(CTX)).rejects.toThrow()
  })
})

// ── CloudBrowserProvider: stateless connect-by-id per op ───────

describe('[COMP:sandbox/browser-provider] CloudBrowserProvider', () => {
  it('resolves the task sandbox and connects by id on every op (stateless orchestrator discipline)', async () => {
    const stub = new StubSandboxProvider()
    const { sandboxId } = await stub.create({ workspaceId: 'ws-1', taskId: 'task-1' })
    let resolves = 0
    const provider = createCloudBrowserProvider({
      provider: stub,
      binding: {
        resolve: async () => {
          resolves += 1
          return { sandboxId }
        },
      },
    })

    await provider.navigate(CTX, 'https://news.ycombinator.com/')
    await provider.snapshot(CTX)
    await provider.currentUrl(CTX)

    expect(resolves).toBe(3)
    const actions = stub.sandboxes.get(sandboxId)?.actions.map((a) => a.op)
    expect(actions).toEqual(['navigate', 'snapshot'])
  })

  it('reports not_configured when no sandbox provider is wired', async () => {
    const provider = createCloudBrowserProvider({ provider: null, binding: null })
    const err = await provider.snapshot(CTX).catch((e: unknown) => e)
    expect((err as BrowserBackendError).code).toBe('not_configured')
  })

  it('works identically against the stub provider (the §4.3 seam-swap proof at the browser surface)', async () => {
    const stub = new StubSandboxProvider({
      defaultSnapshot: {
        url: '',
        title: '',
        nodes: [{ ref: '@e1', role: 'link', name: 'Front page' }],
      },
    })
    const { sandboxId } = await stub.create({ workspaceId: 'ws-1', taskId: 'task-1' })
    const provider = createCloudBrowserProvider({
      provider: stub,
      binding: { resolve: async () => ({ sandboxId }) },
    })
    await provider.navigate(CTX, 'https://example.org/')
    const snap = await provider.snapshot(CTX)
    expect(snap.url).toBe('https://example.org/')
    expect(snap.nodes[0]?.name).toBe('Front page')
  })
})
