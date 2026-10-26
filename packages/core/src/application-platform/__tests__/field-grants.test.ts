import { describe, expect, it } from 'vitest'
import { applicationQuerySchema, type ApplicationAccessGrant } from '@use-brian/shared'
import { applicationQueryFieldCeiling, applicationAuthorityQueryFieldCeiling, assertApplicationQueryFields, assertApplicationWriteFields,
  applicationAuthorityCreationScope, decideApplicationFields, decideApplicationAuthority, projectApplicationFields, type ApplicationGrantLayer, type ApplicationRecordAuthority } from '../access.js'

const userId='10000000-0000-4000-8000-000000000001',appId='10000000-0000-4000-8000-000000000002',workspaceId='10000000-0000-4000-8000-000000000003'
const resource:ApplicationRecordAuthority={ref:{workspaceId,origin:{kind:'native',moduleKey:'operations'},typeKey:'purchase',id:'request-one',version:'1'},
  scope:{workspaceId,userId:null,assistantId:null,sensitivity:'internal',compartments:['purchasing'],projectIds:[]},ownerUserId:userId,relationships:new Set()}
const now=Date.parse('2026-01-02T00:00:00Z')
function grant(patch:Partial<ApplicationAccessGrant>={}):ApplicationAccessGrant {
  return {id:'10000000-0000-4000-8000-000000000004',appId,workspaceId,principal:{kind:'member',userId},origin:resource.ref.origin,typeKey:'purchase',
    actions:['read','query','patch'],readFields:['name','cost'],writeFields:['name','cost'],selector:{kind:'ids',ids:['request-one']},version:1,status:'active',
    startsAt:'2026-01-01T00:00:00Z',expiresAt:null,parentGrantId:null,compartments:['purchasing'],projectIds:[],clearance:'internal',...patch}
}
function layer(grants:ApplicationAccessGrant[]):ApplicationGrantLayer {return {appId,principal:{kind:'member',userId},grants}}
const decide=(layers:ApplicationGrantLayer[],value=resource)=>decideApplicationFields(layers,value,'read',['name','cost'],['name'],now)

describe('[COMP:security/application-access] application grant ceilings',()=>{
  it('denies missing, revoked, future, expired, foreign workspace/app/origin/subject grants',()=>{
    const invalid=[grant({status:'revoked'}),grant({startsAt:'2027-01-01T00:00:00Z'}),grant({expiresAt:'2026-01-01T00:00:00Z'}),
      grant({workspaceId:userId}),grant({appId:userId}),grant({origin:{kind:'native',moduleKey:'other'}}),grant({principal:{kind:'service',userId}})]
    expect(decide([]).allowed).toBe(false)
    expect(decide([layer([])]).allowed).toBe(false)
    for(const value of invalid)expect(decide([layer([value])]).allowed).toBe(false)
  })
  it('intersects credential, user, parent and native module field masks',()=>{
    const result=decide([layer([grant()]),layer([grant({readFields:['name'],writeFields:['name','cost']})])])
    expect(result.readFields).toEqual(['name']);expect(result.writeFields).toEqual(['name'])
    expect(projectApplicationFields({name:'Request',cost:'12.50'},result)).toEqual({name:'Request'})
    expect(()=>assertApplicationWriteFields(['cost'],result)).toThrow()
  })
  it('cannot combine independent app identities into one effective permission',()=>{
    expect(decide([layer([grant()]),{...layer([grant({appId:userId})]),appId:userId}]).allowed).toBe(false)
  })
  it('retains native department/Project/clearance floors and canonical self ownership',()=>{
    expect(decide([layer([grant({compartments:[]})])]).allowed).toBe(false)
    expect(decide([layer([grant({clearance:'public'})])]).allowed).toBe(false)
    expect(decide([layer([grant({selector:{kind:'self'}})])]).allowed).toBe(true)
    expect(decide([layer([grant({selector:{kind:'self'}})])],{...resource,ownerUserId:appId}).allowed).toBe(false)
    expect(decide([layer([grant()])],{...resource,scope:{...resource.scope,projectIds:[userId]}}).allowed).toBe(false)
  })
  it('requires a host-resolved registered relationship and explicit anchor',()=>{
    const related=grant({selector:{kind:'relationship',resolverKey:'customer_company',anchorId:'company-one'}})
    expect(decide([layer([related])]).allowed).toBe(false)
    expect(decide([layer([related])],{...resource,relationships:new Set([JSON.stringify(['customer_company','company-one'])])}).allowed).toBe(true)
  })
  it('refuses hidden predicate, sort, aggregate and explicit projection fields before query execution',()=>{
    const decision=decide([layer([grant({readFields:['name']})])])
    for(const query of [{fields:['cost']},{filters:[{field:'cost',op:'eq',value:'12.50'}]},{sort:[{field:'cost',direction:'asc'}]},
      {aggregate:[{field:'cost',operation:'sum'}]}])expect(()=>assertApplicationQueryFields(applicationQuerySchema.parse(query),decision)).toThrow()
  })
  it('uses the common readable fields across differently scoped query candidates',()=>{
    const ceiling=applicationQueryFieldCeiling([layer([grant(),grant({id:appId,selector:{kind:'ids',ids:['request-two']},readFields:['name']})])],resource.ref,['name','cost'],now)
    expect(ceiling.readFields).toEqual(['name'])
    expect(()=>assertApplicationQueryFields(applicationQuerySchema.parse({filters:[{field:'cost',op:'gt',value:1}]}),ceiling)).toThrow()
  })
  it('pins every parent maximum while allowing independent exact-release alternatives',()=>{
    const leaf=grant({parentGrantId:workspaceId}),parent=grant({id:workspaceId,readFields:['name']})
    const maximum={version:1 as const,grants:[leaf,parent]}
    const result=decideApplicationAuthority([[{maximum,current:[leaf,{...parent,version:2,readFields:['name','cost']}]}]],resource,'read',['name','cost'],[],now)
    expect(result.readFields).toEqual(['name'])
    const second=grant({id:appId,readFields:['cost']})
    expect(decideApplicationAuthority([[{maximum,current:[leaf,parent]},{maximum:{version:1,grants:[second]},current:[second]}]],resource,'read',['name','cost'],[],now).readFields).toEqual(['cost','name'])
  })
  it('denies incomplete, cyclic or substituted parent paths and expired issuance maxima',()=>{
    const leaf=grant({parentGrantId:workspaceId}),parent=grant({id:workspaceId})
    const maximum={version:1 as const,grants:[leaf,parent]}
    for(const path of [
      {maximum,current:[leaf]},
      {maximum,current:[leaf,{...parent,id:appId}]},
      {maximum:{version:1 as const,grants:[leaf,{...parent,parentGrantId:leaf.id}]},current:[leaf,parent]},
      {maximum:{version:1 as const,grants:[{...leaf,expiresAt:'2026-01-01T01:00:00Z'},parent]},current:[leaf,parent]},
    ])expect(decideApplicationAuthority([[path]],resource,'read',['name','cost'],[],now).allowed).toBe(false)
  })
  it('checks query vocabulary against every current and captured parent before scanning rows',()=>{
    const leaf=grant({parentGrantId:workspaceId}),parent=grant({id:workspaceId,readFields:['name']})
    const path={maximum:{version:1 as const,grants:[leaf,parent]},current:[leaf,{...parent,version:2,readFields:['name','cost']}]}
    const alternative=grant({id:appId,selector:{kind:'ids',ids:['request-two']}})
    const decision=applicationAuthorityQueryFieldCeiling([[path,{maximum:{version:1,grants:[alternative]},current:[alternative]}]],resource.ref,['name','cost'],now)
    expect(decision.readFields).toEqual(['name'])
    expect(()=>assertApplicationQueryFields(applicationQuerySchema.parse({aggregate:[{field:'cost',operation:'sum'}]}),decision)).toThrow()
    expect(applicationAuthorityQueryFieldCeiling([[{...path,current:[leaf]}]],resource.ref,['name','cost'],now).allowed).toBe(false)
    expect(applicationAuthorityQueryFieldCeiling([],resource.ref,['name'],now).allowed).toBe(false)
  })
  it('classifies new records from their explicit resource grant rather than unrelated resources or General defaults', () => {
    const scoped = grant({ actions: ['create'], selector: { kind: 'self' } })
    const other = grant({ id: appId, actions: ['create'], typeKey: 'other', compartments: ['different'] })
    const paths = [scoped, other].map(value => ({ maximum: { version: 1 as const, grants: [value] }, current: [value] }))
    expect(applicationAuthorityCreationScope([paths], resource.ref, ['name'], { clearance: 'internal', mutationCompartments: ['purchasing'], projectIds: [] }, now))
      .toEqual({ sensitivity: 'internal', compartments: ['purchasing'], projectIds: [] })
    expect(() => applicationAuthorityCreationScope([paths], resource.ref, ['name'], { clearance: 'internal', mutationCompartments: [], projectIds: [] }, now)).toThrow()
  })
  it('preserves an explicitly empty General leaf and refuses conflicting protected issuance maxima', () => {
    const general = grant({ actions: ['create'], compartments: [] }), protectedGrant = { ...general, compartments: ['purchasing'] }
    const native = { clearance: 'internal' as const, mutationCompartments: null, projectIds: null }
    expect(applicationAuthorityCreationScope([[{ maximum: { version: 1, grants: [general] }, current: [general] }]], resource.ref, ['name'], native, now).compartments).toEqual([])
    expect(() => applicationAuthorityCreationScope([[{ maximum: { version: 1, grants: [protectedGrant] }, current: [{ ...protectedGrant, compartments: ['different'] }] }]],
      resource.ref, ['name'], native, now)).toThrow()
  })
  it('refuses ambiguous alternative classifications and disjoint delegated scopes without choosing an empty intersection', () => {
    const first = grant({ actions: ['create'] }), second = grant({ id: appId, actions: ['create'], compartments: ['different'] })
    const a = { maximum: { version: 1 as const, grants: [first] }, current: [first] }, b = { maximum: { version: 1 as const, grants: [second] }, current: [second] }
    const native = { clearance: 'internal' as const, mutationCompartments: null, projectIds: null }
    expect(() => applicationAuthorityCreationScope([[a,b]], resource.ref, ['name'], native, now)).toThrow('one explicit application scope')
    expect(() => applicationAuthorityCreationScope([[a],[b]], resource.ref, ['name'], native, now)).toThrow()
  })
  it('requires complete live create/field authority and preserves Project classification', () => {
    const value = grant({ actions: ['create'], projectIds: [userId], writeFields: ['name'] })
    const path = { maximum: { version: 1 as const, grants: [value] }, current: [value] }
    const native = { clearance: 'public' as const, mutationCompartments: ['purchasing'], projectIds: [userId] }
    expect(applicationAuthorityCreationScope([[path]], resource.ref, ['name'], native, now)).toEqual({ sensitivity: 'public', compartments: ['purchasing'], projectIds: [userId] })
    expect(() => applicationAuthorityCreationScope([[path]], resource.ref, ['cost'], native, now)).toThrow()
    expect(() => applicationAuthorityCreationScope([[{ ...path, current: [{ ...value, status: 'revoked' }] }]], resource.ref, ['name'], native, now)).toThrow()
    expect(() => applicationAuthorityCreationScope([[{ ...path, current: [{ ...value, actions: ['read'] }] }]], resource.ref, ['name'], native, now)).toThrow()
  })
})
