import {createServer} from 'node:http'
import {createPublicKey,randomUUID,randomBytes,timingSafeEqual} from 'node:crypto'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll,describe,expect,it} from 'vitest'
import {ContextScopeAccumulator} from '@use-brian/core'
import {authorizeConnectorRequest,createConnectorActorVerifier} from '@use-brian/brian-app/connector'
import {getPool,getAppPool,applyRLSGucs,runWithAgentAccess} from '../../db/client.js'
import {createConnectorInstanceStore} from '../../db/connector-instance-store.js'
import {createConnectorActorKeyStore} from '../connector-actor-keys.js'
import {createConnectorSourceRuntimeFactory} from '../source-runtime.js'
import {createSourceAccessClient} from '../source-access.js'
import {bindTrustedSourceRead} from '../source-store.js'
import {createRetainedSourceAuthorityCoordinator} from '../retained-source-authority.js'
import {writeSessionContextRevision,readSessionContextRevisions,bindSessionContextRetainedAuthority} from '../../db/session-context-revisions.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const {createDispatchNotesSource}=await import(new URL('../../../../../examples/application-platform/conformance/second-source.mjs',import.meta.url).href)
const {createSourceStore}=await import(new URL('../../../../../examples/application-platform/external-source/store.mjs',import.meta.url).href)

describe.sequential('[COMP:api/external-source-access] second independent public source adapter',()=>{
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 it('binds actual signed HTTP reads and nonowner retained ancestry, then refuses one revoked source account while an independent reader still succeeds',async()=>{
  const f=await persistentContextFixture('confidential'),directory=await mkdtemp(join(tmpdir(),'dispatch-source-'))
  const file=join(directory,'canonical-source.json'),tenant='dispatch-notes',issuer='https://'+randomUUID()+'.brain.example',audience='https://dispatch.example',transportToken=randomBytes(32).toString('base64url')
  const encryption=randomBytes(32),keys=createConnectorActorKeyStore(encryption),instances=createConnectorInstanceStore(encryption)
  await keys.rotateSystem(issuer)
  const instance=await instances.createWorkspaceInstance({workspaceId:f.workspaceId,createdBy:f.ownerId,provider:randomUUID(),label:'Fictional dispatch notes source',custom:true,connected:true,compartments:[],projectIds:[],sensitivity:'confidential',credentials:{type:'bearer',token:transportToken}})
  const identities=[f.ownerId,f.secondId].map((id,index)=>({issuer,audience,workspaceId:f.workspaceId,connectorInstanceId:instance.id,kind:'human',id,assistantId:f.assistantId,accountId:'dispatcher-'+index}))
  await writeFile(file,JSON.stringify({version:1,tenant,identities,accounts:identities.map(i=>({id:i.accountId,enabled:true})),grants:identities.map(i=>({accountId:i.accountId,resourceType:'dispatch_note',resourceId:'note-a',fields:['title'],actions:['read','context','derive','retain'],retentionModes:['governed'],model:true})),records:[{type:'dispatch_note',id:'note-a',contentVersion:'1',policyVersion:'1',values:{title:'Fictional dispatch detail',cost:'37.25'},labels:{sensitivity:'confidential',compartments:[],projectIds:[]}}],releases:[],replays:{},effects:[]}))
  const store=createSourceStore(file,{tenant}),trust={issuer,audience,workspaceId:f.workspaceId,connectorInstanceId:instance.id,trustedKey:async(kid:string)=>{const jwk=(await keys.publicJwks(issuer)).keys.find(k=>k.kid===kid);return jwk?{key:createPublicKey({key:jwk,format:'jwk'})}:null}},verifyActor=createConnectorActorVerifier({...trust,consumeReplay:store.consumeReplay})
  let readCount=0,sidecars=0
  const server=createServer(async(req,res)=>{
   res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json')
   try{
    const chunks=[];for await(const chunk of req)chunks.push(chunk)
    const request={method:req.method!,target:req.url!,body:Buffer.concat(chunks)},assertion=req.headers['x-usebrian-actor-assertion'] as string
    const authenticateTransport=async()=>{const actual=Buffer.from(req.headers.authorization??''),expected=Buffer.from('Bearer '+transportToken);return actual.length===expected.length&&timingSafeEqual(actual,expected)}
    const adapter=createDispatchNotesSource({trust,consumeReplay:store.consumeReplay,authenticateTransport,source:{capabilities:store.capabilities,authorize:store.authorize,reconcile:store.reconcile}})
    const endpoint=/^\/usebrian\/source\/(capabilities|authorize|reconcile)$/.exec(req.url!)
    let result
    if(endpoint){sidecars++;result=await adapter.sidecar(endpoint[1],request,assertion)}
    else if(req.url==='/records/read'){
     const authorized=await authorizeConnectorRequest({request,assertion,authenticateTransport,verifyActor,authorize:async actor=>({allowed:true,value:actor})})
     result=await store.read(authorized.actor,JSON.parse(request.body.toString('utf8')));readCount++
    }else{res.statusCode=404;res.end('{}');return}
    res.end(JSON.stringify(result))
   }catch{res.statusCode=403;res.end('{"error":"source_access_denied"}')}
  })
  try{
   await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+(server.address() as {port:number}).port
   await instances.update(f.ownerId,instance.id,{url:url+'/mcp'})
   const profile=(await f.pool.query(`INSERT INTO connector_source_profiles(workspace_id,connector_instance_id,tenant,issuer,audience,source_base_url,mcp_url,http_read_path,status,created_by_user_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,'/records/read','qualified',$8) RETURNING id,revision::text`,[f.workspaceId,instance.id,tenant,issuer,audience,url,url+'/mcp',f.ownerId])).rows[0]
   const factory=createConnectorSourceRuntimeFactory({issuer,keys,instances}),coordinator=createRetainedSourceAuthorityCoordinator({factory,instances})
   const execution=await f.execution(),accumulator=new ContextScopeAccumulator(),binding={issuer,audience,workspaceId:f.workspaceId,connectorInstanceId:instance.id,sourceBaseUrl:url,mcpUrl:url+'/mcp',httpReadPath:'/records/read',tenant,bindingRevision:profile.revision,subject:{kind:'human' as const,id:f.ownerId,executingAssistantId:f.assistantId}}
   const source=createSourceAccessClient(execution,binding,{...keys,admit:async()=>({bindingRevision:profile.revision,actor:{kind:'human' as const,userId:f.ownerId,authenticationKind:'native_session' as const}})},{headers:{Authorization:'Bearer '+transportToken}})
   const read=await source.readHttp({type:'dispatch_note',id:'note-a',fields:['title'],retentionMode:'governed'})
   expect(read.result.structuredContent).toEqual({title:'Fictional dispatch detail'});expect(read.result).not.toHaveProperty('_meta')
   await expect(source.readHttp({type:'dispatch_note',id:'note-a',fields:['cost'],retentionMode:'governed'})).rejects.toBeDefined()
   const client=await getAppPool().connect()
   let sources
   try{await runWithAgentAccess(execution.security.access,async()=>{
    await client.query('BEGIN');await applyRLSGucs(client,f.ownerId)
    expect((await client.query(`SELECT r.rolsuper,r.rolbypassrls,c.relowner=r.oid AS owns FROM pg_roles r JOIN pg_class c ON c.oid='session_context_scope_revisions'::regclass WHERE r.rolname=current_user`)).rows[0]).toEqual({rolsuper:false,rolbypassrls:false,owns:false})
    const bound=await bindTrustedSourceRead(client,execution,read,accumulator);sources=bound.sources;await client.query('COMMIT')
   })}finally{await client.query('ROLLBACK');client.release()}
   expect(sources).toHaveLength(1)
   bindSessionContextRetainedAuthority(execution,(actor,roots,action)=>coordinator.prepare(actor,roots,action))
   const written=await writeSessionContextRevision({sessionId:f.session.id,kind:'compact_summary',content:{summary:'Fictional dispatch detail',boundarySequence:0},expectedCursor:null,authority:{execution,accumulator},derivation:{producer:'fixture:second-public-adapter',sources:sources!}})
   expect(written).not.toBeNull();expect(readCount).toBe(1);expect(sidecars).toBeGreaterThan(1)
   await store.transaction((state:any)=>{state.accounts.find((a:any)=>a.id==='dispatcher-0').enabled=false})
   const revoked=await f.execution();bindSessionContextRetainedAuthority(revoked,(actor,roots,action)=>coordinator.prepare(actor,roots,action))
   expect(await readSessionContextRevisions(f.session.id,'compact_summary',{execution:revoked,accumulator:new ContextScopeAccumulator()})).toEqual([])
   const independent=await f.execution(f.secondId);bindSessionContextRetainedAuthority(independent,(actor,roots,action)=>coordinator.prepare(actor,roots,action))
   expect(await readSessionContextRevisions(f.session.id,'compact_summary',{execution:independent,accumulator:new ContextScopeAccumulator()})).toMatchObject([{content:{summary:'Fictional dispatch detail'}}])
   expect((await f.pool.query('SELECT observation FROM external_source_observations WHERE id=$1',[sources![0].resourceId])).rows[0].observation.resource).toEqual({type:'dispatch_note',id:'note-a',contentVersion:'1',policyVersion:'1'})
  }finally{server.closeAllConnections();if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));await f.cleanup();await rm(directory,{recursive:true,force:true})}
 })
})
