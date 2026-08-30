import { describe, expect, it, vi } from 'vitest'
import { createDbCrmOperationsStore } from '../crm-operations-store.js'

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'
const context = {
  workspaceId: WORKSPACE_ID,
  actor: { kind: 'user' as const, userId: USER_ID },
  authority: { role: 'owner' as const, canWrite: true, canConfigure: true, trustedIdentitySources: [] },
}

function fakePool() {
  const query = vi.fn().mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT id FROM entities')) return { rows: [{ id: 'contact-1' }], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  })
  const release = vi.fn()
  const connect = vi.fn().mockResolvedValue({ query, release })
  return { pool: { connect } as never, query, release }
}

describe('[COMP:crm/operations-store] CRM operations PostgreSQL transaction store', () => {
  it('sets system bypass locally, workspace-qualifies reads, and commits once', async () => {
    const { pool, query, release } = fakePool()
    const store = createDbCrmOperationsStore(pool)
    const found = await store.transaction(context, (tx) => tx.findContactByEmail('Ari@Example.com'))

    expect(found).toBe('contact-1')
    expect(query.mock.calls[0]![0]).toBe('BEGIN')
    expect(query.mock.calls[1]![0]).toContain("set_config('app.system_bypass', 'true', true)")
    const scoped = query.mock.calls.find((call) => String(call[0]).includes('SELECT id FROM entities'))!
    expect(scoped[0]).toContain('workspace_id = $1')
    expect(scoped[1]).toEqual([WORKSPACE_ID, 'ari@example.com'])
    expect(query.mock.calls.at(-1)![0]).toBe('COMMIT')
    expect(release).toHaveBeenCalledOnce()
  })

  it('rolls back and never commits when any transaction step fails', async () => {
    const { pool, query, release } = fakePool()
    const store = createDbCrmOperationsStore(pool)
    await expect(store.transaction(context, async () => {
      throw new Error('atomic step failed')
    })).rejects.toThrow('atomic step failed')

    expect(query.mock.calls.map((call) => call[0])).toEqual([
      'BEGIN',
      expect.stringContaining("set_config('app.system_bypass', 'true', true)"),
      'ROLLBACK',
    ])
    expect(query).not.toHaveBeenCalledWith('COMMIT')
    expect(release).toHaveBeenCalledOnce()
  })

  it('refuses generic lifecycle updates for commerce-managed participation', async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT status, source_kind')) {
        return { rows: [{ status: 'confirmed', sourceKind: 'commerce' }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })
    const release = vi.fn()
    const pool = { connect: vi.fn().mockResolvedValue({ query, release }) } as never
    const store = createDbCrmOperationsStore(pool)

    await expect(store.transaction(context, (tx) => tx.updateParticipation(
      '33333333-3333-4333-8333-333333333333',
      'attended',
    ))).rejects.toMatchObject({ code: 'conflict', details: { commerceManaged: true } })
    expect(query.mock.calls.some((call) => String(call[0]).startsWith('UPDATE association_registrations'))).toBe(false)
    expect(query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('rejects invalid entitlement lifecycle reversal inside the transaction', async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT status, starts_at')) {
        return { rows: [{ status: 'cancelled', startsAt: new Date('2026-08-30T00:00:00Z') }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })
    const release = vi.fn()
    const pool = { connect: vi.fn().mockResolvedValue({ query, release }) } as never
    const store = createDbCrmOperationsStore(pool)

    await expect(store.transaction(context, (tx) => tx.updateEntitlement(
      '44444444-4444-4444-8444-444444444444',
      { status: 'active' },
    ))).rejects.toMatchObject({ code: 'conflict' })
    expect(query.mock.calls.some((call) => String(call[0]).startsWith('UPDATE association_memberships'))).toBe(false)
    expect(query).toHaveBeenCalledWith('ROLLBACK')
  })
})

describe('[COMP:crm/pipeline-tools] catalog-backed deal stages', () => {
  it('moves a deal to a non-default custom stage and derives its legacy category', async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('FROM crm_pipelines p') && sql.includes('p.id=$2')) {
        return { rows: [{
          pipelineId: 'pipeline-custom', pipelineName: 'Renewals', pipelineKey: 'pipeline-custom',
          stageId: 'stage-review', stageName: 'Review', stageKey: 'stage-review',
          legacyStage: null, category: 'open', probability: 45, requiredFields: ['amount'],
        }], rowCount: 1 }
      }
      if (sql.includes('FROM entities') && sql.includes('FOR UPDATE')) {
        return { rows: [{ attributes: { amount: 1200, pipeline_stage_id: 'old-stage' } }], rowCount: 1 }
      }
      if (sql.includes('UPDATE entities')) {
        return { rows: [{ id: 'deal-1', attributes: { stage: 'lead', pipeline_stage_id: 'stage-review' } }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    })
    const pool = { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) } as never
    const store = createDbCrmOperationsStore(pool)
    const moved = await store.transaction(context, (tx) => tx.setDealPipelineStage({
      dealId: 'deal-1', pipelineId: 'pipeline-custom', stageId: 'stage-review',
      actorUserId: USER_ID, actorAssistantId: null,
    }))
    expect(moved).toMatchObject({ id: 'deal-1', pipeline: { stageName: 'Review' } })
    const update = query.mock.calls.find((call) => String(call[0]).includes('UPDATE entities'))
    expect(update?.[1]).toEqual([
      WORKSPACE_ID, 'deal-1', 'pipeline-custom', 'stage-review', 'lead',
    ])
  })

  it('treats a repeated exact pipeline stage as a replay-safe no-op', async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('FROM crm_pipelines p') && sql.includes('p.id=$2')) {
        return { rows: [{
          pipelineId: 'pipeline-custom', pipelineName: 'Renewals', pipelineKey: 'pipeline-custom',
          stageId: 'stage-review', stageName: 'Review', stageKey: 'stage-review',
          legacyStage: null, category: 'open', probability: 45, requiredFields: [],
        }], rowCount: 1 }
      }
      if (sql.includes('FROM entities') && sql.includes('FOR UPDATE')) {
        return { rows: [{
          id: 'deal-1', attributes: {
            pipeline_id: 'pipeline-custom', pipeline_stage_id: 'stage-review',
          },
        }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    })
    const pool = { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) } as never
    const store = createDbCrmOperationsStore(pool)
    const moved = await store.transaction(context, (tx) => tx.setDealPipelineStage({
      dealId: 'deal-1', pipelineId: 'pipeline-custom', stageId: 'stage-review',
      actorUserId: USER_ID, actorAssistantId: null,
    }))
    expect(moved).toMatchObject({ id: 'deal-1', unchanged: true })
    expect(query.mock.calls.some((call) => String(call[0]).includes('UPDATE entities'))).toBe(false)
    expect(query.mock.calls.some((call) => String(call[0]).includes('INSERT INTO crm_activities'))).toBe(false)
  })
})
