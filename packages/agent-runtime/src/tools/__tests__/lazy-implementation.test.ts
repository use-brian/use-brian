/**
 * [COMP:tools/lazy-implementation] Lazy tool implementations (M4 step 5): the seam
 * helpers load once on first use, share concurrent loads, fail honestly with
 * `ImplementationUnavailableError` and retry after the window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ImplementationUnavailableError,
  LAZY_IMPLEMENTATION_RETRY_MS,
  isImplementationUnavailable,
  lazyAdapter,
  lazyFunction,
  lazyImplementation,
} from '../lazy-implementation.js'

let now = 1_000_000
beforeEach(() => {
  now = 1_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

describe('[COMP:tools/lazy-implementation] lazyImplementation', () => {
  it('does not load until called, then loads once for concurrent and later calls', async () => {
    const load = vi.fn(async () => ({ value: 42 }))
    const get = lazyImplementation('Fixture', load)
    expect(load).not.toHaveBeenCalled()
    const [a, b] = await Promise.all([get(), get()])
    expect(a).toBe(b)
    expect(await get()).toBe(a)
    expect(load).toHaveBeenCalledOnce()
  })

  it('fails as unavailable with the cause, does not reload inside the window, retries after it', async () => {
    const cause = new Error('Cannot find module fixture')
    const load = vi.fn<() => Promise<string>>().mockRejectedValueOnce(cause).mockResolvedValueOnce('loaded')
    const get = lazyImplementation('The fixture renderer', load)
    const first = await get().catch((error: unknown) => error)
    expect(first).toBeInstanceOf(ImplementationUnavailableError)
    expect(isImplementationUnavailable(first)).toBe(true)
    expect(first).toMatchObject({ code: 'implementation_unavailable', effect: 'none', retryable: true, implementation: 'The fixture renderer', cause })
    expect((first as Error).message).toContain('The fixture renderer could not be loaded on this server, so nothing ran')
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[lazy] implementation The fixture renderer failed to load'), cause)
    now += LAZY_IMPLEMENTATION_RETRY_MS - 1
    await expect(get()).rejects.toBeInstanceOf(ImplementationUnavailableError)
    expect(load).toHaveBeenCalledOnce()
    now += 2
    await expect(get()).resolves.toBe('loaded')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('treats a synchronous throw in the loader as a load failure', async () => {
    const get = lazyImplementation('Sync', () => { throw new Error('boom') })
    await expect(get()).rejects.toBeInstanceOf(ImplementationUnavailableError)
  })
})

describe('[COMP:tools/lazy-implementation] lazyFunction and lazyAdapter', () => {
  it('lazyFunction delegates arguments and results after one load', async () => {
    const impl = vi.fn(async (a: number, b: string) => `${a}:${b}`)
    const load = vi.fn(async () => impl)
    const fn = lazyFunction<(a: number, b: string) => Promise<string>>('Fixture function', load)
    expect(load).not.toHaveBeenCalled()
    expect(await fn(1, 'x')).toBe('1:x')
    expect(await fn(2, 'y')).toBe('2:y')
    expect(load).toHaveBeenCalledOnce()
    expect(impl).toHaveBeenCalledWith(2, 'y')
  })

  it('lazyFunction refuses a module that does not provide a function', async () => {
    const fn = lazyFunction<() => Promise<void>>('Not a function', async () => 'nope' as never)
    await expect(fn()).rejects.toBeInstanceOf(ImplementationUnavailableError)
  })

  it('lazyAdapter builds once on the first method call and keeps `this`', async () => {
    class Runtime {
      prefix = 'sbx'
      async create(id: string) { return `${this.prefix}-new-${id}` }
      async connect(id: string) { return `${this.prefix}-old-${id}` }
    }
    const build = vi.fn(async () => new Runtime())
    const runtime = lazyAdapter<Runtime, 'create' | 'connect'>('Fixture runtime', build, ['create', 'connect'])
    expect(Object.keys(runtime).sort()).toEqual(['connect', 'create'])
    expect(build).not.toHaveBeenCalled()
    expect(await runtime.create('a')).toBe('sbx-new-a')
    expect(await runtime.connect('b')).toBe('sbx-old-b')
    expect(build).toHaveBeenCalledOnce()
  })

  it('lazyAdapter surfaces a failed build as unavailable on every method', async () => {
    const runtime = lazyAdapter<{ create(): Promise<void> }, 'create'>('Broken runtime', async () => { throw new Error('no sdk') }, ['create'])
    await expect(runtime.create()).rejects.toMatchObject({ name: 'ImplementationUnavailableError', implementation: 'Broken runtime' })
  })
})
