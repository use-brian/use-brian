import { describe, it, expect } from 'vitest'
import { admitCrmDestination } from '../creation-destination.js'
import type { AccessSnapshot, Principal } from '../../context-scope/reference-predicate.js'
const person: Principal = { kind: 'user', id: 'fixture-user' }
const snapshot: AccessSnapshot = {
  workspaceId: 'fixture-workspace', base: { 'user:fixture-user': 'internal' },
  edges: [{ principal: person, departmentId: 'fixture-department', clearance: 'confidential', expiresAt: null }],
}
describe('[COMP:crm/creation-destination] manual destination admission', () => {
  it('defaults to the member home and allows a deliberately selected General destination', () => {
    expect(admitCrmDestination(snapshot, person, 'fixture-department', undefined)).toEqual({ explicitGeneral: false, sensitivity: 'internal', compartments: ['team:fixture-department'] })
    expect(admitCrmDestination(snapshot, person, 'fixture-department', { departmentId: null, sensitivity: 'internal' })).toEqual({ explicitGeneral: true, sensitivity: 'internal', compartments: [] })
  })
  it('uses department clearance, not base clearance, for departmental writes', () => {
    expect(admitCrmDestination(snapshot, person, null, { departmentId: 'fixture-department', sensitivity: 'confidential' }).sensitivity).toBe('confidential')
    expect(() => admitCrmDestination(snapshot, person, null, { departmentId: null, sensitivity: 'confidential' })).toThrow('Creation destination unavailable')
  })
  it('refuses revoked or expired department access without falling back to General', () => {
    expect(() => admitCrmDestination({ ...snapshot, edges: [] }, person, 'fixture-department', undefined)).toThrow('Creation destination unavailable')
    expect(() => admitCrmDestination({ ...snapshot, edges: [{ ...snapshot.edges[0], expiresAt: new Date(0) }] }, person, null, { departmentId: 'fixture-department', sensitivity: 'public' })).toThrow('Creation destination unavailable')
  })
  it('never gives an anonymous principal a creation path', () => {
    expect(() => admitCrmDestination(snapshot, { kind: 'anonymous', id: 'anonymous' }, null, undefined)).toThrow('Creation destination unavailable')
  })
})
