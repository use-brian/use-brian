/** Raw task writes keep the exact selected field set and current commit authority. */
import { randomUUID } from 'node:crypto'
import { afterAll,afterEach,beforeAll,beforeEach,describe,expect,it } from 'vitest'
import { applyRLSGucs,getAppPool,getPool } from '../../db/client.js'
import { createTask } from '../../db/tasks.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()

describe('[COMP:api/application-records] exact raw task written fields and current commit authority',()=>{
 const owner=getPool(),userId=randomUUID(),writerId=randomUUID(),assistantId=randomUUID()
 let workspaceId:string,taskId:string
 beforeAll(async()=>{
  for(const id of [userId,writerId])await owner.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[id])
  await owner.query(`CREATE SEQUENCE task_written_fixture_revision_seq;
   CREATE TABLE task_written_fixture_configuration(workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    enabled boolean NOT NULL DEFAULT true,revision bigint NOT NULL DEFAULT nextval('task_written_fixture_revision_seq'));
   ALTER TABLE task_written_fixture_configuration ENABLE ROW LEVEL SECURITY;
   REVOKE ALL ON task_written_fixture_configuration,task_written_fixture_revision_seq FROM PUBLIC;
   CREATE FUNCTION task_written_fixture_configuration_bump() RETURNS trigger
   LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
   BEGIN NEW.revision:=nextval('task_written_fixture_revision_seq');RETURN NEW;END $$;
   REVOKE ALL ON FUNCTION task_written_fixture_configuration_bump() FROM PUBLIC;
   CREATE TRIGGER task_written_fixture_configuration_bump BEFORE UPDATE ON task_written_fixture_configuration
    FOR EACH ROW EXECUTE FUNCTION task_written_fixture_configuration_bump();
   CREATE TRIGGER task_written_fixture_configuration_epoch AFTER INSERT OR UPDATE OR DELETE ON task_written_fixture_configuration
    FOR EACH ROW EXECUTE FUNCTION application_policy_epoch_changed();
   CREATE FUNCTION task_written_fixture_configuration_revision(w uuid) RETURNS text
   LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
    SELECT coalesce((SELECT revision::text FROM task_written_fixture_configuration WHERE workspace_id=w),'0')
   $$;
   REVOKE ALL ON FUNCTION task_written_fixture_configuration_revision(uuid) FROM PUBLIC;
   CREATE FUNCTION task_written_fixture_catalog(w uuid,o jsonb,t text) RETURNS jsonb
   LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
   DECLARE keys text[];fields jsonb;
   BEGIN
    keys:=application_native_field_keys(t);
    SELECT jsonb_agg(jsonb_build_object('key',key,'read','[["reader"]]'::jsonb,'write',CASE WHEN coalesce((SELECT enabled FROM task_written_fixture_configuration WHERE workspace_id=w),true) THEN '[["writer"]]'::jsonb ELSE '[]'::jsonb END,
     'releaseReadTo','[]'::jsonb,'releaseWriteTo','[]'::jsonb) ORDER BY key) INTO fields FROM unnest(keys) key;
    RETURN jsonb_build_object('moduleKey','native','origin',o,'typeKey',t,'schemaVersion','task-written-1','policyVersion','task-written-1','fieldKeys',keys,'fields',fields,
     'scope',jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity','internal','compartments','[]'::jsonb,'projectIds','[]'::jsonb));
   END $$;
   REVOKE ALL ON FUNCTION task_written_fixture_catalog(uuid,jsonb,text) FROM PUBLIC;
   CREATE FUNCTION task_written_fixture_metadata(w uuid,o jsonb,t text,i text) RETURNS jsonb
   LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
   DECLARE source jsonb;
   BEGIN
    source:=read_scope_source(w,'task',i::uuid);
    IF source IS NULL THEN RETURN NULL;END IF;
    RETURN (task_written_fixture_catalog(w,o,t)-'scope')||jsonb_build_object('recordVersion',source->>'version','source',source);
   END $$;
   REVOKE ALL ON FUNCTION task_written_fixture_metadata(uuid,jsonb,text,text) FROM PUBLIC;
   INSERT INTO application_native_field_contracts(module_key,contract_version,role_keys,metadata_reader,catalog_reader,configuration_required,configuration_reader)
    VALUES('native','task-written-1',ARRAY['reader','writer'],'task_written_fixture_metadata(uuid,jsonb,text,text)'::regprocedure,'task_written_fixture_catalog(uuid,jsonb,text)'::regprocedure,true,'task_written_fixture_configuration_revision(uuid)'::regprocedure)`)
 })
 beforeEach(async()=>{
  workspaceId=randomUUID()
  await owner.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Fictional task write boundaries',$2,false)",[workspaceId,userId])
  await owner.query('INSERT INTO task_written_fixture_configuration(workspace_id) VALUES($1)',[workspaceId])
  for(const id of [userId,writerId])await owner.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,$3,'confidential')",[workspaceId,id,id===userId?'owner':'member'])
  await owner.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Fictional task writer',$2,$3,'primary','confidential')",[assistantId,userId,workspaceId])
  taskId=(await createTask(userId,{workspaceId,title:'Fictional original task write',access:{workspaceId,userId,assistantId,assistantKind:'primary',clearance:'confidential'}})).id
  await owner.query(`INSERT INTO application_native_resource_owners(workspace_id,origin,resource_type,module_key) VALUES($1,'{"kind":"native","moduleKey":"native"}','task','native')`,[workspaceId])
  for(const actor of [userId,writerId])for(const role of ['reader','writer'])await owner.query("INSERT INTO application_native_role_assignments(workspace_id,module_key,user_id,role_key,issued_by_user_id,starts_at) VALUES($1,'native',$2,$3,$4,'2020-01-01T00:00:00Z')",[workspaceId,actor,role,userId])
 })
 afterEach(async()=>{await owner.query('DELETE FROM workspaces WHERE id=$1',[workspaceId])})
 afterAll(async()=>{
  await owner.query("DELETE FROM application_native_field_contracts WHERE module_key='native'")
  await owner.query('DROP FUNCTION task_written_fixture_metadata(uuid,jsonb,text,text);DROP FUNCTION task_written_fixture_catalog(uuid,jsonb,text);DROP FUNCTION task_written_fixture_configuration_revision(uuid);DROP TABLE task_written_fixture_configuration;DROP FUNCTION task_written_fixture_configuration_bump();DROP SEQUENCE task_written_fixture_revision_seq')
  await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[userId,writerId]])
  await getAppPool().end();await owner.end()
 })
 async function actorClient(actor:string) {
  const client=await getAppPool().connect()
  await client.query('BEGIN');await applyRLSGucs(client,actor)
  expect((await client.query(`SELECT r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE') AS bypass
   FROM pg_roles r JOIN pg_class c ON c.oid='public.tasks'::regclass WHERE r.rolname=current_user`)).rows[0].bypass).toBe(false)
  return client
 }
 async function snapshot() {
  const [rows,history,receipts,audits,events,intents]=await Promise.all([
   owner.query('SELECT to_jsonb(t) AS value FROM tasks t WHERE workspace_id=$1 ORDER BY id',[workspaceId]),
   owner.query("SELECT to_jsonb(v) AS value FROM brain_row_versions v WHERE workspace_id=$1 AND primitive='task' ORDER BY id",[workspaceId]),
   owner.query('SELECT to_jsonb(r) AS value FROM application_operation_receipts r WHERE workspace_id=$1 ORDER BY id',[workspaceId]),
   owner.query('SELECT to_jsonb(a) AS value FROM application_command_audit a WHERE workspace_id=$1 ORDER BY receipt_id',[workspaceId]),
   owner.query('SELECT to_jsonb(e) AS value FROM application_committed_events e WHERE workspace_id=$1 ORDER BY receipt_id',[workspaceId]),
   owner.query('SELECT to_jsonb(i) AS value FROM application_native_task_write_intents i WHERE workspace_id=$1 ORDER BY physical_id,source_version',[workspaceId]),
  ])
  return {rows:rows.rows,history:history.rows,receipts:receipts.rows,audits:audits.rows,events:events.rows,intents:intents.rows}
 }
 const revokeWriter=()=>owner.query("UPDATE application_native_role_assignments SET status='revoked' WHERE workspace_id=$1 AND user_id=$2 AND role_key='writer'",[workspaceId,userId])
 it('Q04/Q05 refuses a raw equal title assignment after write-role loss despite retained reading and a caller-set intent',async()=>{
  const before=await snapshot();await revokeWriter()
  expect((await owner.query("SELECT role_key FROM application_native_role_assignments WHERE workspace_id=$1 AND user_id=$2 AND status='active'",[workspaceId,userId])).rows).toEqual([{role_key:'reader'}])
  const client=await actorClient(userId)
  try {
   await client.query("SELECT set_config('app.native_task_write_intent',$1,true)",[JSON.stringify({workspaceId,logicalId:taskId,fields:[]})])
   await expect(client.query('UPDATE tasks SET title=title WHERE workspace_id=$1 AND id=$2',[workspaceId,taskId])).rejects.toMatchObject({code:'42501'})
  }finally{await client.query('ROLLBACK');client.release()}
  expect(await snapshot()).toEqual(before)
  const independent=await actorClient(writerId)
  try {
   expect((await independent.query('UPDATE tasks SET title=title WHERE workspace_id=$1 AND id=$2 RETURNING scope_version::text AS version',[workspaceId,taskId])).rows).toEqual([{version:'2'}])
   await independent.query('COMMIT')
  }finally{await independent.query('ROLLBACK');independent.release()}
  const after=await snapshot()
  expect(after.rows[0].value).toMatchObject({id:taskId,title:'Fictional original task write',scope_version:2})
  expect(after.history).toHaveLength(before.history.length+1)
  expect(after.receipts).toHaveLength(before.receipts.length+1)
  expect(after.audits).toHaveLength(before.audits.length+1)
  expect(after.events).toHaveLength(before.events.length+1)
  expect(after.intents).toEqual([])
 })
 it('Q03/Q05/Q06 rolls an authorized raw task write and its version, history, receipt and outbox back when the writer role is independently revoked before commit',async()=>{
  const before=await snapshot(),client=await actorClient(userId)
  try {
   expect((await client.query('UPDATE tasks SET title=$3 WHERE workspace_id=$1 AND id=$2 RETURNING scope_version::text AS version',[workspaceId,taskId,'Fictional rolled back task title'])).rows).toEqual([{version:'2'}])
   await revokeWriter()
   await expect(client.query('COMMIT')).rejects.toMatchObject({code:'42501'})
  }finally{await client.query('ROLLBACK');client.release()}
  expect(await snapshot()).toEqual(before)
  const independent=await actorClient(writerId)
  try {
   expect((await independent.query('UPDATE tasks SET title=$3 WHERE workspace_id=$1 AND id=$2 RETURNING scope_version::text AS version',[workspaceId,taskId,'Fictional independently authorized task title'])).rows).toEqual([{version:'2'}])
   await independent.query('COMMIT')
  }finally{await independent.query('ROLLBACK');independent.release()}
  const after=await snapshot()
  expect(after.rows).toHaveLength(before.rows.length)
  expect(after.rows[0].value).toMatchObject({id:taskId,title:'Fictional independently authorized task title',scope_version:2})
  expect(after.history).toHaveLength(before.history.length+1)
  expect(after.receipts).toHaveLength(before.receipts.length+1)
  expect(after.audits).toHaveLength(before.audits.length+1)
  expect(after.events).toHaveLength(before.events.length+1)
  expect(after.intents).toEqual([])
 })
 it('Q06/Q07 holds an old raw task write after configuration change and restore while a fresh independent writer succeeds',async()=>{
  const before=await snapshot(),client=await actorClient(userId)
  try {
   expect((await client.query('UPDATE tasks SET title=$3 WHERE workspace_id=$1 AND id=$2 RETURNING scope_version::text AS version',[workspaceId,taskId,'Fictional task title before restored authority'])).rows).toEqual([{version:'2'}])
   const originalConfiguration=(await owner.query('SELECT revision FROM task_written_fixture_configuration WHERE workspace_id=$1',[workspaceId])).rows[0].revision
   await owner.query('UPDATE task_written_fixture_configuration SET enabled=false WHERE workspace_id=$1',[workspaceId])
   await owner.query('UPDATE task_written_fixture_configuration SET enabled=true WHERE workspace_id=$1',[workspaceId])
   const restored=(await owner.query('SELECT enabled,revision FROM task_written_fixture_configuration WHERE workspace_id=$1',[workspaceId])).rows[0]
   expect(restored.enabled).toBe(true);expect(BigInt(restored.revision)).toBeGreaterThan(BigInt(originalConfiguration))
   expect((await client.query(`SELECT read_native_application_field_catalog($1,'{"kind":"native","moduleKey":"native"}','task')->'writeFields' AS fields`,[workspaceId])).rows[0].fields).toContain('title')
   await expect(client.query('COMMIT')).rejects.toMatchObject({code:'42501'})
  }finally{await client.query('ROLLBACK');client.release()}
  expect(await snapshot()).toEqual(before)
  const independent=await actorClient(writerId)
  try {
   expect((await independent.query('UPDATE tasks SET title=$3 WHERE workspace_id=$1 AND id=$2 RETURNING scope_version::text AS version',[workspaceId,taskId,'Fictional fresh task after restored authority'])).rows).toEqual([{version:'2'}])
   await independent.query('COMMIT')
  }finally{await independent.query('ROLLBACK');independent.release()}
  const after=await snapshot()
  expect(after.rows[0].value).toMatchObject({id:taskId,title:'Fictional fresh task after restored authority',scope_version:2})
  expect(after.history).toHaveLength(before.history.length+1)
  expect(after.receipts).toHaveLength(before.receipts.length+1)
  expect(after.audits).toHaveLength(before.audits.length+1)
  expect(after.events).toHaveLength(before.events.length+1)
  expect(after.intents).toEqual([])
 })

})
