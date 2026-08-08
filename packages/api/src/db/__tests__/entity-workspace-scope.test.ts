/**
 * [COMP:brain/entity-visibility] — CRM writers create WORKSPACE-scoped
 * entities: `user_id` is NULL, authorship still stamps the actor.
 *
 * Regression for the 2026-08-07 finding (migration 422). Visibility used to be
 * a verbatim copy of authorship — `createContact` passed the acting principal
 * as both `userId` and `createdByUserId` — so every CRM row landed at
 * `workspace_shared` scope and was readable only by whoever wrote it. In prod
 * that produced 1217 live entities across 20 workspaces with ZERO
 * workspace-scoped, `user_id = created_by_user_id` on 100% of rows, one human
 * split across four rows, and a "shared company brain" nobody could share.
 *
 * The two axes must move independently: visibility drops to NULL, provenance
 * does not. A test that only asserted `userId: null` would pass against a
 * writer that had also dropped authorship, which the authorship guard forbids.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { EntityRecord } from '@use-brian/core'

vi.mock('../client.js', () => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  queryGated: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  // Dedupe lookup finds nothing, so every case takes the fresh-insert branch.
  queryWithRLS: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  getAppPool: vi.fn(() => {
    throw new Error('app pool unused in this suite')
  }),
  rollbackAndRelease: vi.fn(),
}))

vi.mock('../entities-store.js', () => ({
  createEntity: vi.fn(),
  getEntityById: vi.fn(),
  getEntityByIdSystem: vi.fn(),
  updateEntity: vi.fn(),
}))

import { createContact, createCompany, createDeal } from '../crm.js'
import { createEntity } from '../entities-store.js'

const ACTOR = 'u-actor'
const WORKSPACE = 'ws-1'

function entity(over: Partial<EntityRecord> = {}): EntityRecord {
  return {
    id: 'e-1',
    kind: 'person',
    displayName: 'Fictional Person',
    canonicalId: null,
    attributes: {},
    sensitivity: 'internal',
    workspaceId: WORKSPACE,
    userId: null,
    assistantId: null,
    compartments: [],
    ...over,
  } as EntityRecord
}

beforeEach(() => {
  vi.mocked(createEntity).mockReset()
  vi.mocked(createEntity).mockResolvedValue(entity())
})

describe('[COMP:brain/entity-visibility] CRM writers scope entities to the workspace', () => {
  it('createContact writes user_id NULL while authorship keeps the actor', async () => {
    await createContact(ACTOR, { workspaceId: WORKSPACE, name: 'Fictional Person' })

    const args = vi.mocked(createEntity).mock.calls[0]![0]
    expect(args.kind).toBe('person')
    // The visibility axis is dropped...
    expect(args.userId).toBeNull()
    // ...and the authorship axis is not. These must not move together.
    expect(args.createdByUserId).toBe(ACTOR)
    expect(args.workspaceId).toBe(WORKSPACE)
  })

  it('createCompany writes user_id NULL while authorship keeps the actor', async () => {
    vi.mocked(createEntity).mockResolvedValue(entity({ kind: 'company', displayName: 'Fictional Co' }))
    await createCompany(ACTOR, { workspaceId: WORKSPACE, name: 'Fictional Co' })

    const args = vi.mocked(createEntity).mock.calls[0]![0]
    expect(args.kind).toBe('company')
    expect(args.userId).toBeNull()
    expect(args.createdByUserId).toBe(ACTOR)
  })

  it('createDeal writes user_id NULL while authorship keeps the actor', async () => {
    vi.mocked(createEntity).mockResolvedValue(entity({ kind: 'deal', displayName: 'Fictional Deal' }))
    await createDeal(ACTOR, { workspaceId: WORKSPACE, stage: 'lead' })

    const args = vi.mocked(createEntity).mock.calls[0]![0]
    expect(args.kind).toBe('deal')
    expect(args.userId).toBeNull()
    expect(args.createdByUserId).toBe(ACTOR)
  })

  it('never partitions a CRM row by assistant either', async () => {
    await createContact(ACTOR, { workspaceId: WORKSPACE, name: 'Fictional Person' })

    const args = vi.mocked(createEntity).mock.calls[0]![0]
    // `(NULL, NULL)` is the workspace scope migration 422 opened up. A row
    // partitioned on either axis is invisible to some member of the workspace,
    // which is the bug, not a narrower version of the fix.
    expect(args.assistantId ?? null).toBeNull()
  })
})
