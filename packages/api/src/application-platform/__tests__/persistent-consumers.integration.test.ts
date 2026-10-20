import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { boundScopeSources, type ScopeSource } from '@use-brian/core'
import { getAppPool, getPool } from '../../db/client.js'
import { addSessionMessage, getSessionMessages, toStampedMessages } from '../../db/sessions.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'
import { persistentSourceFixture } from './fixtures/persistent-source.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

describe.sequential('[COMP:api/application-persistence] actual transcript persistence and replay', () => {
  let fixture: Awaited<ReturnType<typeof persistentContextFixture>> | undefined
  let independent: Awaited<ReturnType<typeof persistentSourceFixture>> | undefined
  afterEach(async () => { await independent?.cleanup(); independent = undefined; await fixture?.cleanup(); fixture = undefined })
  afterAll(async () => { await getAppPool().end(); await getPool().end() })

  it('preserves shared nullable axes across persisted message reads and formatting', async () => {
    fixture = await persistentContextFixture()
    const rows = await fixture.history()
    expect(rows).toHaveLength(3)
    for (const [index, message] of toStampedMessages(rows, 'UTC').entries()) {
      expect(boundScopeSources(message)).toEqual(boundScopeSources(rows[index]))
      expect(boundScopeSources(message)).toMatchObject([{
        workspaceId: fixture.workspaceId, userId: null, assistantId: null,
        resourceKind: 'session_message', resourceId: rows[index].id, sensitivity: 'internal',
      }])
    }
  })

  it('keeps every source edge through tool-result JSON flush and transitive replay holding', async () => {
    fixture = await persistentContextFixture('confidential')
    const f = fixture, first = await f.memory('Fictional first source'), second = await f.memory('Fictional second source', null, 'confidential')
    const sources = (await f.pool.query<{ source: ScopeSource }>(
      "SELECT read_scope_source($1,'memory',roots.id) AS source FROM unnest($2::uuid[]) AS roots(id)", [f.workspaceId, [first.id, second.id]],
    )).rows.map(row => row.source)
    const tool = await addSessionMessage({ sessionId: f.session.id, role: 'user',
      content: [{ type: 'tool_result', toolUseId: 'fixture-read', name: 'getMemory', content: 'Fictional mixed-source result' }],
      derivation: { producer: 'fixture:tool-flush', sources } })
    const answer = await addSessionMessage({ sessionId: f.session.id, role: 'assistant', content: 'Fictional derived answer',
      derivation: { producer: 'fixture:answer-flush', sources: boundScopeSources(tool) } })
    const edges = async () => (await f.pool.query(`SELECT d.resource_id,s.source_kind,s.source_id,s.source_version
      FROM scope_derivations d JOIN scope_derivation_sources s ON s.derivation_id=d.id AND s.workspace_id=d.workspace_id
      WHERE d.workspace_id=$1 AND d.resource_id=ANY($2::uuid[]) ORDER BY d.resource_id,s.source_id`,
    [f.workspaceId, [tool.id, answer.id]])).rows
    const before = await edges()
    expect(before.filter(row => row.resource_id === tool.id).map(row => row.source_id).sort()).toEqual([first.id, second.id].sort())
    expect(before.filter(row => row.resource_id === answer.id).map(row => row.source_id)).toEqual([tool.id])
    const replay = await getSessionMessages(f.session.id, { excludeHeld: true })
    expect(replay).toHaveLength(2)
    expect(replay.flatMap(boundScopeSources).every(source => source.sensitivity === 'confidential')).toBe(true)
    await f.pool.query("UPDATE memories SET summary='Fictional source changed' WHERE id=$1", [second.id])
    expect(await getSessionMessages(f.session.id, { excludeHeld: true })).toEqual([])
    expect(await edges()).toEqual(before)
  })

  it('retains the native historical-deletion allowance without lowering its labels', async () => {
    fixture = await persistentContextFixture('confidential')
    const f = fixture, memory = await f.memory('Fictional native content', null, 'confidential')
    const source = (await f.pool.query<{ source: ScopeSource }>("SELECT read_scope_source($1,'memory',$2) AS source", [f.workspaceId, memory.id])).rows[0].source
    await f.pool.query('DELETE FROM memories WHERE id=$1', [memory.id])
    const row = await addSessionMessage({ sessionId: f.session.id, role: 'assistant', content: 'Fictional native historical reply',
      derivation: { producer: 'fixture:native-gone', sources: [source] } })
    expect(boundScopeSources(row)).toMatchObject([{ sensitivity: 'confidential', compartments: [], projectIds: [] }])
    expect(await getSessionMessages(f.session.id, { excludeHeld: true })).toHaveLength(1)
  })

  it('cannot shed independent source obligations when the native carrier is deleted', async () => {
    fixture = await persistentContextFixture('confidential')
    const f = fixture
    independent = await persistentSourceFixture(f)
    const original = (await f.pool.query('SELECT id,version,observation FROM external_source_observations WHERE workspace_id=$1 ORDER BY id', [f.workspaceId])).rows
    await f.pool.query('DELETE FROM memories WHERE id=$1', [independent.root.resourceId])
    await independent.pool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1", [f.ownerId])
    const count = async () => (await f.pool.query('SELECT count(*)::int AS count FROM session_messages WHERE session_id=$1', [f.session.id])).rows[0].count
    expect(await count()).toBe(0)
    await expect(addSessionMessage({ sessionId: f.session.id, role: 'assistant', content: 'Fictional protected historical reply',
      derivation: { producer: 'fixture:external-gone', sources: [independent.root] } })).rejects.toThrow('scope_source_changed')
    expect(await count()).toBe(0)
    expect(await independent.independentlyAuthorized()).toBe(true)
    expect((await f.pool.query('SELECT id,version,observation FROM external_source_observations WHERE workspace_id=$1 ORDER BY id', [f.workspaceId])).rows).toEqual(original)
  })

  it('persists every transitive independent observation with a currently authorized native transcript', async () => {
    fixture = await persistentContextFixture('confidential')
    const f = fixture
    independent = await persistentSourceFixture(f)
    const row = await independent.writeTranscript()
    const edges = (await f.pool.query(`SELECT s.source_kind,s.source_id,s.source_version FROM scope_derivations d
      JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id
      WHERE d.workspace_id=$1 AND d.resource_kind='session_message' AND d.resource_id=$2 ORDER BY s.source_kind`,
    [f.workspaceId, row.id])).rows
    expect(edges).toEqual([
      ...independent.observations.map(source => ({ source_kind: source.resourceKind, source_id: source.resourceId, source_version: source.version })),
      { source_kind: 'memory', source_id: independent.root.resourceId, source_version: independent.root.version },
    ])
    expect(await getSessionMessages(f.session.id, { excludeHeld: true })).toEqual([])
    expect(await independent.readTranscript(row)).toHaveLength(1)
    await f.pool.query("UPDATE connector_source_profiles SET status='revoked' WHERE workspace_id=$1", [f.workspaceId])
    expect(await getSessionMessages(f.session.id, { excludeHeld: true })).toEqual([])
    await expect(independent.readTranscript(row)).rejects.toMatchObject({ code: 'source_access_denied' })
  })

  it('refuses a transcript admission connection that inherits the table owner', async () => {
    fixture = await persistentContextFixture()
    const f = fixture, role = `context_owner_${randomBytes(8).toString('hex')}`, password = randomBytes(32).toString('hex')
    await f.history()
    const owner = (await f.pool.query<{ owner: string }>("SELECT r.rolname AS owner FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid='session_messages'::regclass")).rows[0].owner
    await f.pool.query(`CREATE ROLE ${role} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${password}'`)
    const url = new URL(process.env.DATABASE_URL!); url.username = role; url.password = password
    const pool = new pg.Pool({ connectionString: url.href })
    try {
      await f.pool.query(`GRANT "${owner.replaceAll('"', '""')}" TO ${role}`)
      const tx = await pool.connect()
      try {
        await tx.query('BEGIN'); await tx.query("SELECT set_config('app.current_user_id',$1,true)", [f.ownerId])
        await expect(getSessionMessages(f.session.id, { excludeHeld: true }, tx)).rejects.toThrow('scope_source_changed')
        await tx.query('ROLLBACK')
      } finally { tx.release() }
    } finally { await pool.end(); await f.pool.query(`DROP ROLE ${role}`) }
  })
})
