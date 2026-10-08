/** Native campaign Email revision, preview, and audience boundary. [COMP:campaigns/email] */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  CampaignError,
  evaluateCrmSendability,
  type CrmDeliveryServicePort,
  type CrmOperationsContext,
} from '@use-brian/core'
import {
  CAMPAIGN_LIMITS,
  campaignEmailMetadataSchema,
  type CampaignEmailMetadata,
} from '@use-brian/shared/campaigns'
import { feedCompositionHtml, projectFeed } from '@use-brian/doc-model'
import { getPool, query } from '../db/client.js'
import {
  executeFeedCommands,
  requireFeedComposition,
  type FeedActor,
  type StructuredFeedContent,
} from '../db/feed-collaboration-store.js'
import { createDbCrmSegmentStore } from '../db/crm-segment-store.js'
import { crmSegmentReadScope, type CrmSegmentReadScope } from '../association/source-scope.js'
import type { AssociationActor, CampaignActor } from '@use-brian/core'

/** The campaign actor as the Association/CRM read principal; unknown kinds fail closed downstream. */
export function campaignReadActor(actor: CampaignActor): AssociationActor {
  return {
    credentialKind: actor.kind,
    credentialId: actor.credentialId ?? actor.assistantId ?? actor.userId ?? 'unknown',
    ...(actor.userId ? { actingUserId: actor.userId } : {}),
  }
}

const tokenPattern = /{{\s*([a-z][a-z0-9_]*)\s*}}/g
const htmlEscape = (value: string) => value.replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]!)

export class CampaignEmailError extends CampaignError {}

function personalizationValues(metadata: CampaignEmailMetadata, raw: Record<string, string>): Record<string, string> {
  const specs = new Map(metadata.personalization.map(spec => [spec.field, spec]))
  const values: Record<string, string> = {}
  for (const [field, spec] of specs) {
    const supplied = raw[field]?.trim()
    if (supplied) values[field] = supplied
    else if (spec.fallback !== undefined) values[field] = spec.fallback
    else if (spec.required) throw new CampaignEmailError('conflict', `Required personalization is missing: ${field}.`, { field })
    else values[field] = ''
  }
  return values
}

function interpolate(value: string, metadata: CampaignEmailMetadata, raw: Record<string, string>, escape = false): string {
  const allowed = new Set(metadata.personalization.map(spec => spec.field))
  const values = personalizationValues(metadata, raw)
  return value.replace(tokenPattern, (_token, field: string) => {
    if (!allowed.has(field as never)) {
      throw new CampaignEmailError('invalid_input', `Unknown personalization field: ${field}.`, {
        field,
        allowedFields: [...allowed],
      })
    }
    const resolved = values[field] ?? ''
    return escape ? htmlEscape(resolved) : resolved
  })
}

export type CampaignEmailProjection = {
  subject: string
  preheader: string | null
  text: string
  html: string
}

export function campaignEmailApprovalCurrent(approvedRevision: number, currentRevision: number, state: string): boolean {
  return approvedRevision === currentRevision && !['cancelled', 'completed'].includes(state)
}

export function freezeCampaignAudienceSnapshot(input: {
  segmentId: string
  segmentVersion: number
  recipients: Array<{ contactId: string; address: string; personalization: Record<string, string>; eligibility: Record<string, unknown> }>
  excluded: Array<Record<string, unknown>>
}) {
  const seen = new Set<string>()
  const recipients = input.recipients.map(item => ({
    contactId: item.contactId,
    address: item.address.trim().toLowerCase(),
    personalization: structuredClone(item.personalization),
    eligibility: structuredClone(item.eligibility),
  })).filter(item => item.address && !seen.has(item.address) && Boolean(seen.add(item.address)))
  return structuredClone({
    version: 1 as const,
    segmentId: input.segmentId,
    segmentVersion: input.segmentVersion,
    capturedAt: new Date().toISOString(),
    recipients,
    excluded: input.excluded,
  })
}

/** Deterministic projections; HTML is derived and never an editable source. */
export function renderCampaignEmail(
  content: StructuredFeedContent,
  metadataInput: CampaignEmailMetadata,
  rawValues: Record<string, string> = {},
): CampaignEmailProjection {
  const metadata = campaignEmailMetadataSchema.parse(metadataInput)
  const projection = projectFeed(content.composition)
  if (projection.missingSlots.length) throw new CampaignEmailError('conflict', 'Email contains unfinished generation slots.')
  const text = interpolate(projection.text, metadata, rawValues)
  const body = interpolate(feedCompositionHtml(content.composition), metadata, rawValues, true)
  const preheader = metadata.preheader ? interpolate(metadata.preheader, metadata, rawValues) : null
  const hidden = preheader
    ? `<span data-brian-preheader style="display:none!important;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">${htmlEscape(preheader)}</span>`
    : ''
  return {
    subject: interpolate(metadata.subject, metadata, rawValues),
    preheader,
    text: preheader ? `${preheader}\n\n${text}` : text,
    html: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${hidden}<main>${body}</main></body></html>`,
  }
}

export type CampaignEmailDraft = {
  campaignId: string
  placementId: string
  sessionId: string
  assistantId: string
  revision: number
  content: StructuredFeedContent
  metadata: CampaignEmailMetadata | null
  approval: { dispatchId: string; revision: number; state: string; current: boolean } | null
}

async function loadDraft(
  workspaceId: string,
  placementId: string,
  revision?: number,
): Promise<CampaignEmailDraft> {
  const placement = (await query<{
    campaignId: string; placementId: string; sessionId: string; assistantId: string;
    currentRevision: number; currentContent: StructuredFeedContent; dispatchId: string | null;
  }>(`SELECT p.campaign_id AS "campaignId",p.id AS "placementId",p.session_id AS "sessionId",
            s.assistant_id AS "assistantId",w.revision AS "currentRevision",w.content AS "currentContent",p.dispatch_id AS "dispatchId"
       FROM campaign_placements p
       JOIN sessions s ON s.id=p.session_id
       JOIN assistants a ON a.id=s.assistant_id AND a.workspace_id=p.workspace_id
       JOIN feed_post_working_copies w ON w.session_id=p.session_id
      WHERE p.workspace_id=$1 AND p.id=$2 AND p.channel='email' AND p.placement_kind='email_body' AND feed_draft_audience_allowed(p.session_id)`,
    [workspaceId, placementId])).rows[0]
  if (!placement) throw new CampaignEmailError('not_found', 'Email campaign placement was not found.')
  let selectedRevision = placement.currentRevision
  let rawContent = placement.currentContent
  if (revision !== undefined && revision !== placement.currentRevision) {
    const historical = (await query<{ content: StructuredFeedContent }>(
      `SELECT content FROM feed_post_revisions WHERE session_id=$1 AND revision=$2`,
      [placement.sessionId, revision],
    )).rows[0]
    if (!historical) throw new CampaignEmailError('conflict', 'The requested Email revision is unavailable.')
    selectedRevision = revision
    rawContent = historical.content
  }
  const content = requireFeedComposition(rawContent)
  const parsed = campaignEmailMetadataSchema.safeParse(content.email)
  const dispatch = placement.dispatchId ? (await query<{ dispatchId: string; revision: number; state: string }>(
    `SELECT id AS "dispatchId",approved_revision AS revision,state FROM campaign_email_dispatches
      WHERE workspace_id=$1 AND id=$2`, [workspaceId, placement.dispatchId],
  )).rows[0] ?? null : null
  return {
    campaignId: placement.campaignId,
    placementId: placement.placementId,
    sessionId: placement.sessionId,
    assistantId: placement.assistantId,
    revision: selectedRevision,
    content,
    metadata: parsed.success ? parsed.data : null,
    approval: dispatch ? { ...dispatch, current: campaignEmailApprovalCurrent(dispatch.revision, selectedRevision, dispatch.state) } : null,
  }
}

type AudienceContact = {
  id: string
  name: string
  email: string | null
  attributes: Record<string, unknown>
}

function contactPersonalization(contact: AudienceContact): Record<string, string> {
  const names = contact.name.trim().split(/\s+/)
  return {
    first_name: typeof contact.attributes.first_name === 'string' ? contact.attributes.first_name : names[0] ?? '',
    last_name: typeof contact.attributes.last_name === 'string' ? contact.attributes.last_name : names.slice(1).join(' '),
    display_name: contact.name,
    company_name: typeof contact.attributes.company_name === 'string' ? contact.attributes.company_name : '',
  }
}

async function verdictFor(workspaceId: string, contact: AudienceContact, purposeKey: string, scope: CrmSegmentReadScope | null) {
  const purpose = (await query<{ archived: boolean; requiresConsent: boolean; applicableChannels: string[] }>(
    `SELECT archived_at IS NOT NULL AS archived,requires_consent AS "requiresConsent",applicable_channels AS "applicableChannels"
       FROM crm_consent_purposes WHERE workspace_id=$1 AND purpose_key=$2`, [workspaceId, purposeKey],
  )).rows[0]
  if (!purpose) return { verdict: 'unknown' as const, reasons: ['purpose_unavailable'] }
  const instant = `to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt",
    to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"`
  // The deciding consent/suppression rows must be readable by the actor; an unreadable
  // latest row is never replaced by an older readable one (that could resurrect a withdrawn consent).
  const readable = (table: string) => scope
    ? `,EXISTS(SELECT 1 FROM ${table} WHERE ${table}.workspace_id=x.workspace_id AND ${table}.id=x.id AND ${scope.record(table === 'crm_suppression_events' ? 'suppression' : 'consent')}) AS readable`
    : ',true AS readable'
  const scopeParams = scope?.params ?? []
  const consent = await query<{ id: string; action: 'granted' | 'withdrawn'; occurredAt: string; createdAt: string; readable: boolean }>(
    `SELECT id,action,${instant}${readable('association_consent_events')}
       FROM association_consent_events x WHERE workspace_id=$1 AND contact_id=$2 AND purpose=$3
      ORDER BY occurred_at DESC,created_at DESC,id DESC LIMIT 1`, [workspaceId, contact.id, purposeKey, ...scopeParams],
  )
  const suppressions = await query<{ id: string; channel: 'all' | 'email'; action: 'suppressed' | 'released'; occurredAt: string; createdAt: string; readable: boolean }>(
    `SELECT DISTINCT ON(channel) id,channel,action,${instant}${readable('crm_suppression_events')}
       FROM crm_suppression_events x WHERE workspace_id=$1 AND contact_id=$2 AND channel IN('all','email')
        ${scope ? 'AND $3::text IS NULL' : ''}
      ORDER BY channel,occurred_at DESC,created_at DESC,id DESC`, [workspaceId, contact.id, ...(scope ? [null, ...scopeParams] : [])],
  )
  if ([...consent.rows, ...suppressions.rows].some(row => !row.readable)) {
    return { verdict: 'unknown' as const, reasons: ['evidence_unavailable'] }
  }
  return evaluateCrmSendability({
    channel: 'email', hasContactMethod: Boolean(contact.email),
    purpose: { ...purpose, applicableChannels: purpose.applicableChannels as ('email')[] },
    consentEvents: consent.rows, suppressionEvents: suppressions.rows,
  })
}

export type CampaignEmailService = ReturnType<typeof createCampaignEmailService>

export function createCampaignEmailService(options: { deliveries?: CrmDeliveryServicePort } = {}) {
  return {
    read: loadDraft,

    async update(actor: { userId: string; workspaceId: string }, placementId: string, input: {
      mutationId: string; expectedRevision: number; metadata: CampaignEmailMetadata
    }) {
      const draft = await loadDraft(actor.workspaceId, placementId)
      const receipt = await executeFeedCommands({
        userId: actor.userId, assistantId: draft.assistantId, sessionId: draft.sessionId, kind: 'user',
      }, {
        mutationId: input.mutationId,
        expectedRevision: input.expectedRevision,
        commands: [{ kind: 'email', metadata: campaignEmailMetadataSchema.parse(input.metadata) }],
      })
      const updated = await loadDraft(actor.workspaceId, placementId)
      return { receipt, draft: { ...updated, content: undefined } }
    },

    async preview(workspaceId: string, placementId: string, values: Record<string, string>, revision?: number) {
      const draft = await loadDraft(workspaceId, placementId, revision)
      if (!draft.metadata) throw new CampaignEmailError('conflict', 'Email metadata must be saved before preview.')
      return { revision: draft.revision, projection: renderCampaignEmail(draft.content, draft.metadata, values) }
    },

    async audience(workspaceId: string, placementId: string, actor: AssociationActor) {
      const draft = await loadDraft(workspaceId, placementId)
      if (!draft.metadata) throw new CampaignEmailError('conflict', 'Email metadata must be saved before audience review.')
      const segments = createDbCrmSegmentStore()
      const segment = await segments.getSegment(workspaceId, draft.metadata.audience.segmentId)
      if (!segment || Number(segment.version) !== draft.metadata.audience.segmentVersion || segment.entityKind !== 'person') {
        throw new CampaignEmailError('conflict', 'The selected CRM audience revision changed or is unavailable.')
      }
      const preview = await segments.previewSegment(workspaceId, draft.metadata.audience.segmentId, {
        limit: Math.min(100, CAMPAIGN_LIMITS.broadcastRecipients), snapshotLimit: CAMPAIGN_LIMITS.broadcastRecipients,
      }, actor)
      const evidenceScope = await crmSegmentReadScope(getPool(), workspaceId, actor, 4)
      if (preview.count > CAMPAIGN_LIMITS.broadcastRecipients) {
        throw new CampaignEmailError('rate_limited', `Audience exceeds the ${CAMPAIGN_LIMITS.broadcastRecipients}-recipient broadcast limit.`, { count: preview.count })
      }
      const contacts = preview.snapshotIds.length ? (await query<AudienceContact>(
        `SELECT id,display_name AS name,lower(btrim(COALESCE(NULLIF(attributes->>'email',''),canonical_id))) AS email,attributes
           FROM entities WHERE workspace_id=$1 AND kind='person' AND id=ANY($2::uuid[])
            AND valid_to IS NULL AND retracted_at IS NULL`, [workspaceId, preview.snapshotIds],
      )).rows : []
      const byId = new Map(contacts.map(contact => [contact.id, contact]))
      const used = new Set<string>()
      const eligible: Array<Record<string, unknown>> = []
      const excluded: Array<Record<string, unknown>> = []
      for (const contactId of preview.snapshotIds) {
        const contact = byId.get(contactId)
        if (!contact) { excluded.push({ contactId, reasons: ['contact_unavailable'] }); continue }
        const address = contact.email?.toLowerCase() ?? ''
        const values = contactPersonalization(contact)
        const missing = draft.metadata.personalization.filter(spec => spec.required && !values[spec.field]?.trim()).map(spec => spec.field)
        const verdict = await verdictFor(workspaceId, contact, draft.metadata.purposeKey, evidenceScope)
        const reasons = [...verdict.reasons]
        if (!address) reasons.push('missing_email')
        if (address && used.has(address)) reasons.push('duplicate_address')
        if (missing.length) reasons.push('missing_personalization')
        if (verdict.verdict !== 'allowed' || reasons.length) {
          excluded.push({ contactId, address: address || null, verdict: verdict.verdict, reasons, missing })
          continue
        }
        used.add(address)
        eligible.push({ contactId, address, personalization: values, eligibility: verdict })
      }
      const snapshot = freezeCampaignAudienceSnapshot({
        segmentId: String(segment.id), segmentVersion: Number(segment.version),
        recipients: eligible as Array<{ contactId: string; address: string; personalization: Record<string, string>; eligibility: Record<string, unknown> }>,
        excluded,
      })
      return {
        state: 'available', revision: draft.revision,
        segment: { id: segment.id, version: segment.version, name: segment.name },
        eligible, excluded,
        counts: { matched: preview.count, eligible: eligible.length, excluded: excluded.length },
        snapshot,
      }
    },

    async catalog(actor: { userId: string; workspaceId: string }) {
      const [segments, purposes, senders] = await Promise.all([
        query(`SELECT id,name,version FROM crm_segments WHERE workspace_id=$1 AND entity_kind='person' AND archived_at IS NULL ORDER BY name,id`, [actor.workspaceId]),
        query(`SELECT purpose_key AS "purposeKey",label,requires_consent AS "requiresConsent" FROM crm_consent_purposes WHERE workspace_id=$1 AND archived_at IS NULL AND 'email'=ANY(applicable_channels) ORDER BY label,purpose_key`, [actor.workspaceId]),
        query(`SELECT DISTINCT ci.id,ci.label,ci.connected_email AS "address",ci.provider,ci.health_status AS health
          FROM connector_instance ci LEFT JOIN connector_grant g ON g.connector_instance_id=ci.id AND g.target_type='workspace' AND g.target_id=$1
          WHERE ci.connected AND ci.health_status<>'auth_failed' AND ci.provider IN('gmail','imap','agentmail')
            AND ((ci.scope='workspace' AND ci.workspace_id=$1) OR (ci.scope='user' AND ci.user_id=$2) OR g.id IS NOT NULL)
          ORDER BY ci.label,ci.id`, [actor.workspaceId, actor.userId]),
      ])
      return { segments: segments.rows, purposes: purposes.rows, senders: senders.rows.map(sender => ({
        ...sender as Record<string, unknown>,
        broadcastCapable: (sender as { provider: string }).provider === 'imap',
      })) }
    },

    async sendTest(actor: { userId: string; workspaceId: string; role: 'owner' | 'admin' | 'member'; canWrite: boolean }, placementId: string, contactId: string, expectedRevision?: number, deliveryId: string = randomUUID()) {
      if (!options.deliveries) throw new CampaignEmailError('unavailable', 'Campaign test delivery is not configured.')
      const draft = await loadDraft(actor.workspaceId, placementId)
      if (!draft.metadata) throw new CampaignEmailError('conflict', 'Email metadata must be saved before a test delivery.')
      if (expectedRevision !== undefined && draft.revision !== expectedRevision) throw new CampaignEmailError('conflict', 'The Email revision changed before test delivery.')
      const contact = (await query<AudienceContact>(`SELECT id,display_name AS name,
          lower(btrim(COALESCE(NULLIF(attributes->>'email',''),canonical_id))) AS email,attributes
        FROM entities WHERE workspace_id=$1 AND kind='person' AND id=$2 AND valid_to IS NULL AND retracted_at IS NULL`,
        [actor.workspaceId, contactId])).rows[0]
      if (!contact?.email) throw new CampaignEmailError('not_found', 'The test recipient is unavailable.')
      const rendered = renderCampaignEmail(draft.content, draft.metadata, contactPersonalization(contact))
      const context: CrmOperationsContext = {
        workspaceId: actor.workspaceId,
        actor: { kind: 'user', userId: actor.userId },
        authority: { role: actor.role, canWrite: actor.canWrite, canConfigure: actor.role !== 'member', trustedIdentitySources: [] },
      }
      const result = await options.deliveries.send(context, {
        kind: 'send_message', deliveryId, connectorInstanceId: draft.metadata.senderId,
        purposeKey: draft.metadata.purposeKey, to: [contact.email], cc: [], bcc: [],
        subject: `[TEST] ${rendered.subject}`, body: rendered.text, attachments: [],
      })
      return { test: true, revision: draft.revision, recipientContactId: contactId, receipt: result.receipt }
    },
  }
}
