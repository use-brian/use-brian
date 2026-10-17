import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'
import { appendBatchEvent, createDbBatchStore, EARLY_FLUSH_CHARS } from '../pending-ingest-batches-store.js'
import { createRoomIngestor } from '../../ingest/room-ingest.js'

const WORKSPACE = '11111111-1111-4111-8111-111111111111'
const ROOM = '22222222-2222-4222-8222-222222222222'
const PROJECT = '33333333-3333-4333-8333-333333333333'
type CapturedBatchRow = { id: string; fires_at: string | Date; events: unknown[]; room_session_id: string; rule_id: string | null }

async function database(legacyDuplicates = false) {
  const db = new PGlite()
  await db.exec(`
    CREATE TABLE workspaces(id uuid PRIMARY KEY);
    CREATE TABLE sessions(id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id));
    CREATE TABLE workspace_access_policies(workspace_id uuid, classification_mode text);
    CREATE TABLE ingest_rules(id uuid PRIMARY KEY, scope_binding_origin text, compartments text[], project_ids uuid[]);
    CREATE TABLE pending_ingest_batches(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      rule_id uuid NOT NULL REFERENCES ingest_rules(id) ON DELETE CASCADE,
      source text NOT NULL, fires_at timestamptz NOT NULL, events jsonb NOT NULL DEFAULT '[]',
      episode_sensitivity text, compartments text[] NOT NULL DEFAULT '{}', project_ids uuid[] NOT NULL DEFAULT '{}',
      scope_binding_origin text NOT NULL DEFAULT 'explicit', scope_held boolean NOT NULL DEFAULT false,
      assistant_id uuid, partition_key text NOT NULL DEFAULT '',
      processed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());`)
  await db.query('INSERT INTO workspaces VALUES($1)', [WORKSPACE])
  await db.query('INSERT INTO sessions VALUES($1,$2)', [ROOM, WORKSPACE])
  if (legacyDuplicates) {
    await db.exec('ALTER TABLE pending_ingest_batches DROP CONSTRAINT pending_ingest_batches_rule_id_fkey')
    await db.query(`INSERT INTO pending_ingest_batches(workspace_id,rule_id,source,fires_at,events)
      VALUES($1,$2,'room','2026-10-17T12:00:00Z','[{"text":"first"}]'),
            ($1,$2,'room','2026-10-17T12:00:00Z','[{"text":"second"}]')`, [WORKSPACE, ROOM])
  }
  await db.exec(await readFile(new URL('../../../migrations/774_room_ingest_batch_identity.sql', import.meta.url), 'utf8'))
  return db
}

// PGlite owns one physical connection. Model pg's checkout queue so each
// concurrent producer gets an isolated transaction rather than nested BEGINs.
function transactionPool(db: PGlite) {
  let tail = Promise.resolve()
  return {
    query: db.query.bind(db),
    async connect() {
      const previous = tail
      let release!: () => void
      tail = new Promise<void>(resolve => { release = resolve })
      await previous
      return { query: db.query.bind(db), release }
    },
  }
}

describe('[COMP:api/room-ingest] room capture queue (PostgreSQL)', () => {
  it('queues the room hourly digest without inventing an ingest rule', async () => {
    const db = await database()
    const pool = transactionPool(db)
    try {
      const ingestor = createRoomIngestor({
        brainEpisodeIngestor: async () => { throw new Error('hosted capture must remain batched') },
        scheduledBatching: true,
        now: () => new Date('2026-10-17T11:32:55Z'),
        appendBatchEvent: input => appendBatchEvent(input, pool),
      })
      await ingestor.ingestPost({
        sessionId: ROOM, workspaceId: WORKSPACE, assistantId: 'assistant', senderUserId: 'sender',
        senderName: 'Fish', text: 'Remember the course registration before the 25th.',
        effectiveClearance: 'internal', compartments: ['finance'], projectIds: [PROJECT],
        contextBindingOrigin: 'explicit', classificationMode: 'strict',
      })
      const rows = await db.query<CapturedBatchRow>('SELECT * FROM pending_ingest_batches')
      expect(rows.rows).toHaveLength(1)
      expect(rows.rows[0]).toMatchObject({
        rule_id: null, room_session_id: ROOM, source: 'room', episode_sensitivity: 'internal',
        compartments: ['finance'], project_ids: [PROJECT], scope_held: false,
      })
      expect(new Date(rows.rows[0]!.fires_at as string).toISOString()).toBe('2026-10-17T12:00:00.000Z')
    } finally { await db.close() }
  })

  it('pools concurrent posts, preserves the strict hold, and retains both real parent FKs', async () => {
    const db = await database()
    const pool = transactionPool(db)
    try {
      const input = {
        workspaceId: WORKSPACE, roomSessionId: ROOM, source: 'room', firesAt: new Date('2026-10-17T12:00:00Z'),
        event: { normalized: { text: 'Remember the registration.' } },
        episodeSensitivity: 'internal' as const, compartments: ['finance'], projectIds: [PROJECT],
        scopeBindingOrigin: 'explicit' as const,
      }
      await Promise.all(Array.from({ length: 8 }, () => appendBatchEvent(input, pool)))
      await appendBatchEvent({ ...input, episodeSensitivity: 'confidential', compartments: ['legal'] }, pool)
      let batches = await db.query<CapturedBatchRow>('SELECT * FROM pending_ingest_batches')
      expect(batches.rows).toHaveLength(1)
      expect(batches.rows[0]).toMatchObject({ episode_sensitivity: 'confidential', compartments: ['finance', 'legal'], project_ids: [PROJECT] })
      expect(batches.rows[0]!.events).toHaveLength(9)

      await db.query("INSERT INTO workspace_access_policies VALUES($1, 'strict')", [WORKSPACE])
      await appendBatchEvent({ ...input, scopeBindingOrigin: 'legacy' }, pool)
      batches = await db.query<CapturedBatchRow>('SELECT * FROM pending_ingest_batches WHERE scope_held')
      expect(batches.rows).toHaveLength(1)

      // Real claimant only exposes the explicit batch and carries its native parent.
      await createDbBatchStore(pool).withClaimedBatches(10, async (claimed, markProcessed) => {
        expect(claimed).toHaveLength(1)
        expect(claimed[0]).toMatchObject({ roomSessionId: ROOM, ruleId: null, scopeHeld: false })
        await markProcessed(claimed[0]!.id)
      })

      // Foreign workspace, connector without a rule, and room without a session all fail closed.
      await expect(appendBatchEvent({ ...input, workspaceId: PROJECT }, pool)).rejects.toThrow('outside the workspace')
      await expect(db.query("INSERT INTO pending_ingest_batches(workspace_id,source,fires_at) VALUES($1,'gmail',now())", [WORKSPACE])).rejects.toThrow('pending_ingest_batch_parent')
      await expect(db.query("INSERT INTO pending_ingest_batches(workspace_id,source,fires_at) VALUES($1,'room',now())", [WORKSPACE])).rejects.toThrow('pending_ingest_batch_parent')
      await expect(db.query("INSERT INTO pending_ingest_batches(workspace_id,rule_id,source,fires_at) VALUES($1,$2,'gmail',now())", [WORKSPACE, ROOM])).rejects.toThrow('foreign key')
      await expect(db.query("INSERT INTO pending_ingest_batches(workspace_id,room_session_id,source,fires_at) VALUES($1,$2,'room',now())", [WORKSPACE, PROJECT])).rejects.toThrow('foreign key')
      await db.query('DELETE FROM sessions WHERE id=$1', [ROOM])
      expect((await db.query('SELECT * FROM pending_ingest_batches')).rows).toHaveLength(0)
    } finally { await db.close() }
  })

  it('upgrades existing duplicate legacy windows without dropping or merging their events', async () => {
    const db = await database(true)
    const pool = transactionPool(db)
    try {
      const before = await db.query<CapturedBatchRow>('SELECT id,events,room_session_id,rule_id FROM pending_ingest_batches ORDER BY id')
      expect(before.rows).toHaveLength(2)
      expect(before.rows.map(row => row.room_session_id)).toEqual([ROOM, ROOM])
      expect(before.rows.every(row => row.rule_id === null)).toBe(true)
      await appendBatchEvent({ workspaceId: WORKSPACE, roomSessionId: ROOM, source: 'room',
        firesAt: new Date('2026-10-17T12:00:00Z'), event: { text: 'third' }, scopeBindingOrigin: 'explicit' }, pool)
      const after = await db.query<{ events: unknown[] }>('SELECT events FROM pending_ingest_batches')
      expect(after.rows).toHaveLength(2)
      expect(after.rows.flatMap(row => row.events)).toEqual(expect.arrayContaining([
        { text: 'first' }, { text: 'second' }, { text: 'third' },
      ]))
    } finally { await db.close() }
  })

  it('pulls a large room window forward for early flush', async () => {
    const db = await database()
    const pool = transactionPool(db)
    try {
      await appendBatchEvent({
        workspaceId: WORKSPACE, roomSessionId: ROOM, source: 'room', firesAt: new Date('2099-01-01T12:00:00Z'),
        event: { normalized: { text: 'x'.repeat(EARLY_FLUSH_CHARS) } }, scopeBindingOrigin: 'explicit',
      }, pool)
      const result = await db.query('SELECT fires_at <= now() AS due FROM pending_ingest_batches')
      expect(result.rows).toEqual([{ due: true }])
    } finally { await db.close() }
  })
})
