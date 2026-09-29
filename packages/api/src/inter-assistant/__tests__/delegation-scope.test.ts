import { describe, expect, it, vi } from 'vitest'
import type { ChannelIntegrationStore } from '../../db/channel-integrations.js'
import { createDeliveryAudienceAuthorizer } from '../../context-scope/delivery-authority.js'

describe('[COMP:api/delivery-authority] delegated output audience', () => {
  it('keeps inherited Team evidence inside the exact approved group binding', async () => {
    const integrationStore = {
      getCredentialsForAssistantSystem: vi.fn(async () => ({
        config: {
          deliveryAudienceBindings: [{
            version: 1,
            channelId: 'C-FINANCE',
            audienceType: 'group',
            clearance: 'internal',
            compartments: ['finance'],
            projectIds: [],
            recipientUserId: null,
            expiresAt: null,
            approvedByUserId: 'admin-1',
            approvedAt: '2026-09-28T00:00:00.000Z',
          }],
        },
      })),
    } as unknown as ChannelIntegrationStore
    const authorize = createDeliveryAudienceAuthorizer({
      integrationStore,
      getWorkspaceRole: vi.fn(async () => 'admin' as const),
    })
    const base = {
      workspaceId: 'workspace-1',
      assistantId: 'callee-1',
      userId: 'actor-1',
      channelType: 'slack',
      channelId: 'C-FINANCE',
    }

    await expect(authorize({
      ...base,
      scopeEvidence: { sensitivity: 'internal', compartments: ['finance'], projectIds: [] },
    })).resolves.toMatchObject({ allowed: true })
    await expect(authorize({
      ...base,
      scopeEvidence: { sensitivity: 'internal', compartments: ['legal'], projectIds: [] },
    })).resolves.toEqual({ allowed: false, reason: 'delivery_audience_unverified', detail: 'evidence_exceeds_audience' })
  })
})
