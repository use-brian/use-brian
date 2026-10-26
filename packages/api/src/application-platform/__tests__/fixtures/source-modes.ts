import { createPublicKey, randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { ContextScopeAccumulator,type ExecutionContext,type Sensitivity } from '@use-brian/core'
import { createConnectorActorVerifier } from '@use-brian/brian-app/connector'
import { createConnectorInstanceStore } from '../../../db/connector-instance-store.js'
import { createConnectorActorKeyStore } from '../../connector-actor-keys.js'
import { createConnectorSourceRuntimeFactory } from '../../source-runtime.js'
import { createRetainedSourceAuthorityCoordinator } from '../../retained-source-authority.js'
import { persistentContextFixture } from './persistent-context.js'
import { independentSourceSchema, independentSourceReplayConsumer, startIndependentSource } from './independent-source.js'
export async function sourceModeFixture(clearance:Sensitivity='confidential') {
 const f=await persistentContextFixture(clearance), role='modes_'+randomBytes(7).toString('hex'), password=randomBytes(24).toString('hex')
 await f.pool.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD '${password}'`)
 await f.pool.query(`CREATE SCHEMA ${role} AUTHORIZATION ${role}`)
 const url=new URL(process.env.DATABASE_URL!);url.username=role;url.password=password
 const sourcePool=new pg.Pool({connectionString:url.href,options:`-c search_path=${role},pg_catalog`,max:3})
 let source:Awaited<ReturnType<typeof startIndependentSource>>|undefined
 const cleanup=async()=>{await source?.close();await sourcePool.end();await f.pool.query(`DROP SCHEMA ${role} CASCADE`);await f.pool.query(`DROP ROLE ${role}`);await f.cleanup()}
 try {
  await sourcePool.query(independentSourceSchema)
  await sourcePool.query("INSERT INTO accounts(kind,id) VALUES('human',$1),('human',$2)",[f.ownerId,f.secondId])
  await sourcePool.query('INSERT INTO assistants(id) VALUES($1)',[f.assistantId])
  await sourcePool.query("INSERT INTO records(id,kind,data) VALUES('record-1','case',$1)",[{description:'Fictional released fact',cost:'37.25'}])
  for(const id of [f.ownerId,f.secondId])await sourcePool.query("INSERT INTO grants(kind,account_id,record_id,fields,actions) VALUES('human',$1,'record-1',ARRAY['description','cost'],ARRAY['read','context','derive','retain','deliver','export','mutate'])",[id])
  const material=randomBytes(32),keys=createConnectorActorKeyStore(material),instances=createConnectorInstanceStore(material)
  const issuer='https://'+randomUUID()+'.brain.example',audience='https://mode-source.example',token=randomBytes(24).toString('base64url')
  await keys.rotateSystem(issuer)
  const instance=await instances.createWorkspaceInstance({workspaceId:f.workspaceId,createdBy:f.ownerId,provider:randomUUID(),label:'Fictional retention source',custom:true,connected:true,compartments:[],projectIds:[],credentials:{type:'bearer',token}})
  const verify=createConnectorActorVerifier({issuer,audience,workspaceId:f.workspaceId,connectorInstanceId:instance.id,consumeReplay:independentSourceReplayConsumer(sourcePool),trustedKey:async kid=>{const jwk=(await keys.publicJwks(issuer)).keys.find(k=>k.kid===kid);return jwk?{key:createPublicKey({key:jwk,format:'jwk'})}:null}})
  source=await startIndependentSource({pool:sourcePool,tenant:'mode-fixture',transportToken:token,verifyActor:verify,uiSessions:new Map(),retentionModes:['governed','released_snapshot','ephemeral']})
  await instances.update(f.ownerId,instance.id,{url:source.url+'/mcp'})
  await f.pool.query(`INSERT INTO connector_source_profiles(workspace_id,connector_instance_id,tenant,issuer,audience,source_base_url,mcp_url,http_read_path,status,created_by_user_id)
    VALUES($1,$2,'mode-fixture',$3,$4,$5,$6,'/http/read','qualified',$7)`,[f.workspaceId,instance.id,issuer,audience,source.url,source.url+'/mcp',f.ownerId])
  const factory=createConnectorSourceRuntimeFactory({issuer,keys,instances}),coordinator=createRetainedSourceAuthorityCoordinator({factory,instances})
  const runtime=async(userId=f.ownerId,originalExecution?:ExecutionContext)=>{const execution=originalExecution??await f.execution(userId),accumulator=new ContextScopeAccumulator();const runtime=await factory({workspaceId:f.workspaceId,instanceId:instance.id,execution,accumulator,headers:{Authorization:'Bearer '+token}});if(!runtime)throw new Error('Missing source runtime');return{execution,accumulator,runtime}}
  const releaseId=randomUUID(),expiresAt=Date.now()+60_000
  await sourcePool.query(`INSERT INTO releases(id,record_id,resource,fields,actions,subjects,expires_at) VALUES($1,'record-1',$2,ARRAY['description'],ARRAY['read','context','derive','retain','deliver'],$3,$4)`,
   [releaseId,{type:'case',id:'record-1',contentVersion:'1',policyVersion:'1'},JSON.stringify([{kind:'human',id:f.ownerId,executingAssistantId:f.assistantId}]),expiresAt])
  return{f,sourcePool,source,factory,instances,coordinator,runtime,releaseId,expiresAt,cleanup}
 }catch(error){await cleanup();throw error}
}
