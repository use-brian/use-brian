import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { MembershipCatalogueDocumentSchema, AssociationPlanInputSchema, AssociationPromotionInputSchema } from '@use-brian/core'
import { createMembershipCatalogueStore } from '../membership-catalogue-store.js'
import { MembershipCheckoutCreateSchema } from '../../association/domain.js'
import { createAssociationStore } from '../association-store.js'
import { createAssociationWorkspaceModulesStore } from '../../association/workspace-module.js'
const url=process.env.MEMBERSHIP_TEST_DATABASE_URL
if(url){ const target=new URL(url); if(target.hostname!=='127.0.0.1'||!target.pathname.startsWith('/membership_catalogue_test_'))throw new Error('Only a disposable local membership test database is allowed') }
const pool=url?new Pool({connectionString:url}):null
const copy={name:'Test membership',summary:'Synthetic test',eligibility:'Test only',benefits:['A test benefit']}
const page={title:'Membership',intro:'Synthetic catalogue',groups:[{id:'plans',title:'Plans',intro:''}],sections:[]}
const document=()=>MembershipCatalogueDocumentSchema.parse({schemaVersion:1,plans:[{key:'synthetic-new-plan',currency:'HKD',feeMinor:120000,billingPeriod:'annual',availability:'public',application:{type:'application',proposerRequired:false,codeOfConduct:true},sites:['oasa','sea'],group:'plans',order:0,i18n:{en:copy,'zh-Hant':copy,'zh-Hans':copy}}],pages:{oasa:{en:page,'zh-Hant':page,'zh-Hans':page},sea:{en:page,'zh-Hant':page,'zh-Hans':page}}})
async function fixture(){
 const workspace=randomUUID(),user=randomUUID()
 await pool!.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[user])
 await pool!.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Membership publication test',$2)",[workspace,user])
 await pool!.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspace,user])
 await createAssociationWorkspaceModulesStore(pool!).act(workspace,user,'association',{action:'enable',expectedVersion:1})
 return {workspace,actor:{credentialKind:'user' as const,credentialId:user,actingUserId:user},store:createMembershipCatalogueStore(pool!)}
}
describe.skipIf(!pool)('[COMP:crm/membership-catalogue] actual PostgreSQL publication',()=>{
 afterAll(async()=>{await pool?.end()})
 it('isolates drafts, atomically publishes fees and identities, detects conflicts and records reader acknowledgement',async()=>{
  const {workspace,actor,store}=await fixture(); const doc=document()
  await store.save(workspace,0,doc,actor)
  expect((await pool!.query('SELECT count(*) FROM association_membership_plans WHERE workspace_id=$1',[workspace])).rows[0].count).toBe('0')
  await expect(store.read(workspace,'oasa')).rejects.toMatchObject({code:'not_available'})
  await expect(store.save(workspace,0,doc,actor)).rejects.toMatchObject({code:'conflict'})
  await store.publish(workspace,1,actor)
  const first=await store.read(workspace,'oasa');expect(first.plans[0].planId).toMatch(/[a-f0-9-]{36}/)
  expect((await store.read(workspace,'sea')).plans[0].planId).toBe(first.plans[0].planId)
  const contact=randomUUID();
  await pool!.query("INSERT INTO entities(id,workspace_id,kind,display_name,created_by_user_id,source) VALUES($1,$2,'person','Synthetic member',$3,'manual')",[contact,workspace,actor.actingUserId]);
  const membership=(await pool!.query("INSERT INTO association_memberships(workspace_id,contact_id,plan_id,idempotency_key,request_fingerprint,status,starts_at,renewal_mode,provider,provider_membership_id) VALUES($1,$2,$3,$4,$5,'active',now(),'auto','stripe','sub_synthetic_catalogue') RETURNING *",[workspace,contact,first.plans[0].planId,randomUUID(),'a'.repeat(64)])).rows[0];
  const next=(await store.draft(workspace)).document!;next.plans[0].feeMinor=150000
  await store.save(workspace,1,next,actor)
  expect((await store.read(workspace,'oasa')).plans[0].feeMinor).toBe(120000)
  await expect(store.publish(workspace,1,actor)).rejects.toMatchObject({code:'conflict'})
  await store.publish(workspace,2,actor)
  expect((await pool!.query('SELECT fee_minor FROM association_membership_plans WHERE workspace_id=$1',[workspace])).rows[0].fee_minor).toBe('150000')
  expect((await pool!.query('SELECT * FROM association_memberships WHERE id=$1',[membership.id])).rows[0]).toEqual(membership);
  await store.observe(workspace,'oasa',1);expect((await store.draft(workspace)).observations.oasa).toBeUndefined()
  await store.observe(workspace,'oasa',2);expect((await store.draft(workspace)).observations.oasa.revision).toBe(2)
  expect((await store.read(workspace,'oasa',[])).plans).toEqual([])
  await expect(store.read(randomUUID(),'oasa')).rejects.toMatchObject({code:'not_available'})
  const removal=structuredClone((await store.draft(workspace)).document!);removal.plans=[];
  await store.save(workspace,2,removal,actor);await expect(store.publish(workspace,3,actor)).rejects.toMatchObject({code:'conflict'});
  expect((await store.read(workspace,'oasa')).revision).toBe(2);
  const commerce=createAssociationStore(pool!)
  await expect(commerce.upsertPlan(workspace,AssociationPlanInputSchema.parse({key:'synthetic-new-plan',name:'Bypass',currency:'HKD',feeMinor:1,billingPeriod:'annual'}),actor)).rejects.toMatchObject({code:'conflict'})
 })
 it('blocks incomplete publication and excludes private/disabled promotions and secret codes',async()=>{
  const {workspace,actor,store}=await fixture();const doc=document();doc.plans[0].i18n['zh-Hans'].name=''
  await store.save(workspace,0,doc,actor);await expect(store.publish(workspace,1,actor)).rejects.toMatchObject({code:'conflict'})
  doc.plans[0].i18n['zh-Hans'].name='Synthetic';await store.save(workspace,1,doc,actor);await store.publish(workspace,2,actor)
  const plan=(await store.read(workspace,'oasa')).plans[0]
  const commerce=createAssociationStore(pool!,undefined,{promotionHmacKey:'synthetic-membership-promotion-test-key'})
  const offer=AssociationPromotionInputSchema.parse({key:'example',name:'Ten percent',code:'SECRET-TEST-CODE',discountType:'percentage',percentageBasisPoints:1000,targetKind:'plan',targetIds:[plan.planId],status:'active'})
  const promotion=await commerce.upsertPromotion(workspace,offer,actor)
  expect((await store.read(workspace,'oasa')).plans[0].promotion).toBeNull()
  const next=(await store.draft(workspace)).document!;next.plans[0].promotionId=String(promotion.record.id)
  await store.save(workspace,2,next,actor);await store.publish(workspace,3,actor)
  const visible=await store.read(workspace,'sea');expect(visible.plans[0].promotion).toMatchObject({priceHkd:1080,requiresCode:true})
  expect(JSON.stringify(visible)).not.toContain('SECRET-TEST-CODE')
  const contact=randomUUID();await pool!.query("INSERT INTO entities(id,workspace_id,kind,display_name,created_by_user_id,source) VALUES($1,$2,'person','Synthetic buyer',$3,'manual')",[contact,workspace,actor.actingUserId]);
  const checkout=await commerce.reserveMembershipCheckout(workspace,MembershipCheckoutCreateSchema.parse({contactId:contact,planId:plan.planId,idempotencyKey:randomUUID(),reservationMinutes:35,promotionCode:'SECRET-TEST-CODE'}),actor);
  expect(Number(checkout.record.totalMinor)/100).toBe(visible.plans[0].promotion!.priceHkd);
  await commerce.upsertPromotion(workspace,{...offer,validTo:'2020-01-01T00:00:00Z'},actor)
  expect((await store.read(workspace,'oasa')).plans[0].promotion).toBeNull()
  await commerce.upsertPromotion(workspace,{...offer,status:'disabled'},actor)
  expect((await store.read(workspace,'oasa')).plans[0].promotion).toBeNull()
 })
 it('saves membership drafts while commerce is off but only publishes plan prices when it is on',async()=>{
  const {workspace,actor,store}=await fixture()
  await createAssociationWorkspaceModulesStore(pool!).act(workspace,actor.credentialId,'association',{action:'request_disable',expectedVersion:2})
  await store.save(workspace,0,document(),actor)
  await expect(store.publish(workspace,1,actor)).rejects.toMatchObject({code:expect.stringMatching(/^module_(disabled|draining)$/)})
  expect(await store.status(workspace)).toMatchObject({version:1,publishedRevision:0,publishedAt:null})
 })
})
