import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  CodexProtocolError,
  CodexRpcClosedError,
  CodexRpcPeer,
  CodexRpcRemoteError,
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

describe('[COMP:providers/codex-rpc] Codex app-server JSONL RPC', () => {
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

  it('times out and removes a pending request', async () => {
    const harness = createHarness({ requestTimeoutMs: 10 })
    const response = harness.peer.request('slow', {}, z.object({}))

    await expect(response).rejects.toThrow('request timed out: slow')
    expect(harness.peer.pendingRequestCount).toBe(0)
    harness.peer.close()
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
