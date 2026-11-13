import { describe, it, expect, vi } from 'vitest'
import { MembershipCatalogueDocumentSchema, membershipPublicationIssues, resolveMembershipCatalogue } from '../membership-catalogue.js'
import { createAssociationTools } from '../tools.js'
const copy = { name:'New plan',summary:'Summary',eligibility:'Adults',benefits:['Events'] }
const page = { title:'Membership',intro:'Join',groups:[{id:'plans',title:'Plans',intro:''}],sections:[] }
export const document = () => MembershipCatalogueDocumentSchema.parse({schemaVersion:1,plans:[{
  key:'new-plan',currency:'HKD',feeMinor:10000,billingPeriod:'annual',availability:'public',application:{type:'application',proposerRequired:false,codeOfConduct:true},sites:['oasa','sea'],group:'plans',order:0,i18n:{en:copy,'zh-Hant':copy,'zh-Hans':copy},overrides:{sea:{en:{...copy,name:'SEA wording'}}},
}],pages:{oasa:{en:page,'zh-Hant':page,'zh-Hans':page},sea:{en:page,'zh-Hant':page,'zh-Hans':page}}})
describe('[COMP:crm/membership-catalogue] publication contract',()=>{
  it('accepts new stable keys and resolves only the requested brand override',()=>{
    const doc=document();expect(membershipPublicationIssues(doc)).toEqual([])
    expect(resolveMembershipCatalogue(doc,'sea').plans[0].i18n.en.name).toBe('SEA wording')
    expect(resolveMembershipCatalogue(doc,'oasa').plans[0].i18n.en.name).toBe('New plan')
    expect(doc.plans[0].i18n.en.name).toBe('New plan')
  })
  it('publishes each plan’s selected application fields and preserves legacy defaults',()=>{
    const previous=document()
    expect(resolveMembershipCatalogue(previous,'sea').plans[0].application.optionalFields).toBeUndefined()
    const next=structuredClone(previous)
    next.plans[0].application.optionalFields=['special_request']
    const saved=MembershipCatalogueDocumentSchema.parse(next)
    expect(resolveMembershipCatalogue(saved,'sea').plans[0].application.optionalFields).toEqual(['special_request'])
    expect(membershipPublicationIssues(saved)).toEqual([])
    saved.plans[0].application.optionalFields=['interests','interests']
    expect(MembershipCatalogueDocumentSchema.safeParse(saved).success).toBe(false)
  })
  it('inherits shared edits for fields without a brand override',()=>{
    const doc=document();doc.plans[0].overrides.sea={en:{name:'SEA only name'}};doc.plans[0].i18n.en.benefits=['Changed shared benefit'];
    expect(resolveMembershipCatalogue(doc,'sea').plans[0].i18n.en).toMatchObject({name:'SEA only name',benefits:['Changed shared benefit']});
  })
  it('lets staff save incomplete drafts but blocks publication until translations and groups are complete',()=>{
    const doc=document();doc.plans[0].i18n['zh-Hant'].name='';doc.plans[0].group='missing'
    expect(MembershipCatalogueDocumentSchema.safeParse(doc).success).toBe(true)
    expect(membershipPublicationIssues(doc).join(' ')).toContain('zh-Hant')
    expect(membershipPublicationIssues(doc).join(' ')).toContain('unknown display group')
  })
  it('rejects duplicate identities, executable links, unsupported billing and reversed dates',()=>{
    const doc=document();doc.plans.push({...doc.plans[0]});expect(MembershipCatalogueDocumentSchema.safeParse(doc).success).toBe(false)
    const bad=document();bad.plans[0].i18n.en.documents=[{label:'Bad',href:'javascript:alert(1)'}];expect(MembershipCatalogueDocumentSchema.safeParse(bad).success).toBe(false)
    expect(MembershipCatalogueDocumentSchema.safeParse({...document(),plans:[{...document().plans[0],billingPeriod:'monthly'}]}).success).toBe(false)
  })
  it('requires explicit AI confirmation to publish and exposes a preview/read before mutation',()=>{
    const tools=createAssociationTools({execute:vi.fn()})
    expect(tools.previewMembershipCatalogue.isReadOnly).toBe(true)
    expect(tools.publishMembershipCatalogue.requiresConfirmation).toBe(true)
    expect(tools.saveMembershipCatalogueDraft.requiresCapability).toBe('configure')
  })
})
