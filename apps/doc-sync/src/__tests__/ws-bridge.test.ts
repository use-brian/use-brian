import { describe, it, expect, vi } from 'vitest'
import { bridgeConnection, toUint8Array, type SocketLike } from '../ws-bridge.js'

/**
 * A hand-rolled `ws`-shaped fake: records listeners by event name and lets a
 * test `emit` them. Avoids a real socket/server — this is the pure forwarding
 * contract that, when broken (the v4 `handleConnection` return discarded),
 * left the editor stuck on "Reconnecting…".
 */
function fakeSocket() {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {}
  const socket = {
    on(event: string, listener: (...args: unknown[]) => void) {
      ;(listeners[event] ??= []).push(listener)
      return socket
    },
  }
  return {
    socket: socket as unknown as SocketLike,
    emit(event: string, ...args: unknown[]) {
      for (const l of listeners[event] ?? []) l(...args)
    },
    has(event: string) {
      return (listeners[event]?.length ?? 0) > 0
    },
  }
}

describe('[COMP:doc-sync/ws-bridge] WS → Hocuspocus connection bridge', () => {
  it('forwards a binary message to handleMessage as a copied Uint8Array', () => {
    const connection = { handleMessage: vi.fn(), handleClose: vi.fn() }
    const ws = fakeSocket()
    bridgeConnection(connection, ws.socket)

    const buf = Buffer.from([1, 2, 3, 250])
    ws.emit('message', buf)

    expect(connection.handleMessage).toHaveBeenCalledTimes(1)
    const arg = connection.handleMessage.mock.calls[0][0]
    expect(arg).toBeInstanceOf(Uint8Array)
    expect(Array.from(arg)).toEqual([1, 2, 3, 250])
    // Must be a copy, not a view over the (poolable) Node Buffer.
    expect(arg.buffer).not.toBe(buf.buffer)
  })

  it('forwards close with the numeric code and a stringified reason', () => {
    const connection = { handleMessage: vi.fn(), handleClose: vi.fn() }
    const ws = fakeSocket()
    bridgeConnection(connection, ws.socket)

    ws.emit('close', 1000, Buffer.from('bye'))

    expect(connection.handleClose).toHaveBeenCalledWith({ code: 1000, reason: 'bye' })
  })

  it('tolerates a missing close reason', () => {
    const connection = { handleMessage: vi.fn(), handleClose: vi.fn() }
    const ws = fakeSocket()
    bridgeConnection(connection, ws.socket)

    ws.emit('close', 1006, undefined)

    expect(connection.handleClose).toHaveBeenCalledWith({ code: 1006, reason: '' })
  })

  it('routes socket errors to the onError callback', () => {
    const connection = { handleMessage: vi.fn(), handleClose: vi.fn() }
    const ws = fakeSocket()
    const onError = vi.fn()
    bridgeConnection(connection, ws.socket, onError)

    const err = new Error('boom')
    ws.emit('error', err)

    expect(onError).toHaveBeenCalledWith(err)
  })

  it('registers all three socket listeners', () => {
    const connection = { handleMessage: vi.fn(), handleClose: vi.fn() }
    const ws = fakeSocket()
    bridgeConnection(connection, ws.socket)

    expect(ws.has('message')).toBe(true)
    expect(ws.has('close')).toBe(true)
    expect(ws.has('error')).toBe(true)
  })
})

describe('[COMP:doc-sync/ws-bridge] toUint8Array', () => {
  it('copies a Node Buffer', () => {
    const buf = Buffer.from([9, 8, 7])
    const out = toUint8Array(buf)
    expect(Array.from(out)).toEqual([9, 8, 7])
    expect(out.buffer).not.toBe(buf.buffer)
  })

  it('concatenates a fragment array', () => {
    const out = toUint8Array([Buffer.from([1, 2]), Buffer.from([3])])
    expect(Array.from(out)).toEqual([1, 2, 3])
  })

  it('copies from an ArrayBuffer', () => {
    const src = new Uint8Array([4, 5, 6])
    const out = toUint8Array(src.buffer)
    expect(Array.from(out)).toEqual([4, 5, 6])
    expect(out.buffer).not.toBe(src.buffer)
  })
})
