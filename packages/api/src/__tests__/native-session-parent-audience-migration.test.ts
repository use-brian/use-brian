/** [COMP:api/native-chat-read-cost] Actual forward SQL refuses unreviewed predecessor drift. */
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const migration = await readFile(new URL('../../migrations/8259_native_session_parent_audience_row.sql', import.meta.url), 'utf8')
const predecessor = await readFile(new URL('../../migrations/8183_native_turn_requirements.sql', import.meta.url), 'utf8')
const original = predecessor.slice(predecessor.indexOf('CREATE OR REPLACE FUNCTION public.native_turn_parent_scope('),
  predecessor.indexOf('CREATE OR REPLACE FUNCTION public.native_turn_capture_parent('))
let db: PGlite

beforeEach(async () => {
  db = new PGlite()
  await db.exec(`CREATE ROLE parent_fixture_owner;GRANT CREATE ON SCHEMA public TO parent_fixture_owner;
    SET ROLE parent_fixture_owner;
    CREATE TABLE sessions(id uuid,workspace_id uuid,assistant_id uuid,user_id uuid,visibility text,
      context_group_id uuid,context_project_id uuid,context_compartments text[],effective_clearance text);
    CREATE TABLE native_turn_contract_helpers(signature text PRIMARY KEY,fingerprint text NOT NULL);
    ${original}
    REVOKE ALL ON FUNCTION native_turn_parent_scope(uuid,uuid) FROM PUBLIC;
    INSERT INTO native_turn_contract_helpers
      SELECT 'native_turn_parent_scope(uuid,uuid)',encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')
      FROM pg_proc p WHERE oid='native_turn_parent_scope(uuid,uuid)'::regprocedure;
    CREATE FUNCTION native_turn_helpers_current() RETURNS boolean LANGUAGE sql AS $body$
      SELECT h.fingerprint=encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')
      FROM native_turn_contract_helpers h JOIN pg_proc p ON p.oid=to_regprocedure(h.signature)
      WHERE h.signature='native_turn_parent_scope(uuid,uuid)'$body$;`)
  // These unrelated canonical ports are controlled here. Actual six-guard,
  // ordinary-owner and app_user qualification runs in the PG18 fixture suite.
  for (const name of ['native_turn_publication_contract', 'application_native_worklist_helpers_current',
    'application_native_dependency_batch_helpers_current', 'application_native_field_reference_helpers_current',
    'application_memory_statement_helpers_current']) {
    await db.exec(`CREATE FUNCTION ${name}() RETURNS boolean LANGUAGE sql AS $body$SELECT true$body$`)
  }
})
afterEach(async () => { await db?.close() })

async function state() {
  return (await db.query<{ metadata: unknown; body: string; fingerprint: string }>(`SELECT to_jsonb(p)-'prosrc' metadata,
    p.prosrc body,h.fingerprint FROM pg_proc p JOIN native_turn_contract_helpers h ON p.oid=to_regprocedure(h.signature)
    WHERE h.signature='native_turn_parent_scope(uuid,uuid)'`)).rows[0]
}
async function refused(message: string) {
  const before = await state()
  await expect(db.exec(migration)).rejects.toThrow(message)
  await db.exec('ROLLBACK')
  expect(await state()).toEqual(before)
}

describe.sequential('[COMP:api/native-chat-read-cost] parent audience forward migration', () => {
  it('preserves OID, complete metadata and ACL while advancing the exact canonical registry pin', async () => {
    const before = await state()
    await db.exec(migration)
    const after = await state()
    expect(after.metadata).toEqual(before.metadata)
    expect(after.body).not.toBe(before.body)
    expect(after.fingerprint).not.toBe(before.fingerprint)
    expect((await db.query<{ value: boolean }>('SELECT native_turn_helpers_current() AS value')).rows[0].value).toBe(true)
  })

  it('refuses altered source even when its registry was recomputed', async () => {
    await db.exec(`DO $body$DECLARE definition text;BEGIN
      definition:=replace(pg_get_functiondef('native_turn_parent_scope(uuid,uuid)'::regprocedure),
        'IF NOT session_recording_read_allowed(i)', 'IF false AND NOT session_recording_read_allowed(i)');
      EXECUTE definition;END$body$;
      UPDATE native_turn_contract_helpers h SET fingerprint=encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')
      FROM pg_proc p WHERE p.oid=to_regprocedure(h.signature)`)
    await refused('native_parent_audience_predecessor_changed')
  })

  it('refuses an unexpected executable pin consumer without changing either function', async () => {
    const { fingerprint } = await state()
    await db.exec(`CREATE FUNCTION fixture_unreviewed_consumer() RETURNS text LANGUAGE sql AS $body$SELECT '${fingerprint}'::text$body$`)
    await refused('native_parent_audience_unexpected_pin_consumer')
  })

  it.each([
    'ALTER FUNCTION native_turn_parent_scope(uuid,uuid) SECURITY INVOKER',
    'ALTER FUNCTION native_turn_parent_scope(uuid,uuid) VOLATILE',
    'GRANT EXECUTE ON FUNCTION native_turn_parent_scope(uuid,uuid) TO PUBLIC',
  ])('refuses changed execution authority even with a matching registry: %s', async (change) => {
    await db.exec(`${change};
      UPDATE native_turn_contract_helpers h SET fingerprint=encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')
      FROM pg_proc p WHERE p.oid=to_regprocedure(h.signature)`)
    await refused('native_parent_audience_predecessor_changed')
  })

  it('refuses a drifted registry before any helper replacement', async () => {
    await db.exec("UPDATE native_turn_contract_helpers SET fingerprint=repeat('0',64)")
    await refused('native_parent_audience_dependency_changed')
  })
})
