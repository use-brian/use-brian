#!/usr/bin/env node
// [COMP:platform/managed-postgres-transfer] Disposable embedded (PGlite) source
// brain for the existing-brain transfer proof (phase 1 of the two-phase proof).
//
//   node --import tsx packages/api/src/application-platform/__tests__/fixtures/embedded-brain-source.mjs \
//     --config <new absolute config dir> [--template <pristine 8273 PGlite dir>] [--save-template <dir>]
//
// Builds `<config>/brain` exactly as an embedded install leaves it: owned by the
// PGlite bootstrap superuser `postgres`, migrated by the maintained embedded
// runner through 8273 (8274 refuses superuser owners). It is populated through
// the product itself: the real API (`apps/api/src/index.ts --admin-only
// --no-workers`) mints the local-owner JWT and creates a workspace chat, and the
// runtime writers add messages, memories, a second member with its own device
// sign-in, an encrypted provider key and a brain key. Every identity and secret
// is fictional. Receiving phases (`--phase verify|chat`, managed DSNs over IPC)
// check stored key material and run one fixed-20 chat on the transferred brain. Writes
// `<config>/config.json` (launcher-style secrets) and `<config>/source-state.json`
// (what the receiving side must observe), both 0600. Nothing outside <config>.
import {spawn} from 'node:child_process'
import {randomBytes,randomUUID} from 'node:crypto'
import {cp,mkdir,open,readFile,writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {createServer} from 'node:net'
import {join,resolve} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {parseArgs} from 'node:util'

const ossRoot=fileURLToPath(new URL('../../../../../../',import.meta.url))
const apiRequire=createRequire(join(ossRoot,'apps/api/package.json'))
const load=specifier=>import(pathToFileURL(apiRequire.resolve(specifier)).href)
const tsx=pathToFileURL(apiRequire.resolve('tsx')).href
const cohort='8273_conversation_requirement_conversion.sql'
const sleep=ms=>new Promise(accept=>setTimeout(accept,ms))
async function freePort(){const server=createServer();await new Promise(accept=>server.listen(0,'127.0.0.1',accept));const {port}=server.address();await new Promise(accept=>server.close(accept));return port}
async function openBrain(directory){
 const [{PGlite},{vector},{pg_trgm}]=await Promise.all([load('@electric-sql/pglite'),load('@electric-sql/pglite-pgvector'),load('@electric-sql/pglite/contrib/pg_trgm')])
 const db=new PGlite(directory,{extensions:{vector,pg_trgm}});await db.waitReady;return db
}

/** Pristine embedded brain at the 8273 cohort (about 30 minutes; reuse with --template). */
async function buildTemplate(directory){
 const db=await openBrain(directory)
 try{
  const {migratePglite,preparePgliteRuntimeRole}=await import(pathToFileURL(join(ossRoot,'apps/api/src/migrate-pglite.ts')).href)
  await preparePgliteRuntimeRole(db)
  await migratePglite(db,join(ossRoot,'packages/api/migrations'),{through:cohort})
 }finally{await db.close()}
}

async function serve(directory,port){
 const db=await openBrain(directory)
 const {PGLiteSocketServer}=await load('@electric-sql/pglite-socket')
 const server=new PGLiteSocketServer({db,port,host:'127.0.0.1',maxConnections:20});await server.start()
 return{async close(){await server.stop().catch(()=>{});await db.close()}}
}

function child(args,env,log){
 const legacyPolicyLoader=new URL('./embedded-brain-source-8273-loader.mjs',import.meta.url).href
 return spawn(process.execPath,['--import',tsx,'--import',legacyPolicyLoader,...args],{cwd:join(ossRoot,'packages/api'),env,stdio:['ignore',log,log,'ipc']})
}

async function sourcePhase({config,template,saveTemplate}){
 await mkdir(config,{mode:0o700})
 const brain=join(config,'brain'),log=await open(join(config,'source.log'),'a',0o600)
 if(template)await cp(template,brain,{recursive:true,errorOnExist:true,preserveTimestamps:true})
 else{await buildTemplate(brain);if(saveTemplate)await cp(brain,saveTemplate,{recursive:true,errorOnExist:true,preserveTimestamps:true})}
 const secrets={jwtSecret:randomBytes(32).toString('hex'),llmProviderKeyEncryptionKey:randomBytes(32).toString('base64')}
 await writeFile(join(config,'config.json'),JSON.stringify(secrets),{mode:0o600})
 const pglitePort=await freePort(),apiPort=await freePort(),files=join(config,'files');await mkdir(files)
 const database=`postgres://postgres@127.0.0.1:${pglitePort}/postgres`
 const base={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,LANG:'C',USER:process.env.USER??'fixture'}
 const server=await serve(brain,pglitePort)
 const state={brain,database:'embedded-pglite',cohort}
 try{
  // 1. The product mints the local-owner session and creates a workspace chat.
  const api=child([join(ossRoot,'apps/api/src/index.ts'),'--admin-only','--no-workers'],{...base,NODE_ENV:'development',USEBRIAN_EDITION:'oss',
   USEBRIAN_OWNER_NAME:'Fixture Owner',JWT_SECRET:secrets.jwtSecret,LLM_PROVIDER_KEY_ENCRYPTION_KEY:secrets.llmProviderKeyEncryptionKey,DATABASE_URL:database,
   PG_SINGLE_CONNECTION:'1',USEBRIAN_SINGLE_PROCESS:'1',LOCAL_FILES_DIR:files,PORT:String(apiPort),API_URL:`http://127.0.0.1:${apiPort}`,APP_URL:'http://127.0.0.1:9',PUBLIC_API_URL:''},log.fd)
  try{
   const url=`http://127.0.0.1:${apiPort}`
   let session
   for(const deadline=Date.now()+240_000;;){
    if(api.exitCode!==null)throw Error('API exited during boot; see '+join(config,'source.log'))
    try{const response=await fetch(url+'/auth/local-session',{method:'POST'});if(response.status===200){session=await response.json();break}}catch{}
    if(Date.now()>deadline)throw Error('API did not become ready');await sleep(1000)
   }
   const authed=(path,init={})=>fetch(url+path,{...init,headers:{'content-type':'application/json',authorization:'Bearer '+session.accessToken}})
   const listed=await(await authed('/api/workspaces')).json(),workspaceId=(Array.isArray(listed)?listed:listed.workspaces)[0].id
   const created=await authed('/api/sessions/workspace',{method:'POST',body:JSON.stringify({workspaceId})})
   if(created.status!==201)throw Error('workspace chat not created: '+created.status)
   const chat=await created.json()
   state.owner={userId:session.user.id,accessToken:session.accessToken,refreshToken:session.refreshToken}
   state.workspaceId=workspaceId;state.sessionId=chat.id;state.assistantId=chat.assistantId
   state.embedded={sessionOpen:(await authed('/api/sessions/'+chat.id)).status,history:(await authed('/api/sessions/'+chat.id+'/messages')).status}
  }finally{api.kill('SIGTERM');await new Promise(accept=>api.exitCode!==null?accept():api.once('exit',accept))}
  // 2. Runtime writers add the conversation, memories, a member and key material.
  const writer=child([fileURLToPath(import.meta.url),'--phase','write'],{...base,DATABASE_URL:database,PG_SINGLE_CONNECTION:'1',
   LLM_PROVIDER_KEY_ENCRYPTION_KEY:secrets.llmProviderKeyEncryptionKey},log.fd)
  const written=await new Promise((accept,reject)=>{
   writer.once('message',message=>message.type==='written'?accept(message.state):reject(Error(message.message)))
   writer.once('exit',code=>reject(Error('writer exited '+code)))
   writer.send({workspaceId:state.workspaceId,sessionId:state.sessionId,assistantId:state.assistantId,ownerId:state.owner.userId,jwtSecret:secrets.jwtSecret})
  })
  Object.assign(state,written)
 }finally{await server.close();await log.close()}
 await writeFile(join(config,'source-state.json'),JSON.stringify(state,null,2),{mode:0o600})
 return state
}

async function writePhase(input){
 const [{addSessionMessage,claimTurnLease,releaseTurnLease},{createMemory},{getPool},{createDbWorkspaceLlmProviderSettingsStore,loadLlmProviderKeyEncryptionKey},{createDbBrainKeyStore}]=await Promise.all([
  import(pathToFileURL(join(ossRoot,'packages/api/src/db/sessions.ts')).href),import(pathToFileURL(join(ossRoot,'packages/api/src/db/memories.ts')).href),
  import(pathToFileURL(join(ossRoot,'packages/api/src/db/client.ts')).href),import(pathToFileURL(join(ossRoot,'packages/api/src/db/workspace-llm-provider-settings.ts')).href),
  import(pathToFileURL(join(ossRoot,'packages/api/src/db/brain-keys-store.ts')).href)])
 const [{authSessionStore},{createTokens}]=await Promise.all([import(pathToFileURL(join(ossRoot,'packages/api/src/db/auth-session-store.ts')).href),
  import(pathToFileURL(join(ossRoot,'packages/api/src/auth/jwt.ts')).href)])
 const scope={workspaceId:input.workspaceId,userId:null,assistantId:null,sensitivity:'internal',compartments:[],projectIds:[]}
 const texts={question:'Fictional transfer question: which ledger is cobalt?',answer:'Fictional answer: the cobalt ledger is the second one.'}
 await addSessionMessage({sessionId:input.sessionId,role:'user',content:[{type:'text',text:texts.question}],senderUserId:input.ownerId,scope})
 // The answer runs under a real turn lease, as every chat reply does: the released
 // lease leaves last_turn_lease_token behind (8063), which the transfer must carry exactly.
 const leaseToken=await claimTurnLease(input.sessionId,input.assistantId)
 if(!leaseToken)throw Error('turn lease not claimed')
 await addSessionMessage({sessionId:input.sessionId,role:'assistant',content:[{type:'text',text:texts.answer}],senderAssistantId:input.assistantId,scope})
 if(!await releaseTurnLease(input.sessionId,'completed',leaseToken))throw Error('turn lease not released')
 const memberId=randomUUID(),pool=getPool()
 await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[memberId])
 await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'member','internal')",[input.workspaceId,memberId])
 // The member signs in on its own device (auth_sessions row), exactly as a login does.
 const memberDevice=await authSessionStore.create(memberId,{deviceLabel:'Fictional member laptop',userAgent:null,ipAddress:null})
 if(!memberDevice)throw Error('member device not created')
 const memberTokens=createTokens(memberId,input.jwtSecret,memberDevice)
 const shared=await createMemory({workspaceId:input.workspaceId,userId:null,assistantId:input.assistantId,summary:'Fictional shared transfer fact',sensitivity:'internal',createdByUserId:input.ownerId})
 const personal=await createMemory({workspaceId:input.workspaceId,userId:input.ownerId,assistantId:input.assistantId,summary:'Fictional private transfer fact',sensitivity:'internal',createdByUserId:input.ownerId})
 const providerKey='fictional-provider-key-'+randomBytes(8).toString('hex')
 await createDbWorkspaceLlmProviderSettingsStore(loadLlmProviderKeyEncryptionKey(process.env.LLM_PROVIDER_KEY_ENCRYPTION_KEY)).set({actingUserId:input.ownerId,workspaceId:input.workspaceId,apiKey:providerKey})
 const brainKey=await createDbBrainKeyStore().create({actingUserId:input.ownerId,workspaceId:input.workspaceId,name:'Fictional transfer key',scope:'read'})
 const forcedTables=await seedForcedTables(input,pool)
 await pool.end()
 return{texts,leaseToken,memberId,member:{userId:memberId,accessToken:memberTokens.accessToken},memories:{shared:shared.id,personal:personal.id},providerKey,brainKey:{id:brainKey.id,plaintext:brainKey.plaintext},forcedTables}
}

/**
 * One row in each table whose FORCE RLS 8285 retired, so the transfer carries
 * rows across the changed access path (cohort system policy on the source,
 * owner read on the target). Each uses the product writer; a writer that cannot
 * run on the embedded 8273 brain falls back to an ordinary owner insert of the
 * same columns, and the method is recorded per table.
 */
async function seedForcedTables(input,pool){
 const src=path=>import(pathToFileURL(join(ossRoot,'packages/api/src/db',path)).href)
 const [admission,{createTask},{createBrandStore},{createRealtimeThreadTargetStore},{createDbInternalLinkAliasStore}]=await Promise.all([
  src('task-admission-store.ts'),src('tasks.ts'),src('brand-store.ts'),src('realtime-thread-target-store.ts'),src('internal-link-alias-store.ts')])
 const methods={},w=input.workspaceId,owner=input.ownerId,a=input.assistantId,later=new Date(Date.now()+30*86400_000)
 const seed=async(tables,product,fallback)=>{
  try{await product();for(const table of tables)methods[table]='product'}
  catch(error){const reason=String(error?.message??error).slice(0,200);await fallback();for(const table of tables)methods[table]='owner insert ('+reason+')'}
 }
 let ruleId
 await seed(['task_rules'],async()=>{ruleId=(await admission.createRule({workspaceId:w,userId:owner,effect:'deny',predicate:{title_matches:['fictional spam']},
  nlClause:'Never create tasks titled fictional spam',reason:'Fictional transfer rule',status:'active'})).id},
 async()=>{ruleId=(await pool.query("INSERT INTO task_rules(workspace_id,status,effect,predicate,nl_clause,reason,origin,created_by_user_id) VALUES($1,'active','deny',$2,$3,$4,'user',$5) RETURNING id",
  [w,JSON.stringify({title_matches:['fictional spam']}),'Never create tasks titled fictional spam','Fictional transfer rule',owner])).rows[0].id})
 await seed(['task_candidates'],()=>admission.recordCandidate({workspaceId:w,title:'Fictional held candidate',due:null,lane:'assistant',sourceKind:null,sourceEpisodeId:null,
  createdByAssistantId:a,status:'pending',reasonCode:'rule',matchedRuleId:ruleId,expiresAt:later}),
 ()=>pool.query("INSERT INTO task_candidates(workspace_id,title,lane,created_by_assistant_id,status,reason_code,matched_rule_id,quality,expires_at) VALUES($1,'Fictional held candidate','assistant',$2,'pending','rule',$3,'{}',$4)",[w,a,ruleId,later]))
 await seed(['task_tombstones'],async()=>{
  const task=await createTask(owner,{workspaceId:w,title:'Fictional rejected task'})
  const rejected=await admission.rejectTask({workspaceId:w,userId:owner,taskId:task.id,reason:'Fictional rejection'})
  if(!rejected)throw Error('rejectTask returned null')
 },()=>pool.query("INSERT INTO task_tombstones(workspace_id,title,title_norm,reason,lane,created_by_user_id) VALUES($1,'Fictional rejected task','fictional rejected task','Fictional rejection','assistant',$2)",[w,owner]))
 const brands=createBrandStore()
 await seed(['workspace_brands','workspace_brand_versions'],async()=>{
  const brand=await brands.create(owner,w,{slug:'fictional-brand',name:'Fictional Brand'})
  if(!await brands.approve(owner,w,brand.id,owner))throw Error('brand approval returned null')
 },async()=>{throw Error('no owner fallback for brands')})
 await seed(['realtime_thread_targets'],()=>createRealtimeThreadTargetStore().set(owner,{workspaceId:w,assistantId:a,channelType:'slack',conversationRef:'C-FICTIONAL',
  threadRef:'1700000000.000100',taskIds:[],contextText:'Fictional thread context',expiresAt:later,createdByUserId:owner}),
 async()=>{throw Error('no owner fallback for realtime thread targets')})
 // A page through the product's page store, so the page alias has a real page.
 const {createDbSavedViewStore}=await src('saved-views-store.ts')
 let page
 try{const created=await createDbSavedViewStore().create({userId:owner,workspaceId:w,name:'Fictional transfer page',binding:{entity:'tasks',viewType:'table'}});page={id:created.id,name:created.name};methods.page='product'}
 catch(error){methods.page='unavailable ('+String(error?.message??error).slice(0,200)+')'}
 await seed(['workspace_link_aliases',...(page?['page_link_aliases']:[])],async()=>{
  const aliases=await createDbInternalLinkAliasStore().ensure({workspaceId:w,workspaceName:'Fictional Transfer Workspace',actorUserId:owner,...(page?{pageId:page.id,pageTitle:page.name}:{})})
  if(!aliases)throw Error('alias ensure returned null')
 },async()=>{throw Error('no owner fallback for link aliases')})
 methods.pagePresent=Boolean(page)
 return methods
}

/** Receiving side (managed DSNs): stored key material is present and usable through the product stores. */
async function verifyPhase(input){
 const [{getPool,getAppPool},{createDbWorkspaceLlmProviderSettingsStore,loadLlmProviderKeyEncryptionKey},{createDbBrainKeyStore},{authenticateBrainRequest}]=await Promise.all([
  import(pathToFileURL(join(ossRoot,'packages/api/src/db/client.ts')).href),import(pathToFileURL(join(ossRoot,'packages/api/src/db/workspace-llm-provider-settings.ts')).href),
  import(pathToFileURL(join(ossRoot,'packages/api/src/db/brain-keys-store.ts')).href),import(pathToFileURL(join(ossRoot,'packages/api/src/brain-mcp/auth.ts')).href)])
 const providerKey=await createDbWorkspaceLlmProviderSettingsStore(loadLlmProviderKeyEncryptionKey(process.env.LLM_PROVIDER_KEY_ENCRYPTION_KEY)).getPlaintextKeySystem({workspaceId:input.workspaceId})
 const auth=await authenticateBrainRequest({headers:{authorization:'Bearer '+input.brainKey}},{brainKeyStore:createDbBrainKeyStore()})
 const wrong=await authenticateBrainRequest({headers:{authorization:'Bearer '+input.brainKey.slice(0,-2)+(input.brainKey.endsWith('a')?'bb':'aa')}},{brainKeyStore:createDbBrainKeyStore()})
 await new Promise(accept=>setTimeout(accept,500))
 await Promise.allSettled([getPool().end(),getAppPool().end()])
 return{providerKeyMatches:providerKey===input.providerKey,brainKeyWorkspace:auth?.workspaceId??null,brainKeyScope:auth?.scope??null,alteredKeyRefused:wrong===null}
}

// Fixed-20 workload: 20 provider text frames, each released only after the
// client received the previous one (the chat-architecture-cost harness pacing).
const fixedReply='The cobalt ledger is still the second one, and this answer continues the transferred conversation without losing any earlier detail.'
const textOf=message=>Array.isArray(message?.content)?message.content.filter(part=>part?.type==='text').map(part=>part.text).join(''):typeof message?.content==='string'?message.content:''
const guardFunctions=['native_turn_helpers_current()','native_conversation_conversion_contract()','native_turn_publication_contract()']

/**
 * Receiving side (managed DSNs): one fixed-20 chat on the transferred workspace
 * conversation through the real chat route, as the owner's pre-transfer sign-in.
 * The provider is deterministic and local; every database effect is real. Reports
 * registry-guard and full-comparator calls when track_functions is on for the roles.
 */
async function chatPhase(input){
 let sqlObserver
 let statementObserver
 if(input.observerBootstrapUrl){
  const pg=createRequire(join(ossRoot,'packages/api/package.json'))('pg')
  const {managedClientConfig}=await import(pathToFileURL(join(ossRoot,'packages/api/src/db/managed-postgres/environment.ts')).href)
  sqlObserver=new pg.Client(managedClientConfig(input.observerBootstrapUrl));await sqlObserver.connect()
  statementObserver=await import(pathToFileURL(join(ossRoot,'scripts/testing/m6/sql-observer.mjs')).href)
 }
 const src=path=>import(pathToFileURL(join(ossRoot,'packages/api/src',path)).href)
 const {setTurnSqlRecording}=await src('db/turn-sql-accounting.js')
 setTurnSqlRecording(true)
 const [{chatRoutes},{getPool,getAppPool},{createDbMemoryStore},{createDbCapabilityStore},{createPendingApprovalsStore},{resolveSessionTitleAuthority},
  {readAttendedSessionHistory},{verifyAccessTokenClaims}]=await Promise.all([src('routes/chat.ts'),src('db/client.ts'),src('db/memory-store.ts'),src('db/capability-store.ts'),
  src('db/pending-approvals-store.ts'),src('routes/session-title-authority.ts'),src('routes/attended-session-context.ts'),src('auth/jwt.ts')])
 const express=(await import(pathToFileURL(createRequire(join(ossRoot,'packages/api/package.json')).resolve('express')).href)).default
 const claims=verifyAccessTokenClaims(input.accessToken,input.jwtSecret)
 if(!claims?.sessionId)throw Error('pre-transfer owner token is not a device sign-in')
 const words=fixedReply.split(' ')
 if(words.length!==20)throw Error('fixed-20 reply must have 20 words')
 let delivered=0,notify
 const waitFor=(count,signal)=>new Promise((accept,reject)=>{
  const check=()=>{if(delivered<count&&!signal?.aborted)return;notify=undefined;signal?.aborted?reject(signal.reason):accept()}
  notify=check;signal?.addEventListener('abort',check,{once:true});check()
 })
 const calls=[]
 const chunks=[{type:'message_start',model:'fixture'},...words.map((word,index)=>({type:'text_delta',text:(index?' ':'')+word})),
  {type:'message_end',stopReason:'end_turn',usage:{inputTokens:10,outputTokens:20}}]
 const provider={name:'fictional-transfer',models:['fixture'],stream:async function*(){yield*chunks},
  createSession(){return{send(messages,options){calls.push(structuredClone(messages));return(async function*(){let count=0;for(const chunk of chunks){yield chunk;if(chunk.type==='text_delta')await waitFor(++count,options?.signal)}})()}}}}
 const functionStats=async()=>{
  for(const pool of [getPool(),getAppPool()]){
   const clients=await Promise.all(Array.from({length:Math.max(1,pool.totalCount)},()=>pool.connect()))
   try{await Promise.all(clients.map(client=>client.query('SELECT pg_stat_force_next_flush()')))}finally{clients.forEach(client=>client.release())}
  }
  await getPool().query('SELECT pg_stat_clear_snapshot()')
  const rows=(await getPool().query('SELECT funcid::regprocedure::text AS name,calls::int AS calls FROM pg_stat_user_functions WHERE funcid::regprocedure::text=ANY($1)',[guardFunctions])).rows
  return Object.fromEntries(guardFunctions.map(name=>[name,rows.find(row=>row.name===name)?.calls??0]))
 }
 const app=express();app.use(express.json())
 app.use((req,_res,next)=>{req.userId=claims.userId;req.authSessionId=claims.sessionId;req.authVersion=claims.authVersion;next()})
 app.use('/chat',chatRoutes({provider,systemPrompt:'Continue the fictional conversation.',tools:new Map(),publishSessionEvent:()=>{},
  memoryStore:createDbMemoryStore(),capabilityStore:createDbCapabilityStore(),pendingApprovalsStore:createPendingApprovalsStore()}))
 const server=await new Promise(accept=>{const listening=app.listen(0,'127.0.0.1',()=>accept(listening))})
 const turnTimings={},originalLog=console.log
 console.log=(...values)=>{
  for(const value of values)if(typeof value==='string'&&value.startsWith(`[chat] turn timings session ${input.sessionId} `)){
   for(const match of value.matchAll(/\b([a-z_]+)=(\d+(?:\.\d+)?)/g))turnTimings[match[1]]=Number(match[2])
  }
  originalLog(...values)
 }
 try{
  const helpersBefore=(await getPool().query('SELECT public.native_turn_helpers_current() IS TRUE ok')).rows[0].ok
  const before=await functionStats()
  const statementsBefore=sqlObserver?await statementObserver.snapshotStatements(sqlObserver):null
  const started=performance.now()
  const response=await fetch(`http://127.0.0.1:${server.address().port}/chat`,{method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify({sessionId:input.sessionId,assistantId:input.assistantId,workspaceId:input.workspaceId,message:'Which ledger was cobalt again?',mode:'default'})})
  let body=''
  const decoder=new TextDecoder()
  for await(const chunk of response.body){body+=decoder.decode(chunk,{stream:true});delivered=(body.match(/event: text_delta/g)??[]).length;notify?.()}
  const elapsedMs=Math.round(performance.now()-started)
  const nestedSql=sqlObserver?{measured:true,...statementObserver.statementDelta(statementsBefore,await statementObserver.snapshotStatements(sqlObserver)),
   boundary:'Immediately before HTTP POST through received SSE end; before durable reopen and post-request function statistics; transfer export/import not in this window'}:
   {measured:false,reason:'The pinned managed runtime does not enable pg_stat_statements; function-call statistics omit inlined SQL and do not replace nested statements.'}
  const after=await functionStats()
  const frames=body.split(/\r?\n\r?\n/).filter(frame=>/^event: text_delta\r?$/m.test(frame))
  const received=frames.map(frame=>JSON.parse(frame.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n')).text).join('')
  const authority=await resolveSessionTitleAuthority({claims,sessionId:input.sessionId,readOnly:false})
  const saved=(await readAttendedSessionHistory(authority,input.sessionId)).messages
  const helpersAfter=(await getPool().query('SELECT public.native_turn_helpers_current() IS TRUE ok')).rows[0].ok
  return{status:response.status,errorEvent:body.includes('event: error'),textFrames:frames.length,receivedExact:received===fixedReply,elapsedMs,
   sql:{statements:turnTimings.sql_statement_count??null,control:turnTimings.sql_control_count??null,failed:turnTimings.sql_failed_count??null,
    elapsedMs:turnTimings.sql_statement_ms??null,
    overflow:{statements:turnTimings.sql_statement_overflow_count??null,fingerprints:turnTimings.sql_fingerprint_overflow_count??null,frames:turnTimings.sql_frame_overflow_count??null}},
   nestedSql,
   providerSawTransferredHistory:JSON.stringify(calls[0]??[]).includes(input.question),
   // The reopened history ends with the published reply, as the client would render it.
   savedReply:saved.at(-1)?.role==='assistant'&&textOf(saved.at(-1))===fixedReply,
   savedTail:saved.slice(-3).map(message=>({role:message.role,sequence:message.sequenceNum??message.sequence??null,text:textOf(message).slice(0,160),
    parts:Array.isArray(message.content)?message.content.map(part=>part?.type):typeof message.content})),
   historyMessages:saved.length,helpersCurrent:{before:helpersBefore,after:helpersAfter},
   functionCalls:Object.fromEntries(guardFunctions.map(name=>[name,after[name]-before[name]]))}
 }finally{
  console.log=originalLog
  setTurnSqlRecording(undefined)
  await sqlObserver?.end()
  await new Promise(accept=>server.close(accept))
  await new Promise(accept=>setTimeout(accept,500))
  await Promise.allSettled([getPool().end(),getAppPool().end()])
 }
}

const {values}=parseArgs({options:{config:{type:'string'},template:{type:'string'},'save-template':{type:'string'},phase:{type:'string'}}})
const phases={write:writePhase,verify:verifyPhase,chat:chatPhase}
if(phases[values.phase]){
 process.once('message',input=>{phases[values.phase](input).then(state=>process.send({type:'written',state},()=>process.exit(0)),error=>process.send({type:'error',message:error.stack??error.message},()=>process.exit(1)))})
}else if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(!values.config?.startsWith('/'))throw Error('Supply a new absolute --config directory')
 sourcePhase({config:values.config,template:values.template,saveTemplate:values['save-template']}).then(state=>console.log(JSON.stringify({ok:true,sessionId:state.sessionId,embedded:state.embedded})),error=>{console.error(error.stack??error.message);process.exitCode=1})
}
export {sourcePhase,verifyPhase,chatPhase}
