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
