import {randomUUID} from 'node:crypto'
import {afterAll,afterEach,describe,expect,it} from 'vitest'
import {boundScopeSources} from '@use-brian/core'
import {getAppPool,getPool} from '../../db/client.js'
import {createWorkspaceChatSession} from '../../db/sessions.js'
import {sessionContextGeneration,writeSessionContextRevision,type SessionContextKind} from '../../db/session-context-revisions.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
describe.sequential('[COMP:api/application-persistence] original native context commands',()=>{
 let fixture:Awaited<ReturnType<typeof persistentContextFixture>>|undefined
 afterEach(async()=>{await fixture?.cleanup();fixture=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function setup(){
  fixture=await persistentContextFixture();const f=fixture,history=await f.history(),authority=await f.modelContext(),parentId=randomUUID(),now=Date.now()
  const content:Record<string,unknown>={key:'Fictional original command',summary:'Fictional original content',detail:null,status:'open',source:'tool',createdAt:now,updatedAt:now,resolvedAt:null}
  const command={sessionId:f.session.id,parentId,kind:'session_state' as SessionContextKind,content,authority,
   expectedGeneration:await sessionContextGeneration(f.session.id),expectedRevision:undefined as string|undefined,expectedCursor:undefined as number|null|undefined,
   derivation:{producer:'fixture:original-context-command',sources:history.flatMap(boundScopeSources)}}
  return{f,command,parentId,original:structuredClone(content),sources:structuredClone(command.derivation.sources)}
 }
 it('keeps the originally admitted session target when the caller mutates the command during source admission',async()=>{
  const {f,command,parentId,original}=await setup()
  const other=await createWorkspaceChatSession({assistantId:f.assistantId,starterUserId:f.ownerId,workspaceId:f.workspaceId,effectiveClearance:'internal',authenticatedHuman:true})
  const pending=writeSessionContextRevision(command);command.sessionId=other.id
  const result=await pending
  expect(result).toMatchObject({sessionId:f.session.id,parentId,content:original})
  expect((await f.pool.query('SELECT session_id FROM session_state WHERE id=$1',[parentId])).rows).toEqual([{session_id:f.session.id}])
  expect((await f.pool.query('SELECT id FROM session_context_scope_revisions WHERE session_id=$1',[other.id])).rows).toEqual([])
 })
 it('pins the original parent, semantic kind and full payload before awaiting authority',async()=>{
  const {f,command,parentId,original}=await setup(),pending=writeSessionContextRevision(command)
  command.parentId=randomUUID();command.kind='compact_summary';command.content.summary='Fictional substituted summary';command.content.boundarySequence=2
  const result=await pending
  expect(result).toMatchObject({sessionId:f.session.id,parentId,content:original})
  expect((await f.pool.query('SELECT parent_kind,parent_id FROM session_context_scope_revisions WHERE id=$1',[result!.id])).rows).toEqual([{parent_kind:'session_state',parent_id:parentId}])
  expect((await f.pool.query('SELECT compact_scope_revision_id FROM sessions WHERE id=$1',[f.session.id])).rows).toEqual([{compact_scope_revision_id:null}])
 })
 it('keeps original ancestry, producer and CAS selectors despite mutation of nested inputs',async()=>{
  const {f,command,parentId,original,sources}=await setup(),pending=writeSessionContextRevision(command)
  command.derivation.sources.splice(0);command.derivation.producer='fixture:substituted-producer';command.expectedGeneration='9223372036854775807';command.expectedRevision=randomUUID()
  const result=await pending
  expect(result).toMatchObject({sessionId:f.session.id,parentId,content:original})
  const derivation=(await f.pool.query("SELECT id,producer FROM scope_derivations WHERE workspace_id=$1 AND resource_kind='session_context_revision' AND resource_id=$2",[f.workspaceId,result!.id])).rows[0]
  expect(derivation.producer).toBe('fixture:original-context-command')
  const edges=(await f.pool.query('SELECT source_kind,source_id,source_version FROM scope_derivation_sources WHERE workspace_id=$1 AND derivation_id=$2',[f.workspaceId,derivation.id])).rows
  for(const source of sources)expect(edges).toContainEqual({source_kind:source.resourceKind,source_id:source.resourceId,source_version:source.version})
 })
})
