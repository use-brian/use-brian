import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createCodexAppServerProvider } from '../provider.js'
import {
  CodexProtocolError,
  CodexRpcClosedError,
  CodexRpcPeer,
  CodexRpcRemoteError,
  readCodexRpcTimeoutDiagnostics,
} from '../rpc.js'

type Harness = {
  peer: CodexRpcPeer
  inbound: PassThrough
  outbound: unknown[]
}

function createHarness(options: {
  maxFrameBytes?: number
  maxPendingRequests?: number
  requestTimeoutMs?: number
} = {}): Harness {
  const inbound = new PassThrough()
  const output = new PassThrough()
  const outbound: unknown[] = []
  let buffered = ''
  output.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8')
    let newline = buffered.indexOf('\n')
    while (newline !== -1) {
      outbound.push(JSON.parse(buffered.slice(0, newline)))
      buffered = buffered.slice(newline + 1)
      newline = buffered.indexOf('\n')
    }
  })
  return {
    peer: new CodexRpcPeer({ input: inbound, output, ...options }),
    inbound,
    outbound,
  }
}

async function waitForOutbound(harness: Harness, count = 1): Promise<void> {
  await vi.waitFor(() => expect(harness.outbound).toHaveLength(count))
}

function queuedHarness() {
  const inbound = new PassThrough(), outbound: Array<Record<string, unknown>> = []
  let release!: () => void
  const output = new Writable({ write(chunk, _encoding, done) {
    outbound.push(JSON.parse(chunk.toString()))
    if (outbound.length === 1) release = () => done()
    else done()
  } })
  return { peer: new CodexRpcPeer({ input: inbound,output }),inbound,outbound,release: () => release() }
}

describe('[COMP:providers/codex-rpc] Codex app-server JSONL RPC', () => {
  it('withholds a refused request without poisoning independent requests on the peer', async () => {
    const harness = createHarness()
    try {
      await expect(harness.peer.request('turn/start', { input: 'Fictional private input' },z.object({}), {
        assertInputAuthority: async () => { throw new Error('Permission withdrawn') },
      })).rejects.toMatchObject({ reason: 'authority_changed',retrySafe: false })
      expect(harness.outbound).toEqual([])
      expect(harness.peer.closed).toBe(false)
      const next = harness.peer.request('model/list',{},z.object({ ok: z.boolean() }))
      await waitForOutbound(harness)
      harness.inbound.write(`${JSON.stringify({ id: (harness.outbound[0] as { id: number }).id,result: { ok: true } })}\n`)
      await expect(next).resolves.toEqual({ ok: true })
      expect(JSON.stringify(harness.outbound)).not.toContain('assertInputAuthority')
    } finally { harness.peer.close() }
  })

  it('checks queued requests after backpressure and drops a newly refused payload', async () => {
    const harness = queuedHarness(); let revoked = false
    const check = vi.fn(async () => { if (revoked) throw new Error('Permission withdrawn') })
    try {
      const first = harness.peer.notify('fixture/barrier',{})
      await vi.waitFor(() => expect(harness.outbound).toHaveLength(1))
      const blocked = expect(harness.peer.request('turn/start',{ input: 'Withheld private input' },z.object({}), { assertInputAuthority: check }))
        .rejects.toMatchObject({ reason: 'authority_changed' })
      expect(check).not.toHaveBeenCalled()
      revoked = true; harness.release()
      await first; await blocked
      expect(harness.outbound).toHaveLength(1)
      expect(check).toHaveBeenCalledOnce()
      expect(harness.peer.closed).toBe(false)
    } finally { harness.peer.close() }
  })

  it('lets an independent authorization and ordered control frames pass a slow proof', async () => {
    const harness = createHarness()
    let release!: () => void
    const check = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
      .mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    try {
      const slow = harness.peer.request('thread/start', { input: 'Slow fixture' }, z.object({}), { assertInputAuthority: check })
      expect(check).toHaveBeenCalledOnce()
      const fast = harness.peer.request('thread/start', { input: 'Ready fixture' }, z.object({}), { assertInputAuthority: async () => {} })
      await waitForOutbound(harness)
      expect(harness.outbound).toEqual([{ id: 2, method: 'thread/start', params: { input: 'Ready fixture' } }])
      harness.inbound.write('{"id":2,"result":{}}\n')
      await fast
      await harness.peer.notify('fixture/ready', {})
      const interrupt = harness.peer.request('turn/interrupt', {}, z.object({}))
      await waitForOutbound(harness, 3)
      expect(harness.outbound.slice(1)).toEqual([
        { method: 'fixture/ready', params: {} }, { id: 3, method: 'turn/interrupt', params: {} },
      ])
      harness.inbound.write('{"id":3,"result":{}}\n')
      await interrupt
      release()
      await waitForOutbound(harness, 4)
      expect(harness.outbound[3]).toEqual({ id: 1, method: 'thread/start', params: { input: 'Slow fixture' } })
      harness.inbound.write('{"id":1,"result":{}}\n')
      await slow
    } finally { harness.peer.close() }
  })

  it('rechecks a proof overtaken by a competing stdin write and withholds a now-revoked payload', async () => {
    const harness = queuedHarness()
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    let revoked = false
    const firstCheck = () => new Promise<void>(resolve => { releaseFirst = resolve })
    const secondCheck = vi.fn(async () => {
      if (revoked) throw new Error('Permission withdrawn')
      await new Promise<void>(resolve => { releaseSecond = resolve })
    })
    try {
      const first = harness.peer.request('thread/start', { input: 'First fixture' }, z.object({}), { assertInputAuthority: firstCheck })
      const second = expect(harness.peer.request('thread/start', { input: 'Never submitted' }, z.object({}), { assertInputAuthority: secondCheck }))
        .rejects.toMatchObject({ reason: 'authority_changed' })
      expect(secondCheck).toHaveBeenCalledOnce()
      releaseFirst()
      await vi.waitFor(() => expect(harness.outbound).toHaveLength(1))
      releaseSecond()
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(secondCheck).toHaveBeenCalledOnce()
      revoked = true
      harness.release()
      harness.inbound.write('{"id":1,"result":{}}\n')
      await first
      await second
      expect(secondCheck).toHaveBeenCalledTimes(2)
      expect(harness.outbound).toHaveLength(1)
      expect(harness.peer.closed).toBe(false)
    } finally { harness.peer.close() }
  })

  it('rechecks after a control frame has already finished writing while authorization awaited', async () => {
    const harness = createHarness()
    let finish!: () => void
    let revoked = false
    const check = vi.fn(async () => { if (revoked) throw new Error('Permission withdrawn') })
      .mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    try {
      const protectedFrame = expect(harness.peer.request('thread/start', { input: 'Never submitted' }, z.object({}), {
        assertInputAuthority: check,
      })).rejects.toMatchObject({ reason: 'authority_changed' })
      await harness.peer.notify('fixture/passed', {})
      revoked = true
      finish()
      await protectedFrame
      expect(check).toHaveBeenCalledTimes(2)
      expect(harness.outbound).toEqual([{ method: 'fixture/passed', params: {} }])
      expect(harness.peer.closed).toBe(false)
    } finally { harness.peer.close() }
  })

  it('runs one proof per owner and discards a cancelled sibling before starting its proof', async () => {
    const harness = createHarness()
    const authorityOwner = {}, controller = new AbortController()
    let release!: () => void
    const firstCheck = () => new Promise<void>(resolve => { release = resolve })
    const siblingCheck = vi.fn(async () => {})
    try {
      const first = harness.peer.request('thread/start', {}, z.object({}), { authorityOwner, assertInputAuthority: firstCheck })
      const cancelled = expect(harness.peer.request('turn/start', {}, z.object({}), {
        authorityOwner, assertInputAuthority: siblingCheck, signal: controller.signal,
      })).rejects.toMatchObject({ name: 'AbortError' })
      controller.abort()
      await cancelled
      release()
      await waitForOutbound(harness)
      harness.inbound.write('{"id":1,"result":{}}\n')
      await first
      expect(siblingCheck).not.toHaveBeenCalled()
      expect(harness.outbound).toHaveLength(1)
    } finally { harness.peer.close() }
  })

  it('keeps a timed-out proof in the peer limit until its work settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const harness = createHarness({ maxPendingRequests: 1, requestTimeoutMs: 10 })
    let settle!: () => void
    const check = vi.fn(async () => {})
    try {
      const stalled = expect(harness.peer.request('thread/start', {}, z.object({}), {
        assertInputAuthority: () => new Promise<void>(resolve => { settle = resolve }),
      })).rejects.toThrow('phase=input_authority')
      await vi.advanceTimersByTimeAsync(10)
      await stalled
      expect(harness.peer.pendingRequestCount).toBe(0)
      await expect(harness.peer.request('thread/start', {}, z.object({}), { assertInputAuthority: check }))
        .rejects.toThrow('authority check limit exceeded')
      expect(check).not.toHaveBeenCalled()
      expect(harness.outbound).toEqual([])
      settle()
      await new Promise<void>(resolve => setImmediate(resolve))
      const healthy = harness.peer.request('thread/start', {}, z.object({}), { assertInputAuthority: check })
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(check).toHaveBeenCalledOnce()
      expect(harness.outbound).toEqual([{ id: 3, method: 'thread/start', params: {} }])
      harness.inbound.write('{"id":3,"result":{}}\n')
      await healthy
    } finally { harness.peer.close(); vi.useRealTimers() }
  })

  it('checks opaque tool responses at the queued write and returns a fixed safe error', async () => {
    const harness = queuedHarness(); let revoked = false, bound = false
    try {
      const first = harness.peer.notify('fixture/barrier',{})
      await vi.waitFor(() => expect(harness.outbound).toHaveLength(1))
      harness.peer.onRequest('item/tool/call', () => {
        bound = true
        return harness.peer.guardResponse({ content: 'Withheld fictional cost' },async () => { if (revoked) throw new Error('Permission withdrawn') })
      })
      harness.inbound.write(`${JSON.stringify({ id: 'guarded-tool',method: 'item/tool/call',params: {} })}\n`)
      await vi.waitFor(() => expect(bound).toBe(true))
      revoked = true; harness.release(); await first
      await vi.waitFor(() => expect(harness.outbound).toHaveLength(2))
      expect(harness.outbound[1]).toEqual({ id: 'guarded-tool',error: { code: -32603,message: 'Request handler failed' } })
      expect(JSON.stringify(harness.outbound)).not.toContain('Withheld fictional cost')
      expect(harness.peer.closed).toBe(false)
    } finally { harness.peer.close() }
  })

  it('drops a cancelled queued request without sending it or closing the peer', async () => {
    const harness = queuedHarness(), controller = new AbortController()
    try {
      const first = harness.peer.notify('fixture/barrier',{})
      await vi.waitFor(() => expect(harness.outbound).toHaveLength(1))
      const cancelled = expect(harness.peer.request('turn/start',{ input: 'Cancelled private input' },z.object({}), { signal: controller.signal }))
        .rejects.toMatchObject({ name: 'AbortError' })
      controller.abort(); await cancelled
      harness.release(); await first
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(harness.outbound).toHaveLength(1)
      expect(harness.peer.pendingRequestCount).toBe(0)
      expect(harness.peer.closed).toBe(false)
    } finally { harness.peer.close() }
  })

  it('correlates a validated response with its request', async () => {
    const harness = createHarness()
    const response = harness.peer.request(
      'initialize',
      { clientInfo: { name: 'test', version: '1' } },
      z.object({ userAgent: z.string() }),
    )

    await waitForOutbound(harness)
    const request = harness.outbound[0] as { id: number }
    harness.inbound.write(`${JSON.stringify({ id: request.id, result: { userAgent: 'codex-test' } })}\n`)

    await expect(response).resolves.toEqual({ userAgent: 'codex-test' })
    expect(harness.peer.pendingRequestCount).toBe(0)
    harness.peer.close()
  })

  it('accepts a response split across arbitrary chunks and CRLF framing', async () => {
    const harness = createHarness()
    const response = harness.peer.request('model/list', {}, z.object({ data: z.array(z.string()) }))
    await waitForOutbound(harness)
    const request = harness.outbound[0] as { id: number }
    const frame = JSON.stringify({ id: request.id, result: { data: ['gpt-test'] } })

    harness.inbound.write(frame.slice(0, 7))
    harness.inbound.write(frame.slice(7))
    harness.inbound.write('\r\n')

    await expect(response).resolves.toEqual({ data: ['gpt-test'] })
    harness.peer.close()
  })

  it('fans out notifications without allowing observer failures to close the peer', async () => {
    const harness = createHarness()
    const first = vi.fn()
    const second = vi.fn(() => {
      throw new Error('observer failed')
    })
    harness.peer.onNotification('account/updated', first)
    harness.peer.onNotification('account/updated', second)

    harness.inbound.write(
      `${JSON.stringify({ method: 'account/updated', params: { connected: true } })}\n`,
    )
    await vi.waitFor(() => expect(first).toHaveBeenCalledWith({ connected: true }))

    expect(second).toHaveBeenCalledOnce()
    expect(harness.peer.closed).toBe(false)
    harness.peer.close()
  })

  it('handles server-initiated requests and returns a correlated result', async () => {
    const harness = createHarness()
    harness.peer.onRequest('dynamicToolCall', async (params) => ({
      success: true,
      contentItems: [{ type: 'inputText', text: JSON.stringify(params) }],
    }))

    harness.inbound.write(
      `${JSON.stringify({ id: 'server-1', method: 'dynamicToolCall', params: { name: 'lookup' } })}\n`,
    )
    await waitForOutbound(harness)

    expect(harness.outbound[0]).toEqual({
      id: 'server-1',
      result: {
        success: true,
        contentItems: [{ type: 'inputText', text: '{"name":"lookup"}' }],
      },
    })
    harness.peer.close()
  })

  it('fails closed on an unregistered server request', async () => {
    const harness = createHarness()
    harness.inbound.write(
      `${JSON.stringify({ id: 'server-2', method: 'command/exec', params: { cmd: 'touch nope' } })}\n`,
    )
    await waitForOutbound(harness)

    expect(harness.outbound[0]).toEqual({
      id: 'server-2',
      error: { code: -32601, message: 'Method not found' },
    })
    expect(harness.peer.closed).toBe(false)
    harness.peer.close()
  })

  it('maps remote errors without logging or wrapping their data', async () => {
    const harness = createHarness()
    const response = harness.peer.request('account/read', {}, z.object({}))
    await waitForOutbound(harness)
    const request = harness.outbound[0] as { id: number }
    harness.inbound.write(
      `${JSON.stringify({
        id: request.id,
        error: { code: 401, message: 'reauthentication required', data: { retry: false } },
      })}\n`,
    )

    await expect(response).rejects.toMatchObject({
      name: 'CodexRpcRemoteError',
      code: 401,
      data: { retry: false },
    })
    harness.peer.close()
  })

  it('rejects a method result that violates its Zod contract', async () => {
    const harness = createHarness()
    const response = harness.peer.request('model/list', {}, z.object({ data: z.array(z.string()) }))
    await waitForOutbound(harness)
    const request = harness.outbound[0] as { id: number }
    harness.inbound.write(`${JSON.stringify({ id: request.id, result: { data: [123] } })}\n`)

    await expect(response).rejects.toBeInstanceOf(CodexProtocolError)
    expect(harness.peer.closed).toBe(false)
    harness.peer.close()
  })

  it('closes on malformed JSON and rejects pending work', async () => {
    const harness = createHarness()
    const response = harness.peer.request('account/read', {}, z.object({}))
    await waitForOutbound(harness)

    harness.inbound.write('{"id":\n')

    await expect(response).rejects.toThrow('malformed JSON')
    expect(harness.peer.closed).toBe(true)
  })

  it('closes before buffering an oversized frame', async () => {
    const harness = createHarness({ maxFrameBytes: 128 })
    const response = harness.peer.request('account/read', {}, z.object({}))
    await waitForOutbound(harness)

    harness.inbound.write('x'.repeat(129))

    await expect(response).rejects.toThrow('exceeded 128 bytes')
    expect(harness.peer.closed).toBe(true)
  })

  it('closes before writing an oversized outbound frame', async () => {
    const harness = createHarness({ maxFrameBytes: 64 })

    await expect(
      harness.peer.request('oversized', { input: 'x'.repeat(80) }, z.object({})),
    ).rejects.toThrow('outbound JSONL frame exceeded 64 bytes')
    expect(harness.peer.closed).toBe(true)
    expect(harness.outbound).toEqual([])
  })

  it('rejects ambiguous envelopes instead of guessing their direction', async () => {
    const harness = createHarness()
    const closed = new Promise<Error>((resolve) => harness.peer.onClose(resolve))
    harness.inbound.write(
      `${JSON.stringify({ id: 1, method: 'turn/start', result: { accepted: true } })}\n`,
    )

    await expect(closed).resolves.toBeInstanceOf(CodexProtocolError)
  })

  it('closes on a response id that was never requested', async () => {
    const harness = createHarness()
    const closed = new Promise<Error>((resolve) => harness.peer.onClose(resolve))
    harness.inbound.write(`${JSON.stringify({ id: 999, result: {} })}\n`)

    await expect(closed).resolves.toBeInstanceOf(CodexProtocolError)
    expect(harness.peer.closed).toBe(true)
  })

  it('enforces the pending-request bound', async () => {
    const harness = createHarness({ maxPendingRequests: 1 })
    const first = harness.peer.request('first', {}, z.object({}))
    await waitForOutbound(harness)

    await expect(harness.peer.request('second', {}, z.object({}))).rejects.toThrow(
      'pending request limit exceeded',
    )
    harness.peer.close()
    await expect(first).rejects.toBeInstanceOf(CodexRpcClosedError)
  })

  it('distinguishes a stalled stdin write from a request still in the write queue', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const harness = queuedHarness()
    try {
      const check = vi.fn(async () => {})
      const options = { timeoutMs: 25, assertInputAuthority: check }
      const written = harness.peer.request('thread/start', { input: 'First private input' }, z.object({}), options)
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(harness.outbound).toHaveLength(1)
      const queued = harness.peer.request('thread/start', { input: 'Second private input' }, z.object({}), options)
      const results = Promise.allSettled([written, queued])
      expect(check).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(25)
      expect(await results).toMatchObject([
        { status: 'rejected', reason: { name: 'CodexProtocolError', message: expect.stringContaining('(phase=stdin_write, write_queue_ms=0, input_authority_ms=0, stdin_write_ms=25, awaiting_response_ms=0)') } },
        { status: 'rejected', reason: { name: 'CodexProtocolError', message: expect.stringContaining('(phase=write_queue, write_queue_ms=25, input_authority_ms=0, stdin_write_ms=0, awaiting_response_ms=0)') } },
      ])
      harness.release()
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(harness.outbound).toHaveLength(1)
      expect(check).toHaveBeenCalledTimes(1)
      expect(harness.peer.pendingRequestCount).toBe(0)
      expect(harness.peer.closed).toBe(false)
    } finally {
      harness.peer.close()
      vi.useRealTimers()
    }
  })

  it('withholds a proved frame whose deadline expired before timers could run', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
    const harness = createHarness({ requestTimeoutMs: 10_000 })
    let prove!: () => void
    try {
      const failed = expect(harness.peer.request('thread/start', {}, z.object({}), {
        assertInputAuthority: () => new Promise<void>(resolve => { prove = resolve }),
      })).rejects.toMatchObject({ retrySafe: false, message: expect.stringContaining('phase=input_authority') })
      clock.mockReturnValue(10_000)
      prove()
      await failed
      expect(harness.outbound).toEqual([])
      expect(harness.peer.pendingRequestCount).toBe(0)
      expect(harness.peer.closed).toBe(false)
    } finally { harness.peer.close(); clock.mockRestore() }
  })

  it('checks the submission fence after proof completion and never serializes it', async () => {
    const harness = createHarness()
    let finish!: () => void
    let current = true
    try {
      const request = expect(harness.peer.request('thread/start', { input: 'Withheld' }, z.object({}), {
        assertInputAuthority: async () => {
          await new Promise<void>(resolve => { finish = resolve })
          queueMicrotask(() => { current = false })
          return () => { if (!current) throw Object.assign(new Error('Permission withdrawn'), { reason: 'authority_changed' }) }
        },
      })).rejects.toMatchObject({ reason: 'authority_changed' })
      finish()
      await request
      expect(harness.outbound).toEqual([])
      expect(harness.peer.closed).toBe(false)
    } finally { harness.peer.close() }
  })

  it('withholds the provider thread frame if its session closes during authorization', async () => {
    const harness = createHarness()
    const provider = createCodexAppServerProvider({ transport: { rpc: harness.peer, cwd: '/fictional' }, models: ['gpt-6.2-sol'] })
    let release!: () => void
    const check = vi.fn<() => Promise<void>>().mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    const session = provider.createSession!({ model: 'gpt-6.2-sol', systemPrompt: 'Fictional private setup.' })
    try {
      const drain = async () => {
        for await (const _ of session.send([{ role: 'user', content: 'Fictional input.' }], { assertInputAuthority: check })) { /* drain */ }
      }
      const rejected = expect(drain()).rejects.toMatchObject({ reason: 'authority_changed', retrySafe: false })
      await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(2))
      if (!('dispose' in session) || typeof session.dispose !== 'function') throw new Error('Fixture has no session disposal')
      await session.dispose()
      release()
      await rejected
      expect(harness.outbound).toEqual([])
      expect(harness.peer.closed).toBe(false)
    } finally { harness.peer.close() }
  })

  it('distinguishes an unfinished authority check from a flushed request without a response', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const harness = createHarness({ requestTimeoutMs: 25 })
    try {
      const written = harness.peer.request('thread/start', { input: 'First private input' }, z.object({}))
      let finishCheck!: () => void
      const check = vi.fn(() => new Promise<void>(resolve => { finishCheck = resolve }))
      const withheld = harness.peer.request('thread/start', { input: 'Second private input' }, z.object({}), {
        assertInputAuthority: check,
      })
      const results = Promise.allSettled([written, withheld])
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(harness.outbound).toHaveLength(1)
      expect(check).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(25)
      expect(await results).toMatchObject([
        { status: 'rejected', reason: { name: 'CodexProtocolError', message: expect.stringContaining('(phase=awaiting_response, write_queue_ms=0, input_authority_ms=0, stdin_write_ms=0, awaiting_response_ms=25)') } },
        { status: 'rejected', reason: { name: 'CodexProtocolError', message: expect.stringContaining('(phase=input_authority, write_queue_ms=0, input_authority_ms=25, stdin_write_ms=0, awaiting_response_ms=0)') } },
      ])
      finishCheck()
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(harness.outbound).toHaveLength(1)
      expect(harness.peer.pendingRequestCount).toBe(0)
      expect(harness.peer.closed).toBe(false)
    } finally {
      harness.peer.close()
      vi.useRealTimers()
    }
  })

  it('reports the permission-check duration when a flushed request times out awaiting the child', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const harness = createHarness({ requestTimeoutMs: 25 })
    try {
      const request = harness.peer.request('thread/start', { input: 'Private input' }, z.object({}), {
        assertInputAuthority: () => new Promise(resolve => setTimeout(resolve, 20)),
      })
      const diagnostics = request.catch(error => readCodexRpcTimeoutDiagnostics(error))
      const failure = expect(request).rejects.toMatchObject({
        name: 'CodexProtocolError',
        message: 'Codex app-server RPC request timed out: thread/start ' +
          '(phase=awaiting_response, write_queue_ms=0, input_authority_ms=20, stdin_write_ms=0, awaiting_response_ms=5)',
      })
      await new Promise<void>(resolve => setImmediate(resolve))
      await vi.advanceTimersByTimeAsync(20)
      expect(harness.outbound).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(5)
      await failure
      expect(await diagnostics).toEqual({ method: 'thread/start', phase: 'awaiting_response',
        elapsedMs: { write_queue: 0, input_authority: 20, stdin_write: 0, awaiting_response: 5 } })
    } finally {
      harness.peer.close()
      vi.useRealTimers()
    }
  })

  it('honors per-request abort signals', async () => {
    const harness = createHarness()
    const controller = new AbortController()
    const response = harness.peer.request('slow', {}, z.object({}), {
      signal: controller.signal,
    })
    await waitForOutbound(harness)
    controller.abort()

    await expect(response).rejects.toMatchObject({ name: 'AbortError' })
    expect(harness.peer.pendingRequestCount).toBe(0)
    harness.peer.close()
  })

  it('rejects an incomplete final frame when stdout ends', async () => {
    const harness = createHarness()
    const response = harness.peer.request('account/read', {}, z.object({}))
    await waitForOutbound(harness)
    harness.inbound.end('{"id":1')

    await expect(response).rejects.toThrow('incomplete JSONL frame')
  })
})
