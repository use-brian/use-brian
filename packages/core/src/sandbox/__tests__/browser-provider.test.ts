import { describe, it, expect } from 'vitest'
import { createLocalBrowserProvider } from '../local-browser-provider.js'
import { createCloudBrowserProvider } from '../cloud-browser-provider.js'
import { StubSandboxProvider } from '../providers/stub.js'
import {
  BrowserBackendError,
  NO_EXTENSION_MESSAGE,
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
      return { ok: true }
    })
    const provider = createLocalBrowserProvider({ transport })

    await provider.navigate(CTX, 'https://example.com/')
    const snap = await provider.snapshot(CTX)
    await provider.click(CTX, '@e1')
    await provider.type(CTX, '@e2', 'hello there')
    await provider.currentUrl(CTX)
    await provider.stop(CTX)

    expect(sent.map((s) => s.op)).toEqual(['navigate', 'snapshot', 'click', 'type', 'currentUrl', 'stop'])
    expect(sent.every((s) => s.userId === 'user-1')).toBe(true)
    expect(sent[0]?.args).toEqual({ url: 'https://example.com/' })
    expect(sent[2]?.args).toEqual({ ref: '@e1' })
    expect(sent[3]?.args).toEqual({ ref: '@e2', text: 'hello there' })
    expect(snap.nodes[0]).toMatchObject({ ref: '@e1', role: 'button', name: 'Send' })
  })

  it('maps a no_extension relay result to the clear open-Chrome error, never a hang (P1.4)', async () => {
    const { transport } = transportRecording(() => ({
      ok: false,
      error: 'no connection',
      code: 'no_extension',
    }))
    const provider = createLocalBrowserProvider({ transport })
    const err = await provider.snapshot(CTX).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BrowserBackendError)
    expect((err as BrowserBackendError).code).toBe('no_extension')
    expect((err as BrowserBackendError).message).toBe(NO_EXTENSION_MESSAGE)
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
