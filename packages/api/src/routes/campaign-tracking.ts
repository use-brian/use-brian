/** Public campaign redirect/collection boundary. [COMP:api/campaign-tracking] */
import express, { Router, type Response } from 'express'
import { z } from 'zod'
import { CampaignError } from '@use-brian/core/campaigns/types.js'
import { campaignBrowserEventSchema, campaignOpaqueIdSchema } from '@use-brian/shared/campaigns'
import { createDbCampaignStore, type CampaignLinkRow } from '../db/campaign-store.js'
import { createCampaignTrackingStore, type CampaignTrackingStore } from '../db/campaign-tracking-store.js'
import { CAMPAIGN_TRACKER_SOURCE } from '../campaigns/browser/tracker.js'

function bearer(header: string | undefined): string | null {
  return header?.startsWith('Bearer ') ? header.slice(7).trim() : null
}

function trackingError(res: Response, error: unknown): void {
  if (error instanceof z.ZodError) return void res.status(400).json({ error: 'invalid_input', issues: error.issues })
  if (error instanceof CampaignError) {
    const status = error.code === 'forbidden' ? 403 : error.code === 'conflict' ? 409
      : error.code === 'rate_limited' ? 429 : error.code === 'unavailable' ? 503 : error.code === 'not_found' ? 404 : 400
    res.status(status).json({ error: error.code, message: error.message, ...error.details })
    return
  }
  console.error('[campaign-tracking] request failed:', error)
  res.status(500).json({ error: 'internal' })
}

export function campaignTrackingRoutes(options: {
  findLink?: (publicId: string) => Promise<CampaignLinkRow | null>
  observeRedirect?: (input: { link: CampaignLinkRow; userAgent?: string; test: boolean }) => Promise<void>
  trackingStore?: CampaignTrackingStore
} = {}): Router {
  const router = Router()
  const store = createDbCampaignStore()
  const tracking = options.trackingStore ?? createCampaignTrackingStore()
  const findLink = options.findLink ?? ((publicId: string) => store.getLinkByPublicId(publicId))

  router.get('/api/campaign-tracking/tracker.js', (_req, res) => {
    res.set({
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=300, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
    }).send(CAMPAIGN_TRACKER_SOURCE)
  })

  router.post('/api/campaign-tracking/collect', express.json({ limit: '20kb' }), async (req, res) => {
    try {
      const siteId = typeof req.body?.siteId === 'string' ? req.body.siteId : ''
      const site = await tracking.getSiteByPublicId(siteId)
      if (!site) return void res.status(404).json({ error: 'site_not_found' })
      const origin = req.get('origin')
      if (!origin || !site.allowedOrigins.includes(origin)) return void res.status(403).json({ error: 'origin_not_allowed' })
      res.set({ 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Cache-Control': 'no-store' })
      const event = campaignBrowserEventSchema.parse(req.body)
      const result = await tracking.collectBrowserEvent(site, origin, event, req.get('user-agent'))
      res.status(result.duplicate ? 200 : 202).json({ accepted: true, duplicate: result.duplicate })
    } catch (error) { trackingError(res, error) }
  })

  router.options('/api/campaign-tracking/collect', async (req, res) => {
    const origin = req.get('origin')
    const siteId = typeof req.query.site_id === 'string' ? req.query.site_id : ''
    const site = siteId ? await tracking.getSiteByPublicId(siteId).catch(() => null) : null
    if (!site || !origin || !site.allowedOrigins.includes(origin)) return void res.status(403).end()
    res.set({
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    }).status(204).end()
  })

  router.post('/api/campaign-tracking/conversions', express.json({ limit: '20kb' }), async (req, res) => {
    try {
      const token = bearer(req.get('authorization'))
      const principal = token ? await tracking.authenticateCredential(token) : null
      if (!principal) return void res.status(401).json({ error: 'unauthorized' })
      const result = await tracking.recordTrustedConversion(principal, req.body)
      res.status(result.duplicate ? 200 : 201).json({ conversionId: result.conversionId, duplicate: result.duplicate })
    } catch (error) { trackingError(res, error) }
  })

  router.get('/r/:linkId', async (req, res) => {
    const parsed = campaignOpaqueIdSchema.safeParse(req.params.linkId)
    if (!parsed.success) return void res.status(404).type('text/plain').send('Campaign link unavailable')
    let link: CampaignLinkRow | null = null
    try { link = await findLink(parsed.data) } catch (error) {
      console.error('[campaign-tracking] redirect lookup failed:', error)
    }
    if (!link) return void res.status(503).set('Cache-Control', 'no-store').type('text/plain').send('Campaign link unavailable')
    res.set('Cache-Control', 'private, no-store, max-age=0')
    const observe = options.observeRedirect
      ? () => options.observeRedirect!({
        link,
        userAgent: req.get('user-agent'),
        test: req.query.brian_test === '1',
      })
      : () => tracking.recordRedirectRequest(link!, req.get('user-agent'), req.query.brian_test === '1')
    void observe().catch(error => console.error('[campaign-tracking] redirect observation failed:', error))
    res.redirect(307, link.destination)
  })

  return router
}
