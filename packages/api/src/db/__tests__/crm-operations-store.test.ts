import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDbCrmOperationsStore } from '../crm-operations-store.js'

const canonical = vi.hoisted(() => ({ read: vi.fn(), update: vi.fn() }))
vi.mock('../crm.js', () => ({ readCrmMutationSource: canonical.read }))
vi.mock('../entities-store.js', () => ({ updateEntity: canonical.update }))

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
      // Lock order: the module share lock precedes the workspace lock.
      'SELECT 1 FROM workspace_modules WHERE workspace_id=$1 AND module_key=$2 FOR SHARE',
      'SELECT id FROM workspaces WHERE id=$1 AND department_read_v2 FOR UPDATE',
      'ROLLBACK',
    ])
    expect(query).not.toHaveBeenCalledWith('COMMIT')
    expect(release).toHaveBeenCalledOnce()
  })

  it('refuses generic lifecycle updates for commerce-managed participation in legacy workspaces', async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT department_read_v2')) return { rows: [{ v2: false }], rowCount: 1 }
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

  it('rejects invalid entitlement lifecycle reversal inside a legacy transaction', async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT department_read_v2')) return { rows: [{ v2: false }], rowCount: 1 }
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
  beforeEach(() => { canonical.read.mockReset(); canonical.update.mockReset() })
  function stageStore() {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('FROM workspace_members')) return { rows: [{ user_id: USER_ID }], rowCount: 1 }
      if (sql.includes('FROM crm_pipelines p')) return { rows: [{
        pipelineId: 'pipeline-custom', stageId: 'stage-review', stageName: 'Review',
        legacyStage: null, category: 'open', requiredFields: ['amount'],
      }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    const client = { query, release: vi.fn() }
    const store = createDbCrmOperationsStore({ connect: vi.fn().mockResolvedValue(client) } as never)
    const run = () => store.transaction(context, tx => tx.setDealPipelineStage({
      dealId: 'deal-1', pipelineId: 'pipeline-custom', stageId: 'stage-review',
      actorUserId: 'untrusted-attribution', actorAssistantId: null,
    }))
    return { query, client, run }
  }
  const source = { id: 'deal-1', displayName: 'Fixture deal', attributes: { amount: 1200 },
    userId: null, assistantId: null, sensitivity: 'internal', compartments: ['fixture'], projectIds: [],
    createdAt: new Date(), updatedAt: new Date() }

  it('uses canonical source and writer in the same transaction and keeps the CRM projection', async () => {
    const f = stageStore()
    canonical.read.mockResolvedValue(source)
    canonical.update.mockResolvedValue({ ...source, attributes: { ...source.attributes, stage: 'lead' } })
    const moved = await f.run()
    expect(moved).toMatchObject({ id: 'deal-1', name: 'Fixture deal', pipeline: { stageName: 'Review' } })
    expect(moved).not.toHaveProperty('compartments')
    expect(canonical.read).toHaveBeenCalledWith(expect.objectContaining({ userId: USER_ID, workspaceId: WORKSPACE_ID }), 'deal-1', ['deal'], f.client)
    expect(canonical.update).toHaveBeenCalledWith(USER_ID, 'deal-1', { attributes: {
      amount: 1200, pipeline_id: 'pipeline-custom', pipeline_stage_id: 'stage-review', stage: 'lead',
    } }, expect.objectContaining({ userId: USER_ID }), f.client)
    expect(f.query.mock.calls.find(call => call[0].includes('FROM crm_pipelines p'))?.[0]).toContain('FOR SHARE OF p,s')
    expect(f.query.mock.calls.find(call => call[0].includes('INSERT INTO crm_activities'))?.[1]).toEqual(expect.arrayContaining([USER_ID]))
    expect(f.query.mock.calls.at(-1)?.[0]).toBe('COMMIT')
  })

  it('requires source admission even for an exact replay and emits no duplicate activity', async () => {
    const f = stageStore()
    canonical.read.mockResolvedValue({ ...source, attributes: { ...source.attributes,
      pipeline_id: 'pipeline-custom', pipeline_stage_id: 'stage-review' } })
    expect(await f.run()).toMatchObject({ id: 'deal-1', unchanged: true })
    expect(canonical.read).toHaveBeenCalledOnce()
    expect(canonical.update).not.toHaveBeenCalled()
    expect(f.query.mock.calls.some(call => call[0].includes('INSERT INTO crm_activities'))).toBe(false)
  })

  it('does not read catalog values when the source is hidden', async () => {
    const f = stageStore()
    canonical.read.mockResolvedValue(null)
    expect(await f.run()).toBeNull()
    expect(f.query.mock.calls.some(call => call[0].includes('FROM crm_pipelines'))).toBe(false)
    expect(canonical.update).not.toHaveBeenCalled()
  })
})
