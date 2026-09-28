import { afterEach, describe, expect, it, vi } from 'vitest'
import { TabExecutor, type ExecutorPlatform, type ExecutorTabUpdatedListener } from '../executor.js'

function makePlatform(url = 'https://example.com/') {
  const listeners = new Set<ExecutorTabUpdatedListener>()
  const platform = {
    debugger: {
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async (..._args: Parameters<ExecutorPlatform['debugger']['sendCommand']>) => ({ nodes: [] })),
    },
    tabs: {
      get: vi.fn(async () => ({ url, title: 'Injected', status: 'loading' })),
      onUpdated: {
        addListener: vi.fn((listener: ExecutorTabUpdatedListener) => { listeners.add(listener) }),
        removeListener: vi.fn((listener: ExecutorTabUpdatedListener) => { listeners.delete(listener) }),
      },
    },
  } satisfies ExecutorPlatform
  return { platform, listeners }
}

afterEach(() => { vi.useRealTimers() })

describe('injected executor platform (no Chrome global)', () => {
  it('imports and constructs without resolving Chrome', () => {
    expect('chrome' in globalThis).toBe(false)
    expect(new TabExecutor().attachedTab()).toBeNull()
  })

  it('routes lifecycle, snapshots, and tab reads through independent adapters', async () => {
    const a = makePlatform()
    const b = makePlatform('https://other.example/')
    const first = new TabExecutor(a.platform)
    const second = new TabExecutor(b.platform)
    await first.attach(7)
    await second.attach(8)
    expect(a.platform.debugger.attach).toHaveBeenCalledWith({ tabId: 7 }, '1.3')
    expect(await first.snapshot()).toMatchObject({ url: 'https://example.com/', title: 'Injected', nodes: [] })
    expect(await second.currentUrl()).toEqual({ url: 'https://other.example/', title: 'Injected' })
    expect(a.platform.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 7 }, 'Accessibility.getFullAXTree', undefined)
    await first.detach()
    expect(a.platform.debugger.detach).toHaveBeenCalledWith({ tabId: 7 })
    expect(b.platform.debugger.detach).not.toHaveBeenCalled()
    expect(second.attachedTab()).toBe(8)
    await second.detach()
  })

  it('uses injected navigation events and removes the listener', async () => {
    const { platform, listeners } = makePlatform()
    const executor = new TabExecutor(platform)
    await executor.attach(7)
    const navigation = executor.navigate('https://example.com/')
    await vi.waitFor(() => expect(listeners.size).toBe(1))
    for (const listener of listeners) listener(8, { status: 'complete' })
    expect(listeners.size).toBe(1)
    for (const listener of listeners) listener(7, { status: 'complete' })
    expect(await navigation).toEqual({ url: 'https://example.com/' })
    expect(listeners.size).toBe(0)
    expect(platform.tabs.onUpdated.removeListener).toHaveBeenCalledOnce()
  })

  it('uses injected tab polling for already-complete navigation', async () => {
    vi.useFakeTimers()
    const { platform, listeners } = makePlatform()
    platform.tabs.get.mockResolvedValue({ url: 'https://example.com/', title: 'Injected', status: 'complete' })
    const executor = new TabExecutor(platform)
    await executor.attach(7)
    const navigation = executor.navigate('https://example.com/')
    await vi.advanceTimersByTimeAsync(500)
    await expect(navigation).resolves.toEqual({ url: 'https://example.com/' })
    expect(listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each<[string, number]>([
    ['stop', 1], ['tab closure', 1], ['stop', 2], ['tab closure', 2],
  ])('rejects navigation on %s during tab read %i without unhandled rejections', async (reason, read) => {
    vi.useFakeTimers()
    const { platform, listeners } = makePlatform()
    const error = new Error(reason === 'stop' ? 'Browser control stopped' : 'Tab closed')
    if (read === 2) {
      platform.tabs.get.mockResolvedValueOnce({ url: '', title: '', status: 'complete' })
    }
    platform.tabs.get.mockRejectedValue(error)
    const executor = new TabExecutor(platform)
    await executor.attach(7)
    // Attach the rejection assertion before advancing timers. Vitest also
    // fails the run if either internal tabs.get produces an unhandled rejection.
    const rejected = expect(executor.navigate('https://example.com/')).rejects.toBe(error)
    await vi.advanceTimersByTimeAsync(500)
    await rejected
    expect(listeners.size).toBe(0)
    expect(platform.tabs.onUpdated.removeListener).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(platform.tabs.get).toHaveBeenCalledTimes(read)
  })

  it('cancels the delayed poll when a completion event wins', async () => {
    vi.useFakeTimers()
    const { platform, listeners } = makePlatform()
    platform.tabs.get.mockResolvedValue({ url: 'https://example.com/', title: '', status: 'complete' })
    const executor = new TabExecutor(platform)
    await executor.attach(7)
    const navigation = executor.navigate('https://example.com/')
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(2)
    for (const listener of listeners) listener(7, { status: 'complete' })
    await navigation
    expect(vi.getTimerCount()).toBe(0)
    platform.tabs.get.mockRejectedValue(new Error('Tab closed after navigation'))
    await vi.advanceTimersByTimeAsync(20_000)
    expect(platform.tabs.get).toHaveBeenCalledTimes(2) // initial read and final URL
  })

  it('handles an in-flight poll rejection after a completion event', async () => {
    vi.useFakeTimers()
    const { platform, listeners } = makePlatform()
    let rejectPoll!: (error: Error) => void
    platform.tabs.get
      .mockResolvedValueOnce({ url: '', title: '', status: 'complete' })
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectPoll = reject }))
    const executor = new TabExecutor(platform)
    await executor.attach(7)
    const navigation = executor.navigate('https://example.com/')
    await vi.advanceTimersByTimeAsync(500)
    for (const listener of listeners) listener(7, { status: 'complete' })
    await navigation
    rejectPoll(new Error('Tab closed'))
    await vi.advanceTimersByTimeAsync(0)
    expect(listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(platform.tabs.onUpdated.removeListener).toHaveBeenCalledOnce()
  })

  it.each(['complete', 'reject'])('ignores a late initial tab read (%s) after timeout', async (outcome) => {
    vi.useFakeTimers()
    const { platform, listeners } = makePlatform()
    let resolve!: (tab: { url: string; title: string; status: string }) => void
    let reject!: (error: Error) => void
    platform.tabs.get.mockImplementationOnce(() => new Promise((res, rej) => { resolve = res; reject = rej }))
    const executor = new TabExecutor(platform)
    await executor.attach(7)
    const navigation = executor.navigate('https://example.com/')
    await vi.advanceTimersByTimeAsync(20_000)
    await navigation
    if (outcome === 'reject') reject(new Error('Browser control stopped'))
    else resolve({ url: '', title: '', status: 'complete' })
    await vi.advanceTimersByTimeAsync(0)
    expect(listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(platform.tabs.get).toHaveBeenCalledTimes(2)
  })

  it('preserves detached-error translation for injected commands', async () => {
    const { platform } = makePlatform()
    const executor = new TabExecutor(platform)
    await executor.attach(7)
    platform.debugger.sendCommand.mockRejectedValue(new Error('Debugger is not attached'))
    await expect(executor.captureFrame()).rejects.toMatchObject({ code: 'detached' })
    expect(executor.attachedTab()).toBeNull()
  })
})
