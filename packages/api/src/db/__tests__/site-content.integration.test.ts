/** [COMP:crm/site-content] Website content collections against actual PostgreSQL. */
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { SITE_CONTENT_COLLECTIONS } from '@use-brian/core'
import { createSiteContentStore } from '../site-content-store.js'
import { createAssociationWorkspaceModulesStore } from '../../association/workspace-module.js'
const url=process.env.MEMBERSHIP_TEST_DATABASE_URL
if(url){ const target=new URL(url); if(target.hostname!=='127.0.0.1'||!target.pathname.startsWith('/membership_catalogue_test_'))throw new Error('Only a disposable local membership test database is allowed') }
const pool=url?new Pool({connectionString:url}):null
const L=(en:string,extra:Record<string,string>={})=>({en,...extra})
const partners=(name:string)=>({schemaVersion:1,partners:[
 {id:'acme',name,logo:{src:'/media/partners/acme.png',alt:L(name)},sites:['oasa','sea'],order:0},
 {id:'sea-only',name:'SEA only',logo:{src:'/media/partners/sea.png',alt:L('SEA only')},sites:['sea'],order:1}]})
async function fixture(){
 const workspace=randomUUID(),user=randomUUID()
 await pool!.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[user])
 await pool!.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Site content test',$2)",[workspace,user])
 await pool!.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspace,user])
 await createAssociationWorkspaceModulesStore(pool!).act(workspace,user,'association',{action:'enable',expectedVersion:1})
 return {workspace,actor:{credentialKind:'user' as const,credentialId:user,actingUserId:user},store:createSiteContentStore(pool!)}
}
describe.skipIf(!pool)('[COMP:crm/site-content] actual PostgreSQL publication',()=>{
 afterAll(async()=>{await pool?.end()})
 it('keeps collections independent, publishes immutable per-site projections and records acknowledgement',async()=>{
  const {workspace,actor,store}=await fixture()
  await store.save(workspace,'partners',0,partners('Acme'),actor)
  await expect(store.read(workspace,'partners','oasa')).rejects.toMatchObject({code:'not_available'})
  await expect(store.save(workspace,'partners',0,partners('Acme'),actor)).rejects.toMatchObject({code:'conflict'})
  // Another collection has its own version counter.
  expect((await store.draft(workspace,'news')).version).toBe(0)
  await store.publish(workspace,'partners',1,actor)
  const oasa=await store.read(workspace,'partners','oasa')
  expect(oasa.revision).toBe(1)
  expect((oasa.document as {partners:{id:string}[]}).partners.map(p=>p.id)).toEqual(['acme'])
  expect((await store.read(workspace,'partners','sea')).document).toMatchObject({partners:[{id:'acme'},{id:'sea-only'}]})
  await store.save(workspace,'partners',1,partners('Acme Renamed（香港）'),actor)
  expect((await store.read(workspace,'partners','oasa')).document).toMatchObject({partners:[{name:'Acme'}]})
  await store.publish(workspace,'partners',2,actor)
  expect((await store.read(workspace,'partners','oasa')).document).toMatchObject({partners:[{name:'Acme Renamed（香港）'}]})
  await store.observe(workspace,'partners','oasa',1);expect((await store.draft(workspace,'partners')).observations.oasa).toBeUndefined()
  await store.observe(workspace,'partners','oasa',2);expect((await store.draft(workspace,'partners')).observations.oasa!.revision).toBe(2)
  expect((await pool!.query('SELECT count(*) FROM association_site_content_revisions WHERE workspace_id=$1',[workspace])).rows[0].count).toBe('2')
  expect((await pool!.query("SELECT metadata FROM association_audit_log WHERE workspace_id=$1 AND action='site_content.published' ORDER BY created_at DESC LIMIT 1",[workspace])).rows[0].metadata).toEqual({collection:'partners',version:2})
 })
 it('refuses invalid documents, blocks drafts with issues and never serves a home page to the other site',async()=>{
  const {workspace,actor,store}=await fixture()
  await expect(store.save(workspace,'news',0,{schemaVersion:1,items:[{id:'x'}]},actor)).rejects.toThrow()
  await store.save(workspace,'settings',0,{schemaVersion:1,sites:{}},actor)
  await expect(store.publish(workspace,'settings',1,actor)).rejects.toMatchObject({code:'conflict'})
  await expect(store.read(workspace,'home-sea','oasa')).rejects.toMatchObject({code:'not_available'})
 })
 it('edits and publishes website content while commerce is switched off and summarises every collection',async()=>{
  const {workspace,actor,store}=await fixture()
  const user=actor.credentialId
  await createAssociationWorkspaceModulesStore(pool!).act(workspace,user,'association',{action:'request_disable',expectedVersion:2})
  await store.save(workspace,'partners',0,partners('Acme'),actor)
  await store.publish(workspace,'partners',1,actor)
  expect((await store.read(workspace,'partners','sea')).revision).toBe(1)
  const status=await store.status(workspace)
  expect(status.map(row=>row.collection)).toEqual([...SITE_CONTENT_COLLECTIONS])
  expect(status.find(row=>row.collection==='partners')).toMatchObject({version:1,publishedRevision:1,issueCount:0})
  expect(status.find(row=>row.collection==='partners')!.publishedAt).toMatch(/^\d{4}-/)
  expect(status.find(row=>row.collection==='people')).toMatchObject({version:0,publishedRevision:0,publishedAt:null})
  const draft=await store.draft(workspace,'partners');expect(draft.issueDetails).toEqual([])
 })
 it('applies item edits inside the version check and blocks publishing images outside the media library',async()=>{
  const {workspace,actor,store}=await fixture()
  const edited=await store.update(workspace,'event-pages',0,[{op:'insert',path:'pages',value:{event:'space-night',sections:[]}},
   {op:'insert',path:'pages/space-night/sections',value:{id:'intro',kind:'text',body:L('Welcome')}}],actor)
  expect(edited).toMatchObject({version:1,issues:[],changed:['insert pages','insert pages/space-night/sections']})
  await expect(store.update(workspace,'event-pages',0,[{op:'remove',path:'pages/space-night'}],actor)).rejects.toMatchObject({code:'conflict'})
  await expect(store.update(workspace,'event-pages',1,[{op:'set',path:'pages/space-night/sections/intro/kind',value:'unknown'}],actor)).rejects.toMatchObject({code:'invalid_edit'})
  expect((await store.draft(workspace,'event-pages')).version).toBe(1)
  const missing=randomUUID()
  const withImage=await store.update(workspace,'event-pages',1,[{op:'set',path:'pages/space-night/cover',value:{mediaId:missing,alt:L('Stage')}}],actor)
  expect(withImage.issueDetails).toEqual([{code:'media_missing',params:{media:missing},message:expect.stringContaining(missing)}])
  expect((await store.status(workspace)).find(row=>row.collection==='event-pages')).toMatchObject({issueCount:1})
  await expect(store.publish(workspace,'event-pages',2,actor)).rejects.toMatchObject({code:'conflict'})
  const file=(await pool!.query(`INSERT INTO workspace_files(workspace_id,path,parent_path,name,mime,size_bytes,storage_uri,created_by_user_id)
   VALUES($1,'/doc/website-media/x-stage.png','/doc/website-media','x-stage.png','image/png',3,'file://x',$2) RETURNING id`,[workspace,actor.credentialId])).rows[0].id
  await store.update(workspace,'event-pages',2,[{op:'set',path:'pages/space-night/cover/mediaId',value:file}],actor)
  await expect(store.publish(workspace,'event-pages',3,actor)).resolves.toMatchObject({revision:3})
 })
})
