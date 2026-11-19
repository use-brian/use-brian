import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { CrmIntegrationAuthority } from '@use-brian/core/crm/integration-authority.js'
import type { CrmOperationsContext } from '@use-brian/core/crm/operations-types.js'
import { importGrantSnapshot, requireImportCeiling, requireImportRowAuthority } from '../import-authority.js'

const credentialId = randomUUID(), eventId = randomUUID(), otherEvent = randomUUID()
const authority: CrmIntegrationAuthority = { credentialId, grants: [
  { operation: 'crm.imports.write', selectors: { eventIds: [eventId] } },
  { operation: 'crm.participation.write', selectors: { eventIds: [eventId] } },
  { operation: 'crm.catalog.configure', selectors: { eventIds: 'all' } },
] }
const context: CrmOperationsContext = { workspaceId: randomUUID(), actor: { kind: 'integration_key', credentialId },
  authority: { role: 'system', canWrite: true, canConfigure: true, trustedIdentitySources: [], integration: authority } }

describe('[COMP:crm/production-import] Integration import authority', () => {
  it('stores only import/domain-write authority and permits equal-ceiling rotation', () => {
    const snapshot = importGrantSnapshot(authority)
    expect(snapshot).toHaveLength(2)
    expect(requireImportCeiling({ ...authority, credentialId: randomUUID() }, snapshot)).toEqual(snapshot)
    expect(() => requireImportCeiling({ credentialId, grants: [{ operation: 'crm.imports.write', selectors: { eventIds: [eventId] } }] }, snapshot)).toThrow()
  })
  it('allows read-only inspection with corresponding resource read grants', () => {
    const snapshot = importGrantSnapshot(authority)
    const reader: CrmIntegrationAuthority = { credentialId, grants: [
      { operation: 'crm.imports.read', selectors: { eventIds: [eventId] } },
      { operation: 'crm.participation.read', selectors: { eventIds: [eventId] } },
    ] }
    expect(requireImportCeiling(reader, snapshot, 'read')).toEqual(snapshot)
    expect(() => requireImportCeiling(reader, snapshot, 'write')).toThrow()
    expect(() => requireImportCeiling(reader, [{ operation: 'crm.imports.write', selectors: { eventIds: 'all' } }], 'read')).toThrow()
  })
  it('checks both import and domain ceilings before row effects and never treats configuration as identity trust', () => {
    expect(() => requireImportRowAuthority(context, 'operations', { participationEventId: eventId })).not.toThrow()
    expect(() => requireImportRowAuthority(context, 'operations', { participationEventId: otherEvent })).toThrow()
    expect(() => requireImportRowAuthority(context, 'contact', { name: 'Fixture' })).toThrow()
    expect(() => requireImportRowAuthority(context, 'operations', { participationEventId: eventId }, 'fixture')).toThrow()
    expect(() => requireImportRowAuthority({ ...context, actor: { kind: 'integration_key', credentialId: randomUUID() } }, 'operations', {})).toThrow()
  })
  it('admits promotions only from a current owner or admin member file', () => {
    const memberContext: CrmOperationsContext = {
      workspaceId: context.workspaceId,
      actor: { kind: 'user', userId: credentialId },
      authority: { role: 'owner', canWrite: true, canConfigure: true, trustedIdentitySources: [] },
    }
    expect(() => requireImportRowAuthority(memberContext, 'operations', { promotionSource: 'wix' })).not.toThrow()
    expect(() => requireImportRowAuthority({
      ...memberContext,
      authority: { ...memberContext.authority, role: 'member', canConfigure: false },
    }, 'operations', { promotionSource: 'wix' })).toThrow('owner or admin')
    expect(() => requireImportRowAuthority(context, 'operations', { promotionSource: 'wix' })).toThrow('member file')
  })
})
