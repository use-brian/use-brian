import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import type { SavedContentDraft } from '../../db/content-planning-store.js'
import type { SelfHostFeedCloudLinkStore } from '../../db/self-host-feed-cloud-link-store.js'
import {
  createSelfHostFeedCloudPublisher,
  publicFeedCloudLink,
  selfHostFeedManagedDistributionRoutes,
} from '../self-host-feed-cloud.js'

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111'
const ASSISTANT_ID = '22222222-2222-4222-8222-222222222222'

function draft(overrides: Partial<SavedContentDraft> = {}): SavedContentDraft {
  return {
    id: 'draft-1',
    assistantId: ASSISTANT_ID,
    sessionId: 'session-1',
    platform: 'threads',
    draftText: 'Local draft',
    finalText: 'Approved copy',
    imageBrief: null,
    topicTag: 'Launch',
    postFormat: 'post',
    formatData: {},
    media: [],
    replyExternalId: null,
    replyAuthor: null,
    replyText: null,
    replyPermalink: null,
    status: 'ready',
    createdBy: 'user-1',
    resolvedBy: 'user-1',
    createdAt: new Date(),
    resolvedAt: new Date(),
    postedPermalink: null,
    ...overrides,
  }
}

function store(): SelfHostFeedCloudLinkStore {
  return {
    get: vi.fn(),
    getWithCredential: vi.fn(async () => ({
      link: {
        workspaceId: WORKSPACE_ID,
        assistantId: ASSISTANT_ID,
        installationId: '33333333-3333-4333-8333-333333333333',
        cloudBaseUrl: 'https://api.usebrian.example',
        localOrigin: 'https://local.example',
        status: 'linked' as const,
        deviceCode: null,
        userCode: null,
        verificationUrl: null,
        hostedLinkId: '44444444-4444-4444-8444-444444444444',
        hostedWorkspaceId: '55555555-5555-4555-8555-555555555555',
        hostedWorkspaceName: 'Cloud Team',
        hostedAssistantId: '66666666-6666-4666-8666-666666666666',
        hostedAssistantName: 'Cloud Voice',
        hostedPlan: 'pro',
        entitlements: { publishing: true },
        expiresAt: null,
        lastCheckedAt: null,
        lastError: null,
      },
      credential: { accessToken: 'shf_token' },
    })),
    savePending: vi.fn(),
    markLinked: vi.fn(),
    markPlanRequired: vi.fn(),
    markError: vi.fn(),
    touchEntitlement: vi.fn(),
    remove: vi.fn(),
  }
}

describe('[COMP:api/self-host-feed-cloud-link] local managed delivery', () => {
  it('does not expose local credentials in the status wire shape', () => {
    expect(publicFeedCloudLink(null)).toEqual({ state: 'unlinked' })
  })

  it('forwards only the managed Feed route through the scoped cloud gateway', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | globalThis.Request) => {
      expect(String(url)).toBe(
        `https://api.usebrian.example/api/self-host-feed/gateway/distribution/team/${WORKSPACE_ID}/profiles`,
      )
      return new Response(JSON.stringify({ profiles: [] }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-usebrian-cloud-plan': 'pro',
        },
      })
    })
    const cloudStore = store()
    const app = express()
    app.use(express.json())
    app.use('/api/distribution', selfHostFeedManagedDistributionRoutes({
      store: cloudStore,
      fetchImpl: fetchImpl as typeof fetch,
    }))
    await request(app)
      .get(`/api/distribution/team/${WORKSPACE_ID}/profiles`)
      .expect(200, { profiles: [] })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(cloudStore.touchEntitlement).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      plan: 'pro',
      entitlements: { publishing: true },
    })
  })

  it('publishes a supported approved draft with a stable scoped request', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | globalThis.Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      expect(body).toMatchObject({
        platform: 'threads',
        text: 'Approved copy',
        topicTag: 'Launch',
      })
      expect(body.idempotencyKey).toMatch(/^draft:draft-1:/)
      return new Response(JSON.stringify({ status: 'posted', postId: 'post-1', permalink: 'https://threads.example/post-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const publish = createSelfHostFeedCloudPublisher({
      store: store(),
      fetchImpl: fetchImpl as typeof fetch,
      resolveAssistant: vi.fn(async () => ({
        id: ASSISTANT_ID,
        name: 'Local Voice',
        ownerUserId: '',
        defaultModelAlias: 'pro',
        apiModelAlias: 'pro',
        workspaceId: WORKSPACE_ID,
        systemPrompt: null,
        bio: null,
        charter: null,
        clearance: 'public' as const,
        compartments: null,
        defaultCompartments: [],
        kind: 'app' as const,
        appType: 'distribution' as const,
      })),
    })
    await expect(publish(draft())).resolves.toEqual({
      status: 'posted',
      permalink: 'https://threads.example/post-1',
    })
  })

  it('keeps unsupported media drafts in the manual queue without a cloud call', async () => {
    const fetchImpl = vi.fn()
    const publish = createSelfHostFeedCloudPublisher({
      store: store(),
      fetchImpl: fetchImpl as typeof fetch,
    })
    await expect(publish(draft({ media: [{ fileId: 'file-1', mimeType: 'image/png' }] })))
      .resolves.toEqual({ status: 'manual', reason: 'format_manual_only' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
