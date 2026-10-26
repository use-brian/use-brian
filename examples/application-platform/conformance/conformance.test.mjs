import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,cpSync,symlinkSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname,resolve,join } from 'node:path'
import { fileURLToPath,pathToFileURL } from 'node:url'
import { generateKeyPairSync,sign,randomUUID } from 'node:crypto'
import { createSourceStore } from '../external-source/store.mjs'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),kit=join(root,'packages/brian-app'),require=createRequire(join(kit,'package.json'))
const run=(command,args,cwd)=>execFileSync(command,args,{cwd,encoding:'utf8',stdio:'pipe',timeout:120000,env:{...process.env,NO_COLOR:'1'}})
test('[COMP:examples/application-references] packed public SDK compiles unrelated module and runs second persisted source without operations imports',async()=>{
 const temporary=mkdtempSync(join(tmpdir(),'application-reference-conformance-'))
 try{
  for(const name of ['brian-app','shared','core']){const source=join(root,'packages',name),archive=join(temporary,name+'.tgz'),destination=join(temporary,'node_modules/@use-brian',name);mkdirSync(destination,{recursive:true});run('pnpm',['pack','--out',archive],source);run('tar',['-xzf',archive,'--strip-components=1','-C',destination],temporary)}
  mkdirSync(join(temporary,'node_modules/@types'),{recursive:true});symlinkSync(dirname(require.resolve('@types/node/package.json')),join(temporary,'node_modules/@types/node'));symlinkSync(dirname(createRequire(join(root,'packages/shared/package.json')).resolve('zod/package.json')),join(temporary,'node_modules/zod'))
  const apiRequire=createRequire(join(root,'packages/api/package.json'));symlinkSync(dirname(apiRequire.resolve('@types/pg/package.json')),join(temporary,'node_modules/@types/pg'))
  writeFileSync(join(temporary,'package.json'),JSON.stringify({type:'module'}));cpSync(new URL('./second-module.ts',import.meta.url),join(temporary,'second-module.ts'));cpSync(new URL('./second-source.mjs',import.meta.url),join(temporary,'second-source.mjs'));cpSync(join(root,'packages/api/src/application-platform/purchasing/module.ts'),join(temporary,'purchase-module.ts'))
  assert.doesNotMatch(readFileSync(new URL('./second-module.ts',import.meta.url),'utf8'),/operations|packages\/api|allowlist/)
  const web=join(temporary,'web');run(process.execPath,[join(root,'examples/application-platform/build.mjs'),web],root)
  for(const app of ['operations','portal']){assert.match(readFileSync(join(web,app,'index.html'),'utf8'),/type="module"/);assert.match(readFileSync(join(web,app,'browser.mjs'),'utf8'),/mountReferenceApp/)}
  assert.match(readFileSync(join(web,'shared/browser-app.mjs'),'utf8'),/createApplicationSignIn/)
  const sessionSource=readFileSync(join(web,'shared/browser-session.mjs'),'utf8');assert.doesNotMatch(sessionSource,/localStorage|indexedDB|serviceWorker/)
  for(const entry of ['application.js','transport.js','sign-in.js'])assert.doesNotMatch(readFileSync(join(web,'sdk',entry),'utf8'),/from ['"](?:node:|@use-brian\/(?:core|shared))/)
  await import(pathToFileURL(join(web,'service-bot/client.mjs')).href)
  run(process.execPath,[require.resolve('typescript/bin/tsc'),'--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','--strict','--skipLibCheck','--outDir','dist','second-module.ts','purchase-module.ts'],temporary)
  const second=await import(pathToFileURL(join(temporary,'dist/second-module.js')).href)
  const canonical=await import(pathToFileURL(join(root,'packages/core/dist/application-platform/contracts.js')).href)
  const shared=await import(pathToFileURL(join(root,'packages/shared/dist/index.js')).href)
  const calls=[],ports={read:{input:shared.applicationJsonSchema,authorize:async()=>{calls.push('authorize')},execute:async()=>({title:'Fictional dispatch'}),authorizeResult:async()=>{calls.push('result')}},change:{input:shared.applicationJsonSchema,eventKey:'dispatch.changed',authorize:async()=>{},execute:async()=>[],authorizeResult:async()=>{}}}
  const registration=second.registerDispatchNotesModule(canonical.defineApplicationModules,{},ports);assert.equal(registration.applications.has('dispatch_notes'),true)
  const module=registration.applications.get('dispatch_notes'),result=await module.queries.lookup.execute({},{});await module.queries.lookup.authorize({},{});await module.queries.lookup.authorizeResult({},result);assert.deepEqual(calls,['authorize','result'])
  const purchase=await import(pathToFileURL(join(temporary,'dist/purchase-module.js')).href)
  let resolutions=0;const schemaIds={requestTypeId:randomUUID(),lineItemTypeId:randomUUID(),orderTypeId:randomUUID()},queryPort={input:shared.applicationJsonSchema,authorize:async()=>{},execute:async()=>({}),authorizeResult:async()=>{}}
  const workspaceModule=purchase.createWorkspacePurchaseOperationsModule({genericModule:{queries:{get:queryPort,query:queryPort,history:queryPort},commands:{record_batch:{input:shared.applicationJsonSchema,eventKey:'records.changed',authorize:async()=>{},execute:async()=>[],authorizeResult:async()=>{}}}},resourceForSchema:schema=>({typeKey:'record.'+schema.id,origin:{kind:'generic',entityTypeId:schema.id},schemaVersion:String(schema.schemaVersion),fields:[]}),jsonInput:shared.applicationJsonSchema,error:(code,message)=>new shared.ApplicationPlatformError(code,message),authorizeRole:async()=>{},lockRecords:async()=>{},resolveSchemaIds:async()=>{resolutions++;return schemaIds}})
  // Resolver/cache mechanics only: authority and transactions are tested in the real API suite.
  const context={},queryInput={type:'record.'+schemaIds.requestTypeId,id:randomUUID()};await workspaceModule.queries.get.authorize(context,queryInput);const queryResult=await workspaceModule.queries.get.execute(context,queryInput);await workspaceModule.queries.get.authorizeResult(context,queryResult);await workspaceModule.resolveResources(context);assert.equal(resolutions,1);await workspaceModule.resolveResources({});assert.equal(resolutions,2)
  const sourceModule=await import(pathToFileURL(join(temporary,'second-source.mjs')).href),sdk=await import(pathToFileURL(join(temporary,'node_modules/@use-brian/brian-app/dist/connector.js')).href)
  const userId=randomUUID(),assistantId=randomUUID(),workspaceId=randomUUID(),connectorInstanceId=randomUUID(),keys=generateKeyPairSync('ed25519'),file=join(temporary,'dispatch-source.json')
  writeFileSync(file,JSON.stringify({version:1,tenant:'dispatch-source',identities:[{issuer:'https://brain.example',audience:'https://dispatch.example',workspaceId,connectorInstanceId,kind:'human',id:userId,assistantId,accountId:'dispatcher'}],accounts:[{id:'dispatcher',enabled:true}],grants:[{accountId:'dispatcher',resourceType:'dispatch_note',resourceId:'note-a',fields:['title'],actions:['read'],retentionModes:['governed']}],records:[{type:'dispatch_note',id:'note-a',contentVersion:'1',policyVersion:'1',values:{title:'Fictional dispatch'},labels:{sensitivity:'internal',compartments:[],projectIds:[]}}],releases:[],replays:{},effects:[]}))
  const store=createSourceStore(file,{tenant:'dispatch-source'}),adapter=sourceModule.createDispatchNotesSource({trust:{issuer:'https://brain.example',audience:'https://dispatch.example',workspaceId,connectorInstanceId,trustedKey:async()=>({key:keys.publicKey})},consumeReplay:store.consumeReplay,authenticateTransport:async()=>true,source:{capabilities:store.capabilities,authorize:store.authorize,reconcile:store.reconcile}})
  const body={version:'ub.source.v1',operationId:randomUUID(),items:[{itemId:randomUUID(),resource:{type:'dispatch_note',id:'note-a',contentVersion:'1',policyVersion:'1'},fields:['title'],action:'read',retentionMode:'governed'}],recipients:[{recipientId:randomUUID(),subject:{kind:'human',id:userId,executingAssistantId:assistantId}}]},request={method:'POST',target:'/usebrian/source/authorize',body:Buffer.from(JSON.stringify(body))},now=Math.floor(Date.now()/1000)
  const claims={version:'ub.actor.v1',iss:'https://brain.example',aud:'https://dispatch.example',iat:now,nbf:now,exp:now+60,jti:randomUUID().replaceAll('-',''),workspaceId,connectorInstanceId,executingAssistantId:assistantId,executionKind:'attended',bindingRevision:'1',actor:{kind:'human',userId,authenticationKind:'native_session'},request:sdk.connectorRequestBinding(request)},header=Buffer.from(JSON.stringify({alg:'EdDSA',typ:'ub-connector-actor+jwt',kid:'dispatch-key'})).toString('base64url'),payload=Buffer.from(JSON.stringify(claims)).toString('base64url'),signed=header+'.'+payload,assertion=signed+'.'+sign(null,Buffer.from(signed),keys.privateKey).toString('base64url')
  assert.equal((await adapter.sidecar('authorize',request,assertion)).decisions[0].allowed,true)
  await assert.rejects(adapter.sidecar('authorize',request,assertion),error=>error.code==='assertion_replayed')
 }finally{rmSync(temporary,{recursive:true,force:true})}
})
