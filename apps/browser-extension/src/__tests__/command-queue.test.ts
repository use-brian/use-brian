import { describe, expect, it, vi } from 'vitest'
import { CommandQueue } from '../command-queue.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('browser command queue', () => {
  it('serializes overlapping capture polling and actions in arrival order', async () => {
    const queue = new CommandQueue()
    const frame = deferred()
    const calls: string[] = []
    const capture = queue.run(async () => { calls.push('captureFrame'); await frame.promise })
    const action = queue.run(async () => { calls.push('fillForm') })
    const next = queue.run(async () => { calls.push('currentUrl') })
    await Promise.resolve()
    expect(calls).toEqual(['captureFrame'])
    frame.resolve()
    await Promise.all([capture, action, next])
    expect(calls).toEqual(['captureFrame', 'fillForm', 'currentUrl'])
  })

  it('evaluates permissions at execution time and drains after a failure', async () => {
    const queue = new CommandQueue()
    const frame = deferred()
    let allowed = true
    const capture = queue.run(() => frame.promise)
    const action = queue.run(async () => { if (!allowed) throw new Error('permission revoked') })
    const rejected = expect(action).rejects.toThrow('permission revoked')
    allowed = false
    frame.resolve()
    await capture
    await rejected
    await expect(queue.run(async () => 'next')).resolves.toBe('next')
  })

  it('Stop invalidates queued operations and active checkpoints immediately', async () => {
    const queue = new CommandQueue()
    const frame = deferred()
    const active = queue.run(async check => { await frame.promise; check() })
    const operation = vi.fn(async () => 'must not prompt or restart')
    const waiting = queue.run(operation)
    const activeRejected = expect(active).rejects.toMatchObject({ code: 'stopped' })
    const waitingRejected = expect(waiting).rejects.toMatchObject({ code: 'stopped' })
    await Promise.resolve()
    queue.cancel() // Stop does not wait for active CDP work.
    frame.resolve()
    await Promise.all([activeRejected, waitingRejected])
    expect(operation).not.toHaveBeenCalled()
    await expect(queue.run(async () => 'fresh command')).resolves.toBe('fresh command')
  })

  it('immediately rejects waiting work and frees its slots without overlapping the active barrier', async () => {
    const queue = new CommandQueue(2)
    const frame = deferred()
    const active = queue.run(() => frame.promise)
    await Promise.resolve()
    const obsolete = vi.fn(async () => {})
    const rejected = expect(queue.run(obsolete)).rejects.toMatchObject({code:'stopped'})
    queue.cancel()
    await rejected // no need to release the active command to acknowledge cancellation
    const fresh = vi.fn(async () => 'fresh')
    const next = queue.run(fresh)
    await Promise.resolve()
    expect(fresh).not.toHaveBeenCalled()
    frame.resolve()
    await active
    await expect(next).resolves.toBe('fresh')
    expect(obsolete).not.toHaveBeenCalled()
  })

  it('bounds outstanding work and frees capacity after completion', async () => {
    const queue = new CommandQueue(2)
    const frame = deferred()
    const active = queue.run(() => frame.promise)
    const waiting = queue.run(async () => {})
    await expect(queue.run(async () => {})).rejects.toThrow('queue is full')
    frame.resolve()
    await Promise.all([active, waiting])
    await expect(queue.run(async () => 'ok')).resolves.toBe('ok')
  })
})
