import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MigrationDiagnostics } from '../migration-diagnostics.js'

const fake = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn(), end: vi.fn(), options: [] as Record<string, unknown>[] }))
vi.mock('pg', () => ({ default: { Client: class {
  constructor(options: Record<string, unknown>) { fake.options.push(options) }
  on() {}
  connect = fake.connect
  query = fake.query
  end = fake.end
} } }))

const observation = { rows: [{ state: 'active', waitEventType: 'Lock', waitEvent: 'relation', blockerPids: [42],
  blockers: [{ pid: 42, state: null, transactionAgeMs: null }] }] }

describe('[COMP:api/migration-diagnostics] migration observation cannot change SQL outcomes', () => {
  const running: MigrationDiagnostics[] = []
  beforeEach(() => {
    vi.useFakeTimers()
    fake.options.length = 0
    fake.query.mockReset().mockResolvedValue(observation)
    fake.connect.mockReset().mockResolvedValue(undefined)
    fake.end.mockReset().mockResolvedValue(undefined)
  })
  afterEach(async () => { await Promise.all(running.splice(0).map(item => item.stop())); vi.useRealTimers() })
  function diagnostics(events: Record<string, unknown>[]) {
    const item = new MigrationDiagnostics('postgres://fixture:connection-canary@localhost/fixture', 123,
      { intervalMs: 20, write: event => events.push(event) })
    running.push(item)
    return item
  }

  it('records file timing without opening an observer for a short phase', async () => {
    const events: Record<string, unknown>[] = [], item = diagnostics(events)
    item.start('apply', '9999_fixture.sql')
    item.finish('applied')
    await vi.advanceTimersByTimeAsync(100)
    expect(fake.options).toHaveLength(0)
    expect(events).toEqual([
      expect.objectContaining({ phase: 'apply', file: '9999_fixture.sql', status: 'started' }),
      expect.objectContaining({ phase: 'apply', file: '9999_fixture.sql', status: 'applied', elapsedMs: expect.any(Number) }),
    ])
  })

  it('opens one bounded observer, retains restricted metadata, and closes it', async () => {
    const events: Record<string, unknown>[] = [], item = diagnostics(events)
    item.start('migration_lock')
    await vi.advanceTimersByTimeAsync(20)
    expect(fake.options).toEqual([expect.objectContaining({ connectionTimeoutMillis: 3000, query_timeout: 2000, statement_timeout: 2000 })])
    expect(events.at(-1)).toMatchObject({ event: 'migration_progress', state: 'active', blockerPids: [42],
      blockers: [{ pid: 42, state: null, transactionAgeMs: null }] })
    await item.stop()
    expect(fake.end).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never overlaps observations or emits a stale result after a phase finishes', async () => {
    let release!: (value: typeof observation) => void
    fake.query.mockImplementation(() => new Promise(resolve => { release = resolve }))
    const events: Record<string, unknown>[] = [], item = diagnostics(events)
    item.start('apply', '9999_fixture.sql')
    await vi.advanceTimersByTimeAsync(100)
    expect(fake.query).toHaveBeenCalledTimes(1)
    item.finish('applied')
    const stopped = item.stop()
    release(observation)
    await stopped
    expect(events.some(event => event.event === 'migration_progress')).toBe(false)
    expect(fake.end).toHaveBeenCalledTimes(1)
  })

  it('does not attach an earlier observation to the next active file', async () => {
    let release!: (value: typeof observation) => void
    fake.query.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const events: Record<string, unknown>[] = [], item = diagnostics(events)
    item.start('apply', 'first.sql')
    await vi.advanceTimersByTimeAsync(20)
    item.finish('applied')
    item.start('apply', 'second.sql')
    release(observation)
    await vi.advanceTimersByTimeAsync(0)
    expect(events.some(event => event.event === 'migration_progress')).toBe(false)
    await vi.advanceTimersByTimeAsync(20)
    expect(events.at(-1)).toMatchObject({ event: 'migration_progress', file: 'second.sql' })
  })

  it('reports missing observations explicitly and redacts failed reads before retrying', async () => {
    fake.query.mockRejectedValueOnce(Object.assign(new Error('connection-canary SELECT private-content'), { code: '42501' }))
      .mockResolvedValueOnce({ rows: [] })
    const events: Record<string, unknown>[] = [], item = diagnostics(events)
    item.start('recovery')
    await vi.advanceTimersByTimeAsync(40)
    expect(events).toContainEqual(expect.objectContaining({ event: 'migration_observation_unavailable', reason: 'observer_error', errorCode: '42501' }))
    expect(events).toContainEqual(expect.objectContaining({ event: 'migration_observation_unavailable', reason: 'backend_not_found' }))
    expect(events.some(event => event.event === 'migration_progress')).toBe(false)
    expect(JSON.stringify(events)).not.toMatch(/connection-canary|private-content|postgres:\/\//)
    expect(fake.options).toHaveLength(2)
  })

  it('preserves a failed file and code without logging SQL errors or requiring logging to work', () => {
    const events: Record<string, unknown>[] = [], item = diagnostics(events)
    item.start('apply', '9999_fixture.sql')
    item.fail(Object.assign(new Error('private-content'), { code: '22012' }))
    expect(events.at(-1)).toMatchObject({ status: 'failed', file: '9999_fixture.sql', errorCode: '22012' })
    expect(JSON.stringify(events)).not.toContain('private-content')
    const broken = new MigrationDiagnostics('unused', 123, { write: () => { throw Error('broken log') } })
    running.push(broken)
    expect(() => { broken.start('recovery'); broken.finish() }).not.toThrow()
  })
})
