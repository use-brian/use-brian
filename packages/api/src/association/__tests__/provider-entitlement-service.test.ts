import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Pool, PoolClient } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import {
  ProviderEntitlementEventSchema,
  type AssociationActor,
  type ProviderInboxEnvelope,
} from '@use-brian/core'
import { createAssociationStore } from '../../db/association-store.js'
import type { ProviderInboxHandlers, ProviderInboxResult } from '../provider-inbox.js'
import {
  createProviderEntitlementService,
  type ProviderEntitlementServicePort,
} from '../provider-entitlement-service.js'

const workspaceId = '10000000-0000-4000-8000-000000000001'
const contactId = '10000000-0000-4000-8000-000000000002'
const planId = '10000000-0000-4000-8000-000000000003'
const entitlementId = '10000000-0000-4000-8000-000000000004'
const event = ProviderEntitlementEventSchema.parse({
  provider: 'fixture',
  eventId: 'fixture-event',
  providerReference: 'fixture-subscription',
  providerPeriodId: 'fixture-period',
  occurredAt: '2026-09-01T12:00:00Z',
  command: {
    kind: 'grant_entitlement',
    contactId,
    planId,
    idempotencyKey: 'fixture-idempotency',
    provider: 'fixture',
    providerEntitlementId: 'fixture-subscription',
    providerPeriodId: 'fixture-period',
    status: 'active',
    startsAt: '2026-09-01T00:00:00Z',
    endsAt: '2027-09-01T00:00:00Z',
    renewalMode: 'auto',
  },
})
const actor: AssociationActor = { credentialKind: 'api_key', credentialId: 'fixture-key' }

describe('[COMP:crm/provider-entitlement-service] transaction-bound provider commands', () => {
  it('runs the unchanged CRM command on the provider inbox application client', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('workspace_modules')) return { rows: [{
        workspaceId,
        moduleKey: 'association',
        state: 'enabled',
        version: 1,
        enabledAt: null,
        disableRequestedAt: null,
        disabledAt: null,
        updatedAt: null,
        updatedByUserId: null,
      }], rowCount: 1 }
      if (sql.includes('SELECT department_read_v2 AS v2')) return { rows: [{ v2: false }], rowCount: 1 }
      if (sql.includes('read_scope_source')) return { rows: [{ snapshot: {
        workspaceId, resourceKind: 'entity', resourceId: contactId, version: '1',
        userId: null, assistantId: null, projectIds: [], compartments: [], sensitivity: 'internal',
        held: false, validTo: null, retractedAt: null,
      } }], rowCount: 1 }
      if (sql.includes('FROM entities c')) return { rows: [{}], rowCount: 1 }
      if (sql.includes("target_kind='entitlement'")) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM association_memberships WHERE workspace_id=$1 AND id=$2')) {
        return { rows: [{ id: entitlementId, contactId, planId, status: 'active', provider: 'fixture' }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })
    const client = { query } as unknown as PoolClient
    const execute = vi.fn(async () => ({
      command: 'grant_entitlement' as const,
      record: { id: entitlementId },
      created: true,
      duplicate: false,
      emittedEventIds: ['fixture-domain-event'],
    }))
    const operationsForTransaction = vi.fn((received: PoolClient) => {
      expect(received).toBe(client)
      return { execute }
    })
    const receive = vi.fn(async (
      _pool: Pool,
      envelope: ProviderInboxEnvelope,
      receivedActor: AssociationActor,
      _receivedWorkspace: string,
      handlers: ProviderInboxHandlers,
    ): Promise<ProviderInboxResult> => {
      const target = await handlers.authorize(client, envelope, receivedActor)
      expect(target).toEqual({ contactId, planId, entitlementId: null })
      const applied = await handlers.apply(client, envelope, receivedActor)
      return { ...applied, receipt: { id: 'fixture-receipt', state: 'applied' } }
    })
    const service = createProviderEntitlementService({
      pool: {} as Pool,
      operationsForTransaction,
      receive: receive as never,
    })

    const result = await service.submit(workspaceId, event, actor)

    expect(result).toMatchObject({ created: true, record: { id: entitlementId }, receipt: { state: 'applied' } })
    expect(operationsForTransaction).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId,
      actor: { kind: 'brain_key', credentialId: actor.credentialId },
    }), event.command)
  })

  it('keeps the Association store as a thin provider-service adapter', async () => {
    const expected = { record: { id: entitlementId }, created: true, receipt: { id: 'fixture-receipt' } }
    const providerEntitlements: ProviderEntitlementServicePort = {
      submit: vi.fn(async () => expected),
      retry: vi.fn(async () => expected),
    }
    const store = createAssociationStore({} as Pool, undefined, { providerEntitlements })

    await expect(store.reconcileProviderEntitlement(workspaceId, event, actor)).resolves.toBe(expected)
    expect(providerEntitlements.submit).toHaveBeenCalledWith(workspaceId, event, actor)
  })

  it('removes the Association/CRM value-import cycle instead of relocating it', () => {
    const source = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
    const associationStore = source('../../db/association-store.ts')
    const crmStore = source('../../db/crm-operations-store.ts')
    const providerService = source('../provider-entitlement-service.ts')
    expect(associationStore).not.toMatch(/from ['"].*(provider-entitlements|crm-operations-store|crm-operations\/service)/)
    expect(crmStore).not.toMatch(/from ['"].*association-store/)
    expect(providerService).not.toMatch(/from ['"].*(crm-operations-store|crm-operations\/service|association-store)/)
  })
})
