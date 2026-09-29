import { describe, expect, it, vi } from 'vitest'
import type { AccessCeiling } from '@use-brian/core'
import type { ChannelIntegrationStore } from '../../db/channel-integrations.js'
import type { Session } from '../../db/sessions.js'
import {
  createDeliveryAudienceAuthorizer,
  createDeliveryAudienceEnvelopeResolver,
} from '../delivery-authority.js'

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
  it('resolves an unbound group to a public General execution ceiling', async () => {
    const resolve = createDeliveryAudienceEnvelopeResolver({
      integrationStore: {
        getCredentialsForAssistantSystem: vi.fn(async () => null),
      } as unknown as ChannelIntegrationStore,
    })
    await expect(resolve({
      workspaceId: WS,
      assistantId: ASSISTANT,
      userId: USER,
      channelType: 'telegram',
      channelId: '-100123',
      recipientType: 'group',
    })).resolves.toMatchObject({
      allowed: true,
      source: 'public',
      ceiling: { clearance: 'public', compartments: [], projectIds: [] },
    })
  })

  it('uses a group binding without requiring the external sender to be a member', async () => {
    const resolveLiveAccess = vi.fn(async () => ceiling())
    const resolve = createDeliveryAudienceEnvelopeResolver({
      integrationStore: {
        getCredentialsForAssistantSystem: vi.fn(async () => ({
          config: { deliveryAudienceBindings: [{
            version: 1,
            channelId: '-100123',
            audienceType: 'group',
            clearance: 'internal',
            compartments: ['finance'],
            projectIds: [],
            recipientUserId: null,
            expiresAt: null,
            approvedByUserId: APPROVER,
            approvedAt: '2026-09-29T00:00:00.000Z',
          }] },
        })),
      } as unknown as ChannelIntegrationStore,
      getWorkspaceRole: vi.fn(async () => 'admin' as const),
      resolveLiveAccess,
    })

    await expect(resolve({
      workspaceId: WS,
      assistantId: ASSISTANT,
      userId: 'external-shadow-user',
      channelType: 'telegram',
      channelId: '-100123',
      recipientType: 'group',
    })).resolves.toMatchObject({
      allowed: true,
      source: 'binding',
      ceiling: { clearance: 'internal', compartments: ['finance'] },
    })
    expect(resolveLiveAccess).not.toHaveBeenCalled()
  })

  it('intersects parent-chat and exact-topic bindings regardless of array order', async () => {
    const resolve = createDeliveryAudienceEnvelopeResolver({
      integrationStore: {
        getCredentialsForAssistantSystem: vi.fn(async () => ({
          config: { deliveryAudienceBindings: [
            {
              version: 1, channelId: '-100123', audienceType: 'group',
              clearance: 'confidential', compartments: ['finance'], projectIds: [PROJECT],
              recipientUserId: null, expiresAt: null, approvedByUserId: APPROVER,
              approvedAt: '2026-09-29T00:00:00.000Z',
            },
            {
              version: 1, channelId: '-100123:topic:42', audienceType: 'group',
              clearance: 'internal', compartments: [], projectIds: [],
              recipientUserId: null, expiresAt: null, approvedByUserId: APPROVER,
              approvedAt: '2026-09-29T00:00:00.000Z',
            },
          ] },
        })),
      } as unknown as ChannelIntegrationStore,
      getWorkspaceRole: vi.fn(async () => 'owner' as const),
    })

    await expect(resolve({
      workspaceId: WS,
      assistantId: ASSISTANT,
      userId: USER,
      channelType: 'telegram',
      channelId: '-100123:topic:42',
      recipientType: 'group',
    })).resolves.toMatchObject({
      allowed: true,
      source: 'binding',
      ceiling: {
        clearance: 'internal',
        compartments: [],
        projectIds: [],
      },
    })
  })

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
    })).resolves.toEqual({ allowed: false, reason: 'delivery_audience_unverified', detail: 'unbound' })
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
    })).resolves.toEqual({ allowed: false, reason: 'delivery_audience_unverified', detail: 'evidence_exceeds_audience' })
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

// ── Personal groups (a group binding that names its only human) ──

function personalGroupIntegration(channelType = 'telegram') {
  return {
    channelType,
    credentials: { bot_token: '1000001:FICTIONAL', webhook_secret: 'x' },
    config: {
      deliveryAudienceBindings: [{
        version: 1,
        channelId: '-100777',
        audienceType: 'group',
        clearance: 'internal',
        compartments: [],
        projectIds: [],
        recipientUserId: USER,
        expiresAt: null,
        approvedByUserId: USER,
        approvedAt: '2026-09-29T00:00:00.000Z',
      }],
    },
  }
}

function personalGroupAuthorizer(verified: boolean, channelType = 'telegram') {
  const verifyPersonalGroup = vi.fn(async () => verified)
  const deps = {
    integrationStore: {
      getCredentialsForAssistantSystem: vi.fn(async () => personalGroupIntegration(channelType)),
      getCredentialsForAssistantIntegrationSystem: vi.fn(async () => personalGroupIntegration(channelType)),
    } as unknown as ChannelIntegrationStore,
    findAssistant: vi.fn(async () => ({ id: ASSISTANT, workspaceId: WS })) as never,
    findSession: vi.fn(async () => null),
    findChannelSession: vi.fn(async () => null),
    getWorkspaceRole: vi.fn(async () => 'owner' as const),
    resolveLiveAccess: vi.fn(async () => ceiling({ compartments: [], mutationCompartments: [], projectIds: [] })),
    verifyPersonalGroup,
  }
  return { deps, verifyPersonalGroup }
}

const personalGroupInput = {
  workspaceId: WS,
  assistantId: ASSISTANT,
  userId: USER,
  channelType: 'telegram',
  channelId: '-100777:topic:15',
  recipientType: 'group' as const,
}

describe('[COMP:api/delivery-authority] personal group bindings', () => {
  // 2026-09-29: an owner's single-person Telegram hub was refused on every
  // turn because group bindings could never carry personal context.
  it('delivers the recipient personal context while membership is verified', async () => {
    const { deps, verifyPersonalGroup } = personalGroupAuthorizer(true)
    await expect(createDeliveryAudienceAuthorizer(deps)({
      ...personalGroupInput,
      scopeEvidence: {
        sensitivity: 'internal',
        compartments: [],
        projectIds: [],
      },
    })).resolves.toMatchObject({ allowed: true })
    expect(verifyPersonalGroup).toHaveBeenCalledWith({
      channelType: 'telegram',
      chatId: '-100777',
      recipientUserId: USER,
      botToken: '1000001:FICTIONAL',
    })
    await expect(createDeliveryAudienceEnvelopeResolver(deps)(personalGroupInput))
      .resolves.toMatchObject({ allowed: true, source: 'binding', ceiling: { userId: USER } })
  })

  it('refuses with a personal-group reason when membership cannot be proven', async () => {
    const { deps } = personalGroupAuthorizer(false)
    await expect(createDeliveryAudienceEnvelopeResolver(deps)(personalGroupInput)).resolves.toEqual({
      allowed: false,
      reason: 'delivery_audience_unverified',
      detail: 'personal_group_unverified',
    })
    await expect(createDeliveryAudienceAuthorizer(deps)({
      ...personalGroupInput,
      scopeEvidence: { sensitivity: 'public', compartments: [], projectIds: [] },
    })).resolves.toEqual({
      allowed: false,
      reason: 'delivery_audience_unverified',
      detail: 'personal_group_unverified',
    })
  })

  it('never widens past the recipient own live access', async () => {
    const { deps } = personalGroupAuthorizer(true)
    await expect(createDeliveryAudienceAuthorizer(deps)({
      ...personalGroupInput,
      scopeEvidence: { sensitivity: 'confidential', compartments: [], projectIds: [] },
    })).resolves.toEqual({
      allowed: false,
      reason: 'delivery_audience_unverified',
      detail: 'evidence_exceeds_audience',
    })
  })
})
