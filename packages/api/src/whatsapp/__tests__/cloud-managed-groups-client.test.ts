import { afterEach, describe, expect, it, vi } from 'vitest'
import { WhatsAppCloudApiError } from '@use-brian/channels'
import {
  createWhatsAppCloudManagedGroupsApi,
  isWhatsAppCloudNotFoundError,
  parseWhatsAppCloudManagedGroupLifecycleEvents,
} from '../cloud-managed-groups-client.js'

afterEach(() => vi.unstubAllGlobals())

describe('[COMP:api/whatsapp-cloud-managed-groups-client]', () => {
  it('flattens phone-scoped lifecycle batches and preserves errors', () => {
    expect(parseWhatsAppCloudManagedGroupLifecycleEvents({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{
        field: 'group_lifecycle_update',
        value: {
          metadata: { phone_number_id: 'phone-1' },
          groups: [
            { type: 'group_create', request_id: 'request-1', group_id: 'group-1', invite_link: 'invite-1' },
          ],
        },
      }, {
        field: 'group_lifecycle_update',
        value: {
          metadata: { phone_number_id: 'phone-1' },
          type: 'group_create', request_id: 'request-2', errors: [{ message: 'rejected' }],
        },
      }] }],
    })).toEqual([
      {
        requestId: 'request-1', phoneNumberId: 'phone-1', event: 'group_create',
        groupId: 'group-1', inviteLink: 'invite-1', error: null,
      },
      {
        requestId: 'request-2', phoneNumberId: 'phone-1', event: 'group_create',
        groupId: null, inviteLink: null, error: '[{"message":"rejected"}]',
      },
    ])
  })

  it('normalizes the current raw request ID into the route contract', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ request_id: 'request-1' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )))
    const api = createWhatsAppCloudManagedGroupsApi({ accessToken: 'token', phoneNumberId: 'phone-1' })

    await expect(api.createGroup('Support')).resolves.toEqual({ requestId: 'request-1' })
  })

  it('recognizes only typed Meta 404 errors as already deleted', () => {
    expect(isWhatsAppCloudNotFoundError(new WhatsAppCloudApiError(404, 'gone'))).toBe(true)
    expect(isWhatsAppCloudNotFoundError(new WhatsAppCloudApiError(500, 'down'))).toBe(false)
    expect(isWhatsAppCloudNotFoundError(Object.assign(new Error('gone'), { status: 404 }))).toBe(false)
  })
})
