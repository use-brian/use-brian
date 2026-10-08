import { describe,expect,it } from 'vitest'
import { pinAccessCeiling,pinAuthoringAuthority,parseAuthoringAuthority,intersectAccessCeilings,accessCeilingContains } from '../access-ceiling.js'
import type { DepartmentReadGrant } from '../department-read.js'
import type { AccessContext } from '../access-context.js'

const context:AccessContext={workspaceId:'workspace',userId:'actor',assistantId:'caller',assistantKind:'standard',clearance:'internal',compartments:['product'],projectIds:null}
describe('[COMP:security/access-ceiling] delegated authority',()=>{
  it('does not turn a standard caller into a reflector when consulting a primary',()=>{
    const caller=pinAccessCeiling(context),callee=pinAccessCeiling({...context,assistantId:'primary',assistantKind:'primary',clearance:'confidential',compartments:null})
    expect(intersectAccessCeilings(caller,callee)).toMatchObject({clearance:'internal',compartments:['product'],visibilityAssistantIds:['caller']})
  })
  it('permits only shared rows between different standard assistants',()=>{
    expect(intersectAccessCeilings(pinAccessCeiling(context),pinAccessCeiling({...context,assistantId:'callee'})).visibilityAssistantIds).toEqual([])
  })
  it('retains an inherited finite ceiling even for a primary',()=>{
    expect(pinAccessCeiling({...context,assistantKind:'primary',visibilityAssistantIds:['earlier']} ).visibilityAssistantIds).toEqual(['earlier'])
  })
  it.each(['workspaceId','userId'] as const)('rejects a different %s',axis=>{
    const a=pinAccessCeiling(context)
    expect(()=>intersectAccessCeilings(a,{...a,[axis]:'other'})).toThrow('access_actor_mismatch')
  })
  it.each(['clearance','compartments','projectIds'] as const)('never interprets missing %s as universe',axis=>{
    expect(()=>pinAccessCeiling({...context,[axis]:undefined})).toThrow('access_ceiling_missing')
  })
  it('detects contraction on every axis and accepts expansion without widening the starting snapshot',()=>{
    const start=pinAccessCeiling({...context,assistantKind:'primary',projectIds:['project']})
    for(const change of [{clearance:'public' as const},{compartments:[]},{projectIds:[]},{visibilityAssistantIds:[]}]) {
      expect(accessCeilingContains({...start,...change},start)).toBe(false)
    }
    const current={...start,clearance:'confidential' as const,compartments:null,projectIds:null}
    expect(accessCeilingContains(current,start)).toBe(true)
    expect(intersectAccessCeilings(current,start)).toEqual(start)
  })
  it('copies and normalizes input arrays so callers cannot edit a retained snapshot',()=>{
    const compartments=['product','product'];const ceiling=pinAccessCeiling({...context,compartments});compartments.push('finance')
    expect(ceiling.compartments).toEqual(['product'])
  })
  it('keeps a read-only department out of mutation reach through delegation',()=>{
    const caller=pinAccessCeiling({...context,compartments:['product','finance'],mutationCompartments:['product']});
    const callee=pinAccessCeiling({...context,assistantKind:'primary',compartments:null,mutationCompartments:null});
    expect(intersectAccessCeilings(caller,callee)).toMatchObject({compartments:['finance','product'],mutationCompartments:['product']});
    expect(accessCeilingContains({...caller,mutationCompartments:[]},caller)).toBe(false);
    expect(accessCeilingContains({...caller,mutationCompartments:null},caller)).toBe(true);
    expect(pinAccessCeiling({...context,mutationCompartments:['finance']} ).mutationCompartments).toEqual([]);
  })
  it('refuses a serialized ceiling with a missing mutation axis',()=>{
    const pinned=pinAccessCeiling(context),legacy={...pinned};
    delete (legacy as Partial<typeof pinned>).mutationCompartments;
    expect(()=>intersectAccessCeilings(pinned,legacy)).toThrow('access_ceiling_missing');
  })
  it('round-trips a normalized durable authoring envelope',()=>{
    const pinned=pinAuthoringAuthority({...context,compartments:['product','product'],mutationCompartments:['product']})
    expect(parseAuthoringAuthority(JSON.parse(JSON.stringify(pinned)))).toEqual(pinned)
  })
  it('refuses legacy or partial authoring envelopes instead of filling absent axes',()=>{
    const pinned=pinAuthoringAuthority({...context,mutationCompartments:['product']})
    const legacy={...pinned,ceiling:{...pinned.ceiling}}
    delete (legacy.ceiling as Partial<typeof pinned.ceiling>).mutationCompartments
    expect(parseAuthoringAuthority(legacy)).toBeNull()
    expect(parseAuthoringAuthority({...pinned,version:0})).toBeNull()
  })

})

describe('[COMP:security/access-ceiling] department authority',()=>{
  const departmentRead = {workspaceId:'workspace',userId:'actor',assistantId:'caller',base:'public' as const,
    departments:{sales:'confidential' as const,finance:'internal' as const},contextDepartment:null,binding:null,cap:null}
  const pin=()=>pinAccessCeiling({...context,compartments:null,departmentRead})
  it('round-trips department authority and rejects malformed persisted grants',()=>{
    const authority=pinAuthoringAuthority({...context,departmentRead})
    expect(parseAuthoringAuthority(JSON.parse(JSON.stringify(authority)))).toEqual(authority)
    for(const patch of [{departments:{sales:'unknown'}},{binding:undefined},{userId:'other'},{base:undefined}]) {
      expect(parseAuthoringAuthority({...authority,ceiling:{...authority.ceiling,departmentRead:{...departmentRead,...patch}}})).toBeNull()
    }
  })
  it('detects department removal, downclearance and credential/context contraction',()=>{
    const start=pin()
    const changes: Partial<DepartmentReadGrant>[] = [{departments:{}},{departments:{sales:'internal' as const,finance:'internal' as const}},
      {binding:['sales']},{contextDepartment:'sales'},{cap:'public' as const}]
    for(const patch of changes) {
      expect(accessCeilingContains({...start,departmentRead:{...departmentRead,...patch}},start)).toBe(false)
    }
    expect(accessCeilingContains({...start,departmentRead:undefined},start)).toBe(false)
    expect(accessCeilingContains({...start,departmentRead:{...departmentRead,departments:{...departmentRead.departments,extra:'confidential'}}},start)).toBe(true)
  })
  it('intersects delegated departments and detaches snapshots from source objects',()=>{
    const start=pin(), narrow={...start,departmentRead:{...departmentRead,departments:{sales:'public' as const}}}
    expect(intersectAccessCeilings(start,narrow).departmentRead?.departments).toEqual({sales:'public'})
    const copy=pin();(copy.departmentRead!.departments as Record<string,string>).sales='public'
    expect(departmentRead.departments.sales).toBe('confidential')
    expect(intersectAccessCeilings(start,{...start,departmentRead:undefined,compartments:[]}).departmentRead?.departments).toEqual({})
  })
})
