/** First-party campaign collection, conversion, and report persistence. [COMP:campaigns/tracking] */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import {
  classifyCampaignRequest,
  normalizeBrowserOccurredAt,
  selectCampaignAttribution,
  type CampaignTouch,
} from '@use-brian/core/campaigns/attribution.js'
import { CampaignError } from '@use-brian/core/campaigns/types.js'
import {
  CAMPAIGN_LIMITS,
  campaignBrowserEventSchema,
  campaignSiteSaveSchema,
  campaignTrustedConversionSchema,
  type CampaignBrowserEvent,
  type CampaignSiteSave,
  type CampaignTrustedConversion,
} from '@use-brian/shared/campaigns'
import { getPool } from './client.js'
import type { CampaignQueryable } from './campaign-store.js'

const COLLECTIONS_PER_MINUTE = 1_000

export type CampaignSiteRow = {
  id: string
  workspaceId: string
  publicId: string
  name: string
  allowedOrigins: string[]
  conversionDefinitions: Array<{ key: string; label: string; enabled: boolean }>
  storageMode: 'none' | 'first_party'
  cookieDomain: string | null
  siteGroupKey: string | null
  rawRetentionDays: number
  aggregateRetentionMonths: number
  enabled: boolean
  version: number
}

export type CampaignSiteCredential = {
  id: string
  workspaceId: string
  siteId: string
  grants: string[]
  keyPrefix: string
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function pseudonym(siteId: string, value: string | undefined): string | null {
  return value ? createHash('sha256').update(`${siteId}:${value}`).digest('hex') : null
}

function mapSite(row: Record<string, unknown>): CampaignSiteRow {
  return {
    id: row.id as string,
    workspaceId: row.workspaceId as string,
    publicId: row.publicId as string,
    name: row.name as string,
    allowedOrigins: row.allowedOrigins as string[],
    conversionDefinitions: row.conversionDefinitions as CampaignSiteRow['conversionDefinitions'],
    storageMode: row.storageMode as CampaignSiteRow['storageMode'],
    cookieDomain: row.cookieDomain as string | null,
    siteGroupKey: row.siteGroupKey as string | null,
    rawRetentionDays: row.rawRetentionDays as number,
    aggregateRetentionMonths: row.aggregateRetentionMonths as number,
    enabled: row.enabled as boolean,
    version: row.version as number,
  }
}

const SITE_COLUMNS = `id,workspace_id AS "workspaceId",public_id AS "publicId",name,
  allowed_origins AS "allowedOrigins",conversion_definitions AS "conversionDefinitions",
  storage_mode AS "storageMode",cookie_domain AS "cookieDomain",site_group_key AS "siteGroupKey",
  raw_retention_days AS "rawRetentionDays",aggregate_retention_months AS "aggregateRetentionMonths",enabled,version`

async function transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const output = await run(client)
    await client.query('COMMIT')
    return output
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}

function parseCredential(token: string): { prefix: string; hash: string } | null {
  const match = /^(sk_campaign_[A-Za-z0-9_-]{8,64})\.([A-Za-z0-9_-]{32,128})$/.exec(token)
  return match ? { prefix: match[1]!, hash: createHash('sha256').update(token).digest('hex') } : null
}

async function findTouches(client: CampaignQueryable, site: CampaignSiteRow, conversion: CampaignTrustedConversion): Promise<CampaignTouch[]> {
  const sessionKey = pseudonym(site.id, conversion.attribution?.sessionId)
  const result = await client.query<Record<string, unknown>>(
    `SELECT e.event_id AS "eventId",e.occurred_at AS "occurredAt",e.utm_snapshot AS utm,
            e.metadata,e.evidence_level AS "acquisitionEvidence",l.id AS "linkId"
       FROM campaign_events e LEFT JOIN campaign_links l ON l.id=e.link_id
      WHERE e.workspace_id=$1 AND e.site_id=$2
        AND e.occurred_at >= $3::timestamptz - make_interval(days=>$4)
        AND e.occurred_at <= $3::timestamptz + interval '5 minutes'
        AND (($5::text IS NOT NULL AND e.session_key=$5)
          OR ($6::text IS NOT NULL AND l.public_id=$6))
      ORDER BY e.occurred_at,e.id LIMIT 500`,
    [site.workspaceId, site.id, conversion.occurredAt, CAMPAIGN_LIMITS.attributionLookbackDays,
      sessionKey, conversion.attribution?.linkId ?? null],
  )
  return result.rows.map(row => ({
    eventId: row.eventId as string,
    linkId: row.linkId as string | undefined,
    siteId: site.id,
    occurredAt: new Date(row.occurredAt as string | Date).toISOString(),
    utm: (row.utm ?? undefined) as CampaignTouch['utm'],
    acquisitionEvidence: row.acquisitionEvidence as CampaignTouch['acquisitionEvidence'],
    internalNavigation: Boolean((row.metadata as Record<string, unknown> | null)?.internal_navigation),
    direct: !row.linkId && !(row.utm as Record<string, unknown> | null)?.source,
  }))
}

async function insertTrustedConversion(
  client: CampaignQueryable,
  site: CampaignSiteRow,
  conversionInput: unknown,
  evidence: 'server_trusted' | 'crm_committed',
): Promise<{ duplicate: boolean; conversionId: string; attribution: ReturnType<typeof selectCampaignAttribution> }> {
  const conversion = campaignTrustedConversionSchema.parse(conversionInput)
  if (conversion.siteId !== site.publicId) throw new CampaignError('forbidden', 'The credential cannot write to this campaign site.')
  const definition = site.conversionDefinitions.find(item => item.key === conversion.conversionKind && item.enabled)
  if (!definition) throw new CampaignError('invalid_input', 'The conversion type is not enabled for this site.')
  const requestFingerprint = fingerprint(conversion)
  const touches = await findTouches(client, site, conversion)
  const attribution = selectCampaignAttribution(touches, conversion.occurredAt)

  let subjectLinkId: string | null = null
  let contactId: string | null = null
  if (conversion.subject?.kind === 'contact') {
    contactId = conversion.subject.id
    const linked = await client.query<{ id: string }>(
      `INSERT INTO campaign_subject_links
         (workspace_id,site_id,session_key,contact_id,source,purpose_key,evidence)
       VALUES($1,$2,$3,$4,$5,'campaign_attribution',$6) RETURNING id`,
      [site.workspaceId, site.id, pseudonym(site.id, conversion.attribution?.sessionId), contactId,
        evidence === 'crm_committed' ? 'committed_crm_intake' : 'verified_application_identity',
        JSON.stringify({ evidence, externalOutcomeId: conversion.externalOutcomeId })],
    )
    subjectLinkId = linked.rows[0]!.id
  }
  if (conversion.subject?.kind === 'application_subject') {
    const linked = await client.query<{ id: string }>(
      `INSERT INTO campaign_subject_links
         (workspace_id,site_id,session_key,application_subject_kind,application_subject_id,source,purpose_key,evidence)
       VALUES($1,$2,$3,$4,$5,'verified_application_identity','campaign_attribution',$6) RETURNING id`,
      [site.workspaceId, site.id, pseudonym(site.id, conversion.attribution?.sessionId), conversion.subject.kind,
        conversion.subject.id, JSON.stringify({ evidence, externalOutcomeId: conversion.externalOutcomeId })],
    )
    subjectLinkId = linked.rows[0]!.id
  }

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO campaign_conversions
       (workspace_id,site_id,conversion_kind,external_outcome_id,request_fingerprint,occurred_at,evidence_level,
        subject_link_id,contact_id,attribution_snapshot,value_minor,currency,metadata,is_test)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT(workspace_id,site_id,conversion_kind,external_outcome_id) DO NOTHING RETURNING id`,
    [site.workspaceId, site.id, conversion.conversionKind, conversion.externalOutcomeId, requestFingerprint,
      conversion.occurredAt, evidence, subjectLinkId, contactId, JSON.stringify(attribution),
      conversion.valueMinor ?? null, conversion.currency ?? null, JSON.stringify(conversion.metadata), conversion.test],
  )
  if (inserted.rows[0]) return { duplicate: false, conversionId: inserted.rows[0].id, attribution }

  const existing = await client.query<{ id: string; requestFingerprint: string; attribution: ReturnType<typeof selectCampaignAttribution> }>(
    `SELECT id,request_fingerprint AS "requestFingerprint",attribution_snapshot AS attribution
       FROM campaign_conversions WHERE workspace_id=$1 AND site_id=$2 AND conversion_kind=$3 AND external_outcome_id=$4`,
    [site.workspaceId, site.id, conversion.conversionKind, conversion.externalOutcomeId],
  )
  const row = existing.rows[0]!
  if (row.requestFingerprint !== requestFingerprint) {
    throw new CampaignError('conflict', 'The conversion idempotency identity was reused with changed data.')
  }
  // A losing concurrent insert may have created an unused subject link; remove
  // only that fresh evidence row. The canonical conversion remains immutable.
  if (subjectLinkId) await client.query('DELETE FROM campaign_subject_links WHERE id=$1', [subjectLinkId])
  return { duplicate: true, conversionId: row.id, attribution: row.attribution }
}

export type CampaignTrackingStore = ReturnType<typeof createCampaignTrackingStore>

export function createCampaignTrackingStore() {
  return {
    async saveSite(client: CampaignQueryable, workspaceId: string, actorUserId: string | null, raw: CampaignSiteSave): Promise<CampaignSiteRow> {
      const input = campaignSiteSaveSchema.parse(raw)
      if (!input.siteId) {
        const inserted = await client.query<Record<string, unknown>>(
          `INSERT INTO campaign_sites
             (workspace_id,name,allowed_origins,conversion_definitions,storage_mode,cookie_domain,site_group_key,
              raw_retention_days,aggregate_retention_months,created_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${SITE_COLUMNS}`,
          [workspaceId, input.name, JSON.stringify(input.allowedOrigins), JSON.stringify(input.conversionDefinitions),
            input.storageMode, input.cookieDomain ?? null, input.siteGroupKey ?? null,
            input.rawRetentionDays, input.aggregateRetentionMonths, actorUserId],
        )
        return mapSite(inserted.rows[0]!)
      }
      if (!input.expectedVersion) throw new CampaignError('conflict', 'expectedVersion is required when editing a campaign site.')
      const updated = await client.query<Record<string, unknown>>(
        `UPDATE campaign_sites SET name=$3,allowed_origins=$4,conversion_definitions=$5,storage_mode=$6,
            cookie_domain=$7,site_group_key=$8,raw_retention_days=$9,aggregate_retention_months=$10,version=version+1
          WHERE workspace_id=$1 AND id=$2 AND version=$11 RETURNING ${SITE_COLUMNS}`,
        [workspaceId, input.siteId, input.name, JSON.stringify(input.allowedOrigins), JSON.stringify(input.conversionDefinitions),
          input.storageMode, input.cookieDomain ?? null, input.siteGroupKey ?? null,
          input.rawRetentionDays, input.aggregateRetentionMonths, input.expectedVersion],
      )
      if (!updated.rows[0]) throw new CampaignError('conflict', 'Campaign site revision changed or is unavailable.')
      return mapSite(updated.rows[0])
    },

    async listSites(workspaceId: string): Promise<CampaignSiteRow[]> {
      const result = await getPool().query<Record<string, unknown>>(
        `SELECT ${SITE_COLUMNS} FROM campaign_sites WHERE workspace_id=$1 ORDER BY created_at,id`, [workspaceId],
      )
      return result.rows.map(mapSite)
    },

    async getSiteByPublicId(publicId: string): Promise<CampaignSiteRow | null> {
      const result = await getPool().query<Record<string, unknown>>(
        `SELECT ${SITE_COLUMNS} FROM campaign_sites WHERE public_id=$1`, [publicId],
      )
      return result.rows[0] ? mapSite(result.rows[0]) : null
    },

    async issueCredential(workspaceId: string, siteId: string, actorUserId: string): Promise<{ credentialId: string; keyPrefix: string; secret: string }> {
      const keyPrefix = `sk_campaign_${randomBytes(9).toString('base64url')}`
      const secret = `${keyPrefix}.${randomBytes(32).toString('base64url')}`
      const secretHash = createHash('sha256').update(secret).digest('hex')
      return transaction(async (client) => {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO campaign_site_credentials(workspace_id,site_id,key_prefix,secret_hash,created_by)
           SELECT $1,$2,$3,$4,$5 WHERE EXISTS(
             SELECT 1 FROM campaign_sites WHERE workspace_id=$1 AND id=$2 AND enabled=true
           ) RETURNING id`,
          [workspaceId, siteId, keyPrefix, secretHash, actorUserId],
        )
        if (!inserted.rows[0]) throw new CampaignError('not_found', 'Campaign site not found.')
        return { credentialId: inserted.rows[0].id, keyPrefix, secret }
      })
    },

    async revokeCredential(workspaceId: string, siteId: string, credentialId: string): Promise<boolean> {
      const result = await getPool().query(
        `UPDATE campaign_site_credentials SET revoked_at=COALESCE(revoked_at,clock_timestamp())
          WHERE workspace_id=$1 AND site_id=$2 AND id=$3`,
        [workspaceId, siteId, credentialId],
      )
      return result.rowCount === 1
    },

    async authenticateCredential(token: string): Promise<(CampaignSiteCredential & { site: CampaignSiteRow }) | null> {
      const parsed = parseCredential(token)
      if (!parsed) return null
      const result = await getPool().query<Record<string, unknown>>(
        `SELECT c.id,c.workspace_id AS "workspaceId",c.site_id AS "siteId",c.grants,c.key_prefix AS "keyPrefix",
                s.id AS "campaignSiteId",s.workspace_id AS "campaignSiteWorkspaceId",s.public_id AS "campaignSitePublicId",
                s.name AS "campaignSiteName",s.allowed_origins AS "campaignSiteAllowedOrigins",
                s.conversion_definitions AS "campaignSiteConversionDefinitions",s.storage_mode AS "campaignSiteStorageMode",
                s.cookie_domain AS "campaignSiteCookieDomain",s.site_group_key AS "campaignSiteGroupKey",
                s.raw_retention_days AS "campaignSiteRawRetentionDays",
                s.aggregate_retention_months AS "campaignSiteAggregateRetentionMonths",
                s.enabled AS "campaignSiteEnabled",s.version AS "campaignSiteVersion"
           FROM campaign_site_credentials c JOIN campaign_sites s ON s.id=c.site_id AND s.workspace_id=c.workspace_id
          WHERE c.key_prefix=$1 AND c.secret_hash=$2 AND c.revoked_at IS NULL AND s.enabled=true`,
        [parsed.prefix, parsed.hash],
      )
      const row = result.rows[0]
      return row ? {
        id: row.id as string,
        workspaceId: row.workspaceId as string,
        siteId: row.siteId as string,
        grants: row.grants as string[],
        keyPrefix: row.keyPrefix as string,
        site: mapSite({
          id: row.campaignSiteId,
          workspaceId: row.campaignSiteWorkspaceId,
          publicId: row.campaignSitePublicId,
          name: row.campaignSiteName,
          allowedOrigins: row.campaignSiteAllowedOrigins,
          conversionDefinitions: row.campaignSiteConversionDefinitions,
          storageMode: row.campaignSiteStorageMode,
          cookieDomain: row.campaignSiteCookieDomain,
          siteGroupKey: row.campaignSiteGroupKey,
          rawRetentionDays: row.campaignSiteRawRetentionDays,
          aggregateRetentionMonths: row.campaignSiteAggregateRetentionMonths,
          enabled: row.campaignSiteEnabled,
          version: row.campaignSiteVersion,
        }),
      } : null
    },

    async collectBrowserEvent(site: CampaignSiteRow, origin: string, raw: unknown, userAgent?: string): Promise<{ duplicate: boolean; eventId: string }> {
      const event = campaignBrowserEventSchema.parse(raw)
      if (!site.enabled) throw new CampaignError('unavailable', 'Campaign collection is disabled for this site.')
      if (event.siteId !== site.publicId) throw new CampaignError('forbidden', 'The event site does not match the configured site.')
      if (!site.allowedOrigins.includes(origin)) throw new CampaignError('forbidden', 'This origin is not allowed for the campaign site.')
      const receivedAt = new Date()
      const occurredAt = normalizeBrowserOccurredAt(event.occurredAt, receivedAt)
      const requestFingerprint = fingerprint(event)
      return transaction(async (client) => {
        const quota = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM campaign_events WHERE site_id=$1 AND received_at >= clock_timestamp()-interval '1 minute'`,
          [site.id],
        )
        if (Number(quota.rows[0]?.count ?? 0) >= COLLECTIONS_PER_MINUTE) {
          throw new CampaignError('rate_limited', 'Campaign collection quota reached. Retry later.')
        }
        let linkId: string | null = null
        if (event.linkId) {
          const link = await client.query<{ id: string }>(
            `SELECT id FROM campaign_links WHERE workspace_id=$1 AND public_id=$2 AND enabled=true`,
            [site.workspaceId, event.linkId],
          )
          linkId = link.rows[0]?.id ?? null
        }
        const internalNavigation = event.referrerOrigin ? site.allowedOrigins.includes(event.referrerOrigin) : false
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO campaign_events
             (workspace_id,site_id,event_id,request_fingerprint,event_type,evidence_level,link_id,session_key,visitor_key,
              occurred_at,received_at,page_path,referrer_origin,utm_snapshot,metadata,is_test,bot_class,classification_version,expires_at)
           VALUES($1,$2,$3,$4,$5,'browser_observed',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,1,$17)
           ON CONFLICT(site_id,event_id) DO NOTHING RETURNING id`,
          [site.workspaceId, site.id, event.eventId, requestFingerprint, event.type, linkId,
            pseudonym(site.id, event.sessionId), pseudonym(site.id, event.visitorId), occurredAt, receivedAt,
            event.pagePath, event.referrerOrigin ?? null, event.utm ? JSON.stringify(event.utm) : null,
            JSON.stringify({ ...event.metadata, internal_navigation: internalNavigation }), event.test,
            classifyCampaignRequest(userAgent), new Date(receivedAt.getTime() + site.rawRetentionDays * 24 * 60 * 60_000)],
        )
        if (inserted.rows[0]) return { duplicate: false, eventId: inserted.rows[0].id }
        const existing = await client.query<{ id: string; requestFingerprint: string }>(
          `SELECT id,request_fingerprint AS "requestFingerprint" FROM campaign_events WHERE site_id=$1 AND event_id=$2`,
          [site.id, event.eventId],
        )
        if (existing.rows[0]?.requestFingerprint !== requestFingerprint) {
          throw new CampaignError('conflict', 'The browser event id was reused with changed data.')
        }
        return { duplicate: true, eventId: existing.rows[0]!.id }
      })
    },

    async recordRedirectRequest(link: { workspaceId: string; id: string; destination: string }, userAgent?: string, test = false): Promise<void> {
      const destinationOrigin = new URL(link.destination).origin
      await transaction(async (client) => {
        const siteResult = await client.query<Record<string, unknown>>(
          `SELECT ${SITE_COLUMNS} FROM campaign_sites
            WHERE workspace_id=$1 AND enabled=true AND allowed_origins @> $2::jsonb
            ORDER BY created_at,id LIMIT 1`,
          [link.workspaceId, JSON.stringify([destinationOrigin])],
        )
        if (!siteResult.rows[0]) return
        const site = mapSite(siteResult.rows[0])
        const now = new Date()
        const eventId = randomUUID().replaceAll('-', '')
        await client.query(
          `INSERT INTO campaign_events
             (workspace_id,site_id,event_id,request_fingerprint,event_type,evidence_level,link_id,occurred_at,
              received_at,page_path,metadata,is_test,bot_class,classification_version,expires_at)
           VALUES($1,$2,$3,$4,'redirect_request','browser_observed',$5,$6,$6,'/', '{}'::jsonb,$7,$8,1,$9)`,
          [link.workspaceId, site.id, eventId, fingerprint({ eventId, linkId: link.id, test }), link.id, now, test,
            classifyCampaignRequest(userAgent), new Date(now.getTime() + site.rawRetentionDays * 24 * 60 * 60_000)],
        )
      })
    },

    async recordTrustedConversion(principal: CampaignSiteCredential & { site: CampaignSiteRow }, raw: unknown) {
      if (!principal.grants.includes('conversion:write')) throw new CampaignError('forbidden', 'The credential lacks conversion write scope.')
      const conversion = campaignTrustedConversionSchema.parse(raw)
      if (conversion.subject?.kind === 'contact') {
        throw new CampaignError('forbidden', 'A site credential cannot assert a CRM contact identity.')
      }
      return transaction(client => insertTrustedConversion(client, principal.site, conversion, 'server_trusted'))
    },

    async recordCommittedConversion(client: CampaignQueryable, workspaceId: string, payload: {
      sitePublicId: string
      conversionKind: 'signup_completed' | 'enquiry_submitted' | 'activation_completed'
      externalOutcomeId: string
      occurredAt: string
      contactId?: string
      attribution?: CampaignTrustedConversion['attribution']
      test?: boolean
    }) {
      const siteResult = await client.query<Record<string, unknown>>(
        `SELECT ${SITE_COLUMNS} FROM campaign_sites WHERE workspace_id=$1 AND public_id=$2 AND enabled=true`,
        [workspaceId, payload.sitePublicId],
      )
      if (!siteResult.rows[0]) throw new CampaignError('not_found', 'Campaign site not found.')
      const site = mapSite(siteResult.rows[0])
      return insertTrustedConversion(client, site, {
        version: 1,
        siteId: site.publicId,
        conversionKind: payload.conversionKind,
        externalOutcomeId: payload.externalOutcomeId,
        occurredAt: payload.occurredAt,
        attribution: payload.attribution,
        subject: payload.contactId ? { kind: 'contact', id: payload.contactId } : undefined,
        test: payload.test ?? false,
        metadata: {},
      }, 'crm_committed')
    },

    async trackingSetup(workspaceId: string, siteId?: string): Promise<Record<string, unknown>> {
      const sites = await this.listSites(workspaceId)
      const selected = siteId ? sites.filter(site => site.id === siteId) : sites
      if (selected.length === 0) return { state: 'not_installed', sites: [] }
      return {
        state: selected.some(site => site.enabled) ? 'available' : 'disabled',
        sites: selected.map(site => ({ ...site, credential: 'server_only' })),
      }
    },

    async results(workspaceId: string, campaignId: string, filters: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
      const sites = await this.listSites(workspaceId)
      const includeTest = filters.include_test === true
      const emailAccepted = Number((await getPool().query<{ count: string }>(`SELECT coalesce(sum(email_accepted),0)::text AS count
        FROM campaign_daily_metrics WHERE workspace_id=$1 AND campaign_id=$2 AND ($3 OR NOT is_test)`,
      [workspaceId, campaignId, includeTest])).rows[0]?.count ?? 0)
      if (sites.length === 0 && emailAccepted === 0) return { state: 'not_installed', reason: 'Tracking not connected' }
      if (sites.length > 0 && !sites.some(site => site.enabled) && emailAccepted === 0) return { state: 'disabled', reason: 'Campaign collection is disabled' }
      const model = filters.model === 'first_touch' ? 'firstTouch' : 'lastTouch'
      const [events, conversions] = await Promise.all([
        getPool().query<{ rawRedirectRequests: string; filteredRedirectRequests: string; pageViews: string; sessions: string; visitors: string }>(
          `SELECT count(*) FILTER(WHERE e.event_type='redirect_request')::text AS "rawRedirectRequests",
                  count(*) FILTER(WHERE e.event_type='redirect_request' AND e.bot_class='observed_browser')::text AS "filteredRedirectRequests",
                  count(*) FILTER(WHERE e.event_type='page_view')::text AS "pageViews",
                  count(DISTINCT e.session_key) FILTER(WHERE e.session_key IS NOT NULL)::text AS sessions,
                  count(DISTINCT e.visitor_key) FILTER(WHERE e.visitor_key IS NOT NULL)::text AS visitors
             FROM campaign_events e JOIN campaign_links l ON l.id=e.link_id
            WHERE e.workspace_id=$1 AND l.campaign_id=$2 AND ($3 OR NOT e.is_test)`,
          [workspaceId, campaignId, includeTest],
        ),
        getPool().query<{ count: string }>(
          `SELECT count(DISTINCT c.id)::text AS count FROM campaign_conversions c
             JOIN campaign_links l ON l.id=(c.attribution_snapshot->$3->>'linkId')::uuid
            WHERE c.workspace_id=$1 AND l.campaign_id=$2 AND ($4 OR NOT c.is_test)`,
          [workspaceId, campaignId, model, includeTest],
        ),
      ])
      const row = events.rows[0]!
      const continuityAvailable = sites.some(site => site.enabled && site.storageMode === 'first_party')
      return {
        state: 'available',
        model: model === 'firstTouch' ? 'first_touch' : 'last_touch',
        rawRedirectRequests: Number(row.rawRedirectRequests),
        filteredRedirectRequests: Number(row.filteredRedirectRequests),
        pageViews: Number(row.pageViews),
        sessions: continuityAvailable ? Number(row.sessions) : null,
        visitors: continuityAvailable ? Number(row.visitors) : null,
        verifiedConversions: Number(conversions.rows[0]?.count ?? 0),
        emailAccepted,
        denominator: continuityAvailable ? 'sessions' : 'unavailable',
        limitations: [
          'Observed acquisition association is not proof of causal credit.',
          'Social impressions are unavailable without provider evidence.',
          'SMTP acceptance is available; inbox delivery, opens, replies, bounces, and complaints are unavailable without provider evidence.',
          ...(!continuityAvailable ? ['Session and visitor continuity are unavailable without permitted first-party storage.'] : []),
        ],
      }
    },

    async attribution(workspaceId: string, campaignId: string, filters: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
      const model = filters.model === 'first_touch' ? 'firstTouch' : 'lastTouch'
      const limit = Math.min(100, Math.max(1, Number(filters.limit ?? 50)))
      const result = await getPool().query<Record<string, unknown>>(
        `SELECT c.id,c.conversion_kind AS "conversionKind",c.occurred_at AS "occurredAt",c.evidence_level AS "conversionEvidence",
                c.attribution_snapshot AS attribution,c.contact_id AS "contactId",c.deal_id AS "dealId",c.value_minor AS "valueMinor",c.currency
           FROM campaign_conversions c JOIN campaign_links l ON l.id=(c.attribution_snapshot->$3->>'linkId')::uuid
          WHERE c.workspace_id=$1 AND l.campaign_id=$2 AND NOT c.is_test
          ORDER BY c.occurred_at DESC,c.id DESC LIMIT $4`,
        [workspaceId, campaignId, model, limit],
      )
      return { state: 'available', model: model === 'firstTouch' ? 'first_touch' : 'last_touch', conversions: result.rows }
    },

    async subjectAttribution(workspaceId: string, subjectId: string): Promise<Record<string, unknown>> {
      const result = await getPool().query<Record<string, unknown>>(
        `SELECT c.id,c.conversion_kind AS "conversionKind",c.occurred_at AS "occurredAt",
                c.evidence_level AS "conversionEvidence",c.attribution_snapshot AS attribution,
                p.id AS "campaignId",p.name AS "campaignName",l.id AS "linkId",l.destination_url AS destination,
                cp.channel,cp.placement_key AS "placementKey"
           FROM campaign_conversions c
           LEFT JOIN campaign_links l ON l.id=(c.attribution_snapshot->'lastTouch'->>'linkId')::uuid
           LEFT JOIN campaigns p ON p.id=l.campaign_id AND p.workspace_id=c.workspace_id
           LEFT JOIN campaign_placements cp ON cp.id=l.placement_id AND cp.workspace_id=c.workspace_id
          WHERE c.workspace_id=$1 AND (c.contact_id=$2 OR c.deal_id=$2)
          ORDER BY c.occurred_at DESC,c.id DESC LIMIT 100`,
        [workspaceId, subjectId],
      )
      return { state: result.rows.length ? 'available' : 'empty', conversions: result.rows,
        limitation: 'Acquisition is observed attribution, not proof of causal credit.' }
    },
  }
}

export async function pruneCampaignTracking(now = new Date()): Promise<{ events: number; aggregates: number }> {
  const result = await transaction(async (client) => {
    const events = await client.query('DELETE FROM campaign_events WHERE expires_at <= $1', [now])
    const aggregates = await client.query(
      `DELETE FROM campaign_daily_metrics m USING campaign_sites s
        WHERE s.workspace_id=m.workspace_id AND s.id=m.site_id
          AND m.metric_date < ($1::date - make_interval(months=>s.aggregate_retention_months))::date`, [now],
    )
    return { events: events.rowCount ?? 0, aggregates: aggregates.rowCount ?? 0 }
  })
  return result
}
