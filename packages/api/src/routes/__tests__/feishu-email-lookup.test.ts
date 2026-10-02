import { describe, it, expect, vi } from 'vitest'
import { feishuMissingScopes, reportFeishuEmailLookup } from '../feishu.js'

describe('[COMP:api/feishu-email-lookup] Feishu email matching status', () => {
  it('extracts the scopes Feishu names in an access-denied message', () => {
    expect(feishuMissingScopes(
      'Access denied. One of the following scopes is required: [contact:contact.base:readonly, contact:contact:access_as_app, contact:contact:readonly]. more text',
    )).toEqual(['contact:contact.base:readonly', 'contact:contact:access_as_app', 'contact:contact:readonly'])
    expect(feishuMissingScopes('rate limited')).toEqual([])
  })

  it('records an analytics row only when the status for an integration changes', () => {
    const logEvent = vi.fn()
    const report = { integrationId: 'integration-a', userId: 'owner', assistantId: 'assistant', analytics: { logEvent } as never }
    const denied = { status: 'unavailable' as const, reason: 'lookup_denied' as const, providerCode: '99991672', missingScopes: ['contact:contact.base:readonly'] }

    reportFeishuEmailLookup(report, denied)
    reportFeishuEmailLookup(report, denied)
    expect(logEvent).toHaveBeenCalledTimes(1)
    expect(logEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      eventName: 'channel_email_lookup_unavailable',
      channelType: 'feishu',
      metadata: expect.objectContaining({ integration_id: 'integration-a', provider_code: '99991672', missing_scopes: 'contact:contact.base:readonly' }),
    }))

    reportFeishuEmailLookup(report, { status: 'ok' })
    reportFeishuEmailLookup(report, { status: 'ok' })
    expect(logEvent).toHaveBeenCalledTimes(2)
    expect(logEvent).toHaveBeenLastCalledWith(expect.objectContaining({ eventName: 'channel_email_lookup_ok' }))
  })

  it('does nothing without an analytics sink', () => {
    expect(() => reportFeishuEmailLookup(undefined, { status: 'ok' })).not.toThrow()
  })
})
