import { createPublicKey,randomBytes,randomUUID } from 'node:crypto'
import pg from 'pg'
import { ContextScopeAccumulator,advanceWorkflowRun,type ApplicationAuthorityLayers,type ExecutionContext,type ScopeSource } from '@use-brian/core'
import { createConnectorActorVerifier,type SourceSubject,type SourceAuthorizationRequest } from '@use-brian/brian-app/connector'
import type { ApplicationAccessGrant } from '@use-brian/shared'
import { getPool,getAppPool,applyRLSGucs,queryWithRLS,runWithAgentAccess } from '../../../db/client.js'
import { findOrCreateUser } from '../../../db/users.js'
import { createConnectorInstanceStore } from '../../../db/connector-instance-store.js'
import { createConnectorActorKeyStore } from '../../connector-actor-keys.js'
import { createConnectorSourceRuntimeFactory,configureConnectorSourceRuntimeFactory } from '../../source-runtime.js'
import { createRetainedSourceAuthorityCoordinator,pinPreparedExternalSourceAuthority } from '../../retained-source-authority.js'
import { pinExternalSourceOperation,activatePinnedExternalSourceOperation } from '../../source-store.js'
import { authenticateBoundApplicationCredential,mintApplicationCredentialSecret } from '../../credentials.js'
import { getApplicationExecutionBinding,applyApplicationRLSContext,releaseApplicationTransactionBinding } from '../../execution-context.js'
import { resolveSourceServiceExecution,prepareSourceServiceBinding,getSourceServiceExecutionBinding,activateSourceServiceBinding } from '../../source-service-binding.js'
import { createDbWorkflowStore,createDbWorkflowRunStore } from '../../../db/workflow-store.js'
import { captureAuthoringAuthoritySystem,resolveWorkflowRunScope } from '../../../context-scope/workflow-authority.js'
import { buildWorkflowToolRegistry } from '../../../workflow/mcp-bridge.js'
import { ApplicationManagementService } from '../../management.js'
import { ApplicationPlatformService } from '../../service.js'
import { createCanonicalNativeApplicationModule } from '../../native-adapters.js'
import { validateDerivedWriteInputs } from '../../../db/derived-scope-store.js'
import { independentSourceSchema,independentSourceReplayConsumer,startIndependentSource } from './independent-source.js'
const pool=getPool()
export const sourceServiceFixtureCleanups=new Set<()=>Promise<void>>()
const cleanups=sourceServiceFixtureCleanups
export async function sourceServiceFixture(options:{readOnly?:boolean;fields?:string[];mutate?:boolean}={}){
 const workspace=randomUUID(),owner=randomUUID(),reader=randomUUID(),assistant=randomUUID(),department=randomUUID(),app=randomUUID(),parent=randomUUID(),leaf=randomUUID()
 const role='service_source_'+randomBytes(7).toString('hex'),password=randomBytes(24).toString('hex')
 await pool.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD '${password}'`)
 await pool.query(`CREATE SCHEMA ${role} AUTHORIZATION ${role}`)
 const url=new URL(process.env.DATABASE_URL!);url.username=role;url.password=password
 const sourcePool=new pg.Pool({connectionString:url.href,options:`-c search_path=${role},pg_catalog`,max:3})
 let source:Awaited<ReturnType<typeof startIndependentSource>>|undefined
 const cleanup=async()=>{if(!cleanups.delete(cleanup))return;configureConnectorSourceRuntimeFactory(undefined);await source?.close();await sourcePool.end();await pool.query('DELETE FROM workspaces WHERE id=$1',[workspace]);await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[owner,reader]]);await pool.query(`DROP SCHEMA IF EXISTS ${role} CASCADE`);await pool.query(`DROP ROLE IF EXISTS ${role}`)}
 cleanups.add(cleanup)
 await sourcePool.query(independentSourceSchema)
 for(const id of [owner,reader])await pool.query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'email',$1::text)",[id])
 await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Fictional service workflow',$2,true)",[workspace,owner])
 await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential'),($1,$3,'member','confidential')",[workspace,owner,reader])
 await pool.query("INSERT INTO assistants(id,name,workspace_id,owner_user_id,kind,clearance,compartments) VALUES($1,'Source service assistant',$2,$3,'primary','confidential',NULL)",[assistant,workspace,owner])
 await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Fictional team',$3,'team',$1::text,$4)",[department,workspace,owner,'team:'+department])
 await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,created_by,managed_by,managed_ref_id) VALUES($1,$2,'Fictional team',$3,'team',$4)",[workspace,'team:'+department,owner,department])
 await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,assistant_id,clearance,origin) VALUES($1,$2,'assistant',$3,'confidential','store') ON CONFLICT DO NOTHING",[workspace,department,assistant])
 for(const id of [owner,reader])await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store') ON CONFLICT DO NOTHING",[workspace,department,id])
 const service=(await findOrCreateUser({authProvider:'channel',authProviderId:`app-service:${app}:${randomUUID()}`,name:'Fictional named service'})).user.id
 await pool.query("INSERT INTO application_clients(id,workspace_id,module_key,name,client_mode,executing_assistant_id,created_by_user_id) VALUES($1,$2,'native','Fictional background app','api_client',$3,$4)",[app,workspace,assistant,owner])
 const issuer=`https://${randomUUID()}.brain.example`,audience='https://service-source.example',token=randomBytes(24).toString('base64url'),encryptionKey=randomBytes(32)
 const keys=createConnectorActorKeyStore(encryptionKey),instances=createConnectorInstanceStore(encryptionKey);await keys.rotateSystem(issuer)
 const instance=await instances.createWorkspaceInstance({workspaceId:workspace,createdBy:owner,provider:randomUUID(),label:'Fictional source',custom:true,connected:true,
  compartments:['team:'+department],projectIds:[],sensitivity:'confidential',credentials:{type:'bearer',token}})
 const verify=createConnectorActorVerifier({issuer,audience,workspaceId:workspace,connectorInstanceId:instance.id,
  trustedKey:async kid=>{const jwk=(await keys.publicJwks(issuer)).keys.find(k=>k.kid===kid);return jwk?{key:createPublicKey({key:jwk,format:'jwk'})}:null},consumeReplay:independentSourceReplayConsumer(sourcePool)})
 await sourcePool.query("INSERT INTO accounts(kind,id) VALUES('service',$1),('human',$2)",[service,reader]);await sourcePool.query('INSERT INTO assistants(id) VALUES($1)',[assistant])
 await sourcePool.query("INSERT INTO records(id,kind,data,compartments) VALUES('order-1','purchase',$1,$2)",[{description:'Fictional purchase',cost:'37.25'},['team:'+department]])
 const actions=['read','context','derive','retain','deliver','export','mutate']
 for(const [kind,id] of [['service',service],['human',reader]])await sourcePool.query('INSERT INTO grants(kind,account_id,record_id,fields,actions) VALUES($1,$2,\'order-1\',$3,$4)',[kind,id,['description','cost'],actions])
 source=await startIndependentSource({pool:sourcePool,tenant:'fixture-tenant',transportToken:token,verifyActor:verify,uiSessions:new Map()})
 await instances.update(owner,instance.id,{url:source.url+'/mcp'})
 const profile=(await pool.query<{id:string}>(`INSERT INTO connector_source_profiles(workspace_id,connector_instance_id,tenant,issuer,audience,source_base_url,mcp_url,http_read_path,status,created_by_user_id,source_effect_binding)
 VALUES($1,$2,'fixture-tenant',$3,$4,$5,$6,'/http/read','qualified',$7,$8) RETURNING id`,[workspace,instance.id,issuer,audience,source.url,source.url+'/mcp',owner,options.mutate?'command_v1':null])).rows[0].id
 const grant=(id:string,parentGrantId:string|null):ApplicationAccessGrant=>({id,appId:app,workspaceId:workspace,principal:{kind:'service',userId:service},origin:{kind:'external',connectorInstanceId:instance.id,sourceTenant:'fixture-tenant'},typeKey:'purchase',
  actions:options.readOnly?['read']:['read','command:source.derive','command:source.retain','command:source.deliver','command:source.export',...(options.mutate?['command:source.mutate']:[])],readFields:options.fields??['description','cost'],writeFields:options.mutate?(options.fields??['description','cost']):[],selector:{kind:'ids',ids:['order-1']},
  version:1,status:'active',startsAt:'2026-01-01T00:00:00.000Z',expiresAt:null,parentGrantId,compartments:['team:'+department],projectIds:[],clearance:'confidential'})
 const path=[grant(leaf,parent),grant(parent,null)]
 for(const g of [...path].reverse())await pool.query(`INSERT INTO application_access_grants(id,app_id,workspace_id,principal_kind,principal_user_id,issued_by_user_id,resource_origin,resource_type,actions,read_fields,write_fields,selector,parent_grant_id,compartments,project_ids,clearance,starts_at)
 VALUES($1,$2,$3,'service',$4,$5,$6,$7,$8,$9,$14,$10,$11,$12,'{}','confidential',$13)`,[g.id,app,workspace,service,owner,g.origin,g.typeKey,g.actions,g.readFields,g.selector,g.parentGrantId,g.compartments,g.startsAt,g.writeFields])
 const material=await mintApplicationCredentialSecret()
 await pool.query(`INSERT INTO application_api_credentials(id,app_id,workspace_id,issued_by_user_id,subject_user_id,name,credential_kind,secret_hash,parent_grant_id,expires_at)
 VALUES($1,$2,$3,$4,$5,'Fictional source service','service',$6,$7,now()+interval '1 hour')`,[material.id,app,workspace,owner,service,material.secretHash,leaf])
 await pool.query('INSERT INTO application_credential_grants(credential_id,app_id,workspace_id,grant_id,maximum_grant) VALUES($1,$2,$3,$4,$5)',[material.id,app,workspace,leaf,{version:1,grants:path}])
 const authority=await captureAuthoringAuthoritySystem({userId:owner,workspaceId:workspace,assistantId:assistant})
 const workflow=await createDbWorkflowStore().create({userId:owner,workspaceId:workspace,name:'Fictional source workflow',authoringAuthority:authority,
  definition:{startStepId:'read',steps:[{id:'read',type:'tool_call',toolName:'readRecord',arguments:{id:'order-1',fields:['description','cost']},nextStepId:'pause'},
   {id:'pause',type:'wait',until:{duration:{minutes:1}},nextStepId:'readAgain'},{id:'readAgain',type:'tool_call',toolName:'readRecord',arguments:{id:'order-1',fields:['description']}}]}})
 const client=await getAppPool().connect();let binding:string
 try{await client.query('BEGIN');await applyRLSGucs(client,owner);await client.query("SELECT set_config('app.application_assistant_id',$1,true),set_config('app.v2_assistant_id',$1,true)",[assistant]);
  binding=(await prepareSourceServiceBinding(client,owner,workspace,{profileId:profile,appId:app,credentialId:material.id,workflowId:workflow.id,expiresAt:new Date(Date.now()+30*60e3).toISOString()})).reviewId;await client.query('COMMIT')
 }finally{await client.query('ROLLBACK');client.release()}
 // Only after assertLocalFixture: synthetic active pre-barrier binding; no readiness override or live issuance.
 await pool.query("UPDATE source_service_bindings SET status='active' WHERE id=$1",[binding])
 const factory=createConnectorSourceRuntimeFactory({issuer,keys,instances});configureConnectorSourceRuntimeFactory(factory,{instances})
 const coordinator=createRetainedSourceAuthorityCoordinator({factory,instances})
 const runtime=async()=>{const execution=await resolveSourceServiceExecution(binding);const accumulator=new ContextScopeAccumulator();const runtime=await factory({workspaceId:workspace,instanceId:instance.id,execution,accumulator,headers:{Authorization:'Bearer '+token}});if(!runtime)throw new Error('Missing fixture runtime');return{execution,accumulator,runtime}}
 const tx=async<T>(execution:ExecutionContext,operation:(c:pg.PoolClient)=>Promise<T>)=>runWithAgentAccess(execution.security.access,async()=>{const c=await getAppPool().connect();try{await c.query('BEGIN');await applyRLSGucs(c,service);await applyApplicationRLSContext(c,execution);const value=await operation(c);await c.query('COMMIT');return value}finally{releaseApplicationTransactionBinding(c);await c.query('ROLLBACK');c.release()}})
 const close=async()=>{await cleanup();await pool.query('DELETE FROM users WHERE id=$1',[service])}
 return{workspace,owner,reader,assistant,department,app,parent,leaf,service,profile,binding,credential:material.id,source,sourcePool,factory,instances,keys,coordinator,runtime,tx,cleanup:close,workflow}
}
