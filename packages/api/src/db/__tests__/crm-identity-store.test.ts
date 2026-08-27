/**
 * Stable CRM identity bindings and reversible separation hard state.
 *
 * [COMP:crm/identity-bindings]
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const poolState = vi.hoisted(() => ({ pool: {} as Record<string, unknown> }))
const decisions = vi.hoisted(() => ({
  appendDecisionEvent: vi.fn(),
  appendDecisionDerivation: vi.fn(),
}))

vi.mock('../client.js', () => ({ getPool: () => poolState.pool }))
vi.mock('../decision-event-store.js', () => ({
  appendDecisionEvent: decisions.appendDecisionEvent,
}))
vi.mock('../decision-provenance-store.js', () => ({
  appendDecisionDerivation: decisions.appendDecisionDerivation,
}))

import {
  applyCrmUndoIdentityProjection,
  bindImportedCrmIdentity,
  bootstrapHistoricalCrmIdentityState,
  keepCrmEntitiesSeparate,
  prepareCrmMergeIdentityProjection,
  resolveCrmPersonIdentity,
} from '../crm-identity-store.js'

const NOW = new Date('2026-08-25T00:00:00Z')
const WS = '00000000-0000-4000-8000-000000000001'
const USER = '00000000-0000-4000-8000-000000000002'
const LEFT = '00000000-0000-4000-8000-000000000010'
const RIGHT = '00000000-0000-4000-8000-000000000011'
const STABLE = { provider: 'slack', providerInstanceKey: 'T000001', subjectId: 'U000001' }

function bindingRow(entityId: string, id = '00000000-0000-4000-8000-000000000020') {
  return {
    id,
    workspaceId: WS,
    ...STABLE,
    entityId,
    sensitivity: 'internal',
    boundByDecisionEventId: null,
    boundAt: NOW,
  }
}

function separationRow() {
  return {
    id: '00000000-0000-4000-8000-000000000030',
    workspace_id: WS,
    left_entity_id: LEFT,
    right_entity_id: RIGHT,
    leftName: 'Jordan Kim',
    rightName: 'Jordan Kim',
    reason: 'Different people',
    actor_user_id: USER,
    sensitivity: 'internal',
    created_by_decision_event_id: '00000000-0000-4000-8000-000000000040',
    created_at: NOW,
  }
}

function pairRows() {
  return [
    { id: LEFT, kind: 'person', name: 'Jordan Kim', sensitivity: 'internal', attributes: {}, aliases: [] },
    { id: RIGHT, kind: 'person', name: 'Jordan Kim', sensitivity: 'internal', attributes: {}, aliases: [] },
  ]
}

beforeEach(() => {
  vi.clearAllMocks()
  decisions.appendDecisionEvent.mockResolvedValue({
    inserted: true,
    event: { id: '00000000-0000-4000-8000-000000000040' },
  })
  decisions.appendDecisionDerivation.mockResolvedValue({ inserted: true })
})

describe('[COMP:crm/identity-bindings] stable binding resolution', () => {
  it('returns conflict instead of choosing among multiple active targets', async () => {
    const queryable = {
      query: vi.fn(async (_text: string) => ({
        rows: [bindingRow(LEFT), bindingRow(RIGHT, '00000000-0000-4000-8000-000000000021')],
      })),
    }
    await expect(resolveCrmPersonIdentity(WS, STABLE, queryable as never)).resolves.toEqual({
      status: 'conflict',
      entityIds: [LEFT, RIGHT],
    })
    expect(queryable.query.mock.calls[0][0]).toContain("NOT COALESCE((e.attributes->>'self')::boolean, false)")
  })

  it('bootstraps only a complete stable provider namespace and links its source decision', async () => {
    const inserted = bindingRow(LEFT)
    const client = {
      query: vi.fn(async (text: string) => {
        if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) return { rows: [] }
        if (text.includes('pg_advisory_xact_lock')) return { rows: [] }
        if (text.includes('SELECT id FROM entities')) return { rows: [{ id: LEFT }] }
        if (text.includes('FROM crm_identity_bindings')) return { rows: [] }
        if (text.includes('INSERT INTO crm_identity_bindings')) return { rows: [inserted] }
        throw new Error(`unexpected SQL: ${text}`)
      }),
      release: vi.fn(),
    }
    poolState.pool = {
      query: vi.fn(async () => ({
        rows: [{
          id: 'merge-1',
          workspaceId: WS,
          survivingId: LEFT,
          mergedId: RIGHT,
          undoneAt: null,
          mergedBy: USER,
          attributes: {
            external_ref: { provider: 'slack', team_id: 'T000001', id: 'U000001' },
          },
          sensitivity: 'internal',
          decisionEventId: 'decision-merge',
          undoDecisionEventId: null,
        }],
      })),
      connect: vi.fn(async () => client),
    }

    await expect(bootstrapHistoricalCrmIdentityState()).resolves.toEqual({
      bindingsCreated: 1,
      separationsCreated: 0,
      collisionsSkipped: 0,
    })
    expect(decisions.appendDecisionDerivation).toHaveBeenCalledWith({
      decisionEventId: 'decision-merge',
      artifactKind: 'crm_identity_binding',
      artifactId: inserted.id,
      relation: 'supports',
    }, client)
  })

  it('refuses self entities as binding targets before insert', async () => {
    const client = {
      query: vi.fn(async (text: string) => {
        if (text.includes('pg_advisory_xact_lock')) return { rows: [] }
        if (text.includes('SELECT id FROM entities')) return { rows: [] }
        throw new Error(`unexpected SQL: ${text}`)
      }),
    }
    await expect(bindImportedCrmIdentity({
      workspaceId: WS,
      entityId: LEFT,
      identity: STABLE,
      sensitivity: 'internal',
    }, client as never)).rejects.toThrow('live non-self person')
    expect(client.query.mock.calls.some(([text]) => String(text).includes('INSERT INTO crm_identity_bindings'))).toBe(false)
  })

  it('returns a namespace collision without writing a competing binding', async () => {
    const client = {
      query: vi.fn(async (text: string) => {
        if (text.includes('pg_advisory_xact_lock')) return { rows: [] }
        if (text.includes('SELECT id FROM entities')) return { rows: [{ id: RIGHT }] }
        if (text.includes('FROM crm_identity_bindings')) return { rows: [bindingRow(LEFT)] }
        throw new Error(`unexpected SQL: ${text}`)
      }),
    }
    await expect(bindImportedCrmIdentity({
      workspaceId: WS,
      entityId: RIGHT,
      identity: STABLE,
      sensitivity: 'internal',
    }, client as never)).resolves.toEqual({ status: 'conflict', entityId: LEFT })
    expect(client.query.mock.calls.some(([text]) => String(text).includes('INSERT INTO crm_identity_bindings'))).toBe(false)
  })
})

describe('[COMP:crm/identity-bindings] separation decisions', () => {
  it('is idempotent and appends one event for repeated Keep separate', async () => {
    let active = false
    const queries: string[] = []
    const client = {
      query: vi.fn(async (text: string) => {
        queries.push(text)
        if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) return { rows: [] }
        if (text.includes('pg_advisory_xact_lock')) return { rows: [] }
        if (text.includes('display_name AS name')) return { rows: pairRows() }
        if (text.includes('SELECT s.*')) return { rows: active ? [separationRow()] : [] }
        if (text.includes('INSERT INTO crm_entity_separations')) {
          active = true
          return { rows: [separationRow()] }
        }
        if (text.includes('UPDATE crm_entity_separations')) return { rows: [] }
        throw new Error(`unexpected SQL: ${text}`)
      }),
      release: vi.fn(),
    }
    poolState.pool = { connect: vi.fn(async () => client) }

    const first = await keepCrmEntitiesSeparate({
      workspaceId: WS,
      leftEntityId: RIGHT,
      rightEntityId: LEFT,
      actorUserId: USER,
      reason: 'Different people',
    })
    const retry = await keepCrmEntitiesSeparate({
      workspaceId: WS,
      leftEntityId: LEFT,
      rightEntityId: RIGHT,
      actorUserId: USER,
      reason: 'Different people',
    })

    expect(first.inserted).toBe(true)
    expect(retry.inserted).toBe(false)
    expect(decisions.appendDecisionEvent).toHaveBeenCalledOnce()
    expect(decisions.appendDecisionEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventKind: 'crm.entities_kept_separate',
      payload: expect.objectContaining({ leftEntityId: LEFT, rightEntityId: RIGHT }),
    }), client)
    expect(queries.filter((text) => text === 'COMMIT')).toHaveLength(2)
  })

  it('rolls back both hard state and event when capture fails', async () => {
    const queries: string[] = []
    const client = {
      query: vi.fn(async (text: string) => {
        queries.push(text)
        if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) return { rows: [] }
        if (text.includes('pg_advisory_xact_lock')) return { rows: [] }
        if (text.includes('display_name AS name')) return { rows: pairRows() }
        if (text.includes('SELECT s.*')) return { rows: [] }
        if (text.includes('INSERT INTO crm_entity_separations')) return { rows: [separationRow()] }
        throw new Error(`unexpected SQL: ${text}`)
      }),
      release: vi.fn(),
    }
    poolState.pool = { connect: vi.fn(async () => client) }
    decisions.appendDecisionEvent.mockRejectedValue(new Error('journal unavailable'))

    await expect(keepCrmEntitiesSeparate({
      workspaceId: WS,
      leftEntityId: LEFT,
      rightEntityId: RIGHT,
      actorUserId: USER,
    })).rejects.toThrow('journal unavailable')
    expect(queries).toContain('ROLLBACK')
    expect(queries).not.toContain('COMMIT')
  })

  it('blocks a merge while an active separation is locked', async () => {
    const client = {
      query: vi.fn(async (text: string) => {
        if (text.includes('pg_advisory_xact_lock')) return { rows: [] }
        if (text.includes('display_name AS name')) return { rows: pairRows() }
        if (text.includes('SELECT id FROM crm_entity_separations')) return { rows: [{ id: 'sep-1' }] }
        throw new Error(`unexpected SQL: ${text}`)
      }),
    }
    await expect(prepareCrmMergeIdentityProjection(client as never, {
      workspaceId: WS,
      survivingEntityId: LEFT,
      mergedEntityId: RIGHT,
    })).rejects.toMatchObject({ code: 'conflict_requires_resolution' })
  })

  it('undo revokes merge bindings, removes the alias, and creates a separation', async () => {
    const queries: string[] = []
    const client = {
      query: vi.fn(async (text: string) => {
        queries.push(text)
        if (text.includes('pg_advisory_xact_lock')) return { rows: [] }
        if (text.includes('UPDATE crm_identity_bindings')) {
          return { rows: [{ id: 'binding-1', ...STABLE }] }
        }
        if (text.includes('FROM crm_identity_bindings')) return { rows: [] }
        if (text.includes('FROM decision_derivations')) return { rows: [{ id: 'alias-derivation' }] }
        if (text.includes('UPDATE entities')) return { rows: [] }
        if (text.includes('INSERT INTO crm_entity_separations')) return { rows: [{ id: 'separation-1' }] }
        throw new Error(`unexpected SQL: ${text}`)
      }),
    }

    const separationId = await applyCrmUndoIdentityProjection(client as never, {
      workspaceId: WS,
      survivingEntityId: LEFT,
      restoredEntityId: RIGHT,
      restoredDisplayName: 'Jordan Kim',
      restoredAttributes: {},
      actorUserId: USER,
      reason: 'Wrong person',
      originalDecisionEventId: 'decision-merge',
      undoDecisionEventId: 'decision-undo',
      sensitivity: 'internal',
    })

    expect(separationId).toBe('separation-1')
    expect(queries.some((text) => text.includes('array_remove(aliases'))).toBe(true)
    expect(queries.some((text) => text.includes('INSERT INTO crm_entity_separations'))).toBe(true)
    expect(decisions.appendDecisionDerivation).toHaveBeenCalledWith(expect.objectContaining({
      relation: 'invalidates',
      artifactKind: 'crm_identity_binding',
    }), client)
  })
})
