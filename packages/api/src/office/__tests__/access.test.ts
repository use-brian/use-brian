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
    mode: 'artifact',
    expiresAt: null,
    sensitivity: 'internal',
    visibilityUserIds: [],
    requiredCompartments: [],
    sourcesEligible: true,
    mutationScopeEligible: true,
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
    expect(resolveOfficeAccessProjection(USER, projection({ memberRole: 'admin' }))).toMatchObject({ role: 'comment', canEdit: false, canElevate: true, canManageSharing: true })
    expect(resolveOfficeAccessProjection(USER, projection())).toMatchObject({ canManageSharing: false })
  })

  it('hard-denies insufficient clearance, source visibility, compartments, and explicit deny', () => {
    expect(resolveOfficeAccessProjection(USER, projection({ sensitivity: 'confidential' }))).toBeNull()
    expect(resolveOfficeAccessProjection(USER, projection({ visibilityUserIds: [OTHER] }))).toBeNull()
    expect(resolveOfficeAccessProjection(USER, projection({ memberCompartments: ['sales'], requiredCompartments: ['legal'] }))).toBeNull()
    expect(resolveOfficeAccessProjection(USER, projection({ explicitRole: 'deny' }))).toBeNull()
    expect(resolveOfficeAccessProjection(USER, projection({ sourcesEligible: false }))).toBeNull()
  })

  it('makes Archive/Trash read-only and Retained owner/admin-only', () => {
    expect(resolveOfficeAccessProjection(USER, projection({ creatorUserId: USER, lifecycleState: 'archived' }))).toMatchObject({ canEdit: false, canRestore: true })
    expect(resolveOfficeAccessProjection(USER, projection({ creatorUserId: USER, lifecycleState: 'trash' }))).toMatchObject({ canComment: false, canRestore: true })
    expect(resolveOfficeAccessProjection(USER, projection({ lifecycleState: 'retained' }))).toBeNull()
    expect(resolveOfficeAccessProjection(USER, projection({ lifecycleState: 'retained', memberRole: 'owner' }))).toMatchObject({ canView: true, canEdit: false })
    expect(resolveOfficeAccessProjection(USER, projection({ lifecycleState: 'purged', memberRole: 'owner' }))).toBeNull()
  })

  it('keeps a read grant read-only despite creator, explicit Edit, or admin capability', () => {
    for (const overrides of [{creatorUserId: USER}, {explicitRole: 'edit' as const}, {memberRole: 'admin' as const}]) {
      for (const lifecycleState of ['active', 'archived', 'trash', 'retained'] as const) {
        const access = resolveOfficeAccessProjection(USER, projection({...overrides, lifecycleState, mutationScopeEligible: false}))
        if (access) expect(access).toMatchObject({role: 'view', canView: true, canComment: false, canEdit: false,
          canRestore: false, canDeletePermanently: false, canElevate: false, canManageSharing: false})
      }
    }
  })

  it('honours a live explicit grant and ignores a revoked grant', () => {
    expect(resolveOfficeAccessProjection(USER, projection({ explicitRole: 'edit' }))).toMatchObject({ role: 'edit', canEdit: true })
    expect(resolveOfficeAccessProjection(USER, projection({ explicitRole: 'edit', grantRevokedAt: new Date() }))).toMatchObject({ role: 'comment', canEdit: false })
  })

  it('admits only the active unexpired session owner and disables generic collaboration', () => {
    const expiresAt = new Date('2030-01-02T00:00:00.000Z')
    const session = projection({ mode: 'session', ownerUserId: USER, defaultWorkspaceRole: 'deny', expiresAt })
    expect(resolveOfficeAccessProjection(USER, session, new Date('2030-01-01T00:00:00.000Z'))).toMatchObject({
      mode: 'session', role: 'edit', canView: true, canEdit: true, canComment: false,
      canRestore: false, canDeletePermanently: false, canElevate: false, canManageSharing: false,
    })
    expect(resolveOfficeAccessProjection(OTHER, session, new Date('2030-01-01T00:00:00.000Z'))).toBeNull()
    expect(resolveOfficeAccessProjection(USER, session, expiresAt)).toBeNull()
    expect(resolveOfficeAccessProjection(USER, { ...session, lifecycleState: 'purged' }, new Date('2030-01-01T00:00:00.000Z'))).toBeNull()
    expect(resolveOfficeAccessProjection(USER, { ...session, mutationScopeEligible: false }, new Date('2030-01-01T00:00:00.000Z'))).toBeNull()
  })
})
