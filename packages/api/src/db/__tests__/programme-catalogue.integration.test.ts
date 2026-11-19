import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { ProgrammeCatalogueDocumentSchema } from '@use-brian/core/association/programme-catalogue.js'
import { createProgrammeCatalogueStore } from '../programme-catalogue-store.js'
import { createAssociationWorkspaceModulesStore } from '../../association/workspace-module.js'
const url=process.env.MEMBERSHIP_TEST_DATABASE_URL
if(url){ const target=new URL(url); if(target.hostname!=='127.0.0.1'||!target.pathname.startsWith('/membership_catalogue_test_'))throw new Error('Only a disposable local membership test database is allowed') }
const pool=url?new Pool({connectionString:url}):null
const en={name:'Synthetic programme',tagline:'Tagline',kicker:'Kicker',summary:'Synthetic test',sections:[{id:'about',heading:'About',paragraphs:['Text']}]}
const document=()=>ProgrammeCatalogueDocumentSchema.parse({schemaVersion:1,
  audiences:{corporates:{gallery:'spacebiz-dialogues',order:['synthetic']},schools:{gallery:'space-exchange-tour',order:[]},students:{gallery:'young-marco-polo',order:[]}},
  programmes:[{slug:'synthetic',audiences:['corporates'],order:0,fee:{currency:'HKD',amountMinor:10000},i18n:{en:{...en,feeUnit:'per person'}}}]})
async function fixture(){
 const workspace=randomUUID(),user=randomUUID()
 await pool!.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[user])
 await pool!.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Programme publication test',$2)",[workspace,user])
 await pool!.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspace,user])
 await createAssociationWorkspaceModulesStore(pool!).act(workspace,user,'association',{action:'enable',expectedVersion:1})
 return {workspace,actor:{credentialKind:'user' as const,credentialId:user,actingUserId:user},store:createProgrammeCatalogueStore(pool!)}
}
describe.skipIf(!pool)('[COMP:crm/programme-catalogue] actual PostgreSQL publication',()=>{
 afterAll(async()=>{await pool?.end()})
 it('isolates drafts, publishes immutable revisions, keeps slugs, detects conflicts and records reader acknowledgement',async()=>{
  const {workspace,actor,store}=await fixture(); const doc=document()
  await store.save(workspace,0,doc,actor)
  await expect(store.read(workspace,'oasa')).rejects.toMatchObject({code:'not_available'})
  await expect(store.save(workspace,0,doc,actor)).rejects.toMatchObject({code:'conflict'})
  await store.publish(workspace,1,actor)
  const first=await store.read(workspace,'oasa');expect(first.revision).toBe(1);expect(first.programmes[0]!.fee).toEqual({currency:'HKD',amountMinor:10000})
  expect((await store.read(workspace,'sea')).programmes).toEqual([])
  // Content only: no plan, ticket or entitlement row is created by publication.
  expect((await pool!.query('SELECT count(*) FROM association_membership_plans WHERE workspace_id=$1',[workspace])).rows[0].count).toBe('0')
  const next=(await store.draft(workspace)).document!;next.programmes[0]!.fee={currency:'HKD',amountMinor:12000}
  await store.save(workspace,1,next,actor)
  expect((await store.read(workspace,'oasa')).programmes[0]!.fee!.amountMinor).toBe(10000)
  await expect(store.publish(workspace,1,actor)).rejects.toMatchObject({code:'conflict'})
  await store.publish(workspace,2,actor)
  expect((await store.read(workspace,'oasa')).programmes[0]!.fee!.amountMinor).toBe(12000)
  await store.observe(workspace,'oasa',1);expect((await store.draft(workspace)).observations.oasa).toBeUndefined()
  await store.observe(workspace,'oasa',2);expect((await store.draft(workspace)).observations.oasa!.revision).toBe(2)
  const removal=structuredClone((await store.draft(workspace)).document!);removal.programmes=[];removal.audiences.corporates.order=[]
  await store.save(workspace,2,removal,actor);await expect(store.publish(workspace,3,actor)).rejects.toMatchObject({code:'conflict'})
  expect((await store.read(workspace,'oasa')).revision).toBe(2)
  const retired=structuredClone(next);retired.programmes[0]!.status='retired'
  await store.save(workspace,3,retired,actor);await store.publish(workspace,4,actor)
  expect((await store.read(workspace,'oasa')).programmes[0]!.status).toBe('retired')
  await expect(store.read(randomUUID(),'oasa')).rejects.toMatchObject({code:'not_available'})
  expect((await pool!.query("SELECT action FROM association_audit_log WHERE workspace_id=$1 AND subject_kind='programme_catalogue' ORDER BY created_at",[workspace])).rows.map(row=>row.action)).toContain('programme_catalogue.published')
 })
 it('blocks incomplete publication',async()=>{
  const {workspace,actor,store}=await fixture();const doc=document();doc.programmes[0]!.i18n['zh-Hans']={...doc.programmes[0]!.i18n.en,name:''}
  await store.save(workspace,0,doc,actor);await expect(store.publish(workspace,1,actor)).rejects.toMatchObject({code:'conflict'})
  doc.programmes[0]!.i18n['zh-Hans']!.name='合成项目';await store.save(workspace,1,doc,actor);await store.publish(workspace,2,actor)
  expect((await store.read(workspace,'oasa')).programmes[0]!.i18n['zh-Hans']!.name).toBe('合成项目')
 })
})
