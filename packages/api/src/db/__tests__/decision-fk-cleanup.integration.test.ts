import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Pool, type PoolClient } from 'pg'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

// Explicit opt-in; all objects are confined to a disposable schema. No migrated
// application database is needed: use the real decision DDL from migration 471.
const url = process.env.DECISION_TEST_DATABASE_URL
const pool = url ? new Pool({ connectionString: url }) : null
const migration = (name: string) => readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8')
const original = migration('471_human_decision_learning.sql')
const fix = migration('562_decision_fk_cleanup.sql')
let client: PoolClient
let schema: string
let user: string
let assistant: string
let session: string

async function event(extra: Record<string, string> = {}) {
  const fields = {
    id: randomUUID(), idempotency_key: randomUUID(), actor_user_id: user,
    assistant_id: assistant, session_id: session, event_kind: 'test', source_kind: 'test',
    source_id: 'source', declared_scope: 'instance', visibility: 'owner', sensitivity: 'internal',
    ...extra,
  }
  await client.query(`INSERT INTO decision_events (${Object.keys(fields).join(',')}) VALUES (${Object.keys(fields).map((_, i) => `$${i + 1}`).join(',')})`, Object.values(fields))
  return fields.id
}
async function application() {
  const id = randomUUID()
  await client.query(`INSERT INTO decision_applications
    (id, actor_user_id, assistant_id, operation_kind, operation_id, visibility, sensitivity)
    VALUES ($1, $2, $3, 'test', 'test', 'owner', 'internal')`, [id, user, assistant])
  return id
}
async function row(id: string) {
  return (await client.query('SELECT * FROM decision_events WHERE id = $1', [id])).rows[0]
}

// A nested application update must not be mistaken for an FK action.
async function nestedClear() {
  await client.query(`CREATE TABLE nested_update (id int);
    CREATE FUNCTION nested_clear() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN UPDATE decision_events SET session_id = NULL; RETURN NEW; END $$;
    CREATE TRIGGER nested_clear AFTER INSERT ON nested_update
      FOR EACH ROW EXECUTE FUNCTION nested_clear();`)
}

describe.skipIf(!pool)('decision append-only FK cleanup (PostgreSQL)', () => {
  beforeEach(async () => {
    client = await pool!.connect()
    schema = `decision_fk_${randomUUID().replaceAll('-', '')}`
    await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}, public;
      CREATE TABLE users (id uuid PRIMARY KEY);
      CREATE TABLE workspaces (id uuid PRIMARY KEY);
      CREATE TABLE assistants (id uuid PRIMARY KEY);
      CREATE TABLE sessions (id uuid PRIMARY KEY);`)
    await client.query(original.slice(original.indexOf('CREATE TABLE decision_applications'), original.indexOf('-- `entities.id`')))
    await client.query(original.slice(original.indexOf('CREATE FUNCTION reject_decision_append_only_update()'), original.indexOf('ALTER TABLE decision_events ENABLE')))
    await client.query(fix)
    user = randomUUID(); assistant = randomUUID(); session = randomUUID()
    await client.query('INSERT INTO users VALUES ($1)', [user])
    await client.query('INSERT INTO assistants VALUES ($1)', [assistant])
    await client.query('INSERT INTO sessions VALUES ($1)', [session])
  })
  afterEach(async () => {
    if (!client) return
    await client.query(`RESET ROLE; RESET search_path; DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    client.release()
  })
  afterAll(async () => { await pool?.end() })

  it('deletes a session while retaining every other evidence field and its derivations', async () => {
    const id = await event()
    const before = await row(id)
    await client.query(`INSERT INTO decision_derivations (decision_event_id, artifact_kind, artifact_id, relation)
      VALUES ($1, 'memory', 'test', 'supports')`, [id])
    await client.query('DELETE FROM sessions WHERE id = $1', [session])
    expect(await row(id)).toEqual({ ...before, session_id: null })
    expect((await client.query('SELECT * FROM sessions')).rowCount).toBe(0)
    expect((await client.query('SELECT * FROM decision_derivations')).rowCount).toBe(1)
  })

  it('clears assistant references on both append-only tables', async () => {
    const app = await application()
    const id = await event()
    const before = await row(id)
    const beforeApp = (await client.query('SELECT * FROM decision_applications WHERE id = $1', [app])).rows[0]
    await client.query('DELETE FROM assistants WHERE id = $1', [assistant])
    expect(await row(id)).toEqual({ ...before, assistant_id: null })
    expect((await client.query('SELECT * FROM decision_applications WHERE id = $1', [app])).rows[0])
      .toEqual({ ...beforeApp, assistant_id: null })
  })

  it('clears application and both event-parent references without rewriting evidence', async () => {
    const app = await application()
    const parent = await event()
    const id = await event({ caused_by_application_id: app, caused_by_event_id: parent, reverses_event_id: parent })
    const before = await row(id)
    await client.query('DELETE FROM decision_applications WHERE id = $1', [app])
    await client.query('DELETE FROM decision_events WHERE id = $1', [parent])
    expect(await row(id)).toEqual({ ...before, caused_by_application_id: null, caused_by_event_id: null, reverses_event_id: null })
  })

  it.each([
    'session_id = NULL', 'session_id = session_id', "payload = '{\"changed\":true}'", "reason = 'changed'",
    'assistant_id = NULL', 'caused_by_event_id = NULL',
  ])('rejects direct updates: %s', async (assignment) => {
    const parent = await event()
    const id = await event({ caused_by_event_id: parent })
    const before = await row(id)
    await expect(client.query(`UPDATE decision_events SET ${assignment} WHERE id = $1`, [id]))
      .rejects.toMatchObject({ code: '55000' })
    expect(await row(id)).toEqual(before)
  })

  it('rejects reassignment to another existing session', async () => {
    const id = await event()
    const other = randomUUID()
    await client.query('INSERT INTO sessions VALUES ($1)', [other])
    await expect(client.query('UPDATE decision_events SET session_id = $1 WHERE id = $2', [other, id]))
      .rejects.toMatchObject({ code: '55000' })
  })

  it('keeps applications, derivations and shared immutable triggers strict', async () => {
    await application()
    const id = await event()
    await client.query(`INSERT INTO decision_derivations (decision_event_id, artifact_kind, artifact_id, relation)
      VALUES ($1, 'memory', 'test', 'supports')`, [id])
    await expect(client.query('UPDATE decision_applications SET assistant_id = NULL')).rejects.toMatchObject({ code: '55000' })
    await expect(client.query("UPDATE decision_derivations SET artifact_id = 'changed'")).rejects.toMatchObject({ code: '55000' })
    await client.query(`CREATE TABLE immutable_receipt (id int);
      CREATE TRIGGER immutable BEFORE UPDATE ON immutable_receipt
      FOR EACH ROW EXECUTE FUNCTION reject_decision_append_only_update();
      INSERT INTO immutable_receipt VALUES (1);`)
    await expect(client.query('UPDATE immutable_receipt SET id = 2')).rejects.toMatchObject({ code: '55000' })
  })

  it('rejects evidence changes mixed into nested cleanup even after the parent is deleted', async () => {
    const id = await event()
    await client.query(`CREATE FUNCTION corrupt_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE decision_events SET session_id = NULL, reason = 'rewritten' WHERE session_id = OLD.id;
        RETURN OLD;
      END $$;
      CREATE TRIGGER "A_corrupt_cleanup" AFTER DELETE ON sessions
        FOR EACH ROW EXECUTE FUNCTION corrupt_cleanup();`)
    await expect(client.query('DELETE FROM sessions WHERE id = $1', [session])).rejects.toMatchObject({ code: '55000' })
    expect((await row(id)).session_id).toBe(session)
    expect((await client.query('SELECT * FROM sessions')).rowCount).toBe(1)
  })

  it('allows a non-owner session deletion with RLS enabled', async () => {
    const id = await event()
    const role = `${schema}_role`
    await client.query(`CREATE ROLE ${role};
      GRANT USAGE ON SCHEMA ${schema} TO ${role};
      GRANT SELECT, DELETE ON sessions TO ${role};
      ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
      CREATE POLICY session_owner ON sessions TO ${role} USING (true);
      ALTER TABLE decision_events ENABLE ROW LEVEL SECURITY;
      SET ROLE ${role};`)
    try {
      // PostgreSQL's referential action runs as the referenced child-table
      // owner, not as this role (which cannot update/read decision evidence).
      await client.query('DELETE FROM sessions WHERE id = $1', [session])
    } finally {
      await client.query(`RESET ROLE; DROP POLICY session_owner ON sessions;
        DROP OWNED BY ${role}; DROP ROLE ${role}`)
    }
    expect((await row(id)).session_id).toBeNull()
  })

  it('rejects nested updates when the referenced parent still exists', async () => {
    const id = await event()
    await nestedClear()
    await expect(client.query('INSERT INTO nested_update VALUES (1)')).rejects.toMatchObject({ code: '55000' })
    expect((await row(id)).session_id).toBe(session)
  })

  it('fails closed when RLS hides a parent from a nested application update', async () => {
    await event()
    await nestedClear()
    const role = `${schema}_role`
    await client.query(`CREATE ROLE ${role};
      GRANT USAGE ON SCHEMA ${schema} TO ${role};
      GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA ${schema} TO ${role};
      ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
      SET ROLE ${role};`)
    try {
      expect((await client.query('SELECT * FROM sessions')).rowCount).toBe(0)
      await expect(client.query('INSERT INTO nested_update VALUES (1)')).rejects.toMatchObject({ code: '42501' })
    } finally {
      await client.query(`RESET ROLE; DROP OWNED BY ${role}; DROP ROLE ${role}`)
    }
  })
})
