import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as sdk from '../../../packages/brian-app/dist/connector.js'
import { createReferenceSourceServer } from './server.mjs'
const userA=randomUUID(),userB=randomUUID(),userC=randomUUID(),assistantId=randomUUID(),workspaceId=randomUUID(),connectorInstanceId=randomUUID()
const identities=[userA,userB,userC].map((id,index)=>({issuer:'https://brain.example',audience:'https://source.example',workspaceId,connectorInstanceId,kind:'human',id,assistantId,accountId:'account-'+index}))
const ref={type:'invoice',id:'invoice-a',contentVersion:'1',policyVersion:'1'}
async function fixture(operation,options={}){const directory=await mkdtemp(join(tmpdir(),'application-reference-source-')),file=join(directory,'source.json'),keys=generateKeyPairSync('ed25519'),token='synthetic-transport-token-which-is-private';let keyActive=true
 const state={version:1,tenant:'fictional-source',identities,accounts:[{id:'account-0',enabled:true,departmentId:'sales'},{id:'account-1',enabled:true,departmentId:'sales'},{id:'account-2',enabled:true,departmentId:'other'}],grants:[{accountId:'account-0',resourceType:'invoice',resourceId:'invoice-a',fields:['title','cost'],actions:['read','context','derive','retain','mutate'],retentionModes:['governed','ephemeral']},{accountId:'account-1',resourceType:'invoice',resourceId:'invoice-a',fields:['title'],actions:['read','context','derive','retain'],retentionModes:['governed','ephemeral']}],records:[{...ref,values:{title:'Fictional order',cost:'9007199254740993.000000000000000001'},labels:{sensitivity:'confidential',compartments:[],projectIds:[]}}],releases:[],replays:{},effects:[]}
 await writeFile(file,JSON.stringify(state),{mode:0o600})
 const serverOptions={file,tenant:state.tenant,sdk,dispatchCommands:options.dispatchCommands??false,transportToken:token,authenticateSourceUser:async req=>req.headers['x-source-user']==='fictional-session'?{accountId:'account-1'}:null,trust:{issuer:'https://brain.example',audience:'https://source.example',workspaceId,connectorInstanceId,trustedKey:async kid=>kid==='reference-key'&&keyActive?{key:keys.publicKey}:null}};let app=await createReferenceSourceServer(serverOptions),origin
 function assertion(path,body,user=userA,overrides={}){const now=Math.floor(Date.now()/1000),request={method:'POST',target:path,body:Buffer.from(JSON.stringify(body))};const claims={version:'ub.actor.v1',iss:'https://brain.example',aud:'https://source.example',iat:now,nbf:now,exp:now+60,jti:randomUUID().replaceAll('-',''),workspaceId,connectorInstanceId,executingAssistantId:assistantId,executionKind:'attended',bindingRevision:'1',actor:{kind:'human',userId:user,authenticationKind:'native_session'},request:sdk.connectorRequestBinding(request),...overrides};const head=Buffer.from(JSON.stringify({alg:'EdDSA',typ:'ub-connector-actor+jwt',kid:'reference-key'})).toString('base64url'),payload=Buffer.from(JSON.stringify(claims)).toString('base64url'),input=head+'.'+payload;return input+'.'+sign(null,Buffer.from(input),keys.privateKey).toString('base64url')}
 async function call(path,body,user=userA,options={}){const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token,'X-UseBrian-Actor-Assertion':options.assertion??assertion(path,body,user,options.claims)},body:JSON.stringify(body)});return{status:response.status,body:await response.json()}}
 try{origin=await app.listen();await operation({app,call,assertion,file,state,origin,keys,token,async restart(){await app.close();app=await createReferenceSourceServer(serverOptions);origin=await app.listen()},rotate(){keyActive=false}})}finally{await app.close();await rm(directory,{recursive:true,force:true})}}
const read=(fields=['title'],retentionMode='governed')=>({type:'invoice',id:'invoice-a',fields,retentionMode})
test('[COMP:examples/application-references] signed dispatch durably enqueues once without changing parent versions and rechecks current source authority',()=>fixture(async({call,file,app,restart})=>{
 const input={type:ref.type,id:ref.id,fields:['title'],expectedVersion:'1',expectedPolicyVersion:'1',destination:'source_outbox',idempotencyKey:randomUUID()}
 const authorization={version:'ub.source.v1',operationId:randomUUID(),effect:{tool:'dispatchRecord',input,idempotencyKey:input.idempotencyKey},items:[{itemId:randomUUID(),resource:ref,fields:['title'],action:'mutate',retentionMode:'governed'}],recipients:[{recipientId:randomUUID(),subject:{kind:'human',id:userA,executingAssistantId:assistantId}}]}
 const wire=(actual=input,intent={intent:'mutate',authorization})=>({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'dispatchRecord',arguments:actual,_meta:{'ub.source.v1':intent}}})
 assert.equal((await call('/usebrian/source/capabilities',{version:'ub.source.v1'})).body.effectBinding,'command_v1')
 const prospective={...authorization};delete prospective.effect
 assert.equal((await call('/usebrian/source/authorize',prospective)).body.decisions[0].allowed,true)
 assert.equal(JSON.parse(await readFile(file,'utf8')).dispatches,undefined)
 assert.notEqual((await call('/mcp',wire(input,{intent:'read'}))).status,200)
 assert.notEqual((await call('/mcp',wire({...input,destination:'https://other.example'}))).status,200)
 assert.notEqual((await call('/mcp',wire({...input,fields:['cost']}))).status,200)
 assert.notEqual((await call('/mcp',wire(),userB)).status,200)
 assert.equal((await call('/records/command',{idempotencyKey:randomUUID(),input:{type:ref.type,id:ref.id,expectedVersion:'1',patch:{title:'Refused'}}})).status,403)
 assert.equal(JSON.parse(await readFile(file,'utf8')).dispatches,undefined)
 const pair=await Promise.all([call('/mcp',wire()),call('/mcp',wire())]);pair.forEach(result=>assert.equal(result.status,200));const first=pair[0]
 const receipt=JSON.parse(first.body.result.content[0].text);assert.equal(typeof receipt.receipt,'string');assert.equal(Object.hasOwn(receipt,'values'),false)
 const replay=await call('/mcp',wire());assert.deepEqual(replay.body.result,first.body.result)
 const changed={...input,fields:['cost']},changedAuthorization={...authorization,effect:{tool:'dispatchRecord',input:changed,idempotencyKey:changed.idempotencyKey},items:[{...authorization.items[0],fields:['cost']}]}
 assert.notEqual((await call('/mcp',wire(changed,{intent:'mutate',authorization:changedAuthorization}))).status,200)
 await restart();assert.equal((await call('/mcp',wire())).status,200)
 let state=JSON.parse(await readFile(file,'utf8'));assert.equal(state.dispatches.length,1);assert.deepEqual(state.dispatches[0].values,{title:'Fictional order'});assert.equal(state.effects.length,1);assert.equal(state.records[0].contentVersion,'1');assert.equal(state.records[0].policyVersion,'1')
 const reconcile={version:'ub.source.v1',idempotencyKey:input.idempotencyKey,effectDigest:sdk.sourceEffectDigest(authorization.effect),authorization}
 assert.equal((await call('/usebrian/source/reconcile',reconcile)).body.state,'applied')
 await app.store.transaction(state=>{state.records[0].policyVersion='2'})
 assert.notEqual((await call('/mcp',wire())).status,200)
 assert.notEqual((await call('/usebrian/source/reconcile',reconcile)).status,200)
 state=JSON.parse(await readFile(file,'utf8'));assert.equal(state.dispatches.length,1)
 await app.store.transaction(state=>{state.records[0].policyVersion='1';state.records[0].contentVersion='2'})
 assert.notEqual((await call('/mcp',wire())).status,200)
 await app.store.transaction(state=>{state.records[0].contentVersion='1';state.grants.filter(g=>g.accountId==='account-0').forEach(g=>{g.revoked=true})})
 assert.notEqual((await call('/mcp',wire())).status,200)
 assert.notEqual((await call('/usebrian/source/reconcile',reconcile)).status,200)
 assert.equal(JSON.parse(await readFile(file,'utf8')).dispatches.length,1)
},{dispatchCommands:true}))
test('[COMP:examples/application-references] real source HTTP distinguishes same-department readers and the source UI uses identical ACL',()=>fixture(async({call,origin})=>{assert.equal((await call('/records/read',read(['title','cost']))).status,200);assert.equal((await call('/records/read',read(['cost']),userB)).status,403);assert.equal((await call('/records/read',read(),userB)).status,200);assert.equal((await call('/records/read',read(),userC)).status,403);const ui=await fetch(origin+'/ui/records/read',{method:'POST',headers:{'x-source-user':'fictional-session','Content-Type':'application/json'},body:JSON.stringify(read(['cost']))});assert.equal(ui.status,403)}))
test('canonical source client discovers and reconciles an independent signed dispatch',()=>fixture(async({app,origin,keys,token,file,call})=>{
 const {createSourceAccessClient}=await import('../../../packages/api/dist/application-platform/source-access.js')
 const {createExecutionContext}=await import('../../../packages/core/dist/security/execution-context.js')
 const execution=createExecutionContext({identity:{kind:'attended',principal:{kind:'workspace_member',userId:userA,authenticationKind:'native_session'}},ownership:{kind:'workspace',workspaceId},access:{workspaceId,userId:userA,assistantId,assistantKind:'primary',clearance:'confidential',compartments:[],mutationCompartments:[],projectIds:[],visibilityAssistantIds:[]},authority:{assertCurrent:async()=>{},execute:async operation=>operation()},writeDefaults:{compartments:[],projectIds:[]},lifecycle:{sessionId:randomUUID(),channelId:'dispatch-wire-test',channelType:'web',abortSignal:new AbortController().signal}})
 const client=createSourceAccessClient(execution,{issuer:'https://brain.example',audience:'https://source.example',workspaceId,connectorInstanceId,mcpUrl:origin+'/mcp',sourceBaseUrl:origin,httpReadPath:'/http/read',tenant:'fictional-source',bindingRevision:'1',subject:{kind:'human',id:userA,executingAssistantId:assistantId}},{now:()=>Date.now(),admit:async()=>({bindingRevision:'1',actor:{kind:'human',userId:userA,authenticationKind:'native_session'}}),loadActiveKey:async()=>({kid:'reference-key',privateKey:keys.privateKey,notBefore:Math.floor(Date.now()/1000)-1}),keyCurrent:async()=>true},{headers:{Authorization:'Bearer '+token}})
 await app.store.transaction(state=>{state.grants[0].model=true})
 const catalog=await client.discoverMcp('Published dispatch source');assert.equal(catalog.tools.some(tool=>tool.name==='dispatchRecord'),true)
 await client.readMcp('readRecord',{id:ref.id,fields:['title']})
 const input={type:ref.type,id:ref.id,fields:['title'],expectedVersion:'1',expectedPolicyVersion:'1',destination:'source_outbox',idempotencyKey:randomUUID()}
 const authorization={version:'ub.source.v1',operationId:randomUUID(),effect:{tool:'dispatchRecord',input,idempotencyKey:input.idempotencyKey},items:[{itemId:randomUUID(),resource:ref,fields:['title'],action:'mutate',retentionMode:'governed'}],recipients:[{recipientId:randomUUID(),subject:{kind:'human',id:userA,executingAssistantId:assistantId}}]}
 const dispatched=await call('/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'dispatchRecord',arguments:input,_meta:{'ub.source.v1':{intent:'mutate',authorization}}}})
 assert.equal(dispatched.status,200)
 const reconcile={version:'ub.source.v1',idempotencyKey:input.idempotencyKey,effectDigest:sdk.sourceEffectDigest(authorization.effect),authorization}
 const receipt=await client.reconcile(reconcile);assert.equal(receipt.state,'applied')
 assert.equal((await client.reconcile(reconcile)).receipt,receipt.receipt)
 assert.equal(JSON.parse(await readFile(file,'utf8')).dispatches.length,1)
},{dispatchCommands:true}))
test('unknown actor, assistant, workspace and revoked signing key refuse at actual transport',()=>fixture(async({call,rotate})=>{assert.notEqual((await call('/records/read',read(),randomUUID())).status,200);assert.notEqual((await call('/records/read',read(),userA,{claims:{executingAssistantId:randomUUID()}})).status,200);assert.notEqual((await call('/records/read',read(),userA,{claims:{workspaceId:randomUUID()}})).status,200);rotate();assert.notEqual((await call('/records/read',read())).status,200)}))
test('durable request replay is rejected across source instances and body substitution fails',()=>fixture(async({call,assertion,restart})=>{const body=read(),proof=assertion('/records/read',body);assert.equal((await call('/records/read',body,userA,{assertion:proof})).status,200);await restart();assert.notEqual((await call('/records/read',body,userA,{assertion:proof})).status,200);const changed=read(['cost']);assert.notEqual((await call('/records/read',changed,userA,{assertion:assertion('/records/read',body)})).status,200)}))
test('source revocation preserves an independently authorized reader',()=>fixture(async({call,app})=>{assert.equal((await call('/records/read',read())).status,200);await app.store.transaction(state=>{state.grants.filter(row=>row.accountId==='account-0').forEach(row=>{row.revoked=true});return null});assert.equal((await call('/records/read',read())).status,403);assert.equal((await call('/records/read',read(),userB)).status,200)}))
test('all recipients independently pass record and field rights',()=>fixture(async({call})=>{const request={version:'ub.source.v1',operationId:randomUUID(),items:[{itemId:randomUUID(),resource:ref,fields:['cost'],action:'read',retentionMode:'governed'}],recipients:[{recipientId:randomUUID(),subject:{kind:'human',id:userB,executingAssistantId:assistantId}}]};const result=await call('/usebrian/source/authorize',request);assert.equal(result.status,200);assert.equal(result.body.decisions[0].allowed,false)}))
test('explicit released snapshot requires saved audience and lifetime while ephemeral returns no retained payload copy',()=>fixture(async({call,app,file})=>{assert.equal((await call('/records/read',read(['title'],'released_snapshot'))).status,403);await app.store.transaction(state=>{state.releases.push({id:'explicit-release',resourceType:ref.type,resourceId:ref.id,contentVersion:'1',policyVersion:'1',fields:['title'],accountIds:['account-0'],actions:['read'],expiresAt:Date.now()+60000});return null});const released=await call('/records/read',read(['title'],'released_snapshot'));assert.equal(released.status,200);assert.equal(released.body.envelope.resources[0].retention.releaseId,'explicit-release');assert.equal((await call('/records/read',read(['title'],'released_snapshot'),userB)).status,403);const ephemeral=await call('/records/read',read(['title'],'ephemeral'));assert.equal(ephemeral.status,200);assert.equal(ephemeral.body.envelope.resources[0].retention.mode,'ephemeral');const saved=JSON.parse(await readFile(file,'utf8'));assert.equal(saved.effects.length,0);assert.deepEqual(saved.records[0].values,{title:'Fictional order',cost:'9007199254740993.000000000000000001'});await app.store.transaction(state=>{state.releases[0].expiresAt=0;return null});assert.equal((await call('/records/read',read(['title'],'released_snapshot'))).status,403)}))
test('released authorization selects the exact requested tuple for the initiator and every recipient',()=>fixture(async({call,app,file})=>{
 const expiry=Date.now()+60000,original={id:'release-original',expiresAt:expiry},replacement={id:'release-replacement',expiresAt:expiry+60000}
 const row=release=>({...release,resourceType:ref.type,resourceId:ref.id,contentVersion:ref.contentVersion,policyVersion:ref.policyVersion,fields:['title'],accountIds:['account-0','account-1'],actions:['read','context','derive','retain'],model:true})
 // Array order must not choose the authority for a different requested release.
 await app.store.transaction(state=>{state.releases=[row(replacement),row(original)]})
 const authorize=async(release,actor=userA,recipient=userA)=>{
  const request={version:'ub.source.v1',operationId:randomUUID(),items:[{itemId:randomUUID(),resource:ref,fields:['title'],action:'retain',retentionMode:'released_snapshot',release}],recipients:[{recipientId:randomUUID(),subject:{kind:'human',id:recipient,executingAssistantId:assistantId}}]}
  const result=await call('/usebrian/source/authorize',request,actor);assert.equal(result.status,200);return result.body.decisions[0].allowed
 }
 assert.equal(await authorize(original),true);assert.equal(await authorize(replacement),true)
 const initial=await call('/records/read',read(['title'],'released_snapshot'));assert.equal(initial.status,200)
 assert.deepEqual(initial.body.envelope.resources[0].retention,{mode:'released_snapshot',releaseId:replacement.id,expiresAt:replacement.expiresAt})
 assert.equal(await authorize({id:initial.body.envelope.resources[0].retention.releaseId,expiresAt:initial.body.envelope.resources[0].retention.expiresAt}),true)
 await app.store.transaction(state=>{state.releases.find(row=>row.id===original.id).revoked=true})
 assert.equal(await authorize(original),false);assert.equal(await authorize(replacement),true)
 await app.store.transaction(state=>{const row=state.releases.find(row=>row.id===original.id);row.revoked=false;row.expiresAt=0})
 assert.equal(await authorize(original),false)
 assert.equal(await authorize({id:original.id,expiresAt:0}),false);assert.equal(await authorize(replacement),true)
 await app.store.transaction(state=>{const row=state.releases.find(row=>row.id===original.id);row.expiresAt=original.expiresAt;row.accountIds=['account-0']})
 assert.equal(await authorize({...original,expiresAt:original.expiresAt+1}),false)
 assert.equal(await authorize({id:'release-never-issued',expiresAt:original.expiresAt}),false)
 assert.equal(await authorize(original,userA,userB),false)
 assert.equal(await authorize(original,userB,userA),false)
 const batch=await call('/usebrian/source/authorize',{version:'ub.source.v1',operationId:randomUUID(),items:[{itemId:randomUUID(),resource:ref,fields:['title'],action:'retain',retentionMode:'released_snapshot',release:original}],recipients:[userA,userB].map(id=>({recipientId:randomUUID(),subject:{kind:'human',id,executingAssistantId:assistantId}}))})
 assert.equal(batch.status,200);assert.deepEqual(batch.body.decisions.map(decision=>decision.allowed),[true,false])
 assert.equal(await authorize(replacement,userA,userB),true)
 assert.equal(JSON.parse(await readFile(file,'utf8')).effects.length,0)
}))
test('uncertain source effects reconcile once with fresh assertions and never impersonate another actor',()=>fixture(async({call,file})=>{const command={idempotencyKey:randomUUID(),input:{type:'invoice',id:'invoice-a',expectedVersion:'1',patch:{title:'Fictional revised order'}}};const first=await call('/records/command',command);assert.equal(first.status,200);const replay=await call('/records/command',command);assert.equal(replay.status,200);assert.equal(replay.body.receipt,first.body.receipt);const reconcile=await call('/usebrian/source/reconcile',{version:'ub.source.v1',idempotencyKey:command.idempotencyKey});assert.equal(reconcile.body.state,'applied');assert.equal(reconcile.body.receipt,first.body.receipt);assert.equal((await call('/usebrian/source/reconcile',{version:'ub.source.v1',idempotencyKey:command.idempotencyKey},userB)).body.state,'not_applied');const saved=JSON.parse(await readFile(file,'utf8'));assert.equal(saved.effects.length,1);assert.equal(saved.records[0].contentVersion,'2')}))

test('named services require their own exact source mapping and keep its narrower fields',()=>fixture(async({call,app})=>{const serviceId=randomUUID(),claims={actor:{kind:'service',serviceUserId:serviceId},executionKind:'programmatic'};assert.notEqual((await call('/records/read',read(),userA,{claims})).status,200);await app.store.transaction(state=>{state.identities.push({...identities[0],kind:'service',id:serviceId,accountId:'account-1'});return null});assert.equal((await call('/records/read',read(),userA,{claims})).status,200);assert.equal((await call('/records/read',read(['cost']),userA,{claims})).status,403)}))

// The transport and source ACL are real. Only Brian execution/key-admission ports are synthetic here.
test('canonical current source client reads the real HTTP wire only with explicit field-scoped model rights',()=>fixture(async({app,origin,keys,token})=>{
 const {createSourceAccessClient,trustedSourceEnvelope}=await import('../../../packages/api/dist/application-platform/source-access.js')
 const {createExecutionContext}=await import('../../../packages/core/dist/security/execution-context.js')
 const execution=createExecutionContext({identity:{kind:'attended',principal:{kind:'workspace_member',userId:userA,authenticationKind:'native_session'}},ownership:{kind:'workspace',workspaceId},access:{workspaceId,userId:userA,assistantId,assistantKind:'primary',clearance:'confidential',compartments:[],mutationCompartments:[],projectIds:[],visibilityAssistantIds:[]},authority:{assertCurrent:async()=>{},execute:async operation=>operation()},writeDefaults:{compartments:[],projectIds:[]},lifecycle:{sessionId:randomUUID(),channelId:'reference-source-test',channelType:'web',abortSignal:new AbortController().signal}})
 const client=createSourceAccessClient(execution,{issuer:'https://brain.example',audience:'https://source.example',workspaceId,connectorInstanceId,mcpUrl:origin+'/mcp',sourceBaseUrl:origin,httpReadPath:'/records/read',tenant:'fictional-source',bindingRevision:'1',subject:{kind:'human',id:userA,executingAssistantId:assistantId}},{now:()=>Date.now(),admit:async()=>({bindingRevision:'1',actor:{kind:'human',userId:userA,authenticationKind:'native_session'}}),loadActiveKey:async()=>({kid:'reference-key',privateKey:keys.privateKey,notBefore:Math.floor(Date.now()/1000)-1}),keyCurrent:async()=>true},{headers:{Authorization:'Bearer '+token}})
 await assert.rejects(()=>client.readHttp(read()),{code:'source_access_denied'})
 await app.store.transaction(state=>{state.grants.push({accountId:'account-0',resourceType:'invoice',resourceId:'invoice-a',fields:['title'],actions:['read','context'],retentionModes:['governed','ephemeral'],model:true});return null})
 const admitted=await client.readHttp(read());assert.deepEqual(admitted.result.structuredContent,{title:'Fictional order'});assert.equal(trustedSourceEnvelope(admitted).resources[0].labels.sensitivity,'confidential');assert.equal(trustedSourceEnvelope(structuredClone(admitted)),undefined)
 const ephemeral=await client.readHttp(read(['title'],'ephemeral'),'ephemeral');assert.equal(trustedSourceEnvelope(ephemeral).resources[0].retention.mode,'ephemeral')
 await app.store.transaction(state=>{state.releases.push({id:'client-explicit-release',resourceType:ref.type,resourceId:ref.id,contentVersion:'1',policyVersion:'1',fields:['title'],accountIds:['account-0'],actions:['read','context'],model:true,expiresAt:Date.now()+60000});return null})
 const released=await client.readHttp(read(['title'],'released_snapshot'),'released_snapshot');assert.equal(trustedSourceEnvelope(released).resources[0].retention.releaseId,'client-explicit-release')
 await app.store.transaction(state=>{state.releases[0].expiresAt=0;return null});await assert.rejects(()=>client.readHttp(read(['title'],'released_snapshot'),'released_snapshot'))
 await assert.rejects(()=>client.readHttp(read(['title','cost'])),{code:'source_access_denied'})
 await app.store.transaction(state=>{state.grants.filter(row=>row.model===true).forEach(row=>{row.revoked=true});return null})
 await assert.rejects(()=>client.readHttp(read()),{code:'source_access_denied'})
}))

test('[COMP:examples/application-references] source-owned exact historical authorization keeps original versions and current policy and field floors',()=>fixture(async({call,app,file,restart})=>{
 const before=JSON.parse(await readFile(file,'utf8')).records[0]
 const input={type:ref.type,id:ref.id,expectedVersion:'1',expectedPolicyVersion:'1',values:{title:'Fictional changed record'},idempotencyKey:randomUUID()}
 const authorization={version:'ub.source.v1',operationId:randomUUID(),effect:{tool:'updateRecord',input,idempotencyKey:input.idempotencyKey},items:[{itemId:randomUUID(),resource:ref,fields:['title'],action:'mutate',retentionMode:'governed'}],recipients:[{recipientId:randomUUID(),subject:{kind:'human',id:userA,executingAssistantId:assistantId}}]}
 const wire={jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'updateRecord',arguments:input,_meta:{'ub.source.v1':{intent:'mutate',authorization}}}}
 assert.equal((await call('/usebrian/source/authorize',authorization)).body.decisions[0].allowed,true)
 const changed=await call('/mcp',wire);assert.equal(changed.status,200)
 const receipt=JSON.parse(changed.body.result.content[0].text)
 const reconciliation={version:'ub.source.v1',idempotencyKey:input.idempotencyKey,effectDigest:sdk.sourceEffectDigest(authorization.effect),authorization}
 await restart()
 assert.deepEqual((await call('/usebrian/source/reconcile',reconciliation)).body,{version:'ub.source.v1',tenant:'fictional-source',state:'applied',receipt:receipt.receipt,effectDigest:receipt.effectDigest})
 assert.notEqual((await call('/mcp',wire)).status,200)
 const historical={version:'ub.source.v1',operationId:randomUUID(),items:['read','context','derive','retain'].map(action=>({itemId:randomUUID(),resource:ref,fields:['title'],action,retentionMode:'governed'})),recipients:[{recipientId:randomUUID(),subject:{kind:'human',id:userA,executingAssistantId:assistantId}}]}
 const decisions=async()=> (await call('/usebrian/source/authorize',historical)).body.decisions.map(row=>row.allowed)
 assert.deepEqual(await decisions(),[true,true,true,true])
 let saved=JSON.parse(await readFile(file,'utf8'));assert.deepEqual(saved.history,[before]);assert.equal(saved.records[0].contentVersion,'2')
 assert.equal((await call('/records/read',read())).body.data.title,'Fictional changed record')
 const mutation={...historical,items:[{...historical.items[0],action:'mutate'}]}
 assert.equal((await call('/usebrian/source/authorize',mutation)).body.decisions[0].allowed,false)
 await app.store.transaction(state=>{state.records[0].policyVersion='2'})
 assert.deepEqual(await decisions(),[false,false,false,false])
 await app.store.transaction(state=>{state.records[0].policyVersion='1';state.grants[0].fields=['cost']})
 assert.deepEqual(await decisions(),[false,false,false,false])
 await app.store.transaction(state=>{state.grants[0].fields=['title','cost'];state.records[0].withdrawn=true})
 assert.deepEqual(await decisions(),[false,false,false,false])
 await app.store.transaction(state=>{state.records[0].withdrawn=false;state.history=[]})
 assert.deepEqual(await decisions(),[false,false,false,false])
 saved=JSON.parse(await readFile(file,'utf8'));assert.equal(saved.effects.length,1);assert.equal(saved.records[0].contentVersion,'2')
},{dispatchCommands:true}))
