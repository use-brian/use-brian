import { describe, it, expect } from 'vitest'
import type { EntityRecord, AccessContext } from '@use-brian/core'
import { createProtectedCrmSource } from '../protected-fill-crm.js'
const scope = { userId: 'u', workspaceId: 'w', sessionId: 's', taskId: 't', browserProfileId: 'p', destinationOrigin: 'https://example.com' }
const entity = { id: 'entity', workspaceId: 'w', kind: 'person', displayName: 'SECRET_NAME', canonicalId: 'SECRET_EMAIL', attributes: { phone: 'SECRET_PHONE', company_id: 'company' } } as unknown as EntityRecord
const source = { kind: 'crm', entityId: 'entity', field: 'email' }
describe('protected CRM scalar adapter', () => {
  it('uses the permission-aware member viewpoint and follows company links through the same gate', async () => {
    const ctx = { userId: 'u', workspaceId: 'w' } as AccessContext
    const adapter = createProtectedCrmSource({ viewpoint: async (u, w) => { expect([u, w]).toEqual(['u', 'w']); return ctx }, entity: async (context, id) => {
      expect(context).toBe(ctx)
      return id === 'company' ? { ...entity, kind: 'company', displayName: 'SECRET_COMPANY' } : entity
    } })
    expect(await adapter.readSource(scope, source)).toBe('SECRET_EMAIL')
    expect(await adapter.readSource(scope, { ...source, field: 'company' })).toBe('SECRET_COMPANY')
    expect(await adapter.validateSource(scope, { ...source, field: 'phone' })).toBe(true)
  })
  it.each(['missingMembership', 'missingEntity', 'wrongWorkspace', 'archived', 'object', 'sourceError', 'unknownField', 'unknownKind', 'missingCompany'])('fails closed for %s without echoing values', async reason => {
    const adapter = createProtectedCrmSource({ viewpoint: async () => reason === 'missingMembership' ? null : {} as AccessContext,
      entity: async (_ctx, id) => {
        if (reason === 'sourceError') throw new Error('SECRET_SENTINEL')
        if (reason === 'missingEntity' || (reason === 'missingCompany' && id === 'company')) return null
        return { ...entity, workspaceId: reason === 'wrongWorkspace' ? 'other' : 'w',
          attributes: { ...entity.attributes, ...(reason === 'object' ? { email: { raw: 'SECRET_SENTINEL' } } : {}),
            ...(reason === 'archived' ? { crm_archived_at: 'date' } : {}) } }
      },
    })
    const input = { ...source, field: reason === 'unknownField' ? '__proto__' : reason === 'missingCompany' ? 'company' : 'email', kind: reason === 'unknownKind' ? 'file' : 'crm' }
    await expect(adapter.readSource(scope, input)).rejects.toThrow(/^Protected fill unavailable$/)
    expect(await adapter.validateSource(scope, input)).toBe(false)
  })
})
