import { describe, expect, it } from 'vitest'
import type { ApplicationResourceDefinition, ApplicationResourceRef } from '@use-brian/shared'
import { defineNativeApplicationFieldPolicy, nativeApplicationFieldPolicyDescriptor, decideNativeApplicationFields,
  restrictNativeApplicationFieldPolicy, type NativeApplicationFieldFacts } from '../native-field-policy.js'

// Projection algebra only. Canonical SQL/identity/role facts still need real-DB acceptance.
const workspaceId = '10000000-0000-4000-8000-000000000001',userId = '10000000-0000-4000-8000-000000000002',otherId = '10000000-0000-4000-8000-000000000003'
const now = Date.parse('2026-01-02T00:00:00Z')
const ref: ApplicationResourceRef = { workspaceId,origin: { kind: 'native',moduleKey: 'operations' },typeKey: 'purchase',id: 'fictional-purchase',version: '1' }
const catalog: ApplicationResourceDefinition[] = [{ origin: ref.origin,typeKey: ref.typeKey,schemaVersion: '1',fields: [
  { key: 'title',label: 'Title',kind: 'text' },{ key: 'cost',label: 'Cost',kind: 'decimal',scale: 2 },
] }]
function definition() {
  return { moduleKey: 'operations',version: 'policy:1',roles: ['operator','finance','approver'],resources: [{ origin: ref.origin,typeKey: ref.typeKey,schemaVersion: '1',fields: [
    { key: 'title',read: [],write: [['operator','finance']],releaseReadTo: ['external_user','service'],releaseWriteTo: ['service'] },
    { key: 'cost',read: [['finance']],write: [['finance'],['approver']],releaseReadTo: [],releaseWriteTo: [] },
  ] }] }
}
function facts(): NativeApplicationFieldFacts {
  return { workspaceId,moduleKey: 'operations',userId,resource: structuredClone(ref),schemaVersion: '1',policyVersion: 'policy:1',profile: 'native_member',
    roles: [{ workspaceId,moduleKey: 'operations',userId,roleKey: 'finance',startsAt: '2026-01-01T00:00:00Z',expiresAt: null }],
    base: { allowed: true,readFields: ['title','cost'],writeFields: ['title','cost'] } }
}
function issuer(): NonNullable<NativeApplicationFieldFacts['issuer']> {
  return { workspaceId,moduleKey: 'operations',userId: otherId,resource: structuredClone(ref),schemaVersion: '1',policyVersion: 'policy:1',allowed: true,
    readFields: ['title','cost'],writeFields: ['title','cost'],releaseReadFields: ['title','cost'],releaseWriteFields: ['title','cost'] }
}
const decide = (value = facts()) => decideNativeApplicationFields(defineNativeApplicationFieldPolicy(definition(),catalog),ref,value,now)

describe('[COMP:security/native-field-policy] deployed field policy vocabulary', () => {
  it.each(['missing-field','unknown-field','unknown-role','duplicate-role','duplicate-resource','duplicate-field','duplicate-clause','foreign-module','wrong-schema'])(
    'rejects %s declarations instead of falling back to unrestricted fields', kind => {
      const value = definition(),resource = value.resources[0]
      if (kind === 'missing-field') resource.fields.pop()
      if (kind === 'unknown-field') resource.fields[0].key = 'invented'
      if (kind === 'unknown-role') resource.fields[0].read = [['invented']]
      if (kind === 'duplicate-role') value.roles.push('finance')
      if (kind === 'duplicate-resource') value.resources.push(structuredClone(resource))
      if (kind === 'duplicate-field') resource.fields[1].key = 'title'
      if (kind === 'duplicate-clause') resource.fields[0].read = [['finance'],['finance']]
      if (kind === 'foreign-module') value.moduleKey = 'another'
      if (kind === 'wrong-schema') resource.schemaVersion = '2'
      expect(() => defineNativeApplicationFieldPolicy(value,catalog)).toThrow()
    })
  it('detaches definitions/descriptors and refuses a JSON clone of a catalog-validation handle', () => {
    const raw = definition(),handle = defineNativeApplicationFieldPolicy(raw,catalog)
    raw.resources[0].fields[1].read = []
    nativeApplicationFieldPolicyDescriptor(handle).resources[0].fields[1].read = []
    expect(decideNativeApplicationFields(handle,ref,{ ...facts(),roles: [] },now).readFields).toEqual(['title'])
    expect(decideNativeApplicationFields(structuredClone(handle),ref,facts(),now).allowed).toBe(false)
  })
  it('uses canonical generic identity across catalog aliases', () => {
    const origin = { kind: 'generic' as const,entityTypeId: otherId },resource = { ...ref,origin,typeKey: 'portal_alias' }
    const raw = definition();raw.resources[0] = { ...raw.resources[0],origin,typeKey: `record.${otherId}` }
    const handle = defineNativeApplicationFieldPolicy(raw,[{ ...catalog[0],origin,typeKey: 'catalog_alias' }])
    expect(decideNativeApplicationFields(handle,resource,{ ...facts(),resource },now).readFields).toEqual(['cost','title'])
    raw.resources[0].typeKey = 'catalog_alias'
    expect(() => defineNativeApplicationFieldPolicy(raw,[{ ...catalog[0],origin,typeKey: 'catalog_alias' }])).toThrow()
  })
})

describe('[COMP:security/native-field-policy] native member projection masks', () => {
  it('intersects all constraints and unions alternatives within each constraint', () => {
    expect(decide().readFields).toEqual(['cost','title'])
    expect(decide().writeFields).toEqual(['title'])
    const value = facts();value.roles.push({ ...value.roles[0],roleKey: 'approver' })
    expect(decide(value).writeFields).toEqual(['cost','title'])
  })
  it.each(['workspace','module','member','future','expired','unknown'])(
    'does not turn a %s role assignment into field authority', kind => {
      const value = facts(),role = value.roles[0]
      if (kind === 'workspace') role.workspaceId = otherId
      if (kind === 'module') role.moduleKey = 'another'
      if (kind === 'member') role.userId = otherId
      if (kind === 'future') role.startsAt = '2027-01-01T00:00:00Z'
      if (kind === 'expired') role.expiresAt = '2026-01-02T00:00:00Z'
      if (kind === 'unknown') role.roleKey = 'invented'
      expect(decide(value).readFields).toEqual(['title'])
    })
  it('retains the base record/field ceiling and permits an explicitly identity-only read', () => {
    const value = facts();value.base.readFields = ['title']
    expect(decide(value).readFields).toEqual(['title'])
    value.base.readFields = [];value.base.writeFields = []
    expect(decide(value)).toMatchObject({ allowed: true,readFields: [],writeFields: [] })
    value.base.allowed = false
    expect(decide(value).allowed).toBe(false)
  })
  it.each(['workspace','module','record','version','schema','policy','origin','unknown-field'])(
    'refuses a mismatched %s fact snapshot', kind => {
      const value = facts()
      if (kind === 'workspace') value.workspaceId = otherId
      if (kind === 'module') value.moduleKey = 'another'
      if (kind === 'record') value.resource.id = 'another-record'
      if (kind === 'version') value.resource.version = '2'
      if (kind === 'schema') value.schemaVersion = '2'
      if (kind === 'policy') value.policyVersion = 'policy:2'
      if (kind === 'origin') value.resource.origin = { kind: 'native',moduleKey: 'another' }
      if (kind === 'unknown-field') value.base.readFields.push('invented')
      expect(decide(value).allowed).toBe(false)
    })
  it('refuses an unstructured role claim and invalid clock rather than admitting it', () => {
    expect(decide({ ...facts(),roles: ['finance'] as never }).allowed).toBe(false)
    expect(decideNativeApplicationFields(defineNativeApplicationFieldPolicy(definition(),catalog),ref,facts(),NaN).allowed).toBe(false)
  })
})

describe('[COMP:security/native-field-policy] current application and issuer intersections', () => {
  it.each(['application_member','external_user','service'] as const)('requires a current issuer for %s', profile => {
    const value = { ...facts(),profile }
    expect(decide(value).allowed).toBe(false)
    value.issuer = issuer()
    expect(decide(value).readFields).toEqual(profile === 'application_member' ? ['cost','title'] : ['title'])
    value.issuer.allowed = false
    expect(decide(value).allowed).toBe(false)
  })
  it('keeps native member role rules and issuer field/release masks for an app member', () => {
    const value: NativeApplicationFieldFacts = { ...facts(),profile: 'application_member',issuer: issuer() }
    value.issuer!.readFields = ['title']
    expect(decide(value).readFields).toEqual(['title'])
    value.issuer!.readFields.push('cost');value.issuer!.releaseReadFields = ['title']
    expect(decide(value).readFields).toEqual(['title'])
    value.issuer!.releaseReadFields.push('cost');value.roles = []
    expect(decide(value).readFields).toEqual(['title'])
  })
  it('requires explicit non-member release eligibility even when app and issuer fields include protected cost', () => {
    const value: NativeApplicationFieldFacts = { ...facts(),profile: 'external_user',issuer: issuer() }
    expect(decide(value).readFields).toEqual(['title'])
    const raw = definition();raw.resources[0].fields[1].releaseReadTo = ['external_user']
    expect(decideNativeApplicationFields(defineNativeApplicationFieldPolicy(raw,catalog),ref,value,now).readFields).toEqual(['cost','title'])
  })
  it('separates write-only service release from disclosure', () => {
    const value: NativeApplicationFieldFacts = { ...facts(),profile: 'service',roles: [],issuer: issuer(),
      base: { allowed: true,readFields: [],writeFields: ['title'] } }
    value.issuer!.readFields = [];value.issuer!.releaseReadFields = []
    expect(decide(value)).toMatchObject({ allowed: true,readFields: [],writeFields: ['title'] })
  })
  it('refuses an issuer mask containing fields outside the canonical policy', () => {
    const value: NativeApplicationFieldFacts = { ...facts(),profile: 'application_member',issuer: issuer() }
    value.issuer!.releaseReadFields.push('invented')
    expect(decide(value).allowed).toBe(false)
  })
  it.each(['workspace','module','record','version','schema','policy'])(
    'rejects a substituted issuer %s snapshot', kind => {
      const value: NativeApplicationFieldFacts = { ...facts(),profile: 'application_member',issuer: issuer() },source = value.issuer!
      if (kind === 'workspace') source.workspaceId = otherId
      if (kind === 'module') source.moduleKey = 'another'
      if (kind === 'record') source.resource.id = 'another-record'
      if (kind === 'version') source.resource.version = '2'
      if (kind === 'schema') source.schemaVersion = '2'
      if (kind === 'policy') source.policyVersion = 'policy:2'
      expect(decide(value).allowed).toBe(false)
    })
})

describe('[COMP:security/native-field-policy] configured restrictions retain deployed floors', () => {
  it('intersects configured and deployed role requirements', () => {
    const base = defineNativeApplicationFieldPolicy(definition(),catalog), restriction = definition()
    restriction.version = 'configured:1';restriction.resources[0].fields[1].read = [['operator']]
    const narrowed = restrictNativeApplicationFieldPolicy(base,restriction), value = facts()
    value.policyVersion = narrowed.version
    expect(decideNativeApplicationFields(narrowed,ref,value,now).readFields).toEqual(['title'])
    value.roles.push({ ...value.roles[0],roleKey: 'operator' })
    expect(decideNativeApplicationFields(narrowed,ref,value,now).readFields).toEqual(['cost','title'])
    expect(decideNativeApplicationFields(base,ref,facts(),now).readFields).toEqual(['cost','title'])
  })
  it('cannot turn a protected field into an unrestricted or externally released field', () => {
    const base = defineNativeApplicationFieldPolicy(definition(),catalog), restriction = definition()
    restriction.resources[0].fields[1].read = []
    restriction.resources[0].fields[1].releaseReadTo = ['external_user']
    const narrowed = restrictNativeApplicationFieldPolicy(base,restriction), value = facts()
    value.policyVersion = narrowed.version;value.roles = []
    expect(decideNativeApplicationFields(narrowed,ref,value,now).readFields).toEqual(['title'])
    value.profile = 'external_user';value.issuer = { ...issuer(),policyVersion: narrowed.version }
    expect(decideNativeApplicationFields(narrowed,ref,value,now).readFields).toEqual(['title'])
  })
  it('allows an explicit deny without treating an empty role alternative as unrestricted', () => {
    const base = defineNativeApplicationFieldPolicy(definition(),catalog), restriction = definition()
    restriction.resources[0].fields[0].read = [[]]
    const narrowed = restrictNativeApplicationFieldPolicy(base,restriction), value = { ...facts(),policyVersion: narrowed.version }
    expect(decideNativeApplicationFields(narrowed,ref,value,now).readFields).toEqual(['cost'])
  })
  it('gives distinct configurations distinct policy versions and rejects stale facts', () => {
    const base = defineNativeApplicationFieldPolicy(definition(),catalog), restriction = definition()
    const first = restrictNativeApplicationFieldPolicy(base,restriction)
    restriction.version = 'configured:2'
    const second = restrictNativeApplicationFieldPolicy(base,restriction)
    expect(first.version).not.toBe(second.version)
    expect(decideNativeApplicationFields(second,ref,{ ...facts(),policyVersion: first.version },now).allowed).toBe(false)
  })
})
