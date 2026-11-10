/** [COMP:api/native-chat-read-cost] Real metadata certificate SQL is conservative;
 * this isolated unit does not replace native actor/source/proof integration tests. */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
const db=new PGlite()
const ids=Object.fromEntries(['workspace','session','owner','assistant','other','policy','integration','channel','route'].map(k=>[k,randomUUID()])) as Record<string,string>
const conversation='-1000008243:topic:4'
const migration=await readFile(new URL('../../migrations/8243_active_work_recording_native_proof.sql',import.meta.url),'utf8')
const certificate=migration.split('certificate constant text:=$certificate$')[1].split('$certificate$;')[0]
const query=(sql:string,values:unknown[]=[])=>db.query<Record<string,unknown>>(sql,values)
const binding=(extra:Record<string,unknown>={})=>({version:1,channelId:conversation,audienceType:'group',recipientUserId:null,clearance:'internal',compartments:[],projectIds:[],approvedByUserId:ids.owner,expiresAt:null,...extra})
const config=async(bindings:unknown[])=>query('UPDATE channel_integrations SET config=$1 WHERE id=$2',[JSON.stringify({deliveryAudienceBindings:bindings}),ids.integration])
const read=async()=> (await query('SELECT fixture_recording_certificate($1,$2) AS value',[ids.workspace,ids.session])).rows[0].value as Record<string,unknown>
const eligible=async()=> (await read()).eligible
beforeAll(async()=>{
 await db.exec(`CREATE ROLE work_proof_owner; GRANT CREATE ON SCHEMA public TO work_proof_owner; SET ROLE work_proof_owner;
 CREATE TABLE workspaces(id uuid,department_read_v2 boolean,project_shared_spaces boolean);
 CREATE TABLE sessions(id uuid,workspace_id uuid,recording_privacy_held boolean,visibility text,channel_type text,anchor_kind text,anchor_ref text,channel_id text,recording_revision integer,recording_policy_id uuid,context_project_id uuid,user_id uuid,assistant_id uuid,effective_clearance text,context_compartments text[]);
 CREATE TABLE channel_recording_policies(id uuid,workspace_id uuid,session_id uuid,revision integer,enabled boolean,destination text,project_id uuid,conversation_id text,owner_user_id uuid,integration_id uuid,bot_id text);
 CREATE TABLE channel_integrations(id uuid,channel_id uuid,status text,channel_type text,bot_user_id text,recording_owner_user_id uuid,config jsonb);
 CREATE TABLE channels(id uuid,workspace_id uuid,status text,channel_type text,clearance text,enabled_capabilities text[]);
 CREATE TABLE workspace_members(workspace_id uuid,user_id uuid,role text,clearance text,compartments text[]);
 CREATE TABLE assistants(id uuid,workspace_id uuid,clearance text,compartments text[],placement_department_id uuid);
 CREATE TABLE channel_assistants(id uuid,channel_id uuid,assistant_id uuid,external_surface_id text);
 CREATE TABLE workspace_projects(id uuid,workspace_id uuid,status text); CREATE TABLE project_shared_scopes(project_id uuid,status text);
 CREATE FUNCTION sensitivity_rank(text) RETURNS integer LANGUAGE sql AS $$ SELECT CASE $1 WHEN 'public' THEN 0 WHEN 'internal' THEN 1 WHEN 'confidential' THEN 2 ELSE 3 END $$;
 CREATE FUNCTION project_member_live(uuid,text,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;`)
 await db.exec(`CREATE FUNCTION fixture_recording_certificate(w uuid,sid uuid) RETURNS jsonb LANGUAGE plpgsql AS $body$
 DECLARE privacy_parents jsonb:=jsonb_build_array(jsonb_build_object('sessionId',sid));recording_epochs jsonb;
 BEGIN ${certificate} RETURN recording_epochs->sid::text;END $body$;`)
})
afterAll(async()=>db.close())
beforeEach(async()=>{
 await db.exec('TRUNCATE workspaces,sessions,channel_recording_policies,channel_integrations,channels,workspace_members,assistants,channel_assistants,workspace_projects,project_shared_scopes')
 await query('INSERT INTO workspaces VALUES($1,true,true)',[ids.workspace])
 await query("INSERT INTO workspace_members VALUES($1,$2,'owner','confidential','{}')",[ids.workspace,ids.owner])
 await query("INSERT INTO assistants VALUES($1,$2,'internal','{}',NULL)",[ids.assistant,ids.workspace])
 await query("INSERT INTO channels VALUES($1,$2,'active','telegram','internal','{}')",[ids.channel,ids.workspace])
 await query("INSERT INTO channel_integrations VALUES($1,$2,'active','telegram','987658243',$3,$4)",[ids.integration,ids.channel,ids.owner,JSON.stringify({deliveryAudienceBindings:[binding()]})])
 await query("INSERT INTO channel_assistants VALUES($1,$2,$3,$4)",[ids.route,ids.channel,ids.assistant,conversation])
 await query("INSERT INTO channel_recording_policies VALUES($1,$2,$3,1,true,'workspace',NULL,$4,$5,$6,'987658243')",[ids.policy,ids.workspace,ids.session,conversation,ids.owner,ids.integration])
 await query("INSERT INTO sessions VALUES($1,$2,false,'workspace','telegram','channel',$3,$3,1,$4,NULL,$5,$6,'internal','{}')",[ids.session,ids.workspace,conversation,ids.policy,ids.owner,ids.assistant])
})
describe('[COMP:api/native-chat-read-cost] active Work recording certificate',()=>{
 it('qualifies one exact active Work epoch using metadata only',async()=>{
  expect(await read()).toMatchObject({eligible:true,policy:{id:ids.policy,revision:1},routing:{assistantId:ids.assistant}})
 })
 it.each([
  ["UPDATE channel_recording_policies SET enabled=false"],
  ["UPDATE channel_recording_policies SET revision=2"],
  ["UPDATE channel_recording_policies SET session_id=NULL"],
  ["UPDATE channel_recording_policies SET destination='personal'"],
  ["UPDATE channel_integrations SET recording_owner_user_id=NULL"],
  ["UPDATE channel_integrations SET bot_user_id='different-bot'"],
  ["UPDATE channel_integrations SET status='revoked'"],
  ["UPDATE channels SET status='revoked'"],
  ["UPDATE sessions SET recording_privacy_held=true"],
  ["UPDATE sessions SET visibility='personal'"],
  ["DELETE FROM workspace_members"],
 ])('keeps changed recording authority ineligible: %s',async sql=>{
  await db.exec(sql);expect(await eligible()).toBe(false)
 })
 it('does not certify a shadowed or ambiguous route',async()=>{
  await query('UPDATE channel_assistants SET external_surface_id=$1',['-1000008243'])
  await query('INSERT INTO channel_assistants VALUES($1,$2,$3,$4)',[randomUUID(),ids.channel,ids.other,conversation])
  expect(await eligible()).toBe(false)
  await query('UPDATE channel_assistants SET assistant_id=$1',[ids.assistant])
  expect(await eligible()).toBe(true)
  await query('INSERT INTO channel_assistants VALUES($1,$2,$3,$4)',[randomUUID(),ids.channel,ids.other,conversation])
  expect(await eligible()).toBe(false)
 })
 it('does not let NULL predicates disappear in a mixed audience',async()=>{
  for(const invalid of [binding({approvedByUserId:ids.other}),binding({clearance:null}),binding({compartments:null}),binding({companyWide:'true'}),binding({version:'1'})]) {
   await config([binding(),invalid]);expect(await eligible()).toBe(false)
  }
 })
 it('requires well-formed company-wide scope and records all bots’ current audiences',async()=>{
  await config([binding({companyWide:true,compartments:['team:fictional']})]);expect(await eligible()).toBe(false)
  await config([binding({companyWide:true})]);expect(await eligible()).toBe(true)
  const otherChannel=randomUUID(),otherIntegration=randomUUID()
  await query("INSERT INTO channels VALUES($1,$2,'active','telegram','internal','{}')",[otherChannel,ids.workspace])
  await query("INSERT INTO channel_integrations VALUES($1,$2,'active','telegram','other-bot',$3,$4)",[otherIntegration,otherChannel,ids.owner,JSON.stringify({deliveryAudienceBindings:[binding({approvedByUserId:ids.other})]})])
  expect((await read()).audiences).toHaveLength(2);expect(await eligible()).toBe(false)
 })
 it('captures meaningful authority changes and excludes seen-chat timestamps',async()=>{
  const initial=await read()
  await query("UPDATE channel_integrations SET config=config||'{\"seenChats\":[{\"lastSeenAt\":\"2099-01-01T00:00:00Z\"}]}'::jsonb")
  expect(await read()).toEqual(initial)
  await config([binding({expiresAt:'2099-01-01T00:00:00Z'})])
  expect(await read()).not.toEqual(initial)
  await config([binding({expiresAt:'2000-01-01T00:00:00Z'})]);expect(await eligible()).toBe(false)
 })
})
