import { describe, expect, it } from 'vitest'
import type { ExecutionContext } from '@use-brian/core'
import { bindExternalServiceReceiptIdentity, externalServiceReceiptIdentity } from './external-service-receipt-identity.js'

const identity = { serviceId: 'service-one', workspaceId: 'workspace-one', userId: 'user-one' }
function execution(credentialId = 'original-authorization'): ExecutionContext {
  return { identity: { kind: 'programmatic', principal: { kind: 'oauth_token', credentialId, actorUserId: identity.userId },
    credentialOwnerUserId: identity.userId }, security: { access: { workspaceId: identity.workspaceId, userId: identity.userId } } } as ExecutionContext
}

describe('[COMP:api/external-services] trusted canonical receipt identity', () => {
  it('keeps durable ownership across renewed grants without changing either credential', () => {
    const first = execution(), renewed = execution('renewed-authorization')
    bindExternalServiceReceiptIdentity(first, { ...identity, authorizationId: 'original-authorization' } as typeof identity)
    bindExternalServiceReceiptIdentity(renewed, { ...identity, authorizationId: 'renewed-authorization' } as typeof identity)
    expect(externalServiceReceiptIdentity(first, 'native')).toEqual({ kind: 'external_service', ...identity })
    expect(externalServiceReceiptIdentity(renewed, 'native')).toEqual(externalServiceReceiptIdentity(first, 'native'))
    expect(first.identity).toMatchObject({ principal: { credentialId: 'original-authorization' } })
    expect(renewed.identity).toMatchObject({ principal: { credentialId: 'renewed-authorization' } })
  })

  it('isolates service, user and workspace and cannot survive copying or alter another module', () => {
    const original = bindExternalServiceReceiptIdentity(execution(), identity)
    const other = bindExternalServiceReceiptIdentity(execution(), { ...identity, serviceId: 'service-two' })
    expect(externalServiceReceiptIdentity(other, 'native')).not.toEqual(externalServiceReceiptIdentity(original, 'native'))
    expect(externalServiceReceiptIdentity({ ...original }, 'native')).toBeUndefined()
    expect(externalServiceReceiptIdentity(original, 'erp')).toBeUndefined()
    expect(() => bindExternalServiceReceiptIdentity(execution(), { ...identity, userId: 'other-user' })).toThrow()
    expect(() => bindExternalServiceReceiptIdentity(execution(), { ...identity, workspaceId: 'other-workspace' })).toThrow()
    expect(() => bindExternalServiceReceiptIdentity(original, identity)).toThrow()
    const attended = { ...execution(), identity: { kind: 'attended', principal: { kind: 'workspace_member', userId: identity.userId } } } as ExecutionContext
    expect(() => bindExternalServiceReceiptIdentity(attended, identity)).toThrow()
  })
})
