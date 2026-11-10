import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import type { Pool, PoolClient } from 'pg'
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
vi.mock('../../db/client.js',()=>({getPool:()=>{throw new Error('No live database')}}))
vi.mock('../../brain-stream/notify.js',()=>({notifyWorkspaceChange:vi.fn()}))
import { discoverExternalDestinations, externalDestinationTransports, destinationReadSql, destinationThreadRef } from '../destinations.js'
import { assertExternalDestination } from '../authority.js'
import { createExternalApprovalSourceRegistry, createExternalApprovalSourceSchema } from '../source-registry.js'
import { PROACTIVE_DELIVERY_TRANSPORTS } from '../../session-kind.js'
const db=new PGlite(), id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const w=id(1),a=id(2),u=id(3),auth=id(4),web=id(5)
const client={query:(sql:string,args?:unknown[])=>db.query(sql,args),release:()=>{}} as unknown as PoolClient
const notify=vi.fn(), registry=createExternalApprovalSourceRegistry({pool:{query:client.query,connect:async()=>client} as unknown as Pick<Pool,'query'|'connect'>,notify})
beforeAll(async()=>{
 await db.exec(`CREATE ROLE app_user;
 CREATE TABLE users(id uuid PRIMARY KEY,auth_version integer DEFAULT 0);
 CREATE TABLE workspaces(id uuid PRIMARY KEY);
 CREATE SEQUENCE application_policy_revision_seq;
 CREATE TABLE application_policy_workspace_epochs(workspace_id uuid PRIMARY KEY,revision bigint);
 CREATE TABLE assistants(id uuid PRIMARY KEY,workspace_id uuid);
 CREATE TABLE workspace_members(workspace_id uuid,user_id uuid,role text);
 CREATE TABLE auth_sessions(id uuid PRIMARY KEY,user_id uuid,auth_version integer DEFAULT 0,revoked_at timestamptz,expires_at timestamptz);
 CREATE TABLE sessions(id uuid PRIMARY KEY,workspace_id uuid,assistant_id uuid,channel_type text,channel_id text,transient boolean DEFAULT false,anchor_kind text DEFAULT 'none',recording_revision uuid,visible boolean DEFAULT true,held boolean DEFAULT false);
 CREATE TABLE channels(id uuid PRIMARY KEY,workspace_id uuid,status text,display_name text);
 CREATE TABLE channel_integrations(id uuid PRIMARY KEY,channel_id uuid,channel_type text,status text,bot_user_id text,team_id text);
 CREATE TABLE channel_assistants(id uuid PRIMARY KEY,channel_id uuid,assistant_id uuid,external_surface_id text);
 CREATE TABLE pending_approvals(id uuid PRIMARY KEY,workspace_id uuid,kind text,approver_user_id uuid,originating_assistant_id uuid,delivery_channel_type text,delivery_channel_id text);
 ALTER TABLE pending_approvals ENABLE ROW LEVEL SECURITY;
 CREATE POLICY member_read ON pending_approvals FOR SELECT USING(true);
 CREATE FUNCTION assistant_placement_visible(uuid,uuid) RETURNS boolean LANGUAGE sql AS 'SELECT EXISTS(SELECT 1 FROM assistants WHERE id=$2)';
 CREATE FUNCTION session_recording_read_allowed(uuid) RETURNS boolean LANGUAGE sql AS 'SELECT NOT held FROM sessions WHERE id=$1';
 CREATE FUNCTION session_context_parent_snapshot(uuid,uuid) RETURNS jsonb LANGUAGE sql AS 'SELECT jsonb_build_object(''visible'',visible) FROM sessions WHERE workspace_id=$1 AND id=$2';
 CREATE FUNCTION workflow_evidence_envelope_visible(uuid,jsonb) RETURNS boolean LANGUAGE sql AS 'SELECT ($2->>''visible'')::boolean';
 GRANT SELECT ON pending_approvals TO app_user;`)
 for(const migration of ['8252_external_human_approvals.sql','8253_workspace_external_approval_sources.sql','8254_external_approval_web_chat_destination.sql','8255_external_approval_conversation_members.sql']) await db.exec(readFileSync(new URL(`../../../migrations/${migration}`,import.meta.url),'utf8'))
 await db.query('INSERT INTO users(id) VALUES($1)',[u]); await db.query('INSERT INTO workspaces VALUES($1)',[w]); await db.query('INSERT INTO assistants VALUES($1,$2)',[a,w]); await db.query("INSERT INTO workspace_members VALUES($1,$2,'admin')",[w,u])
 await db.query("INSERT INTO auth_sessions(id,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",[auth,u])
 await db.query("INSERT INTO sessions(id,workspace_id,assistant_id,channel_type,channel_id) VALUES($1,$2,$3,'web','web')",[web,w,a])
 for(const [n,transport] of ['slack','telegram','whatsapp','discord','email','wechat','custom','feishu','msteams'].entries()){
  const cid=id(20+n)
  await db.query("INSERT INTO channels(id,workspace_id,status) VALUES($1,$2,'active')",[cid,w])
  await db.query("INSERT INTO channel_integrations(id,channel_id,channel_type,status) VALUES($1,$1,$2,'active')",[cid,transport])
  await db.query('INSERT INTO channel_assistants VALUES($1,$1,$2,NULL)',[cid,a])
  await db.query('INSERT INTO sessions(id,workspace_id,assistant_id,channel_type,channel_id) VALUES($1,$2,$3,$4,$5)',[id(40+n),w,a,transport,transport==='slack'?'room:thread:123':transport==='telegram'?'-100:topic:42':transport==='whatsapp'?'room@g.us':'room'])
 }
},30000)
afterAll(()=>db.close())
describe('[COMP:api/external-approval-destinations] conversation destination inventory',()=>{
 it('strictly separates legacy and destination inputs',()=>{
  expect(createExternalApprovalSourceSchema.parse({name:'New',assistantId:a,destinationId:web})).toEqual({name:'New',assistantId:a,destinationId:web})
  for(const extra of [{approverUserId:u},{channelId:'caller'},{audience:'conversation_members'},{destinationSessionId:web}]) expect(createExternalApprovalSourceSchema.safeParse({name:'New',assistantId:a,destinationId:web,...extra}).success).toBe(false)
 })
 it('lists every installation, explicitly marks unsupported transports and never advertises Discord',async()=>{
  expect(externalDestinationTransports).toEqual(['web',...PROACTIVE_DELIVERY_TRANSPORTS])
  const inventory=await registry.destinations({userId:u,sessionId:auth},w,a)
  expect(notify).not.toHaveBeenCalled()
  expect(inventory.connections).toHaveLength(9)
  for(const transport of ['discord','email','wechat']) expect(inventory.connections.find(i=>i.channelType===transport)).toMatchObject({available:false,reason:'unsupported_transport',label:expect.stringContaining(transport)})
  expect(inventory.destinations.map(d=>d.channelType).sort()).toEqual(['custom','feishu','msteams','slack','telegram','web','whatsapp'])
  expect(inventory.destinations.find(d=>d.channelType==='slack')?.channelId).toBe('room')
  expect(inventory.destinations.find(d=>d.channelType==='telegram')?.channelId).toBe('-100:topic:42')
 })
 it('does not offer a Cloud API or non-connector WhatsApp address as deliverable',async()=>{
  const inventory=()=>registry.destinations({userId:u,sessionId:auth},w,a)
  const target=(await inventory()).destinations.find(d=>d.channelType==='whatsapp')!
  const issued=await registry.create({userId:u,sessionId:auth},w,{name:'WhatsApp',assistantId:a,destinationId:target.id})
  const source=(await registry.get(issued.source.id))!
  await db.query("UPDATE channel_integrations SET bot_user_id='phone',team_id='waba' WHERE id=$1",[id(22)])
  expect((await inventory()).destinations.some(d=>d.channelType==='whatsapp')).toBe(false)
  expect((await inventory()).connections.find(c=>c.id===id(22))).toMatchObject({available:false,reason:'unsupported_transport'})
  await expect(assertExternalDestination(client,source,u)).rejects.toMatchObject({status:404})
  await db.query('UPDATE channel_integrations SET bot_user_id=NULL,team_id=NULL WHERE id=$1',[id(22)])
  await db.query("UPDATE sessions SET channel_id='unroutable' WHERE id=$1",[id(42)])
  expect((await inventory()).destinations.some(d=>d.channelType==='whatsapp')).toBe(false)
  await db.query("UPDATE sessions SET channel_id='room@g.us' WHERE id=$1",[id(42)])
 })
 it('retains mandatory native approvers and refuses orphan external reads',async()=>{
  await expect(db.query("INSERT INTO pending_approvals(id,workspace_id,kind) VALUES($1,$2,'workflow_step')",[id(800),w])).rejects.toThrow('native_approval_requires_approver')
  await db.query("INSERT INTO pending_approvals(id,workspace_id,kind) VALUES($1,$2,'external_action')",[id(801),w])
  expect((await db.query<{allowed:boolean}>('SELECT external_approval_conversation_read_allowed($1,$2) AS allowed',[w,id(801)])).rows[0].allowed).toBe(false)
  await db.query('DELETE FROM pending_approvals WHERE id=$1',[id(801)])
 })
 it('derives native thread suffixes only, without interpreting other provider addresses',()=>{
  for(const transport of ['slack','feishu']) {
   expect(destinationThreadRef(transport,'room:thread:123:thread:456')).toBe('123:thread:456')
   expect(destinationThreadRef(transport,'room')).toBeUndefined()
  }
  for(const transport of ['web','telegram','whatsapp','msteams','custom']) expect(destinationThreadRef(transport,'room:thread:123')).toBeUndefined()
 })
 it('freezes exact native thread authority and refuses parent/sibling escalation',async()=>{
  for(const [n,transport] of [[0,'slack'],[7,'feishu']] as const) {
   await db.query('UPDATE sessions SET channel_id=$2 WHERE id=$1',[id(40+n),'room:thread:123'])
   const target=(await registry.destinations({userId:u,sessionId:auth},w,a)).destinations.find(d=>d.sessionId===id(40+n))!
   expect(target).toMatchObject({channelId:'room',threadRef:'123'})
   const issued=await registry.create({userId:u,sessionId:auth},w,{name:transport,assistantId:a,destinationId:target.id})
   expect(issued.source.threadRef).toBe('123')
   const source=(await registry.authenticate(`Bearer ${issued.token}`))!
   expect(source.threadRef).toBe('123')
   await assertExternalDestination(client,source,u)
   await expect(assertExternalDestination(client,{...source,threadRef:undefined},u)).rejects.toMatchObject({status:404})
   await expect(assertExternalDestination(client,{...source,threadRef:'456'},u)).rejects.toMatchObject({status:404})
   for(const stored of ['room','room:thread:456']) {
    await db.query('UPDATE sessions SET channel_id=$2 WHERE id=$1',[id(40+n),stored])
    await expect(assertExternalDestination(client,source,u)).rejects.toMatchObject({status:404})
   }
   await db.query('UPDATE sessions SET channel_id=$2 WHERE id=$1',[id(40+n),'room:thread:123'])
   await expect(db.query('UPDATE workspace_external_approval_sources SET thread_ref=$2 WHERE id=$1',[source.id,'456'])).rejects.toThrow('immutable')
  }
  const issued=await registry.create({userId:u,sessionId:auth},w,{name:'Web',assistantId:a,destinationId:web})
  const source=(await registry.get(issued.source.id))!
  expect(source).not.toHaveProperty('threadRef')
  await expect(assertExternalDestination(client,{...source,threadRef:'123'},u)).rejects.toMatchObject({status:404})
 })
 it('uses envelope visibility AND recording privacy, not merely snapshot presence',async()=>{
  expect(destinationReadSql).toContain('workflow_evidence_envelope_visible')
  for(const column of ['visible','held']){
   await db.query(`UPDATE sessions SET ${column}=$2 WHERE id=$1`,[web,column==='held'])
   expect((await discoverExternalDestinations(client,w,a,u)).destinations.some(d=>d.sessionId===web)).toBe(false)
   await db.query(`UPDATE sessions SET ${column}=$2 WHERE id=$1`,[web,column==='visible'])
  }
 })
 it('creates immutable conversation authority; actual app_user RLS hides loss of current read or membership',async()=>{
  const issued=await registry.create({userId:u,sessionId:auth},w,{name:'Room',assistantId:a,destinationId:web})
  expect(issued.source).toMatchObject({audience:'conversation_members',approverUserId:null,destinationSessionId:web})
  const source=(await registry.get(issued.source.id))!
  await assertExternalDestination(client,source,u)
  await db.query("INSERT INTO pending_approvals(id,workspace_id,kind,originating_assistant_id,delivery_channel_type,delivery_channel_id) VALUES($1,$2,'external_action',$3,'web',$4)",[id(90),w,a,web])
  await db.query(`INSERT INTO external_approval_requests(approval_id,source_id,source_binding,external_request_id,task_id,session_id,payload_hash,immutable_input,expires_at) VALUES($1,$2,$3,'req','task','session',$3,'{}',now()+interval '1 day')`,[id(90),source.id,'0'.repeat(64)])
  const read=async()=>{
   await db.query("SELECT set_config('app.current_user_id',$1,false)",[u]);await db.exec('SET ROLE app_user')
   try{return (await db.query('SELECT id FROM pending_approvals')).rows}finally{await db.exec('RESET ROLE')}
  }
  expect(await read()).toHaveLength(1)
  for(const column of ['visible','held']){
   await db.query(`UPDATE sessions SET ${column}=$2 WHERE id=$1`,[web,column==='held'])
   expect(await read()).toHaveLength(0)
   await expect(assertExternalDestination(client,source,u)).rejects.toMatchObject({status:404})
   await db.query(`UPDATE sessions SET ${column}=$2 WHERE id=$1`,[web,column==='visible'])
  }
  await expect(db.query('UPDATE workspace_external_approval_sources SET destination_session_id=$2 WHERE id=$1',[source.id,id(91)])).rejects.toThrow('immutable')
  await db.query('DELETE FROM workspace_members WHERE user_id=$1',[u]);expect(await read()).toHaveLength(0)
  await db.query("INSERT INTO workspace_members VALUES($1,$2,'admin')",[w,u]);expect(await read()).toHaveLength(1)
  await registry.revoke({userId:u,sessionId:auth},w,source.id);expect(await read()).toHaveLength(0)
 })
 it('SQL authority and TypeScript discovery use identical thread/topic normalization and pinned winning routes',async()=>{
  for(const [n,transport,stored,provider,parent] of [
   [0,'slack','room:thread:123','room','room'],
   [1,'telegram','-100:topic:42','-100:topic:42','-100'],
   [2,'whatsapp','room@g.us:thread:123','room@g.us:thread:123','room@g.us:thread:123'],
   [6,'custom','-100:topic:42','-100:topic:42','-100:topic:42'],
   [7,'feishu','room:thread:123','room','room'],
   [8,'msteams','room:thread:123','room:thread:123','room:thread:123'],
  ] as const){
   await db.query('UPDATE sessions SET channel_id=$2 WHERE id=$1',[id(40+n),stored])
   await db.query('UPDATE channel_assistants SET external_surface_id=$2 WHERE id=$1',[id(20+n),parent])
   const inventory=await registry.destinations({userId:u,sessionId:auth},w,a)
   const destination=inventory.destinations.find(d=>d.sessionId===id(40+n))!
   expect(destination?.channelId).toBe(provider)
   const issued=await registry.create({userId:u,sessionId:auth},w,{name:transport,assistantId:a,destinationId:destination.id})
   await db.query("INSERT INTO pending_approvals(id,workspace_id,kind,originating_assistant_id,delivery_channel_type,delivery_channel_id) VALUES($1,$2,'external_action',$3,$4,$5)",[id(100+n),w,a,issued.source.channelType,issued.source.channelId])
   await db.query(`INSERT INTO external_approval_requests(approval_id,source_id,source_binding,external_request_id,task_id,session_id,payload_hash,immutable_input,expires_at) VALUES($1,$2,$3,'req','task','session',$3,'{}',now()+interval '1 day')`,[id(100+n),issued.source.id,'0'.repeat(64)])
   const permitted=async()=> (await db.query<{allowed:boolean}>('SELECT external_approval_conversation_read_allowed($1,$2) AS allowed',[w,id(100+n)])).rows[0].allowed
   expect(await permitted()).toBe(true)
   await db.query("UPDATE channel_integrations SET status='inactive' WHERE id=$1",[id(20+n)])
   expect(await permitted()).toBe(false)
   await db.query("UPDATE channel_integrations SET status='active' WHERE id=$1",[id(20+n)])
   // A competing more-specific assistant route supersedes this source's route.
   await db.query('INSERT INTO channel_assistants VALUES($1,$2,$3,$4)',[id(200+n),id(20+n),id(999),provider])
   // Identical specificity is not a useful test: only Telegram has distinct parent/exact surfaces.
   if(transport==='telegram') expect(await permitted()).toBe(false)
   await db.query('DELETE FROM channel_assistants WHERE id=$1',[id(200+n)])
  }
 })

})
