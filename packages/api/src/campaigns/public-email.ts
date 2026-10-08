/** Login-free, opaque campaign unsubscribe and email-click capabilities. [COMP:campaigns/dispatch] */
import { createHash } from 'node:crypto'
import express, { Router, type Response } from 'express'
import { z } from 'zod'
import type { Pool, PoolClient } from 'pg'
import { campaignOpaqueIdSchema } from '@use-brian/shared/campaigns'
import { getPool, query } from '../db/client.js'
import type { CampaignLinkRow } from '../db/campaign-store.js'
import { createCampaignTrackingStore, type CampaignTrackingStore } from '../db/campaign-tracking-store.js'

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const tokenSchema = campaignOpaqueIdSchema

type TokenRow = {
  id: string; workspaceId: string; recipientId: string; contactId: string; purposeKey: string;
  allMarketing: boolean; expiresAt: Date; usedAt: Date | null; revokedAt: Date | null; purposeLabel: string; scopeSnapshot: unknown | null; scopeSources: unknown | null;
}

async function tokenRow(token: string, lock = false, client: Pick<Pool | PoolClient, 'query'> = getPool()) {
  return (await client.query<TokenRow>(`SELECT t.id,t.workspace_id AS "workspaceId",t.recipient_id AS "recipientId",r.contact_id AS "contactId",
      t.purpose_key AS "purposeKey",t.all_marketing AS "allMarketing",t.expires_at AS "expiresAt",t.used_at AS "usedAt",
      t.revoked_at AS "revokedAt",coalesce(p.label,'Marketing email') AS "purposeLabel",
      r.scope_snapshot AS "scopeSnapshot",r.scope_sources AS "scopeSources"
    FROM campaign_unsubscribe_tokens t JOIN campaign_email_recipients r ON r.id=t.recipient_id AND r.workspace_id=t.workspace_id
    LEFT JOIN crm_consent_purposes p ON p.workspace_id=t.workspace_id AND p.purpose_key=t.purpose_key
    WHERE t.token_hash=$1 ${lock ? 'FOR UPDATE OF t' : ''}`, [sha256(token)])).rows[0] ?? null
}

export function createCampaignPublicEmailService() {
  return {
    async preview(token: string) {
      tokenSchema.parse(token)
      const row = await tokenRow(token)
      if (!row || row.revokedAt || row.expiresAt <= new Date()) return null
      return { purposeLabel: row.purposeLabel, canUnsubscribeAll: row.allMarketing, alreadyUsed: Boolean(row.usedAt) }
    },
    async unsubscribe(token: string, scope: 'purpose' | 'all') {
      tokenSchema.parse(token)
      const client = await getPool().connect()
      try {
        await client.query('BEGIN')
        const row = await tokenRow(token, true, client)
        if (!row || row.revokedAt || row.expiresAt <= new Date()) { await client.query('ROLLBACK'); return null }
        const purposes = scope === 'all' && row.allMarketing
          ? (await client.query<{ purposeKey: string }>(`SELECT purpose_key AS "purposeKey" FROM crm_consent_purposes
              WHERE workspace_id=$1 AND archived_at IS NULL AND 'email'=ANY(applicable_channels) ORDER BY purpose_key`, [row.workspaceId])).rows
          : [{ purposeKey: row.purposeKey }]
        for (const purpose of purposes) {
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
            `crm-consent:${row.workspaceId}:${row.contactId}:${purpose.purposeKey}`,
          ])
          await client.query(`INSERT INTO association_consent_events
            (workspace_id,contact_id,purpose,purpose_id,action,wording_version,wording_hash,wording_snapshot,source,occurred_at,
             provider,provider_event_id,metadata,actor_kind,request_fingerprint,wording_version_id,scope_snapshot,scope_sources)
            SELECT p.workspace_id,$2,p.purpose_key,p.id,'withdrawn',p.active_wording_version,p.wording_hash,p.wording_snapshot,
              'native_campaign',clock_timestamp(),'native_campaign',$3,jsonb_build_object('unsubscribeTokenId',$4::text),'provider',
              $5,v.id,$7::jsonb,$8::jsonb
            FROM crm_consent_purposes p JOIN crm_consent_purpose_versions v
              ON v.workspace_id=p.workspace_id AND v.purpose_id=p.id AND v.version=p.active_wording_version
            WHERE p.workspace_id=$1 AND p.purpose_key=$6
            ON CONFLICT(workspace_id,provider,provider_event_id) WHERE provider IS NOT NULL DO NOTHING`, [
            row.workspaceId, row.contactId, `${row.id}:${purpose.purposeKey}`, row.id,
            sha256(JSON.stringify({ tokenId: row.id, purposeKey: purpose.purposeKey, action: 'withdrawn' })), purpose.purposeKey,
            // The withdrawal inherits the recipient's saved floor, so authorized staff can see it and it is never unclassified.
            row.scopeSnapshot ? JSON.stringify(row.scopeSnapshot) : null, row.scopeSources ? JSON.stringify(row.scopeSources) : null,
          ])
        }
        await client.query('UPDATE campaign_unsubscribe_tokens SET used_at=coalesce(used_at,clock_timestamp()) WHERE id=$1', [row.id])
        await client.query('COMMIT')
        return { unsubscribed: true, scope: scope === 'all' && row.allMarketing ? 'all' : 'purpose', alreadyUsed: Boolean(row.usedAt) }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      } finally { client.release() }
    },
  }
}

export function campaignPublicEmailRoutes(options: {
  service?: ReturnType<typeof createCampaignPublicEmailService>
  tracking?: CampaignTrackingStore
} = {}): Router {
  const router = Router(), service = options.service ?? createCampaignPublicEmailService()
  const tracking = options.tracking ?? createCampaignTrackingStore()
  const unavailable = (res: Response) => res.status(404).set('Cache-Control', 'no-store').type('text/plain').send('This email preference link is unavailable.')

  router.get('/c/unsubscribe/:token', async (req, res) => {
    const parsed = tokenSchema.safeParse(req.params.token)
    if (!parsed.success) return void unavailable(res)
    const preview = await service.preview(parsed.data).catch(() => null)
    if (!preview) return void unavailable(res)
    res.set('Cache-Control', 'no-store').type('html').send(`<!doctype html><html><body><main><h1>Email preferences</h1><p>Stop receiving ${preview.purposeLabel.replace(/[<>&]/g, '')}.</p><form method="post"><button name="scope" value="purpose">Unsubscribe</button>${preview.canUnsubscribeAll ? '<button name="scope" value="all">Unsubscribe from all marketing</button>' : ''}</form></main></body></html>`)
  })
  router.post('/c/unsubscribe/:token', express.urlencoded({ extended: false, limit: '2kb' }), async (req, res) => {
    const parsed = tokenSchema.safeParse(req.params.token)
    if (!parsed.success) return void unavailable(res)
    const oneClick = req.body?.['List-Unsubscribe'] === 'One-Click'
    const scope = !oneClick && req.body?.scope === 'all' ? 'all' : 'purpose'
    const result = await service.unsubscribe(parsed.data, scope).catch(() => null)
    if (!result) return void unavailable(res)
    if (oneClick) return void res.status(204).set('Cache-Control', 'no-store').end()
    res.set('Cache-Control', 'no-store').type('html').send('<!doctype html><html><body><main><h1>Email preferences updated</h1><p>You have been unsubscribed.</p></main></body></html>')
  })
  router.get('/e/:token', async (req, res) => {
    const parsed = tokenSchema.safeParse(req.params.token)
    if (!parsed.success) return void unavailable(res)
    const row = (await query<CampaignLinkRow>(`SELECT l.destination_url AS destination,l.public_id AS "publicId",l.id,l.workspace_id AS "workspaceId",
        l.campaign_id AS "campaignId",l.placement_id AS "placementId",l.created_at AS "createdAt",l.enabled,l.utm_snapshot AS utm
      FROM campaign_email_link_tokens t JOIN campaign_links l ON l.id=t.link_id AND l.workspace_id=t.workspace_id
      WHERE t.token_hash=$1 AND t.revoked_at IS NULL AND t.expires_at>clock_timestamp() AND l.enabled`, [sha256(parsed.data)])).rows[0]
    if (!row) return void unavailable(res)
    void tracking.recordRedirectRequest(row, req.get('user-agent'), req.query.brian_test === '1')
      .catch(error => console.error('[campaign-email] click observation failed:', error))
    res.set('Cache-Control', 'private, no-store, max-age=0').redirect(307, row.destination)
  })
  return router
}
