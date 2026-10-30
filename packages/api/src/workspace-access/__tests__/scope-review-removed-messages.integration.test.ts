import {randomUUID} from 'node:crypto'
import {afterAll,describe,expect,it} from 'vitest'
import {boundScopeSources} from '@use-brian/core'
import {getAppPool,getPool} from '../../db/client.js'
import {createMemory} from '../../db/memories.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {addSessionMessage} from '../../db/sessions.js'
import {createDbWorkspaceGroupStore} from '../../db/workspace-group-store.js'
import {persistentContextFixture} from '../../application-platform/__tests__/fixtures/persistent-context.js'
import {executeWorkspaceScopeReview as execute} from '../scope-review.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool()
async function fixture(kind:'memory'|'workspace_file'='memory'){
 const f=await persistentContextFixture()
 const team=await createDbWorkspaceGroupStore().createTeam(f.ownerId,f.workspaceId,{name:'Personal',key:'personal'})
 const id=kind==='memory'?(await f.memory('Fictional removed-message root')).id:randomUUID()
 if(kind==='workspace_file')await pool.query(`INSERT INTO workspace_files(id,workspace_id,path,name,storage_uri,created_by_user_id,sensitivity)
  VALUES($1,$2,'/fictional-removed.txt','fictional-removed.txt','fixture://removed',$3,'internal')`,[id,f.workspaceId,f.ownerId])
 const source=(await pool.query('SELECT read_scope_source($1,$2,$3) AS source',[f.workspaceId,kind,id])).rows[0].source
 const authority=await f.modelContext()
 const observed=kind==='memory'?await createDbMemoryStore().getById(authority.execution.security.access,id):null
 if(kind==='memory'&&!observed)throw Error('Expected the actual canonical memory read')
 const message=await addSessionMessage({sessionId:f.session.id,role:'assistant',content:'Fictional derived reply',
  authority,derivationTarget:f.envelope,derivation:{producer:'fixture:removed-scope-review',sources:observed?boundScopeSources(observed):[source]}})
 const stored=(await pool.query('SELECT * FROM session_messages WHERE id=$1',[message.id])).rows[0]
 const read=async(workspace=f.workspaceId,messageId=message.id)=>(await pool.query(
  "SELECT read_scope_review_impact_source($1,'session_message',$2) AS source",[workspace,messageId])).rows[0].source
 const preview=()=>execute(f.workspaceId,f.ownerId,{type:'scope.review.preview',resourceKind:kind,resourceIds:[id],action:'assign_team',targetTeamId:team.id,reason:'Move fictional root with removed transcript history'})
 const apply=(job:Awaited<ReturnType<typeof preview>>)=>execute(f.workspaceId,f.ownerId,{type:'scope.review.apply',reviewId:job.id,expectedVersion:job.version,payloadHash:job.payloadHash})
 return {...f,kind,id,team,source,message,stored,read,preview,apply}
}
describe.sequential('[COMP:api/workspace-scope-review] removed transcript impact evidence',()=>{
 afterAll(async()=>{await getAppPool().end();await pool.end()})
 it.each(['memory','workspace_file'] as const)('moves a %s with retained evidence for a deleted derived message',async kind=>{
  const f=await fixture(kind)
  try{
   await pool.query('DELETE FROM session_messages WHERE id=$1',[f.message.id])
   const evidence=await f.read()
   expect(evidence).toEqual({version:expect.stringMatching(/^removed:[a-f0-9]{64}$/),held:true,removed:true})
   const job=await f.preview()
   expect(job.items[0].impact?.descendants).toContainEqual({resourceKind:'session_message',resourceId:f.message.id,...evidence})
   expect((await f.apply(job)).status).toBe('complete')
   expect((await pool.query('SELECT read_scope_source($1,$2,$3) AS source',[f.workspaceId,kind,f.id])).rows[0].source)
    .toEqual({...f.source,compartments:[f.team.compartmentKey],version:String(Number(f.source.version)+1)})
   expect((await pool.query('SELECT id FROM session_messages WHERE id=$1',[f.message.id])).rows).toEqual([])
   expect((await pool.query("SELECT count(*)::int AS n FROM scope_derivations WHERE workspace_id=$1 AND resource_kind='session_message' AND resource_id=$2",[f.workspaceId,f.message.id])).rows[0].n).toBeGreaterThan(0)
  }finally{await f.cleanup()}
 })
 it('requires retained evidence in this workspace and denies app_user access',async()=>{
  const f=await fixture()
  try{
   await pool.query('DELETE FROM session_messages WHERE id=$1',[f.message.id])
   expect(await f.read(randomUUID())).toBeNull()
   expect(await f.read(f.workspaceId,randomUUID())).toBeNull()
   await expect(getAppPool().query("SELECT read_scope_review_impact_source($1,'session_message',$2)",[f.workspaceId,f.message.id])).rejects.toMatchObject({code:'42501'})
  }finally{await f.cleanup()}
 })
})
