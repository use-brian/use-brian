import { describe, expect, it } from 'vitest'
import {
  resolveOfficeAccessProjection,
  type OfficeAccessProjection,
} from '../access.js'

const USER = '00000000-0000-4000-8000-000000000001'
const OTHER = '00000000-0000-4000-8000-000000000002'

function projection(overrides: Partial<OfficeAccessProjection> = {}): OfficeAccessProjection {
  return {
    artifactId: '00000000-0000-4000-8000-000000000010',
    workspaceId: '00000000-0000-4000-8000-000000000011',
    creatorUserId: OTHER,
    ownerUserId: OTHER,
    sensitivity: 'internal',
    visibilityUserIds: [],
    requiredCompartments: [],
    defaultWorkspaceRole: 'comment',
    lifecycleState: 'active',
    memberRole: 'member',
    memberClearance: 'internal',
    memberCompartments: null,
    explicitRole: null,
    grantRevokedAt: null,
    ...overrides,
  }
}

describe('[COMP:api/office-access] Office access predicate', () => {
  it('gives eligible peers Comment and creators Edit without admin magic', () => {
    expect(resolveOfficeAccessProjection(USER, projection())).toMatchObject({ role: 'comment', canComment: true, canEdit: false })
    expect(resolveOfficeAccessProjection(USER, projection({ creatorUserId: USER }))).toMatchObject({ role: 'edit', canEdit: true })
    expect(resolveOfficeAccessProjection(USER, projection({ memberRole: 'admin' }))).toMatchObject({ role: 'comment', canEdit: false, canElevate: true })
  })

  it('hard-denies insufficient clearance, source visibility, compartments, and explicit deny', () => {
    expect(resolveOfficeAccessProjection(USER, projection({ sensitivity: 'confidential' }))).toBeNull()
    expect(resolveOfficeAccessProjection(USER, projection({ visibilityUserIds: [OTHER] }))).toBeNull()
    expect(resolveOfficeAccessProjection(USER, projection({ memberCompartments: ['sales'], requiredCompartments: ['legal'] }))).toBeNull()
    expect(resolveOfficeAccessProjection(USER, projection({ explicitRole: 'deny' }))).toBeNull()
  })

  it('makes Archive/Trash read-only and Retained owner/admin-only', () => {
    expect(resolveOfficeAccessProjection(USER, projection({ creatorUserId: USER, lifecycleState: 'archived' }))).toMatchObject({ canEdit: false, canRestore: true })
    expect(resolveOfficeAccessProjection(USER, projection({ creatorUserId: USER, lifecycleState: 'trash' }))).toMatchObject({ canComment: false, canRestore: true })
    expect(resolveOfficeAccessProjection(USER, projection({ lifecycleState: 'retained' }))).toBeNull()
    expect(resolveOfficeAccessProjection(USER, projection({ lifecycleState: 'retained', memberRole: 'owner' }))).toMatchObject({ canView: true, canEdit: false })
    expect(resolveOfficeAccessProjection(USER, projection({ lifecycleState: 'purged', memberRole: 'owner' }))).toBeNull()
  })

  it('honours a live explicit grant and ignores a revoked grant', () => {
    expect(resolveOfficeAccessProjection(USER, projection({ explicitRole: 'edit' }))).toMatchObject({ role: 'edit', canEdit: true })
    expect(resolveOfficeAccessProjection(USER, projection({ explicitRole: 'edit', grantRevokedAt: new Date() }))).toMatchObject({ role: 'comment', canEdit: false })
  })
})
