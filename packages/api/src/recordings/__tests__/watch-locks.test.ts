import { beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ max: 4, connect: vi.fn(), release: vi.fn(), sql: vi.fn() }))
vi.mock('../../db/client.js', () => ({ query: vi.fn(), getPool: () => ({ options: { max: mock.max }, connect: mock.connect }) }))
import { withCaptureLock } from '../watch-store.js'
beforeEach(() => {
  mock.max = 4; vi.clearAllMocks()
  mock.sql.mockResolvedValue({ rows: [{ locked: true }] })
  mock.connect.mockImplementation(async () => ({ query: mock.sql, release: mock.release }))
})
describe('bounded per-capture watch work', () => {
  it('allows independent users/captures concurrently, serializes one capture and reserves a PG slot', async () => {
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    const entered = vi.fn()
    const job = (id: string) => withCaptureLock(id, async () => { entered(id); await barrier })
    const a = job('capture-a'), b = job('capture-b'), c = job('capture-c')
    await vi.waitFor(() => expect(entered).toHaveBeenCalledTimes(3))
    await expect(job('capture-a')).rejects.toMatchObject({ message: 'capture_busy' })
    await expect(job('capture-d')).rejects.toMatchObject({ message: 'watch_work_capacity' })
    expect(mock.connect).toHaveBeenCalledTimes(3) // max=4, keep one slot free for store work
    release(); await Promise.all([a, b, c])
    await job('capture-d')
    expect(mock.release).toHaveBeenCalledTimes(4)
  })
  it('releases capacity after connection/provider failures and cross-replica contention', async () => {
    mock.connect.mockRejectedValueOnce(new Error('connect failed'))
    await expect(withCaptureLock('a', async () => {})).rejects.toThrow('connect failed')
    await expect(withCaptureLock('a', async () => { throw new Error('provider failed') })).rejects.toThrow('provider failed')
    mock.sql.mockResolvedValueOnce({ rows: [{ locked: false }] })
    await expect(withCaptureLock('a', async () => {})).rejects.toMatchObject({ message: 'capture_busy' })
    await withCaptureLock('a', async () => {})
    mock.max = 1
    await expect(withCaptureLock('a', async () => {})).rejects.toMatchObject({ message: 'watch_requires_pool_slots' })
  })
})
