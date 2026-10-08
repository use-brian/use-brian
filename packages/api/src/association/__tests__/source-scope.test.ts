import { describe, it, expect, vi } from 'vitest'
import type { PoolClient } from 'pg'
import { assertAssociationOrderAuthority, assertAssociationSourceAuthority, loadAssociationOrderScope } from '../source-scope.js'

const source = (id: string, patch = {}) => ({ resourceKind: 'entity', resourceId: id, version: '1', workspaceId: 'workspace',
  userId: null, assistantId: null, sensitivity: 'public', compartments: [], projectIds: [], held: false, validTo: null, retractedAt: null, ...patch })
const client = (sources: unknown[]) => ({ query: vi.fn(async () => ({ rows: sources.map(snapshot => ({ snapshot })) })) }) as unknown as Pick<PoolClient, 'query'>

describe('[COMP:crm/association-source-scope] order inheritance', () => {
  it.each(['order', 'registration', 'membership', 'rescue', 'allocation', 'invitation', 'checkout', 'submission',
    'consent', 'suppression', 'provider_receipt', 'notification', 'promotion_usage'] as const)(
    'provides identical safe recovery for missing and historical %s without disclosing existence', async kind => {
      async function refusal(historical: boolean) {
        const query = vi.fn(async (sql: string) => ({ rows: sql.includes('department_read_v2') ? [{ v2: true }]
          : historical ? [{ scope: null, sources: null, orderId: null, membershipId: null }] : [] }))
        const error = await assertAssociationOrderAuthority({ query } as unknown as PoolClient, 'workspace', 'withheld-record',
          { credentialKind: 'user', credentialId: 'viewer' }, kind).catch(error => error)
        expect(error).toMatchObject({ code: 'not_authorized', details: { recovery: {
          mutationRetry: 'never_automatic', preserveRequestIdentity: true,
          freshStart: 'only_after_operator_verifies_no_duplicate_effect',
        } } })
        expect(query.mock.calls.every(([sql]) => sql.trimStart().startsWith('SELECT'))).toBe(true)
        expect(JSON.stringify(error.details)).not.toContain('withheld-record')
        return { message: error.message, details: error.details }
      }
      expect(await refusal(true)).toEqual(await refusal(false))
    })
  it('uses the same recovery category for unavailable actor authority, without suggesting historical evidence exists', async () => {
    const query = vi.fn(async () => ({ rows: [{ v2: true }] }))
    await expect(assertAssociationSourceAuthority({ query } as unknown as PoolClient, 'workspace',
      { credentialKind: 'assistant', credentialId: 'unbound-assistant' }, { scope: {
        workspaceId: 'workspace', userId: null, assistantId: null, sensitivity: 'internal', compartments: [], projectIds: [],
      }, sources: [] })).rejects.toMatchObject({ code: 'not_authorized', details: { recovery: {
        kind: 'operational_access_review', historicalEvidence: 'original_trustworthy_evidence_required',
      } } })
    expect(query).toHaveBeenCalledTimes(1)
  })
  it('unions buyer and attendee departments, preserves private visibility and raises the operation floor', async () => {
    const db = client([source('buyer', { compartments: ['team:a'], userId: 'owner' }),
      source('guest', { sensitivity: 'confidential', compartments: ['team:b'], projectIds: ['project'] })])
    const result = await loadAssociationOrderScope(db, 'workspace', ['guest', 'buyer', 'guest'])
    expect(result.scope).toEqual({ workspaceId: 'workspace', userId: 'owner', assistantId: null,
      sensitivity: 'confidential', compartments: ['team:a', 'team:b'], projectIds: ['project'] })
    expect(result.sources.map(s => s.resourceId)).toEqual(['buyer', 'guest'])
    expect(db.query).toHaveBeenCalledWith(expect.any(String), ['workspace', ['buyer', 'guest']])
    expect((await loadAssociationOrderScope(client([source('buyer')]), 'workspace', ['buyer'])).scope.sensitivity).toBe('internal')
  })
  it.each([null, source('buyer', { held: true }), source('buyer', { validTo: 'retired' }),
    source('buyer', { retractedAt: 'removed' }), source('buyer', { workspaceId: 'foreign' }), source('wrong-id')])(
    'refuses unavailable canonical source %j', async invalid => {
      await expect(loadAssociationOrderScope(client([invalid]), 'workspace', ['buyer'])).rejects.toMatchObject({ code: 'scope_source_changed' })
    })
  it('refuses incompatible private sources and missing evidence', async () => {
    await expect(loadAssociationOrderScope(client([source('buyer', { userId: 'one' }), source('guest', { userId: 'two' })]), 'workspace', ['buyer', 'guest']))
      .rejects.toMatchObject({ code: 'scope_visibility_incompatible' })
    await expect(loadAssociationOrderScope(client([]), 'workspace', ['buyer'])).rejects.toMatchObject({ code: 'scope_evidence_missing' })
    await expect(loadAssociationOrderScope(client([]), 'workspace', [])).rejects.toMatchObject({ code: 'scope_evidence_missing' })
  })
})
