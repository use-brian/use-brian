import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createActionPermissionSnapshots,
  PermissionSnapshotUnavailableError,
  type LoadedPermissionSnapshot,
} from '../action-permission-snapshots.js'
import type { PermissionInvalidation, PermissionInvalidationSubscription } from '../permission-events.js'

// Never import the real listener/DB graph, even accidentally via the default subscriber.
vi.mock('../permission-events.js', () => ({
  subscribePermissionInvalidation: () => { throw new Error('Tests must inject subscribe') },
}))

const WORKSPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
type Value = Readonly<{ grants: readonly string[] }>
const value = (grant: string): Value => Object.freeze({ grants: Object.freeze([grant]) })
const loaded = (grant: string, refreshAt?: number): LoadedPermissionSnapshot<Value> =>
  Object.freeze({ value: value(grant), ...(refreshAt === undefined ? {} : { refreshAt }) })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose()
  vi.restoreAllMocks()
})

function fixture(options: { eligible?: boolean; available?: boolean; signal?: AbortSignal } = {}) {
  let clock = 100
  let available = options.available ?? true
  const eligible = options.eligible ?? true
  let listener: ((event: PermissionInvalidation) => void) | undefined
  const unsubscribe = vi.fn(() => { listener = undefined })
  const subscribe = vi.fn((_workspaceId: string, callback: (event: PermissionInvalidation) => void): PermissionInvalidationSubscription => {
    listener = callback
    callback({ dirty: true, eligible, available, reason: 'initial' })
    return { eligible, get available() { return available }, unsubscribe }
  })
  const load = vi.fn<() => Promise<LoadedPermissionSnapshot<Value>>>()
  load.mockResolvedValue(loaded('initial'))
  const now = vi.fn(() => clock)
  const cache = createActionPermissionSnapshots(WORKSPACE, load, { subscribe, now, signal: options.signal })
  cleanup.push(cache.dispose)
  return {
    cache, load, subscribe, unsubscribe, now,
    setNow: (time: number) => { clock = time },
    emit: (reason: PermissionInvalidation['reason'] = 'workspace') => {
      if (reason === 'unavailable') available = false
      if (reason === 'ready') available = true
      listener?.({ dirty: true, eligible, available, reason })
    },
  }
}

function unavailable(promise: Promise<Value>) {
  return expect(promise).rejects.toMatchObject({
    name: 'PermissionSnapshotUnavailableError',
    reason: 'permission_snapshot_unavailable',
    operationMayHaveExecuted: false,
  })
}

describe('action permission snapshots', () => {
  it('subscribes immediately but loads only beforeAction, then reuses a clean snapshot', async () => {
    const f = fixture()
    expect(f.subscribe).toHaveBeenCalledExactlyOnceWith(WORKSPACE, expect.any(Function))
    expect(f.cache.eligible).toBe(true)
    f.emit('global')
    await Promise.resolve()
    expect(f.load).not.toHaveBeenCalled()
    const first = await f.cache.beforeAction()
    expect(await f.cache.beforeAction()).toBe(first)
    expect(f.load).toHaveBeenCalledTimes(1)
  })

  it('coalesces a dirty event burst into one load on the next action only', async () => {
    const f = fixture()
    await f.cache.beforeAction()
    const next = loaded('revoked')
    f.load.mockResolvedValue(next)
    for (const reason of ['workspace', 'global', 'malformed', 'workspace'] as const) f.emit(reason)
    await Promise.resolve()
    expect(f.load).toHaveBeenCalledTimes(1)
    expect(await f.cache.beforeAction()).toBe(next.value)
    expect(await f.cache.beforeAction()).toBe(next.value)
    expect(f.load).toHaveBeenCalledTimes(2)
  })

  it('never mutates or cancels the immutable snapshot held by an active action', async () => {
    const f = fixture()
    const held = await f.cache.beforeAction()
    f.emit()
    f.load.mockResolvedValue(loaded('replacement'))
    const next = await f.cache.beforeAction()
    expect(next).not.toBe(held)
    expect(held).toEqual({ grants: ['initial'] })
    expect(Object.isFrozen(held)).toBe(true)
    expect(Object.isFrozen(held.grants)).toBe(true)
    f.emit('unavailable')
    f.cache.dispose()
    expect(held.grants).toEqual(['initial'])
  })

  it('keeps invalidations during a refresh pending for the following action without retrying the current load', async () => {
    const f = fixture()
    const pending = deferred<LoadedPermissionSnapshot<Value>>()
    f.load.mockReturnValueOnce(pending.promise)
    const action = f.cache.beforeAction()
    await Promise.resolve()
    expect(f.load).toHaveBeenCalledTimes(1)
    f.emit()
    f.emit('global')
    const current = loaded('current')
    pending.resolve(current)
    expect(await action).toBe(current.value)
    expect(f.load).toHaveBeenCalledTimes(1)
    const following = loaded('following')
    f.load.mockResolvedValue(following)
    expect(await f.cache.beforeAction()).toBe(following.value)
    expect(await f.cache.beforeAction()).toBe(following.value)
    expect(f.load).toHaveBeenCalledTimes(2)
  })

  it('single-flights parallel starts on both initial load and a dirty refresh', async () => {
    const f = fixture()
    for (let round = 0; round < 2; round++) {
      const pending = deferred<LoadedPermissionSnapshot<Value>>()
      f.load.mockReturnValueOnce(pending.promise)
      const starts = [f.cache.beforeAction(), f.cache.beforeAction(), f.cache.beforeAction()]
      await Promise.resolve()
      expect(f.load).toHaveBeenCalledTimes(round + 1)
      const snapshot = loaded(`round-${round}`)
      pending.resolve(snapshot)
      for (const result of await Promise.all(starts)) expect(result).toBe(snapshot.value)
      f.emit()
    }
  })

  it('rejects all waiting actions on refresh failure, never returns stale grants, and retries next time', async () => {
    const f = fixture()
    const held = await f.cache.beforeAction()
    f.emit()
    const pending = deferred<LoadedPermissionSnapshot<Value>>()
    const error = new Error('permission read failed')
    f.load.mockReturnValueOnce(pending.promise)
    const first = expect(f.cache.beforeAction()).rejects.toBe(error)
    const second = expect(f.cache.beforeAction()).rejects.toBe(error)
    pending.reject(error)
    await Promise.all([first, second])
    expect(f.load).toHaveBeenCalledTimes(2)
    const recovery = loaded('recovered')
    f.load.mockResolvedValue(recovery)
    expect(await f.cache.beforeAction()).toBe(recovery.value)
    expect(f.load).toHaveBeenCalledTimes(3)
    expect(held.grants).toEqual(['initial'])
  })

  it('also retries a synchronously throwing loader on the next admission', async () => {
    const f = fixture()
    const error = new Error('synchronous failure')
    f.load.mockImplementationOnce(() => { throw error })
    await expect(f.cache.beforeAction()).rejects.toBe(error)
    await expect(f.cache.beforeAction()).resolves.toEqual({ grants: ['initial'] })
    expect(f.load).toHaveBeenCalledTimes(2)
  })

  it('pauses admissions on disconnect and reloads on reconnect without another dirty event', async () => {
    const f = fixture()
    const held = await f.cache.beforeAction()
    f.emit('unavailable')
    await unavailable(f.cache.beforeAction())
    expect(f.load).toHaveBeenCalledTimes(1)
    f.emit('ready')
    expect(f.load).toHaveBeenCalledTimes(1)
    f.load.mockResolvedValue(loaded('after reconnect'))
    expect(await f.cache.beforeAction()).not.toBe(held)
    expect(f.load).toHaveBeenCalledTimes(2)
  })

  it.each([
    { eligible: false, available: false },
    { eligible: false, available: true },
    { eligible: true, available: false },
  ])('refuses initial admissions when transport is %j', async options => {
    const f = fixture(options)
    expect(f.cache.eligible).toBe(options.eligible)
    await unavailable(f.cache.beforeAction())
    expect(f.load).not.toHaveBeenCalled()
  })

  it.each(['disconnect', 'dispose', 'abort'] as const)('fails closed when %s happens during refresh', async transition => {
    const controller = new AbortController()
    const f = fixture({ signal: controller.signal })
    await f.cache.beforeAction()
    f.emit()
    const pending = deferred<LoadedPermissionSnapshot<Value>>()
    f.load.mockReturnValueOnce(pending.promise)
    const result = unavailable(f.cache.beforeAction())
    await Promise.resolve()
    if (transition === 'disconnect') f.emit('unavailable')
    else if (transition === 'dispose') f.cache.dispose()
    else controller.abort()
    pending.resolve(loaded('must not be admitted'))
    await result
    await unavailable(f.cache.beforeAction())
    expect(f.load).toHaveBeenCalledTimes(2)
    if (transition === 'disconnect') {
      f.emit('ready')
      await f.cache.beforeAction()
      expect(f.load).toHaveBeenCalledTimes(3)
    }
  })

  it('disposes idempotently, unsubscribes once, and removes its abort listener', async () => {
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const f = fixture({ signal: controller.signal })
    expect(add).toHaveBeenCalledWith('abort', expect.any(Function), { once: true })
    const handler = add.mock.calls[0]![1]
    f.cache.dispose()
    f.cache.dispose()
    controller.abort()
    expect(f.unsubscribe).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledExactlyOnceWith('abort', handler)
    await unavailable(f.cache.beforeAction())
    expect(f.load).not.toHaveBeenCalled()
  })

  it.each([false, true])('cleans up an abort signal (already aborted: %s)', async alreadyAborted => {
    const controller = new AbortController()
    if (alreadyAborted) controller.abort()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const f = fixture({ signal: controller.signal })
    if (!alreadyAborted) controller.abort()
    f.cache.dispose()
    expect(f.unsubscribe).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledTimes(1)
    await unavailable(f.cache.beforeAction())
    expect(f.load).not.toHaveBeenCalled()
  })

  it('refreshes locally at the timed grant transition, not before or in the background', async () => {
    const f = fixture()
    const initial = loaded('timed grant', 200)
    f.load.mockResolvedValueOnce(initial)
    expect(await f.cache.beforeAction()).toBe(initial.value)
    f.setNow(199)
    expect(await f.cache.beforeAction()).toBe(initial.value)
    f.setNow(200)
    await Promise.resolve()
    expect(f.load).toHaveBeenCalledTimes(1)
    const next = loaded('grant expired', 300)
    f.load.mockResolvedValue(next)
    expect(await f.cache.beforeAction()).toBe(next.value)
    expect(await f.cache.beforeAction()).toBe(next.value)
    expect(f.load).toHaveBeenCalledTimes(2)
  })

  it.each([99, 100, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'refuses expired or nonfinite refreshAt %s without stale fallback, then retries', async refreshAt => {
      const f = fixture()
      await f.cache.beforeAction()
      f.emit()
      f.load.mockResolvedValueOnce(loaded('invalid deadline', refreshAt))
      await expect(f.cache.beforeAction()).rejects.toBeInstanceOf(PermissionSnapshotUnavailableError)
      expect(f.load).toHaveBeenCalledTimes(2)
      const valid = loaded('valid deadline', 101)
      f.load.mockResolvedValue(valid)
      expect(await f.cache.beforeAction()).toBe(valid.value)
      expect(f.load).toHaveBeenCalledTimes(3)
    },
  )

  it('checks the deadline at load completion, not just when refresh starts', async () => {
    const f = fixture()
    const pending = deferred<LoadedPermissionSnapshot<Value>>()
    f.load.mockReturnValueOnce(pending.promise)
    const result = unavailable(f.cache.beforeAction())
    await Promise.resolve()
    f.setNow(200)
    pending.resolve(loaded('expired while loading', 200))
    await result
  })
})
