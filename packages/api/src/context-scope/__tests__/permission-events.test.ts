import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { PermissionInvalidation } from '../permission-events.js'

const transport = vi.hoisted(() => ({
  handler: undefined as undefined | ((payload: string) => void),
  lifecycle: undefined as undefined | ((state: { ready: boolean; reason: 'initial' | 'ready' | 'disconnected' }) => void),
  ready: false,
  register: vi.fn(),
  start: vi.fn(),
}))
vi.mock('../../db/notify-listener.js', () => ({
  registerNotifyChannel: (channel: string, handler: (payload: string) => void) => {
    transport.register(channel)
    transport.handler = handler
  },
  subscribeNotifyLifecycle: (_channel: string, callback: NonNullable<typeof transport.lifecycle>) => {
    transport.lifecycle = callback
    callback({ ready: transport.ready, reason: 'initial' })
    return () => {}
  },
  startNotifyListener: transport.start,
}))
const W1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const W2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('USEBRIAN_SINGLE_PROCESS', '0')
  transport.handler = undefined
  transport.lifecycle = undefined
  transport.ready = false
  vi.clearAllMocks()
})
afterEach(() => vi.unstubAllEnvs())

describe('permission invalidation transport', () => {
  it('starts once, provides initial availability and routes workspace/global hints without revisions', async () => {
    const { subscribePermissionInvalidation: subscribe } = await import('../permission-events.js')
    const one: PermissionInvalidation[] = [], two: PermissionInvalidation[] = []
    const sub = subscribe(W1, event => one.push(event))
    subscribe(W2, event => two.push(event))
    expect(one).toEqual([{ dirty: true, eligible: true, available: false, reason: 'initial' }])
    expect(sub.available).toBe(false)
    expect(transport.register).toHaveBeenCalledExactlyOnceWith('permission_invalidation')
    expect(transport.start).toHaveBeenCalledTimes(1)
    transport.lifecycle!({ ready: true, reason: 'ready' })
    expect(sub.available).toBe(true)
    transport.handler!(JSON.stringify({ workspaceId: W1.toUpperCase() }))
    expect(one.at(-1)?.reason).toBe('workspace')
    expect(two.at(-1)?.reason).toBe('ready')
    transport.handler!('{"global":true}')
    expect(one.at(-1)?.reason).toBe('global')
    expect(two.at(-1)?.reason).toBe('global')
    sub.unsubscribe()
    const count = one.length
    transport.handler!('{"global":true}')
    expect(one).toHaveLength(count)
  })

  it('invalidates everyone on disconnect and reconnect even without any NOTIFY', async () => {
    const { subscribePermissionInvalidation: subscribe } = await import('../permission-events.js')
    const one = vi.fn(), two = vi.fn()
    const sub = subscribe(W1, one)
    subscribe(W2, two)
    transport.lifecycle!({ ready: true, reason: 'ready' })
    transport.lifecycle!({ ready: false, reason: 'disconnected' })
    expect(sub.available).toBe(false)
    for (const callback of [one, two]) expect(callback).toHaveBeenLastCalledWith({
      dirty: true, eligible: true, available: false, reason: 'unavailable',
    })
    transport.lifecycle!({ ready: true, reason: 'ready' })
    for (const callback of [one, two]) expect(callback).toHaveBeenLastCalledWith({
      dirty: true, eligible: true, available: true, reason: 'ready',
    })
  })

  it.each(['', 'not json', 'null', '[]', '{}', '{"global":false}', '{"workspaceId":"bad"}',
    `{"workspaceId":"${W1}","global":true}`])('fails closed for malformed payload %s', async payload => {
    const { subscribePermissionInvalidation: subscribe } = await import('../permission-events.js')
    const one = vi.fn(), two = vi.fn()
    subscribe(W1, one)
    subscribe(W2, two)
    expect(() => transport.handler!(payload)).not.toThrow()
    for (const callback of [one, two]) expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({
      dirty: true, reason: 'malformed',
    }))
  })

  it('isolates throwing subscribers and reports ready initial state for late snapshots', async () => {
    transport.ready = true
    const { subscribePermissionInvalidation: subscribe } = await import('../permission-events.js')
    subscribe(W1, () => { throw new Error('broken snapshot') })
    const callback = vi.fn()
    subscribe(W1, callback)
    expect(callback).toHaveBeenLastCalledWith({ dirty: true, eligible: true, available: true, reason: 'initial' })
    expect(() => transport.handler!('{"global":true}')).not.toThrow()
    expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'global' }))
  })

  it('PGLite is ineligible and unavailable, with no fake local notification coverage', async () => {
    vi.stubEnv('USEBRIAN_SINGLE_PROCESS', '1')
    const { subscribePermissionInvalidation: subscribe } = await import('../permission-events.js')
    const callback = vi.fn()
    const sub = subscribe(W1, callback)
    expect(sub.eligible).toBe(false)
    expect(sub.available).toBe(false)
    expect(callback).toHaveBeenCalledExactlyOnceWith({
      dirty: true, eligible: false, available: false, reason: 'initial',
    })
    expect(transport.register).not.toHaveBeenCalled()
    expect(transport.start).not.toHaveBeenCalled()
  })

  it('rejects malformed workspace subscriptions before starting transport', async () => {
    const { subscribePermissionInvalidation: subscribe } = await import('../permission-events.js')
    expect(() => subscribe('bad', vi.fn())).toThrow()
    expect(transport.start).not.toHaveBeenCalled()
  })
})

it('migration installs transactional epoch triggers (SQL harness, not PGLite transport coverage)', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const { readFile } = await import('node:fs/promises')
  const sql = await readFile(new URL('../../../migrations/8208_permission_snapshot_events.sql', import.meta.url), 'utf8')
  const db = new PGlite()
  try {
    await db.exec(`
      CREATE TABLE application_policy_workspace_epochs(workspace_id uuid PRIMARY KEY, revision bigint);
      CREATE TABLE application_policy_contract_epoch(singleton boolean PRIMARY KEY, revision bigint);
    `)
    // Execute the actual migration first, including its pg_notify calls. PGLite
    // accepting these statements is NOT evidence of reliable event delivery.
    await db.exec(sql)
    await db.exec(`INSERT INTO application_policy_contract_epoch VALUES(true,1)`)
    const triggers = await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM pg_trigger WHERE NOT tgisinternal`)
    expect(triggers.rows[0].count).toBe(4)
    // Instrument only the publisher call to inspect payloads and transactional
    // coupling without claiming that PGLite implements the network transport.
    await db.exec(`CREATE TABLE captured_permission_events(channel text, payload jsonb);
      CREATE FUNCTION public.capture_permission_notify(text,text) RETURNS void LANGUAGE sql AS
      $$ INSERT INTO public.captured_permission_events VALUES($1,$2::jsonb) $$;`)
    const functionDefinition = (await db.query<{ definition: string }>(`
      SELECT pg_get_functiondef('public.notify_permission_snapshot_event()'::regprocedure) AS definition
    `)).rows[0].definition
    await db.exec(functionDefinition.replaceAll('pg_notify(', 'public.capture_permission_notify('))
    await db.exec(`INSERT INTO application_policy_workspace_epochs VALUES('${W1}',1);
      UPDATE application_policy_workspace_epochs SET revision=2;
      UPDATE application_policy_workspace_epochs SET workspace_id='${W2}';
      DELETE FROM application_policy_workspace_epochs;
      UPDATE application_policy_contract_epoch SET revision=2;`)
    const events = await db.query<{ channel: string; payload: unknown }>('SELECT * FROM captured_permission_events')
    expect(events.rows.every(row => row.channel === 'permission_invalidation')).toBe(true)
    const payloads = events.rows.map(row => row.payload)
    expect(payloads).toHaveLength(6)
    expect(payloads.slice(0, 2)).toEqual([{ workspaceId: W1 }, { workspaceId: W1 }])
    // SQL DISTINCT order is unspecified for a changed workspace key.
    expect(payloads.slice(2, 4)).toEqual(expect.arrayContaining([{ workspaceId: W1 }, { workspaceId: W2 }]))
    expect(payloads.slice(4)).toEqual([{ workspaceId: W2 }, { global: true }])
    await db.exec(`BEGIN; INSERT INTO application_policy_workspace_epochs VALUES('${W1}',3); ROLLBACK;`)
    expect((await db.query('SELECT * FROM captured_permission_events')).rows).toHaveLength(6)
    await db.exec('TRUNCATE application_policy_workspace_epochs; TRUNCATE application_policy_contract_epoch;')
    const all = await db.query<{ payload: unknown }>('SELECT payload FROM captured_permission_events')
    expect(all.rows.slice(-2)).toEqual([{ payload: { global: true } }, { payload: { global: true } }])
  } finally { await db.close() }
})
