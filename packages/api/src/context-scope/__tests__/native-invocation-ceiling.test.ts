import { describe, expect, it } from 'vitest'
import { accessCeilingContains, type AccessCeiling } from '@use-brian/core'
import { nativeInvocationReadCeiling } from '../native-invocation-ceiling.js'

const original: AccessCeiling = {
  workspaceId: 'workspace', userId: 'actor', clearance: 'confidential', compartments: null,
  mutationCompartments: null, projectIds: ['project-a', 'project-b'], visibilityAssistantIds: ['assistant'],
  departmentRead: { workspaceId: 'workspace', userId: 'actor', assistantId: 'assistant', base: 'confidential',
    departments: { finance: 'confidential' }, projects: { 'project-a': 'member', 'project-b': 'member' },
    binding: null, contextDepartment: null, cap: null },
}
const recipient: AccessCeiling = {
  workspaceId: 'workspace', userId: '', clearance: 'internal', compartments: ['project:project-a'],
  mutationCompartments: [], projectIds: ['project-a'], visibilityAssistantIds: null,
  departmentRead: { workspaceId: 'workspace', userId: '', assistantId: 'assistant', base: 'internal',
    departments: {}, projects: { 'project-a': 'member' }, binding: null, contextDepartment: null, cap: null },
}

describe('[COMP:api/delivery-authority] native reader identity under an anonymous Project destination', () => {
  it('keeps the original SQL actor/grant, removes Departments and siblings, and never rebinds the audience grant', () => {
    const before = structuredClone({ original, recipient })
    const bounded = nativeInvocationReadCeiling(original, recipient)
    expect(bounded).toMatchObject({ userId: 'actor', clearance: 'internal', compartments: ['project:project-a'],
      mutationCompartments: [], projectIds: ['project-a'], visibilityAssistantIds: ['assistant'],
      departmentRead: { userId: 'actor', base: 'internal', departments: {}, projects: { 'project-a': 'member' } } })
    expect(bounded.departmentRead!.projects).not.toHaveProperty('project-b')
    expect(accessCeilingContains(original, bounded)).toBe(true)
    expect({ original, recipient }).toEqual(before)
  })
  it('also preserves the original actor under legacy anonymous destinations', () => {
    const { departmentRead: _grant, ...legacy } = recipient
    expect(nativeInvocationReadCeiling(original, legacy)).toEqual(nativeInvocationReadCeiling(original, recipient))
  })
  it('intersects a personal recipient with its current grant rather than discarding it', () => {
    const personal = { ...recipient, userId: 'actor', departmentRead: { ...recipient.departmentRead!, userId: 'actor', base: 'public' as const, projects: {} } }
    const bounded = nativeInvocationReadCeiling(original, personal)
    expect(bounded.departmentRead).toMatchObject({ userId: 'actor', base: 'public' })
    expect(bounded.departmentRead?.projects ?? {}).toEqual({})
  })
  it('cannot grant the SQL actor a Project absent from its original ceiling', () => {
    const foreign = { ...recipient, compartments: ['project:foreign'], projectIds: ['foreign'],
      departmentRead: { ...recipient.departmentRead!, projects: { foreign: 'member' as const } } }
    expect(nativeInvocationReadCeiling(original, foreign)).toMatchObject({ projectIds: [], departmentRead: { projects: {} } })
  })
  it.each([{ workspaceId: 'foreign' }, { userId: 'another-person' }])('refuses foreign recipient identity: %j', patch => {
    expect(() => nativeInvocationReadCeiling(original, { ...recipient, ...patch })).toThrow('access_actor_mismatch')
  })
  it('refuses an incoherent anonymous grant instead of silently accepting its shape', () => {
    expect(() => nativeInvocationReadCeiling(original, { ...recipient, departmentRead: { ...recipient.departmentRead!, userId: 'actor' } })).toThrow('access_ceiling_missing')
  })
})
