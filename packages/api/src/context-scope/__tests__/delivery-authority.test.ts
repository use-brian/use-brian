import { describe, expect, it, vi } from 'vitest'
import type { AccessCeiling, ScopeSource } from '@use-brian/core'
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
const OTHER_ASSISTANT = '77777777-7777-4777-8777-777777777777'
const OTHER_USER = '88888888-8888-4888-8888-888888888888'

// Current-label revalidation reads the database; these tests exercise the
// per-source policy, so every source is reported unchanged.
vi.mock('../../db/client.js', () => ({ getPool: () => ({}) }))
vi.mock('../../db/derived-scope-store.js', () => ({
  readCurrentScopeSources: async (_client: unknown, _workspaceId: string, sources: ScopeSource[]) =>
    sources.map((source) => ({ state: 'current', source })),
}))

function source(id: string, assistantId: string | null, userId: string | null = USER): ScopeSource {
  return {
    workspaceId: WS, userId, assistantId, sensitivity: 'internal', compartments: [], projectIds: [],
    resourceKind: 'memory', resourceId: id, version: '1',
  }
}

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
    })).resolves.toEqual({ allowed: false, reason: 'delivery_audience_unverified', detail: 'unbound', diagnostic: 'clearance' })
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
      .resolves.toEqual({ allowed: false, reason: 'delivery_audience_unverified', diagnostic: 'binding_approver_not_admin' })
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
    })).resolves.toEqual({ allowed: false, reason: 'delivery_audience_unverified', detail: 'evidence_exceeds_audience', diagnostic: 'teams' })
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
    })).resolves.toEqual({ allowed: false, reason: 'delivery_audience_unverified', diagnostic: 'binding_expired' })
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
    })).resolves.toEqual({ allowed: false, reason: 'delivery_audience_unverified', diagnostic: 'teams' })
  })
})

// ── Linked members speaking in an approved group ──

const SPEAKER_GROUP = '-100777'

function approvedGroupDeps(options: {
  speakerRole: 'owner' | 'admin' | 'member' | null
  live?: AccessCeiling | (() => Promise<AccessCeiling>)
  recipientUserId?: string | null
}) {
  const binding = {
    version: 1,
    channelId: SPEAKER_GROUP,
    audienceType: 'group',
    clearance: 'confidential',
    compartments: [],
    projectIds: [],
    recipientUserId: options.recipientUserId ?? null,
    expiresAt: null,
    approvedByUserId: APPROVER,
    approvedAt: '2026-09-29T00:00:00.000Z',
  }
  const live = options.live ?? ceiling({ clearance: 'internal', compartments: [], mutationCompartments: [], projectIds: [] })
  return {
    integrationStore: {
      getCredentialsForAssistantSystem: vi.fn(async () => ({ config: { deliveryAudienceBindings: [binding] } })),
      getCredentialsForAssistantIntegrationSystem: vi.fn(async () => ({ config: { deliveryAudienceBindings: [binding] } })),
    } as unknown as ChannelIntegrationStore,
    findAssistant: vi.fn(async () => ({ id: ASSISTANT, workspaceId: WS })) as never,
    findSession: vi.fn(async () => null),
    findChannelSession: vi.fn(async () => null),
    getWorkspaceRole: vi.fn(async (userId: string) => (userId === APPROVER ? 'owner' : options.speakerRole)) as never,
    resolveLiveAccess: vi.fn(typeof live === 'function' ? live : async () => live),
  }
}

const speakerInput = {
  workspaceId: WS,
  assistantId: ASSISTANT,
  userId: USER,
  channelType: 'telegram',
  channelId: `${SPEAKER_GROUP}:topic:15`,
  recipientType: 'group' as const,
  recipientMode: 'member' as const,
  groupSpeaker: true,
}

const ownPersonalRow = { sensitivity: 'internal' as const, compartments: [], projectIds: [], sources: [source('own-memory', null)] }

describe('[COMP:api/delivery-authority] a linked member speaking in an approved group', () => {
  // 2026-10-01: group bindings could never carry personal context, so an
  // owner's own topic-routed Telegram group refused every turn that touched
  // their memories. Who else is in the group is the call of the owner or
  // admin who added the bot, so the speaker's role is not checked.
  it.each(['owner', 'admin', 'member'] as const)('delivers the %s their own personal context', async (role) => {
    const deps = approvedGroupDeps({ speakerRole: role })
    await expect(createDeliveryAudienceEnvelopeResolver(deps)(speakerInput)).resolves.toMatchObject({
      allowed: true,
      source: 'binding',
      // Capped by both the binding (confidential) and live access (internal).
      ceiling: { userId: USER, clearance: 'internal' },
    })
    await expect(createDeliveryAudienceAuthorizer(deps)({ ...speakerInput, scopeEvidence: ownPersonalRow }))
      .resolves.toMatchObject({ allowed: true })
  })

  it('keeps a sender who is not a workspace member at the shared binding', async () => {
    const deps = approvedGroupDeps({
      speakerRole: null,
      live: async () => { throw Object.assign(new Error('gone'), { code: 'context_not_available' }) },
    })
    await expect(createDeliveryAudienceEnvelopeResolver(deps)(speakerInput))
      .resolves.toMatchObject({ allowed: true, source: 'binding', ceiling: { userId: '' } })
    await expect(createDeliveryAudienceAuthorizer(deps)({ ...speakerInput, scopeEvidence: ownPersonalRow }))
      .resolves.toMatchObject({ allowed: false, detail: 'evidence_exceeds_audience' })
  })

  it('never elevates a caller that is not a live group turn', async () => {
    // Workflows, relays and replays address the group on someone's behalf.
    const deps = approvedGroupDeps({ speakerRole: 'owner' })
    const { groupSpeaker: _omitted, ...onBehalf } = speakerInput
    await expect(createDeliveryAudienceEnvelopeResolver(deps)(onBehalf))
      .resolves.toMatchObject({ allowed: true, ceiling: { userId: '' } })
    await expect(createDeliveryAudienceEnvelopeResolver(deps)({ ...speakerInput, recipientMode: 'external' }))
      .resolves.toMatchObject({ allowed: true, ceiling: { userId: '' } })
  })

  it('never delivers another member\'s personal rows to the speaker', async () => {
    const deps = approvedGroupDeps({ speakerRole: 'admin' })
    await expect(createDeliveryAudienceAuthorizer(deps)({
      ...speakerInput,
      scopeEvidence: { ...ownPersonalRow, sources: [source('foreign-memory', null, OTHER_USER)] },
    })).resolves.toMatchObject({ allowed: false })
  })

  it('degrades to the shared binding when the speaker lookup fails', async () => {
    const deps = approvedGroupDeps({ speakerRole: 'owner', live: async () => { throw new Error('db timeout') } })
    await expect(createDeliveryAudienceEnvelopeResolver(deps)(speakerInput))
      .resolves.toMatchObject({ allowed: true, ceiling: { userId: '' } })
  })

  it('still refuses a group binding that names a single recipient', async () => {
    const deps = approvedGroupDeps({ speakerRole: 'owner', recipientUserId: USER })
    await expect(createDeliveryAudienceEnvelopeResolver(deps)(speakerInput))
      .resolves.toEqual({ allowed: false, reason: 'delivery_audience_unverified', diagnostic: 'binding_audience_mismatch' })
  })
})

describe('[COMP:api/delivery-authority] owner thread audience (decision D2)', () => {
  const ownerThread = session({ channelType: 'web', appOrigin: 'doc', visibility: 'owner' })
  const input = {
    workspaceId: WS,
    // The doc dock re-addressed this turn: the answering assistant is not the
    // session's bound one, and the transcript carries both assistants' rows.
    assistantId: OTHER_ASSISTANT,
    userId: USER,
    channelType: 'web',
    channelId: 'default',
    sessionId: ownerThread.id,
    scopeEvidence: { sources: [source('bound-reply', ASSISTANT), source('answering-memory', OTHER_ASSISTANT)] },
  }

  it('delivers a thread spanning several assistants to its owner', async () => {
    const authorize = authorizer({
      originSession: ownerThread,
      // A standard assistant's own ceiling partitions by assistant; as an
      // AUDIENCE the owner is not partitioned.
      live: ceiling({ compartments: null, mutationCompartments: null, projectIds: null, visibilityAssistantIds: [OTHER_ASSISTANT] }),
    })
    await expect(authorize(input)).resolves.toMatchObject({ allowed: true })
  })

  it('still refuses another user\'s personal row and another member\'s thread', async () => {
    const live = ceiling({ compartments: null, mutationCompartments: null, projectIds: null })
    await expect(authorizer({ originSession: ownerThread, live })({
      ...input,
      scopeEvidence: { sources: [source('foreign', ASSISTANT, APPROVER)] },
    })).resolves.toMatchObject({ allowed: false, diagnostic: 'user_visibility' })
    await expect(authorizer({ originSession: session({ userId: APPROVER }), live })(input))
      .resolves.toMatchObject({ allowed: false, diagnostic: 'session_not_owner' })
  })

  it('tells a failed membership lookup apart from a lost membership', async () => {
    const failing = (error: Error) => createDeliveryAudienceAuthorizer({
      findAssistant: vi.fn(async () => ({ id: ASSISTANT, workspaceId: WS })) as never,
      findSession: vi.fn(async () => ownerThread),
      findChannelSession: vi.fn(async () => null),
      getWorkspaceRole: vi.fn(async () => null),
      resolveLiveAccess: vi.fn(async () => { throw error }),
    })
    await expect(failing(new Error('authority_unavailable'))(input))
      .resolves.toMatchObject({ allowed: false, diagnostic: 'member_not_found' })
    await expect(failing(new Error('timeout exceeded when trying to connect'))(input))
      .resolves.toMatchObject({ allowed: false, diagnostic: 'member_ceiling_error' })
  })
})

describe('[COMP:api/delivery-authority] non-member recipients', () => {
  const GUEST = '88888888-8888-4888-8888-888888888888'
  const guestSession = session({ userId: GUEST, channelType: 'telegram', channelId: '5550100', appOrigin: null })
  // What resolveLiveAccess yields for each mode: a guest is not a member, so
  // the strict member lookup throws; as an external principal it resolves to
  // public General for that guest.
  const resolveLiveAccess = vi.fn(async (input: { memberMode?: string }) => {
    if (input.memberMode !== 'external') throw new Error('authority_unavailable')
    return ceiling({ userId: GUEST, clearance: 'public', compartments: [], mutationCompartments: [], projectIds: [] })
  })
  const authorize = () => createDeliveryAudienceAuthorizer({
    findAssistant: vi.fn(async () => ({ id: ASSISTANT, workspaceId: WS })) as never,
    findSession: vi.fn(async () => guestSession),
    findChannelSession: vi.fn(async () => guestSession),
    getWorkspaceRole: vi.fn(async () => null),
    resolveLiveAccess: resolveLiveAccess as never,
  })
  const guestInput = {
    workspaceId: WS,
    assistantId: ASSISTANT,
    userId: GUEST,
    channelType: 'telegram',
    channelId: '5550100',
    recipientType: 'individual' as const,
    scopeEvidence: {
      sensitivity: 'public' as const,
      sources: [{ ...source('guest-message', null, GUEST), sensitivity: 'public' as const, resourceKind: 'session_message' }],
    },
  }

  it('delivers a guest DM reply that carries the guest\'s own message', async () => {
    await expect(authorize()({ ...guestInput, recipientMode: 'external' })).resolves.toMatchObject({ allowed: true })
    await expect(authorize()({ ...guestInput, sessionId: guestSession.id, channelType: 'api', recipientMode: 'external' }))
      .resolves.toMatchObject({ allowed: true })
  })

  it('refuses when the guest is judged as a member, and never widens a guest past public', async () => {
    await expect(authorize()({ ...guestInput, sessionId: guestSession.id, channelType: 'api' }))
      .resolves.toMatchObject({ allowed: false, diagnostic: 'member_not_found' })
    await expect(authorize()({
      ...guestInput,
      recipientMode: 'external',
      scopeEvidence: { sensitivity: 'internal' as const, sources: guestInput.scopeEvidence.sources },
    })).resolves.toMatchObject({ allowed: false, diagnostic: 'clearance' })
  })
})

describe('[COMP:api/delivery-authority] thread-scoped channel DM', () => {
  // Feishu / Slack reply-in-thread key the session by `<chat>:thread:<root>`,
  // while delivery targets the bare chat. The member's personal session lives
  // under the thread key only.
  const threadKey = 'oc_chat:thread:om_root'
  const threadSession = session({ channelType: 'feishu', channelId: threadKey, visibility: 'owner' })
  const findChannelSession = vi.fn(async (query: { channelId: string }) =>
    query.channelId === threadKey ? threadSession : null)
  const authorize = createDeliveryAudienceAuthorizer({
    findAssistant: vi.fn(async () => ({ id: ASSISTANT, workspaceId: WS })) as never,
    findSession: vi.fn(async () => null),
    findChannelSession: findChannelSession as never,
    getWorkspaceRole: vi.fn(async () => null),
    resolveLiveAccess: vi.fn(async () => ceiling()),
  })
  const input = {
    workspaceId: WS,
    assistantId: ASSISTANT,
    userId: USER,
    channelType: 'feishu',
    channelId: 'oc_chat',
    recipientType: 'individual' as const,
    scopeEvidence: { sources: [source('own-memory', ASSISTANT)] },
  }

  it('finds the member personal session under the thread key and delivers their own rows', async () => {
    await expect(authorize({ ...input, sessionChannelId: threadKey })).resolves.toMatchObject({ allowed: true })
    expect(findChannelSession).toHaveBeenLastCalledWith(expect.objectContaining({ channelId: threadKey }))
  })

  it('judges the member as anonymous when only the bare chat is looked up', async () => {
    await expect(authorize(input)).resolves.toMatchObject({ allowed: false })
  })
})
