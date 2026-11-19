import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import type { CampaignLinkRow } from '../../db/campaign-store.js'
import type { CampaignTrackingStore, CampaignSiteRow } from '../../db/campaign-tracking-store.js'
import { campaignTrackingRoutes } from '../campaign-tracking.js'
import { CampaignError } from '@use-brian/core/campaigns/types.js'

const PUBLIC_ID = '0123456789abcdef0123456789abcdef'
const LINK: CampaignLinkRow = {
  id: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  campaignId: '00000000-0000-4000-8000-000000000003',
  placementId: '00000000-0000-4000-8000-000000000004',
  publicId: PUBLIC_ID,
  destination: 'https://example.com/offer?utm_source=linkedin&brian_link=0123456789abcdef0123456789abcdef#details',
  utm: { source: 'linkedin', medium: 'organic_social', campaign: 'example', content: 'body' },
  enabled: true,
  createdAt: new Date('2026-09-20T00:00:00.000Z'),
}

const SITE: CampaignSiteRow = {
  id: '00000000-0000-4000-8000-000000000005', workspaceId: LINK.workspaceId,
  publicId: 'abcdef0123456789abcdef0123456789', name: 'Fixture site',
  allowedOrigins: ['https://example.com'], conversionDefinitions: [{ key: 'enquiry_submitted', label: 'Enquiry', enabled: true }],
  storageMode: 'first_party', cookieDomain: '.example.com', siteGroupKey: 'fixture_sites',
  rawRetentionDays: 90, aggregateRetentionMonths: 13, enabled: true, version: 1,
}

function fakeTracking(overrides: Partial<CampaignTrackingStore> = {}): CampaignTrackingStore {
  return {
    getSiteByPublicId: vi.fn(async () => SITE),
    collectBrowserEvent: vi.fn(async () => ({ duplicate: false, eventId: '00000000-0000-4000-8000-000000000006' })),
    authenticateCredential: vi.fn(async () => null),
    recordTrustedConversion: vi.fn(), recordRedirectRequest: vi.fn(),
    saveSite: vi.fn(), listSites: vi.fn(), issueCredential: vi.fn(), recordCommittedConversion: vi.fn(),
    trackingSetup: vi.fn(), results: vi.fn(), attribution: vi.fn(),
    ...overrides,
  } as unknown as CampaignTrackingStore
}

function app(options: Parameters<typeof campaignTrackingRoutes>[0]) {
  const server = express()
  // Deliberately mount the public router before a broad auth guard: this is
  // the route order both editions receive from bootOpenApi.
  server.use(campaignTrackingRoutes({ trackingStore: fakeTracking(), observeRedirect: async () => {}, ...options }))
  server.use('/api', (_req, res) => res.status(401).json({ error: 'auth' }))
  return server
}

describe('[COMP:api/campaign-tracking] [COMP:campaigns/browser-acceptance] public native campaign boundaries', () => {
  it('redirects only through an enabled stored destination without caching', async () => {
    const findLink = vi.fn(async () => LINK)
    const response = await request(app({ findLink }))
      .get(`/r/${PUBLIC_ID}?url=https://attacker.example/`)
      .expect(307)
    expect(response.headers.location).toBe(LINK.destination)
    expect(response.headers['cache-control']).toContain('no-store')
    expect(findLink).toHaveBeenCalledWith(PUBLIC_ID)
  })

  it('keeps redirect delivery working when observation storage fails', async () => {
    const observeRedirect = vi.fn(async () => { throw new Error('collector offline') })
    const response = await request(app({ findLink: async () => LINK, observeRedirect }))
      .get(`/r/${PUBLIC_ID}?brian_test=1`)
      .set('user-agent', 'synthetic-browser')
      .expect(307)
    expect(response.headers.location).toBe(LINK.destination)
    await vi.waitFor(() => expect(observeRedirect).toHaveBeenCalledWith(expect.objectContaining({ test: true })))
  })

  it('serves a local tracker and admits bounded observations only for an exact configured origin', async () => {
    const collectBrowserEvent = vi.fn(async () => ({ duplicate: false, eventId: 'event-row' }))
    const trackingStore = fakeTracking({ collectBrowserEvent })
    const server = app({ findLink: async () => LINK, trackingStore })
    const tracker = await request(server).get('/api/campaign-tracking/tracker.js').expect(200)
    expect(tracker.text).toContain('BrianCampaign')
    expect(tracker.text).toContain('dataset.brianAutoInit')
    expect(tracker.text).not.toMatch(/posthog|google-analytics|segment\.com/i)
    const event = {
      version: 1, eventId: 'event_0123456789abcdef012345', siteId: SITE.publicId, type: 'page_view',
      occurredAt: '2026-09-20T01:00:00.000Z', sessionId: 'session_0123456789abcdef0123',
      visitorId: 'visitor_0123456789abcdef0123', pagePath: '/offer', metadata: {}, test: true,
    }
    const accepted = await request(server).post('/api/campaign-tracking/collect')
      .set('Origin', 'https://example.com').send(event).expect(202)
    expect(accepted.headers['access-control-allow-origin']).toBe('https://example.com')
    expect(collectBrowserEvent).toHaveBeenCalledWith(SITE, 'https://example.com', event, undefined)
    await request(server).post('/api/campaign-tracking/collect').set('Origin', 'https://evil.example').send(event).expect(403)
    await request(server).post('/api/campaign-tracking/collect').set('Origin', 'https://example.com')
      .send({ ...event, contactId: '00000000-0000-4000-8000-000000000009' }).expect(400)
    await request(server).options(`/api/campaign-tracking/collect?site_id=${SITE.publicId}`)
      .set('Origin', 'https://example.com').expect(204)
  })

  it('requires a scoped backend credential for verified outcomes and exposes quota errors honestly', async () => {
    const principal = { id: 'credential', workspaceId: SITE.workspaceId, siteId: SITE.id,
      grants: ['conversion:write'], keyPrefix: 'sk_campaign_fixture', site: SITE }
    const conversionId = '00000000-0000-4000-8000-000000000007'
    const trackingStore = fakeTracking({
      authenticateCredential: vi.fn(async token => token === 'valid-token' ? principal : null),
      recordTrustedConversion: vi.fn(async (_principal, raw) => {
        if ((raw as { subject?: { kind?: string } }).subject?.kind === 'contact') throw new CampaignError('forbidden', 'forged contact')
        return { duplicate: false, conversionId, attribution: {} as never }
      }),
      collectBrowserEvent: vi.fn(async () => { throw new CampaignError('rate_limited', 'quota') }),
    })
    const server = app({ findLink: async () => LINK, trackingStore })
    const conversion = { version: 1, siteId: SITE.publicId, conversionKind: 'enquiry_submitted',
      externalOutcomeId: 'fixture-enquiry-1', occurredAt: '2026-09-20T01:00:00.000Z', test: true, metadata: {} }
    await request(server).post('/api/campaign-tracking/conversions').send(conversion).expect(401)
    await request(server).post('/api/campaign-tracking/conversions').set('Authorization', 'Bearer invalid').send(conversion).expect(401)
    await request(server).post('/api/campaign-tracking/conversions').set('Authorization', 'Bearer valid-token')
      .send({ ...conversion, subject: { kind: 'contact', id: '00000000-0000-4000-8000-000000000009' } }).expect(403)
    await request(server).post('/api/campaign-tracking/conversions').set('Authorization', 'Bearer valid-token')
      .send(conversion).expect(201)
    await request(server).post('/api/campaign-tracking/collect').set('Origin', 'https://example.com').send({
      version: 1, eventId: 'event_0123456789abcdef012345', siteId: SITE.publicId, type: 'page_view',
      occurredAt: '2026-09-20T01:00:00.000Z', pagePath: '/', metadata: {}, test: true,
    }).expect(429)
  })

  it('never turns a malformed or unknown id into an open redirect', async () => {
    await request(app({ findLink: async () => LINK })).get('/r/not-valid?url=https://attacker.example').expect(404)
    await request(app({ findLink: async () => null })).get(`/r/${PUBLIC_ID}?url=https://attacker.example`).expect(503)
  })
})
