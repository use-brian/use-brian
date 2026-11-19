import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// This executes the maintained module against a finite original-store harness.
// It does not qualify migration authentication, RLS, or an installed reader.
const script = (name: string) => readFileSync(new URL(`../../../scripts/conversation-store/${name}`, import.meta.url), 'utf8')
let db: PGlite
const schema = `
CREATE ROLE app_user;
CREATE TABLE workspaces(id uuid PRIMARY KEY);
CREATE TABLE sessions(id uuid PRIMARY KEY,workspace_id uuid REFERENCES workspaces ON DELETE CASCADE,visibility text,user_id uuid);
CREATE TABLE native_turn_frames(id uuid PRIMARY KEY,workspace_id uuid REFERENCES workspaces ON DELETE CASCADE,session_id uuid,format smallint,manifest_digest text);
CREATE TABLE session_context_scope_revisions(id uuid PRIMARY KEY,workspace_id uuid REFERENCES workspaces ON DELETE CASCADE,session_id uuid,parent_kind text,parent_id uuid,scope_version int,payload_sha256 text,user_id uuid,assistant_id uuid,sensitivity text,compartments text[],project_ids uuid[],scope_held bool DEFAULT false);
CREATE TABLE session_context_revision_contents(revision_id uuid PRIMARY KEY,workspace_id uuid REFERENCES workspaces ON DELETE CASCADE,content jsonb);
CREATE TABLE scope_derivations(id uuid PRIMARY KEY,workspace_id uuid REFERENCES workspaces ON DELETE CASCADE,resource_kind text,resource_id uuid,resource_version text,user_id uuid,assistant_id uuid,sensitivity text,compartments text[],project_ids uuid[]);
CREATE TABLE scope_derivation_sources(workspace_id uuid REFERENCES workspaces ON DELETE CASCADE,derivation_id uuid,source_kind text,source_id uuid,source_version text);
CREATE TABLE application_field_resources(id uuid PRIMARY KEY,workspace_id uuid REFERENCES workspaces ON DELETE CASCADE,selection text,fields text[]);
CREATE TABLE application_field_observations(workspace_id uuid REFERENCES workspaces ON DELETE CASCADE,resource_id uuid,version text,record_version text,policy_version text,source_scope jsonb);
CREATE TABLE application_field_observation_sources(workspace_id uuid REFERENCES workspaces ON DELETE CASCADE,resource_id uuid,version text);
CREATE TABLE application_query_domains(id uuid PRIMARY KEY,workspace_id uuid REFERENCES workspaces ON DELETE CASCADE,identity text,origin jsonb,domain jsonb,type_key text);
CREATE FUNCTION sensitivity_rank(text) RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT CASE $1 WHEN 'public' THEN 0 WHEN 'internal' THEN 1 WHEN 'confidential' THEN 2 END $$;
CREATE FUNCTION scope_source_table(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN $1 IN('session_message','workspace_file') THEN $1 END $$;
CREATE FUNCTION scope_review_state_held(text,uuid) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT false $$;
`
beforeAll(async () => {
  db = new PGlite()
  await db.exec(schema)
  const original = readFileSync(new URL('../../../migrations/631_entity_knowledge_derivation.sql', import.meta.url), 'utf8')
  await db.exec(original.slice(original.indexOf('CREATE FUNCTION entity_derivation_envelope_valid'), original.indexOf('-- The only INSERT exemption')))
  await db.exec(script('manifest.sql'))
  await db.exec(script('conversion.sql'))
}, 30_000)
afterAll(async () => { await db?.close() })
async function scalar<T>(sql: string, args: unknown[] = []): Promise<T> {
  return Object.values((await db.query<Record<string, T>>(sql, args)).rows[0]!)[0]!
}
async function fixture() {
  const w = randomUUID(), session = randomUUID()
  await db.query('INSERT INTO workspaces VALUES($1)', [w])
  await db.query("INSERT INTO sessions VALUES($1,$2,'workspace',NULL)", [session, w])
  return { w, session, run: () => scalar<string>("SELECT native_conversation_conversion_start($1,repeat('a',64))", [w]) }
}
async function frame(w: string, session: string, id: string, count = 1) {
  const sources = Array.from({ length: count }, () => ({ workspaceId: w, userId: null, assistantId: null,
    sensitivity: 'internal', compartments: [], projectIds: [], resourceKind: 'session_message', resourceId: randomUUID(), version: '1' }))
  const payload = { kind: 'native_turn_frame_v1', originalSources: sources, declaredSources: sources }
  const digest = await scalar<string>("SELECT encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex')", [JSON.stringify(payload)])
  const declaration = randomUUID()
  await db.query('INSERT INTO native_turn_frames VALUES($1,$2,$3,1,$4)', [id, w, session, digest])
  await db.query("INSERT INTO session_context_scope_revisions VALUES($1,$2,$3,'turn_frame',$1,1,$4,NULL,NULL,'internal','{}','{}',false)", [id, w, session, digest])
  await db.query('INSERT INTO session_context_revision_contents VALUES($1,$2,$3)', [id, w, JSON.stringify(payload)])
  await db.query("INSERT INTO scope_derivations VALUES($1,$2,'session_context_revision',$3,'1',NULL,NULL,'internal','{}','{}')", [declaration, w, id])
  await db.query("INSERT INTO scope_derivation_sources SELECT $1,$2,'session_message',(s->>'resourceId')::uuid,'1' FROM jsonb_array_elements($3::jsonb) s", [w, declaration, JSON.stringify(sources)])
  return { payload, digest, declaration }
}
const page = (run: string, units = 32, bytes = 16_777_216) => scalar<Record<string, unknown>>('SELECT native_conversation_conversion_page($1,$2,$3)', [run, units, bytes])
async function count(table: string, w: string) { return scalar<number>(`SELECT count(*)::int FROM ${table} WHERE workspace_id=$1`, [w]) }

describe('[COMP:api/native-turn-frame] standalone immutable conversion SQL', () => {
  it('compiles exact original/declared tuples idempotently and checks fresh holds and floors', async () => {
    const f = await fixture(), id = randomUUID()
    const original = await frame(f.w, f.session, id)
    const run = await f.run()
    expect((await page(run, 1)).units).toBe(1)
    expect(await scalar('SELECT native_conversation_compiled_frame_pair($1,$2)', [f.w, id])).toBe(true)
    expect(await scalar('SELECT to_jsonb(originals)->0 FROM native_conversation_frame_requirements WHERE id=$1', [id])).toMatchObject({
      workspace_id: f.w, id: original.payload.originalSources[0]!.resourceId, version: '1', kind: 'session_message',
    })
    await db.query('SELECT native_conversation_compile_frame_requirements($1,$2)', [f.w, id])
    expect(await count('native_conversation_frame_requirements', f.w)).toBe(1)
    await db.query('UPDATE session_context_scope_revisions SET scope_held=true WHERE id=$1', [id])
    expect(await scalar('SELECT native_conversation_compiled_frame_pair($1,$2)', [f.w, id])).toBe(false)
    await db.query("UPDATE session_context_scope_revisions SET scope_held=false,sensitivity='public' WHERE id=$1", [id])
    expect(await scalar('SELECT native_conversation_compiled_frame_pair($1,$2)', [f.w, id])).toBe(false)
  })

  it('does not materialize an uncounted second descriptor at the page byte boundary', async () => {
    const f = await fixture(), first = '10000000-0000-4000-8000-000000000001', second = '20000000-0000-4000-8000-000000000002'
    await frame(f.w, f.session, first)
    await frame(f.w, f.session, second, 80)
    const run = await f.run()
    const size = await scalar<number>(`WITH x AS (SELECT native_conversation_frame_requirement_input($1,$2) d), v AS (
      SELECT d,encode(sha256(convert_to(to_jsonb(d)::text,'UTF8')),'hex') digest FROM x)
      SELECT pg_column_size(d)+pg_column_size(jsonb_build_array('frame',$2::uuid,'1',repeat('0',64),digest,'compiled_frame')) FROM v`, [f.w, first])
    const result = await page(run, 2, size + 100)
    expect(result).toMatchObject({ state: 'committed', units: 1, bytes: size })
    expect(await scalar('SELECT id::text FROM native_conversation_frame_requirements WHERE workspace_id=$1', [f.w])).toBe(first)
    expect(await scalar('SELECT cursor_id::text FROM native_conversation_conversion_runs WHERE id=$1', [run])).toBe(first)
    expect(await scalar('SELECT count(*)::int FROM native_conversation_conversion_inputs WHERE run_id=$1', [run])).toBe(1)
    expect(result.sourceBytes as number).toBeGreaterThan(await scalar<number>('SELECT bytes FROM native_conversation_conversion_inputs WHERE run_id=$1', [run]))
    expect((await page(run, 1)).units).toBe(1)
    expect(await count('native_conversation_frame_requirements', f.w)).toBe(2)
  })

  it('rolls back the complete page on malformed originals and too-small budgets', async () => {
    const f = await fixture(), a = '10000000-0000-4000-8000-000000000003', b = '20000000-0000-4000-8000-000000000004'
    await frame(f.w, f.session, a)
    await frame(f.w, f.session, b)
    const run = await f.run()
    await expect(page(run, 1, 1)).rejects.toThrow('conversion_page_budget_too_small')
    await db.query("UPDATE session_context_revision_contents SET content=content||'{\"unexpected\":true}'::jsonb WHERE revision_id=$1", [b])
    await expect(page(run, 2)).rejects.toThrow('conversion_unsupported_payload')
    expect(await count('native_conversation_frame_requirements', f.w)).toBe(0)
    expect(await scalar('SELECT page::int FROM native_conversation_conversion_runs WHERE id=$1', [run])).toBe(0)
    expect(await scalar('SELECT count(*)::int FROM native_conversation_conversion_inputs WHERE run_id=$1', [run])).toBe(0)
  })

  it('preserves complete original-adapter input beyond native 4096 eligibility', async () => {
    const f = await fixture(), id = randomUUID()
    const original = await frame(f.w, f.session, id, 4097)
    const run = await f.run()
    expect((await page(run, 1)).units).toBe(1)
    expect(await count('native_conversation_frame_requirements', f.w)).toBe(0)
    expect(await scalar('SELECT processing_mode FROM native_conversation_conversion_inputs WHERE run_id=$1', [run])).toBe('original_adapter')
    expect(await scalar('SELECT content FROM session_context_revision_contents WHERE revision_id=$1', [id])).toEqual(original.payload)
  }, 30_000)

  it('refuses descriptor mutation and missing original bytes without advancing', async () => {
    const f = await fixture(), id = randomUUID()
    await frame(f.w, f.session, id)
    const run = await f.run()
    await page(run, 1)
    await expect(db.query("UPDATE native_conversation_frame_requirements SET payload_digest=repeat('b',64) WHERE id=$1", [id])).rejects.toThrow('conversion_requirement_immutable')
    await db.query('DELETE FROM session_context_revision_contents WHERE revision_id=$1', [id])
    expect(await count('native_conversation_frame_requirements', f.w)).toBe(0)
    await db.query("UPDATE native_conversation_conversion_runs SET phase='delta' WHERE id=$1", [run])
    await expect(page(run, 1)).rejects.toThrow('conversion_missing_original')
    expect(await scalar('SELECT page::int FROM native_conversation_conversion_runs WHERE id=$1', [run])).toBe(1)
  })

  it('retains a newer enrollment generated after page selection and drains it on a later page', async () => {
    const f = await fixture(), id = randomUUID()
    await frame(f.w, f.session, id)
    const run = await f.run()
    await db.query("UPDATE native_conversation_conversion_runs SET phase='delta' WHERE id=$1", [run])
    expect(await scalar('SELECT generation::int FROM native_conversation_conversion_pending WHERE workspace_id=$1 AND kind=\'frame\'', [f.w])).toBe(2)
    // Deterministic insertion seam advances gen2 to gen3 after selection, before
    // the conditional delete. True multi-connection lock ordering is a PG gate.
    await db.exec(`CREATE FUNCTION test_conversion_reenroll() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      UPDATE native_conversation_conversion_pending SET generation=generation+1
        WHERE workspace_id=NEW.workspace_id AND kind='frame' AND id=NEW.id;
      RETURN NEW; END $$;
      CREATE TRIGGER test_conversion_reenroll AFTER INSERT ON native_conversation_frame_requirements FOR EACH ROW EXECUTE FUNCTION test_conversion_reenroll();`)
    try {
      await page(run, 1)
      expect(await scalar('SELECT generation::int FROM native_conversation_conversion_pending WHERE workspace_id=$1 AND kind=\'frame\'', [f.w])).toBe(3)
      await page(run, 1)
      expect(await scalar('SELECT count(*)::int FROM native_conversation_conversion_pending WHERE workspace_id=$1 AND kind=\'frame\'', [f.w])).toBe(0)
    } finally { await db.exec('DROP TRIGGER test_conversion_reenroll ON native_conversation_frame_requirements; DROP FUNCTION test_conversion_reenroll();') }
  })

  it('rejects caller-authored descriptor tuples and unknown formats before a receipt', async () => {
    const f = await fixture(), id = randomUUID()
    await frame(f.w, f.session, id)
    await expect(db.query(`INSERT INTO native_conversation_frame_requirements
      SELECT (jsonb_populate_record(NULL::native_conversation_frame_requirements,
        to_jsonb(native_conversation_frame_requirement_input($1,$2))||jsonb_build_object('payload_digest',repeat('b',64)))).*`, [f.w, id])).rejects.toThrow('conversion_original_or_descriptor_mismatch')
    await db.query('UPDATE native_turn_frames SET format=3 WHERE id=$1', [id])
    const run = await f.run()
    await expect(page(run, 1)).rejects.toThrow('conversion_unsupported_frame')
    expect(await count('native_conversation_frame_requirements', f.w)).toBe(0)
    expect(await scalar('SELECT page::int FROM native_conversation_conversion_runs WHERE id=$1', [run])).toBe(0)
  })

  it('resumes through enrolled behind-cursor inserts, reconciles and purges with its parent', async () => {
    const f = await fixture(), id = '90000000-0000-4000-8000-000000000009'
    await frame(f.w, f.session, id)
    const run = await f.run()
    await page(run, 1)
    expect(await f.run()).toBe(run)
    const earlier = '10000000-0000-4000-8000-000000000009'
    await frame(f.w, f.session, earlier)
    let done = false
    for (let n = 0; n < 30; n++) {
      const result = await page(run, 2)
      if (result.state === 'await_barrier') { done = true; break }
    }
    expect(done).toBe(true)
    expect(await scalar('SELECT native_conversation_conversion_reconcile($1)', [run])).toMatchObject({ state: 'reconciled' })
    expect(await count('native_conversation_frame_requirements', f.w)).toBe(2)
    await db.query('DELETE FROM workspaces WHERE id=$1', [f.w])
    expect(await count('native_conversation_frame_requirements', f.w)).toBe(0)
    expect(await page(run)).toEqual({ state: 'absent' })
  })
})
