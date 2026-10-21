import {afterAll,afterEach,describe,expect,it} from 'vitest'
import {boundScopeSources,executionToolContext,type LLMProvider} from '@use-brian/core'
import {getAppPool,getPool} from '../../db/client.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {readAdmittedSessionQuery} from '../../db/session-query-reader.js'
import {publishSessionTitle,readSessionTitle,sessionTitleHead} from '../../db/session-title-store.js'
import {resolveSessionTitleAuthority} from '../../routes/session-title-authority.js'
import {generateTitle} from '../../routes/attended-session-title.js'
import {assertSourceModelInputAuthority,assertSourceModelOutputAuthority} from '../model-source-authority.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
const{assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
type Fixture=Awaited<ReturnType<typeof persistentContextFixture>>
describe.sequential('[COMP:api/application-persistence] stored native context at actual model boundaries',()=>{
 let fixture:Fixture|undefined
 afterEach(async()=>{await fixture?.cleanup();fixture=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function setup(){
  fixture=await persistentContextFixture();const f=fixture
  async function authority(actor=f.ownerId,readOnly=true){
   const device=(await authSessionStore.create(actor,{deviceLabel:'Fictional stored context device',userAgent:null,ipAddress:null}))!
   return resolveSessionTitleAuthority({claims:{userId:actor,sessionId:device.id,authVersion:device.authVersion},sessionId:f.session.id,readOnly})
  }
  async function publish(summary:string,title:string){
   const writer=await authority(f.ownerId,false),memory=await f.memory(summary)
   await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:0,topicThroughSequence:0,authority:writer})
   const admitted=await createDbMemoryStore().getById(writer.execution.security.access,memory.id);expect(admitted).not.toBeNull()
   writer.accumulator.note({sources:boundScopeSources(admitted!)})
   const stored=await publishSessionTitle({sessionId:f.session.id,title,manual:false,expectedRevision:await sessionTitleHead(f.session.id,writer),authority:writer,
    derivation:{producer:'fixture:stored-root-model',sources:writer.accumulator.evidence.sources??[]}});expect(stored).not.toBeNull()
   return{memory,stored:stored!}
  }
  async function reader(actor=f.firstId){
   const value=await authority(actor),title=await readSessionTitle(f.session.id,value);expect(title).not.toBeNull()
   expect([...new Set(value.accumulator.evidence.sources?.map(source=>source.resourceKind))]).toEqual(['session_context_revision'])
   return{authority:value,title:title!,context:{...executionToolContext(value.execution,{appId:'native-stored-context-model'}),scopeAccumulator:value.accumulator}}
  }
  const source=async(id:string)=>(await f.pool.query("SELECT read_scope_source($1,'session_context_revision',$2) AS source",[f.workspaceId,id])).rows[0].source
  return{f,authority,publish,reader,source}
 }
 for(const action of ['context','deliver'] as const)it(`rechecks hidden native Memory ancestry at the actual ${action} model guard and keeps another current reader usable`,async()=>{
  const c=await setup(),first=await c.publish('Fictional model ancestor','Fictional retained model title'),before=await c.source(first.stored.revisionId)
  const guard=action==='context'?assertSourceModelInputAuthority:assertSourceModelOutputAuthority
  await expect(guard((await c.reader()).context)).resolves.toBeUndefined()
  const cached=await c.reader()
  await c.f.pool.query('UPDATE memories SET scope_held=true WHERE id=$1',[first.memory.id])
  await expect(guard(cached.context)).rejects.toMatchObject({reason:'authority_changed',retrySafe:false})
  expect(await c.source(first.stored.revisionId)).toEqual(before)
  const independent=await c.publish('Fictional independent model ancestor','Fictional independent model title')
  const other=await c.reader(c.f.secondId)
  expect(other.title.revisionId).toBe(independent.stored.revisionId)
  await expect(guard(other.context)).resolves.toBeUndefined()
 })
 it('refuses a cached stored ancestor before actual title text extraction or provider dispatch',async()=>{
  const c=await setup(),first=await c.publish('Fictional cached model ancestor','Fictional protected cached title'),cached=await c.reader()
  let extractions=0,calls=0
  const provider:LLMProvider={name:'fictional-stored-model',models:['fixture'],createSession(){throw new Error('Stateless fixture required')},
   stream:async function*(){calls++;yield{type:'message_start',model:'fixture'};yield{type:'text_delta',text:'Fictional generated safe title'};
    yield{type:'message_end',stopReason:'end_turn',usage:{inputTokens:2,outputTokens:2}}}}
  const messages=[{role:'user' as const,get content(){extractions++;return cached.title.title}}]
  await c.f.pool.query('UPDATE memories SET scope_held=true WHERE id=$1',[first.memory.id])
  await expect(generateTitle(provider,messages,'fixture',()=>assertSourceModelInputAuthority(cached.context))).rejects.toMatchObject({reason:'authority_changed',retrySafe:false})
  expect(extractions).toBe(0);expect(calls).toBe(0)
 })
})
