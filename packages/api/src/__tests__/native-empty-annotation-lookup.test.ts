/** [COMP:api/native-chat-read-cost] The authenticated predecessor and real
 * forward splice keep absent annotations denied without repeating parent proof. */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
const db = new PGlite()
const [workspace,session,message,revision]=Array.from({length:4},()=>randomUUID())
const evaluate=()=>db.query('SELECT application_session_eval_point_state($1,$2,$3,$4,$5) AS value',[workspace,'session_message_annotation',message,['id'],'{}'])
const migration=await readFile(new URL('../../migrations/8242_native_empty_annotation_lookup.sql',import.meta.url),'utf8')
const splice=migration.slice(migration.indexOf('DO $empty_annotation_lookup$'),migration.indexOf('END $empty_annotation_lookup$;')+'END $empty_annotation_lookup$;'.length)
beforeAll(async()=>{
 await db.exec(`CREATE ROLE annotation_lookup_owner; GRANT CREATE ON SCHEMA public TO annotation_lookup_owner; SET ROLE annotation_lookup_owner;
  CREATE TABLE session_messages(id uuid,workspace_id uuid,session_id uuid,scope_version integer,sequence_num integer);
  CREATE TABLE session_context_scope_revisions(id uuid,workspace_id uuid,session_id uuid,parent_kind text,parent_id uuid);
  CREATE TABLE session_message_annotation_heads(workspace_id uuid,session_id uuid,message_id uuid,scope_revision_id uuid);
  CREATE FUNCTION recording_source_read_allowed(uuid,text,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
  CREATE FUNCTION application_session_field_keys(text) RETURNS text[] LANGUAGE sql AS $$ SELECT ARRAY['id'] $$;
  CREATE FUNCTION application_session_query_parent(uuid,uuid) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'parent_admission_called'; END $$;`)
 await db.query('INSERT INTO session_messages VALUES($1,$2,$3,1,1)',[message,workspace,session])
 await db.exec(await readFile(new URL('./fixtures/native-annotation-point-predecessor.sql',import.meta.url),'utf8'))
 // Metadata witnesses use the actual ordinary-role predecessor, as in the full migration.
 await db.exec(`CREATE TEMP TABLE annotation_lookup_originals AS SELECT oid,prosrc expected_body,
  encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') fingerprint FROM pg_proc p
  WHERE oid='application_session_eval_point_state(uuid,text,uuid,text[],jsonb)'::regprocedure;
  CREATE TABLE private_session_display_contract(signature text,fingerprint text);
  INSERT INTO private_session_display_contract SELECT oid::regprocedure::text,fingerprint FROM annotation_lookup_originals;`)
})
afterAll(async()=>db.close())
describe.sequential('[COMP:api/native-chat-read-cost] absent annotation lookup',()=>{
 it('reproduces the predecessor parent lookup before discovering no annotation',async()=>{
  await expect(evaluate()).rejects.toThrow('parent_admission_called')
 })
 it('executes the forward splice and refuses absence without entering parent authority',async()=>{
  await db.exec(splice)
  expect((await evaluate()).rows).toEqual([{value:null}])
 })
 it('refuses mismatched workspace/session/message heads without reading a body',async()=>{
  await db.query('INSERT INTO session_context_scope_revisions VALUES($1,$2,$3,$4,$5)',[revision,workspace,session,'message_annotation',message])
  for(const [headWorkspace,headSession,headMessage] of [[randomUUID(),session,message],[workspace,randomUUID(),message],[workspace,session,randomUUID()]]) {
   await db.query('INSERT INTO session_message_annotation_heads VALUES($1,$2,$3,$4)',[headWorkspace,headSession,headMessage,revision])
   expect((await evaluate()).rows).toEqual([{value:null}])
   await db.exec('DELETE FROM session_message_annotation_heads')
  }
 })
 it('keeps the earlier recording privacy gate and its refusal shape',async()=>{
  await db.exec('CREATE OR REPLACE FUNCTION recording_source_read_allowed(uuid,text,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$')
  expect((await evaluate()).rows).toEqual([{value:{memo:{}}}])
  await db.exec('CREATE OR REPLACE FUNCTION recording_source_read_allowed(uuid,text,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$')
 })
 it('does not cache absence: a new valid head enters the original parent admission',async()=>{
  await db.query('INSERT INTO session_message_annotation_heads VALUES($1,$2,$3,$4)',[workspace,session,message,revision])
  await expect(evaluate()).rejects.toThrow('parent_admission_called')
  await db.exec('DELETE FROM session_message_annotation_heads')
  expect((await evaluate()).rows).toEqual([{value:null}])
 })
})
