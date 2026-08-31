import { beforeEach, describe, expect, it, vi } from 'vitest'

const { query, verifySecret } = vi.hoisted(() => ({
  query: vi.fn(),
  verifySecret: vi.fn(),
}))
vi.mock('../client.js', () => ({ query }))
vi.mock('../api-key-store.js', () => ({ verifySecret }))

import { createDbCrmIntakeReadStore, parseCrmIntakeToken } from '../crm-intake-store.js'

const CREDENTIAL_ID = '11111111-1111-4111-8111-111111111111'
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222'
const DEFINITION_ID = '33333333-3333-4333-8333-333333333333'

describe('[COMP:api/crm-intake-route] CRM intake credential authentication', () => {
  beforeEach(() => vi.clearAllMocks())

  it('parses only the separate sk_intake credential family', () => {
    expect(parseCrmIntakeToken(`sk_intake_${CREDENTIAL_ID}_secret_part`)).toEqual({
      credentialId: CREDENTIAL_ID,
      secret: 'secret_part',
    })
    expect(parseCrmIntakeToken(`sk_brain_${CREDENTIAL_ID}_secret`)).toBeNull()
    expect(parseCrmIntakeToken('sk_intake_bad_secret')).toBeNull()
  })

  it('authenticates only an active definition binding and touches that workspace row', async () => {
    query
      .mockResolvedValueOnce({ rows: [{
        credentialId: CREDENTIAL_ID,
        workspaceId: WORKSPACE_ID,
        secretHash: 'scrypt$encoded',
        revokedAt: null,
        definitionId: DEFINITION_ID,
        definitionKey: 'contact_form',
      }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    verifySecret.mockResolvedValue(true)
    const principal = await createDbCrmIntakeReadStore().authenticate(
      `sk_intake_${CREDENTIAL_ID}_secret`,
      'contact_form',
    )
    expect(principal).toEqual({
      workspaceId: WORKSPACE_ID,
      credentialId: CREDENTIAL_ID,
      definitionId: DEFINITION_ID,
      definitionKey: 'contact_form',
    })
    expect(query.mock.calls[0]![0]).toContain('d.definition_key = $2 AND d.active')
    expect(query.mock.calls[1]).toEqual([
      expect.stringContaining('WHERE workspace_id = $1 AND id = $2'),
      [WORKSPACE_ID, CREDENTIAL_ID],
    ])
  })

  it('returns one uniform null for a revoked or mismatched secret', async () => {
    query.mockResolvedValue({ rows: [{
      credentialId: CREDENTIAL_ID,
      workspaceId: WORKSPACE_ID,
      secretHash: 'scrypt$encoded',
      revokedAt: new Date(),
      definitionId: DEFINITION_ID,
      definitionKey: 'contact_form',
    }] })
    expect(await createDbCrmIntakeReadStore().authenticate(
      `sk_intake_${CREDENTIAL_ID}_secret`, 'contact_form',
    )).toBeNull()
    expect(verifySecret).not.toHaveBeenCalled()
  })
})

describe('[COMP:crm/operations-store] CRM operations read model', () => {
  beforeEach(() => vi.clearAllMocks())

  it('workspace-qualifies bounded submission queue reads', async () => {
    query.mockResolvedValue({ rows: [{ id: 'submission-1' }] })
    const rows = await createDbCrmIntakeReadStore().listSubmissions(WORKSPACE_ID, {
      status: 'new', definitionKey: 'contact_form', limit: 25,
    })
    expect(rows).toEqual([{ id: 'submission-1' }])
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE e.workspace_id=$1'),
      [WORKSPACE_ID, 'new', 'contact_form', null, 25],
    )
  })

  it('derives a fail-closed sendability verdict from catalog and evidence rows', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'purpose-1', archivedAt: null, requiresConsent: true }] })
      .mockResolvedValueOnce({ rows: [{ email: 'person@example.com', phone: null, providerIdentity: false }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        id: 'suppression-1', channel: 'email', action: 'suppressed',
        occurredAt: new Date('2026-08-30T00:00:00Z'), createdAt: new Date('2026-08-30T00:00:00Z'),
      }] })
    const verdict = await createDbCrmIntakeReadStore().checkSendability(
      WORKSPACE_ID, DEFINITION_ID, 'email', 'marketing',
    )
    expect(verdict).toEqual({
      verdict: 'blocked',
      reasons: ['channel_suppression', 'consent_not_recorded'],
      effectiveSuppressionEventIds: ['suppression-1'],
    })
    expect(query.mock.calls.every((call) => call[1]?.[0] === WORKSPACE_ID)).toBe(true)
  })

  it('maps commerce registrations to canonical participation without hiding their management boundary', async () => {
    query.mockResolvedValue({ rows: [{
      id: 'participation-1', status: 'registered', sourceStatus: 'confirmed',
      sourceKind: 'commerce', commerceManaged: true,
    }] })
    const rows = await createDbCrmIntakeReadStore().listParticipation(WORKSPACE_ID, {
      eventId: DEFINITION_ID, status: 'registered', sourceKind: 'commerce', limit: 25,
    })
    expect(rows[0]).toMatchObject({
      status: 'registered', sourceStatus: 'confirmed', commerceManaged: true,
    })
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("WHEN 'confirmed' THEN 'registered'"),
      [WORKSPACE_ID, null, DEFINITION_ID, 'commerce', 'registered', 25],
    )
  })

  it('enumerates live custom pipeline stages with stable catalog ids', async () => {
    query.mockResolvedValue({ rows: [{
      id: 'pipeline-1', name: 'Renewals', stages: [{ id: 'stage-1', name: 'Review' }],
    }] })
    const rows = await createDbCrmIntakeReadStore().listPipelines(WORKSPACE_ID, {
      entityKind: 'deal', includeArchived: false,
    })
    expect(rows).toEqual([{
      id: 'pipeline-1', name: 'Renewals', stages: [{ id: 'stage-1', name: 'Review' }],
    }])
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM crm_pipelines p'),
      [WORKSPACE_ID, false],
    )
  })
})
