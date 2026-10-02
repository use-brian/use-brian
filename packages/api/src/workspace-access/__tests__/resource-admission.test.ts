import { describe, expect, it } from 'vitest'
import { resolveResourceAdmission, type AdmissionPolicy, type AdmissionAuthority, type AdmissionInput } from '../resource-admission.js'

const simple: AdmissionPolicy = { workspaceId: 'workspace', mode: 'simple', setupState: 'ready', revision: '4', defaultDepartmentId: 'common', defaultCompartment: 'team:common' }
const departments: AdmissionPolicy = { ...simple, mode: 'departments' }
const member: AdmissionAuthority = { clearance: 'internal', mutationCompartments: ['team:common'], projectIds: [] }
const root: AdmissionInput = { expectedPolicyRevision: '4', visibility: 'workspace', sensitivity: 'internal' }

describe('workspace resource admission policy', () => {
  it('AM01 assigns only the default department to an unbound shared Simple root', () => {
    expect(resolveResourceAdmission(simple, member, root)).toEqual({ policyRevision: '4', origin: 'workspace_default', departmentId: 'common', envelope: { visibility: 'workspace', sensitivity: 'internal', compartments: ['team:common'], projectIds: [] } })
    expect(member.mutationCompartments).toEqual(['team:common'])
  })
  it('AM03 does not turn personal resources into shared work', () => {
    expect(resolveResourceAdmission(simple, member, { ...root, visibility: 'private' })).toMatchObject({ origin: 'private', envelope: { visibility: 'private', compartments: [] } })
  })
  it('AM14 requires a choice in Departments, not a union of memberships', () => {
    expect(() => resolveResourceAdmission(departments, { ...member, mutationCompartments: null }, root)).toThrow('context_selection_required')
    expect(resolveResourceAdmission(departments, member, { ...root, destination: { kind: 'general' } })).toMatchObject({ origin: 'explicit', envelope: { compartments: [] } })
  })
  it('AM14 distinguishes explicit General from omission in Simple', () => {
    expect(() => resolveResourceAdmission(simple, member, { ...root, destination: { kind: 'general' } })).toThrow('access_mode_destination_conflict')
  })
  it('AM14 rejects competing explicit label and destination encodings', () => {
    for (const compartments of [[], ['team:other'], ['team:common']]) {
      expect(() => resolveResourceAdmission(simple, { ...member, mutationCompartments: null }, {
        ...root, destination: { kind: 'department', departmentId: 'common' }, requestedLabels: { compartments },
      }, { id: 'common', compartment: 'team:common' })).toThrow('access_mode_destination_conflict')
    }
  })
  it('AM02 never interprets legacy setup as permission to share', () => {
    expect(() => resolveResourceAdmission({ ...simple, setupState: 'legacy' }, member, root)).toThrow('access_mode_setup_required')
  })
  it('AM09 rejects stale policy and missing Simple defaults', () => {
    expect(() => resolveResourceAdmission(simple, member, { ...root, expectedPolicyRevision: '3' })).toThrow('access_policy_conflict')
    expect(() => resolveResourceAdmission({ ...simple, defaultCompartment: null }, member, root)).toThrow('access_mode_default_invalid')
  })
  it('AM14 only accepts a server-resolved exact department and the Simple common destination', () => {
    const input: AdmissionInput = { ...root, destination: { kind: 'department', departmentId: 'other' } }
    expect(() => resolveResourceAdmission(departments, member, input)).toThrow('context_not_available')
    expect(() => resolveResourceAdmission(departments, member, input, { id: 'wrong', compartment: 'team:common' })).toThrow('context_not_available')
    expect(() => resolveResourceAdmission(simple, member, input, { id: 'other', compartment: 'team:other' })).toThrow('access_mode_destination_conflict')
  })
  it('AM17 retains parent privacy, sensitivity and scope floors even for explicit General', () => {
    const inherited = { visibility: 'private' as const, sensitivity: 'confidential' as const, compartments: ['team:secret'], projectIds: ['project'] }
    const admitted = resolveResourceAdmission(departments, { clearance: 'confidential', mutationCompartments: null, projectIds: null }, { ...root, inherited, destination: { kind: 'general' } })
    expect(admitted.envelope).toEqual(inherited)
    expect(inherited.compartments).toEqual(['team:secret'])
  })
  it('AM17 unions source requirements with a destination, never replaces them', () => {
    expect(resolveResourceAdmission(departments, { clearance: 'confidential', mutationCompartments: null, projectIds: null }, {
      ...root, inherited: { visibility: 'workspace', sensitivity: 'internal', compartments: ['team:source'], projectIds: ['source-project'] },
      destination: { kind: 'department', departmentId: 'common', projectId: 'destination-project' },
    }, { id: 'common', compartment: 'team:common' }).envelope).toMatchObject({ compartments: ['team:common', 'team:source'], projectIds: ['destination-project', 'source-project'] })
  })
  it('AM03 rejects confidentiality, Project or mutation ceiling violations', () => {
    expect(() => resolveResourceAdmission(simple, member, { ...root, sensitivity: 'confidential' })).toThrow('context_not_available')
    expect(() => resolveResourceAdmission(departments, member, { ...root, destination: { kind: 'general', projectId: 'unavailable' } })).toThrow('context_not_available')
    expect(() => resolveResourceAdmission(simple, { ...member, mutationCompartments: [] }, root)).toThrow('context_not_available')
  })
  it('AM17 separates canonical readable source floors from mutation-authorized destinations', () => {
    const authority={...member,readCompartments:['team:source'],mutationCompartments:[]}
    const inherited={visibility:'workspace' as const,sensitivity:'internal' as const,compartments:['team:source'],projectIds:[]}
    const input={...root,inherited,inheritedAuthority:'read' as const}
    expect(resolveResourceAdmission(departments,authority,input).envelope).toEqual(inherited)
    expect(()=>resolveResourceAdmission(departments,authority,{...input,inheritedAuthority:'mutation'})).toThrow('context_not_available')
    expect(()=>resolveResourceAdmission(departments,authority,{...input,requestedLabels:{compartments:['team:added']}})).toThrow('context_not_available')
    expect(()=>resolveResourceAdmission(departments,authority,{...input,destination:{kind:'department',departmentId:'source'}},{id:'source',compartment:'team:source'})).toThrow('context_not_available')
    expect(()=>resolveResourceAdmission(departments,{...authority,readCompartments:[]},input)).toThrow('context_not_available')
  })
  it('AM16 preserves a bound parent instead of replacing it with a new default', () => {
    const inherited = { visibility: 'workspace' as const, sensitivity: 'internal' as const, compartments: [] as string[], projectIds: [] as string[] }
    expect(resolveResourceAdmission(simple, member, { ...root, inherited })).toMatchObject({ origin: 'inherited', envelope: inherited })
  })
})
