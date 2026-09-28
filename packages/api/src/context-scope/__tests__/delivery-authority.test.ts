import { describe, expect, it, vi } from 'vitest'
import type { AccessCeiling } from '@use-brian/core'
import type { ChannelIntegrationStore } from '../../db/channel-integrations.js'
import type { Session } from '../../db/sessions.js'
import { createDeliveryAudienceAuthorizer } from '../delivery-authority.js'

const WS = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const ASSISTANT = '33333333-3333-4333-8333-333333333333'
const APPROVER = '44444444-4444-4444-8444-444444444444'
const PROJECT = '55555555-5555-4555-8555-555555555555'

function ceiling(overrides: Partial<AccessCeiling> = {}): AccessCeiling {
  return {
    workspaceId: WS,
    userId: USER,
    clearance: 'confidential',
    compartments: ['finance'],
    mutationCompartments: ['finance'],
    projectIds: [PROJECT],
    visibilityAssistantIds: null,
    ...overrides,
  }
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: '66666666-6666-4666-8666-666666666666',
    assistantId: ASSISTANT,
    userId: USER,
    channelType: 'web',
    channelId: 'room',
    appId: 'Use Brian',
    appOrigin: 'chat',
    status: 'idle',
    compactSummary: null,
    compactionCount: 0,
    compactBoundarySequence: null,
    title: null,
    downgradeNoticeSent: false,
    downgradeNoticePinMessageId: null,
    mode: null,
    visibility: 'owner',
    effectiveClearance: null,
    contextGroupId: null,
    contextProjectId: null,
    contextCompartments: [],
    contextLockedAt: null,
    createdAt: new Date(),
    lastActiveAt: new Date(),
    ...overrides,
  }
}

function authorizer(options: {
  integration?: Record<string, unknown> | null
  exactSession?: Session | null
  originSession?: Session | null
  approverRole?: 'owner' | 'admin' | 'member' | null
  live?: AccessCeiling
} = {}) {
  const integrationStore = {
    getCredentialsForAssistantSystem: vi.fn(async () => options.integration ?? null),
    getCredentialsForAssistantIntegrationSystem: vi.fn(async () => options.integration ?? null),
  } as unknown as ChannelIntegrationStore
  return createDeliveryAudienceAuthorizer({
    integrationStore,
    findAssistant: vi.fn(async () => ({ id: ASSISTANT, workspaceId: WS })) as never,
    findSession: vi.fn(async () => options.originSession ?? null),
    findChannelSession: vi.fn(async () => options.exactSession ?? null),
    getWorkspaceRole: vi.fn(async () => options.approverRole ?? null),
    resolveLiveAccess: vi.fn(async () => options.live ?? ceiling()),
  })
}

describe('[COMP:api/delivery-authority] destination-bound output policy', () => {
  it('allows only public unscoped output to an unbound external audience', async () => {
    const authorize = authorizer()
    await expect(authorize({
      workspaceId: WS,
      assistantId: ASSISTANT,
      userId: USER,
      channelType: 'slack',
      channelId: 'C-FICTIONAL',
      scopeEvidence: { sensitivity: 'public', compartments: [], projectIds: [] },
    })).resolves.toMatchObject({ allowed: true })
    await expect(authorize({
      workspaceId: WS,
      assistantId: ASSISTANT,
      userId: USER,
      channelType: 'slack',
      channelId: 'C-FICTIONAL',
      scopeEvidence: { sensitivity: 'internal', compartments: [], projectIds: [] },
    })).resolves.toEqual({ allowed: false, reason: 'delivery_audience_unverified' })
  })

  it('rechecks an exact owner-approved binding and its current approver role', async () => {
    const integration = {
      config: {
        deliveryAudienceBindings: [{
          version: 1,
          channelId: '-100123',
          audienceType: 'group',
          clearance: 'confidential',
          compartments: ['finance'],
          projectIds: [PROJECT],
          recipientUserId: null,
          expiresAt: null,
          approvedByUserId: APPROVER,
          approvedAt: '2026-09-28T00:00:00.000Z',
        }],
      },
    }
    const input = {
      workspaceId: WS,
      assistantId: ASSISTANT,
      userId: USER,
      channelType: 'telegram',
      channelId: '-100123:topic:42',
      scopeEvidence: { sensitivity: 'confidential' as const, compartments: ['finance'], projectIds: [PROJECT] },
    }
    await expect(authorizer({ integration, approverRole: 'owner' })(input))
      .resolves.toMatchObject({ allowed: true })
    await expect(authorizer({ integration, approverRole: 'member' })(input))
      .resolves.toEqual({ allowed: false, reason: 'delivery_audience_unverified' })
  })

  it('intersects a private binding with the recipient current membership', async () => {
    const integration = {
      config: {
        deliveryAudienceBindings: [{
          version: 1,
          channelId: 'D-FICTIONAL',
          audienceType: 'individual',
          clearance: 'confidential',
          compartments: ['finance'],
          projectIds: [PROJECT],
          recipientUserId: USER,
          expiresAt: null,
          approvedByUserId: APPROVER,
          approvedAt: '2026-09-28T00:00:00.000Z',
        }],
      },
    }
    const authorize = authorizer({
      integration,
      approverRole: 'admin',
      live: ceiling({ compartments: [], mutationCompartments: [] }),
    })
    await expect(authorize({
      workspaceId: WS,
      assistantId: ASSISTANT,
      userId: USER,
      channelType: 'slack',
      channelId: 'D-FICTIONAL',
      scopeEvidence: { sensitivity: 'internal', compartments: ['finance'], projectIds: [] },
    })).resolves.toEqual({ allowed: false, reason: 'delivery_audience_unverified' })
  })

  it('refuses an expired binding even when its former approver is still admin', async () => {
    const authorize = createDeliveryAudienceAuthorizer({
      now: () => Date.parse('2026-09-28T12:00:00.000Z'),
      integrationStore: {
        getCredentialsForAssistantSystem: vi.fn(async () => ({
          config: { deliveryAudienceBindings: [{
            version: 1,
            channelId: 'C-FICTIONAL',
            audienceType: 'group',
            clearance: 'confidential',
            compartments: ['finance'],
            projectIds: [],
            recipientUserId: null,
            expiresAt: '2026-09-28T11:59:59.000Z',
            approvedByUserId: APPROVER,
            approvedAt: '2026-09-27T00:00:00.000Z',
          }] },
        })),
      } as unknown as ChannelIntegrationStore,
      getWorkspaceRole: vi.fn(async () => 'admin' as const),
    })
    await expect(authorize({
      workspaceId: WS,
      assistantId: ASSISTANT,
      userId: USER,
      channelType: 'slack',
      channelId: 'C-FICTIONAL',
      scopeEvidence: { sensitivity: 'internal', compartments: ['finance'] },
    })).resolves.toEqual({ allowed: false, reason: 'delivery_audience_unverified' })
  })

  it('uses the immutable room Team/Project envelope for an origin session', async () => {
    const authorize = authorizer({
      originSession: session({
        visibility: 'workspace',
        effectiveClearance: 'internal',
        contextCompartments: ['finance'],
        contextProjectId: PROJECT,
      }),
    })
    await expect(authorize({
      workspaceId: WS,
      assistantId: ASSISTANT,
      userId: USER,
      channelType: 'web',
      channelId: 'default',
      sessionId: '66666666-6666-4666-8666-666666666666',
      scopeEvidence: { sensitivity: 'internal', compartments: ['finance'], projectIds: [PROJECT] },
    })).resolves.toMatchObject({ allowed: true })
    await expect(authorize({
      workspaceId: WS,
      assistantId: ASSISTANT,
      userId: USER,
      channelType: 'web',
      channelId: 'default',
      sessionId: '66666666-6666-4666-8666-666666666666',
      scopeEvidence: { sensitivity: 'internal', compartments: ['legal'], projectIds: [PROJECT] },
    })).resolves.toEqual({ allowed: false, reason: 'delivery_audience_unverified' })
  })
})
