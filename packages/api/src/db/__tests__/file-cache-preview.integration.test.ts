import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {afterAll,describe,expect,it,vi} from 'vitest'
import request from 'supertest'
import {getPool,getAppPool,queryWithRLS} from '../client.js'
import {createDbFileStore,getFileCachePreviewProjection} from '../file-store.js'
import {createDbWorkspaceGroupStore} from '../workspace-group-store.js'
import {fileRoutes} from '../../routes/files.js'
import {createTestApp} from '../../routes/__tests__/helpers.js'
import {runWithAgentAccess} from '../agent-access-context.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool(),store=createDbFileStore()
const DOCX='application/vnd.openxmlformats-officedocument.wordprocessingml.document'
async function fixture(pdf=false,grantExpiryMs=60_000) {
 const workspaceId=randomUUID(),owner=randomUUID(),viewer=randomUUID(),assistantId=randomUUID(),sessionId=randomUUID()
 for(const id of [owner,viewer])await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[id])
 await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Preview fixture',$2)",[workspaceId,owner])
 await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance,team_scope_mode) VALUES($1,$2,'owner','confidential','assigned'),($1,$3,'member','internal','assigned')",[workspaceId,owner,viewer])
 await pool.query("INSERT INTO assistants(id,name,workspace_id,owner_user_id,kind) VALUES($1,'Preview fixture',$2,$3,'standard')",[assistantId,workspaceId,owner])
 await pool.query("INSERT INTO sessions(id,assistant_id,user_id,channel_type,channel_id,status) VALUES($1,$2,$3,'web','web:preview-fixture','idle')",[sessionId,assistantId,viewer])
 const team=await createDbWorkspaceGroupStore().createTeam(owner,workspaceId,{name:'Preview team',key:'preview-team'})
 const file=await store.cache({sessionId,fileName:pdf?'fixture.docx':'fixture.png',mimeType:pdf?DOCX:'image/png',content:pdf?'Extracted text':'data:image/png;base64,aW1hZ2U=',originalContent:pdf?'data:'+DOCX+';base64,ZG9jeA==':undefined,sizeBytes:5,workspaceId,compartments:[team.compartmentKey!]})
 async function grant(expiresMs=60_000) {
  const id=randomUUID()
  await pool.query(`INSERT INTO workspace_access_requests(id,workspace_id,requester_user_id,beneficiary_kind,beneficiary_id,target_team_id,reason,starts_at,expires_at,payload_hash,policy_revision,status,decided_by,decided_at)
   VALUES($1,$2,$3,'member',$3,$4,'Preview fixture',now()-interval '1 day',now()+$7*interval '1 millisecond',$5,1,'approved',$6,now())`,[id,workspaceId,viewer,team.id,'a'.repeat(64),owner,expiresMs])
  return (await pool.query<{id:string}>(`INSERT INTO workspace_access_grants(workspace_id,request_id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,approved_by)
   SELECT workspace_id,id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,decided_by FROM workspace_access_requests WHERE id=$1 RETURNING id`,[id])).rows[0]!.id
 }
 const grantId=await grant(grantExpiryMs)
 const revoke=(id=grantId)=>pool.query('UPDATE workspace_access_grants SET revoked_at=now(),revoked_by=$2 WHERE id=$1',[id,owner])
 const ctx={workspaceId,userId:viewer,assistantId:viewer,assistantKind:'standard' as const}
 const convert=vi.fn(async()=>Buffer.from('%PDF-fixture'))
 const app=(actor=viewer)=>createTestApp('/api/files',fileRoutes(store,null,null,null,null,convert),{userId:actor})
 const path=(representation=pdf?'preview-pdf':'preview',ws=workspaceId)=>`/api/files/${file.id}/${representation}?workspaceId=${ws}`
 return {workspaceId,owner,viewer,assistantId,sessionId,team,file,grantId,grant,revoke,ctx,convert,app,path}
}
afterAll(async()=>{await getAppPool().end();await pool.end()})

describe('[COMP:api/file-cache-preview] cached-file preview current authority (PG18)',()=>{
 it('serves a shared source through a current read grant, with no mutation rights',async()=>{
  const f=await fixture()
  const res=await request(f.app()).get(f.path())
  expect(res.status).toBe(200);expect(res.body.toString()).toBe('image');expect(res.headers['cache-control']).toBe('private, no-store')
  expect(Number(res.headers['x-brian-media-valid-for-ms'])).toBeGreaterThan(0)
  expect((await queryWithRLS(f.viewer,'SELECT id FROM file_cache WHERE id=$1',[f.file.id])).rows).toHaveLength(1)
  expect((await queryWithRLS(f.viewer,"UPDATE file_cache SET summary='forbidden' WHERE id=$1 RETURNING id",[f.file.id])).rows).toHaveLength(0)
  expect((await queryWithRLS(f.viewer,'DELETE FROM file_cache WHERE id=$1 RETURNING id',[f.file.id])).rows).toHaveLength(0)
  await f.revoke();expect((await request(f.app()).get(f.path())).status).toBe(404)
 })
 it('denies retained locators after revocation and never accepts signatures without auth',async()=>{
  const f=await fixture(),locator=await request(f.app()).get(f.path('preview-url'))
  expect(locator.status).toBe(200);expect(locator.body.requiresAuth).toBe(true)
  await f.revoke();expect((await request(f.app()).get(locator.body.url)).status).toBe(404)
  const anonymous=createTestApp('/api/files',fileRoutes(store))
  expect((await request(anonymous).get(f.path()+'&sig=old.signature')).status).toBe(401)
 })
 it('preserves an independent still-valid read grant',async()=>{
  const f=await fixture();await f.grant();await f.revoke()
  expect((await request(f.app()).get(f.path())).status).toBe(200)
 })
 it('rejects foreign workspace, nonmember, private-user and execution-ceiling reads',async()=>{
  const f=await fixture()
  expect((await request(f.app()).get(f.path('preview',randomUUID()))).status).toBe(404)
  expect((await request(f.app(randomUUID())).get(f.path())).status).toBe(404)
  expect(await runWithAgentAccess({workspaceId:f.workspaceId,userId:f.viewer,clearance:'internal',compartments:[],projectIds:null},()=>getFileCachePreviewProjection(f.ctx,f.file.id))).toBeNull()
  await pool.query('UPDATE file_cache SET user_id=$2 WHERE id=$1',[f.file.id,f.owner])
  expect((await request(f.app()).get(f.path())).status).toBe(404)
 })
 it('applies current classification, holding and cache expiry to an otherwise owned session',async()=>{
  const f=await fixture()
  await pool.query("UPDATE file_cache SET sensitivity='confidential' WHERE id=$1",[f.file.id])
  expect((await request(f.app()).get(f.path())).status).toBe(404)
  await pool.query("UPDATE workspace_members SET clearance='confidential' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.viewer])
  expect((await request(f.app()).get(f.path())).status).toBe(200)
  await pool.query('UPDATE file_cache SET scope_held=true WHERE id=$1',[f.file.id]);expect((await request(f.app()).get(f.path())).status).toBe(404)
  await pool.query("UPDATE file_cache SET scope_held=false,expires_at=now()-interval '1 second' WHERE id=$1",[f.file.id]);expect((await request(f.app()).get(f.path())).status).toBe(404)
 })
 it.each(['revoke','source','membership','hold'] as const)('withholds a PDF when %s changes during conversion',async change=>{
  const f=await fixture(true)
  f.convert.mockImplementationOnce(async()=>{
   if(change==='revoke')await f.revoke()
   if(change==='source')await pool.query("UPDATE file_cache SET original_content='data:application/octet-stream;base64,Y2hhbmdlZA==' WHERE id=$1",[f.file.id])
   if(change==='membership')await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.viewer])
   if(change==='hold')await pool.query('UPDATE file_cache SET scope_held=true WHERE id=$1',[f.file.id])
   return Buffer.from('%PDF-withheld')
  })
  const res=await request(f.app()).get(f.path());expect(f.convert).toHaveBeenCalledOnce();expect(res.status).toBe(404);expect(res.text).not.toContain('%PDF')
 })
 it('rechecks independent authority after conversion and bounds the lifetime by cache expiry',async()=>{
  const f=await fixture(true);await f.grant()
  f.convert.mockImplementationOnce(async()=>{await f.revoke();return Buffer.from('%PDF-fixture')})
  await pool.query("UPDATE file_cache SET expires_at=now()+interval '3 seconds' WHERE id=$1",[f.file.id])
  const res=await request(f.app()).get(f.path());expect(res.status).toBe(200);expect(res.body.toString()).toBe('%PDF-fixture')
  expect(Number(res.headers['x-brian-media-valid-for-ms'])).toBeGreaterThan(0);expect(Number(res.headers['x-brian-media-valid-for-ms'])).toBeLessThanOrEqual(3000)
 })
 it('does not deliver converted bytes after the approving grant expires',async()=>{
  const f=await fixture(true,300)
  f.convert.mockImplementationOnce(async()=>{await pool.query('SELECT pg_sleep(0.4)');return Buffer.from('%PDF-expired')})
  const res=await request(f.app()).get(f.path());expect(f.convert).toHaveBeenCalledOnce();expect(res.status).toBe(404);expect(res.text).not.toContain('%PDF')
 })
 it('adds preview policies to the predecessor schema without rewriting existing bytes',async()=>{
  const f=await fixture()
  const before=(await pool.query('SELECT content,original_content,compartments FROM file_cache WHERE id=$1',[f.file.id])).rows[0]
  for(const policy of ['file_cache_shared_read','file_cache_read_floor','file_cache_execution_visibility','file_cache_insert_floor','file_cache_update_floor','file_cache_delete_floor'])await pool.query('DROP POLICY '+policy+' ON file_cache')
  await pool.query('ALTER TABLE file_cache DROP COLUMN scope_held')
  const sql=await readFile(new URL('../../../migrations/595_file_cache_preview_scope.sql',import.meta.url),'utf8')
  try{await pool.query(sql)}catch(error){await pool.query('ROLLBACK');throw error}
  expect((await pool.query('SELECT content,original_content,compartments FROM file_cache WHERE id=$1',[f.file.id])).rows[0]).toEqual(before)
  expect((await request(f.app()).get(f.path())).status).toBe(200)
  await f.revoke();expect((await queryWithRLS(f.viewer,'SELECT id FROM file_cache WHERE id=$1',[f.file.id])).rows).toHaveLength(0)
 })
})
