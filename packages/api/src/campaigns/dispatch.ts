/** Immutable campaign approval and leased SMTP dispatch. [COMP:campaigns/dispatch] */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import {
  CampaignError,
  type CampaignContext,
  type CrmDeliveryReceipt,
  type CrmDeliveryServicePort,
  type CrmOperationsContext,
} from '@use-brian/core'
import {
  CAMPAIGN_LIMITS,
  campaignEmailMetadataSchema,
  campaignPrepareDispatchSchema,
  type CampaignEmailMetadata,
} from '@use-brian/shared/campaigns'
import { getPool, query } from '../db/client.js'
import { associationOrderReadPredicate, loadAssociationOrderScope } from '../association/source-scope.js'
import type { AssociationActor } from '@use-brian/core'
import {
  campaignReadActor,
  createCampaignEmailService,
  renderCampaignEmail,
  type CampaignEmailService,
} from '../content-planning/email.js'

type DispatchContext = CampaignContext & { actor: CampaignContext['actor'] & { userId: string } }
type PrepareInput = Parameters<typeof campaignPrepareDispatchSchema.parse>[0]

type ClaimedJob = {
  jobId: string
  workspaceId: string
  dispatchId: string
  recipientId: string
  deliveryId: string
  contactId: string
  emailAddress: string
  personalization: Record<string, string>
  campaignId: string
  placementId: string
  approvedRevision: number
  senderId: string
  replyTo: string | null
  purposeKey: string
  contentSnapshot: { content: Parameters<typeof renderCampaignEmail>[0]; metadata: CampaignEmailMetadata }
  trackingOptions: { publicOrigin: string; oneClick: boolean }
  approvedBy: string
  leaseToken: string
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const canonicalRecipients = (items: Array<{ contactId: string; address: string; personalization: Record<string, string> }>) =>
  items.map(item => ({ contactId: item.contactId, address: item.address.trim().toLowerCase(), personalization: item.personalization }))
    .sort((a, b) => a.address.localeCompare(b.address) || a.contactId.localeCompare(b.contactId))
const opaqueToken = () => randomBytes(32).toString('base64url')

function assertSendAuthority(context: CampaignContext): asserts context is DispatchContext {
  if (!context.authority.canSend || !context.authority.canWrite || !context.actor.userId) {
    throw new CampaignError('forbidden', 'Current campaign send authority is required.')
  }
}

async function transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const result = await run(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function finishDispatch(workspaceId: string, dispatchId: string): Promise<void> {
  await query(`UPDATE campaign_email_dispatches d SET
      state=CASE
        WHEN EXISTS(SELECT 1 FROM campaign_email_jobs j WHERE j.dispatch_id=d.id AND j.state='needs_attention') THEN 'needs_attention'
        WHEN EXISTS(SELECT 1 FROM campaign_email_jobs j WHERE j.dispatch_id=d.id AND j.state IN('pending','leased')) THEN 'sending'
        ELSE 'completed' END,
      state_changed_at=clock_timestamp(),
      completed_at=CASE WHEN NOT EXISTS(SELECT 1 FROM campaign_email_jobs j WHERE j.dispatch_id=d.id AND j.state IN('pending','leased','needs_attention')) THEN clock_timestamp() ELSE completed_at END
    WHERE d.workspace_id=$1 AND d.id=$2 AND d.state NOT IN('paused','cancelled')`, [workspaceId, dispatchId])
}

function receiptRecipientState(receipt: CrmDeliveryReceipt): 'accepted' | 'rejected' | 'uncertain' {
  if (receipt.status === 'sent') return 'accepted'
  if (receipt.status === 'needs_reconciliation' || receipt.status === 'dispatching') return 'uncertain'
  return 'rejected'
}

export function createCampaignDispatchService(options: {
  deliveries?: CrmDeliveryServicePort
  email?: CampaignEmailService
  publicOrigin?: string
  oneClickEnabled?: boolean
  leaseSeconds?: number
  now?: () => Date
} = {}) {
  const email = options.email ?? createCampaignEmailService()
  const publicOrigin = new URL(options.publicOrigin ?? 'http://localhost:3000').origin
  const oneClick = options.oneClickEnabled === true
  const leaseSeconds = Math.max(30, Math.min(600, options.leaseSeconds ?? 120))
  const now = options.now ?? (() => new Date())
  let timer: ReturnType<typeof setInterval> | null = null

  const service = {
    async prepare(client: PoolClient, context: CampaignContext, raw: PrepareInput) {
      assertSendAuthority(context)
      const input = campaignPrepareDispatchSchema.parse(raw)
      const draft = await email.read(context.workspaceId, input.placementId)
      if (draft.campaignId !== input.campaignId || draft.revision !== input.approvedRevision || !draft.metadata) {
        throw new CampaignError('conflict', 'The reviewed Email revision changed before approval.')
      }
      if (JSON.stringify(draft.metadata) !== JSON.stringify(campaignEmailMetadataSchema.parse(input.metadata))) {
        throw new CampaignError('conflict', 'Email metadata does not match the reviewed revision.')
      }
      const audience = await email.audience(context.workspaceId, input.placementId, campaignReadActor(context.actor))
      const serverRecipients = canonicalRecipients(audience.eligible as Array<{ contactId: string; address: string; personalization: Record<string, string> }>)
      const requestedRecipients = canonicalRecipients(input.recipients)
      if (JSON.stringify(serverRecipients) !== JSON.stringify(requestedRecipients)) {
        throw new CampaignError('conflict', 'The approved recipients do not match the current reviewed audience snapshot.')
      }
      if (!serverRecipients.length) throw new CampaignError('conflict', 'A live dispatch requires at least one eligible recipient.')
      const sender = await client.query<{ provider: string }>(`SELECT provider FROM connector_instance
        WHERE id=$1 AND connected AND health_status<>'auth_failed' AND provider='imap'
          AND ((scope='workspace' AND workspace_id=$2) OR (scope='user' AND user_id=$3)
            OR EXISTS(SELECT 1 FROM connector_grant g WHERE g.connector_instance_id=connector_instance.id
              AND g.target_type='workspace' AND g.target_id=$2)) FOR SHARE`,
      [draft.metadata.senderId, context.workspaceId, context.actor.userId])
      if (!sender.rows[0]) throw new CampaignError('conflict', 'The approved sender does not provide the native SMTP broadcast capability.')

      const scheduledAt = input.scheduledAt ?? now().toISOString()
      const requestFingerprint = sha256(JSON.stringify({
        campaignId: input.campaignId,
        placementId: input.placementId,
        revision: input.approvedRevision,
        metadata: draft.metadata,
        recipients: serverRecipients,
        scheduledAt,
      }))
      const authority = {
        actorKind: context.actor.kind,
        approvedBy: context.actor.userId,
        role: context.authority.role,
        senderId: draft.metadata.senderId,
      }
      const audienceSnapshot = {
        version: 1,
        segmentId: draft.metadata.audience.segmentId,
        segmentVersion: draft.metadata.audience.segmentVersion,
        matched: audience.counts.matched,
        eligible: serverRecipients.length,
        excluded: audience.counts.excluded,
      }
      const contentSnapshot = { content: draft.content, metadata: draft.metadata }
      await client.query(`UPDATE campaign_email_dispatches SET state='cancelled',state_changed_at=clock_timestamp()
        WHERE workspace_id=$1 AND placement_id=$2 AND state IN('ready','scheduled','paused')`, [context.workspaceId, input.placementId])
      const dispatch = (await client.query<{ id: string; state: string; scheduledAt: Date }>(`INSERT INTO campaign_email_dispatches
        (workspace_id,campaign_id,placement_id,approved_revision,sender_ref,reply_to,purpose_key,segment_id,segment_version,
         audience_snapshot,content_snapshot,tracking_options,authority_snapshot,request_fingerprint,state,scheduled_at,approved_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14,'ready',$15,$16)
        RETURNING id,state,scheduled_at AS "scheduledAt"`, [
        context.workspaceId, input.campaignId, input.placementId, input.approvedRevision,
        draft.metadata.senderId, draft.metadata.replyTo ?? null, draft.metadata.purposeKey,
        draft.metadata.audience.segmentId, draft.metadata.audience.segmentVersion,
        JSON.stringify(audienceSnapshot), JSON.stringify(contentSnapshot),
        JSON.stringify({ ...draft.metadata.tracking, publicOrigin, oneClick }), JSON.stringify(authority),
        requestFingerprint, scheduledAt, context.actor.userId,
      ])).rows[0]!
      for (const recipient of serverRecipients) {
        const deliveryId = randomUUID()
        // The recipient row copies personal data out of the contact, so it keeps the contact's canonical
        // protection captured now, under the approver's scoped audience; history is never relabeled later.
        const evidence = await loadAssociationOrderScope(client, context.workspaceId, [recipient.contactId])
        const saved = (await client.query<{ id: string }>(`INSERT INTO campaign_email_recipients
          (workspace_id,dispatch_id,contact_id,email_address,address_hash,personalization_snapshot,eligibility_snapshot,delivery_id,scope_snapshot,scope_sources)
          VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9::jsonb,$10::jsonb) RETURNING id`, [
          context.workspaceId, dispatch.id, recipient.contactId, recipient.address, sha256(recipient.address),
          JSON.stringify(recipient.personalization), JSON.stringify(input.recipients.find(item => item.contactId === recipient.contactId)?.eligibility ?? {}), deliveryId,
          JSON.stringify(evidence.scope), JSON.stringify(evidence.sources),
        ])).rows[0]!
        await client.query(`INSERT INTO campaign_email_jobs(workspace_id,dispatch_id,recipient_id,available_at)
          VALUES($1,$2,$3,$4)`, [context.workspaceId, dispatch.id, saved.id, scheduledAt])
      }
      await client.query(`UPDATE campaign_placements SET dispatch_id=$3,approved_revision=$4
        WHERE workspace_id=$1 AND id=$2`, [context.workspaceId, input.placementId, dispatch.id, input.approvedRevision])
      return { dispatchId: dispatch.id, state: dispatch.state, scheduledAt: dispatch.scheduledAt.toISOString(), recipients: serverRecipients.length }
    },

    async schedule(client: PoolClient, context: CampaignContext, dispatchId: string, scheduledAt: string) {
      assertSendAuthority(context)
      const row = await client.query<{ scheduledAt: Date }>(`SELECT scheduled_at AS "scheduledAt" FROM campaign_email_dispatches
        WHERE workspace_id=$1 AND id=$2 AND approved_by=$3 AND state IN('ready','paused') FOR UPDATE`, [context.workspaceId, dispatchId, context.actor.userId])
      if (!row.rows[0]) throw new CampaignError('conflict', 'The approved dispatch cannot be scheduled in its current state.')
      if (row.rows[0].scheduledAt.toISOString() !== new Date(scheduledAt).toISOString()) {
        throw new CampaignError('conflict', 'The scheduled time differs from the approved dispatch snapshot.')
      }
      await client.query(`UPDATE campaign_email_dispatches SET state='scheduled',state_changed_at=clock_timestamp()
        WHERE workspace_id=$1 AND id=$2`, [context.workspaceId, dispatchId])
      return { dispatchId, state: 'scheduled', scheduledAt: row.rows[0].scheduledAt.toISOString() }
    },

    async pause(client: PoolClient, context: CampaignContext, dispatchId: string) {
      assertSendAuthority(context)
      const changed = await client.query(`UPDATE campaign_email_dispatches SET state='paused',state_changed_at=clock_timestamp()
        WHERE workspace_id=$1 AND id=$2 AND state IN('scheduled','sending')`, [context.workspaceId, dispatchId])
      if (!changed.rowCount) throw new CampaignError('conflict', 'Only a scheduled or sending dispatch can be paused.')
      return { dispatchId, state: 'paused' }
    },

    async cancel(client: PoolClient, context: CampaignContext, dispatchId: string) {
      assertSendAuthority(context)
      const changed = await client.query(`UPDATE campaign_email_dispatches SET state='cancelled',state_changed_at=clock_timestamp()
        WHERE workspace_id=$1 AND id=$2 AND state NOT IN('completed','cancelled')`, [context.workspaceId, dispatchId])
      if (!changed.rowCount) throw new CampaignError('conflict', 'The dispatch is already terminal.')
      await client.query(`UPDATE campaign_email_jobs SET state='cancelled',lease_token=NULL,lease_expires_at=NULL
        WHERE workspace_id=$1 AND dispatch_id=$2 AND state IN('pending','leased')`, [context.workspaceId, dispatchId])
      await client.query(`UPDATE campaign_email_recipients SET state='cancelled',completed_at=clock_timestamp()
        WHERE workspace_id=$1 AND dispatch_id=$2 AND state='pending'`, [context.workspaceId, dispatchId])
      return { dispatchId, state: 'cancelled' }
    },

    /** With `actor`, recipient counts are returned only when every recipient is readable; otherwise they are unknown (null). */
    async read(workspaceId: string, dispatchId: string, actor?: AssociationActor) {
      const dispatch = (await query<Record<string, unknown>>(`SELECT id,campaign_id AS "campaignId",placement_id AS "placementId",
          approved_revision AS "approvedRevision",state,scheduled_at AS "scheduledAt",approved_at AS "approvedAt",
          started_at AS "startedAt",completed_at AS "completedAt"
        FROM campaign_email_dispatches WHERE workspace_id=$1 AND id=$2`, [workspaceId, dispatchId])).rows[0]
      if (!dispatch) throw new CampaignError('not_found', 'Campaign dispatch was not found.')
      const counts = (await query<Record<string, number>>(`SELECT count(*)::int AS total,
        count(*) FILTER(WHERE state='accepted')::int AS accepted,count(*) FILTER(WHERE state='rejected')::int AS rejected,
        count(*) FILTER(WHERE state='suppressed')::int AS suppressed,count(*) FILTER(WHERE state IN('pending','admitted'))::int AS pending,
        count(*) FILTER(WHERE state='uncertain')::int AS uncertain,count(*) FILTER(WHERE state='cancelled')::int AS cancelled
        FROM campaign_email_recipients WHERE workspace_id=$1 AND dispatch_id=$2`, [workspaceId, dispatchId])).rows[0]!
      if (actor) {
        const scope = await associationOrderReadPredicate(getPool(), workspaceId, actor, 3, 'campaign_recipient')
        const hidden = (await query<{ hidden: number }>(`SELECT count(*)::int AS hidden FROM campaign_email_recipients
          WHERE workspace_id=$1 AND dispatch_id=$2 AND NOT coalesce(${scope.sql},false)`, [workspaceId, dispatchId, ...scope.params])).rows[0]!
        if (hidden.hidden > 0) {
          for (const key of Object.keys(counts)) (counts as Record<string, number | null>)[key] = null
        }
      }
      return {
        dispatch: Object.fromEntries(Object.entries(dispatch).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value])),
        counts,
        metrics: { smtpAccepted: 'available', delivered: 'unavailable', opened: 'unsupported', replies: 'unavailable', bounces: 'unavailable', complaints: 'unavailable' },
      }
    },

    async tick(): Promise<number> {
      if (!options.deliveries) return 0
      const claimed = await transaction(async client => {
        const row = (await client.query<ClaimedJob>(`SELECT j.id AS "jobId",j.workspace_id AS "workspaceId",j.dispatch_id AS "dispatchId",j.recipient_id AS "recipientId",
            r.delivery_id AS "deliveryId",r.contact_id AS "contactId",r.email_address AS "emailAddress",r.personalization_snapshot AS personalization,
            d.campaign_id AS "campaignId",d.placement_id AS "placementId",d.approved_revision AS "approvedRevision",d.sender_ref AS "senderId",
            d.reply_to AS "replyTo",d.purpose_key AS "purposeKey",d.content_snapshot AS "contentSnapshot",d.tracking_options AS "trackingOptions",
            d.approved_by AS "approvedBy"
          FROM campaign_email_jobs j JOIN campaign_email_dispatches d ON d.id=j.dispatch_id AND d.workspace_id=j.workspace_id
          JOIN campaign_email_recipients r ON r.id=j.recipient_id AND r.workspace_id=j.workspace_id
          WHERE d.state IN('scheduled','sending') AND d.scheduled_at<=clock_timestamp() AND r.state='pending'
            AND (j.state='pending' OR (j.state='leased' AND j.lease_expires_at<=clock_timestamp())) AND j.available_at<=clock_timestamp()
            AND (SELECT count(*) FROM campaign_email_recipients used JOIN campaign_email_dispatches sent ON sent.id=used.dispatch_id
                 WHERE sent.workspace_id=d.workspace_id AND sent.sender_ref=d.sender_ref AND used.admitted_at>clock_timestamp()-interval '1 minute')
                < ${CAMPAIGN_LIMITS.senderHandoffsPerMinute}
          ORDER BY j.available_at,j.id FOR UPDATE OF j,d,r SKIP LOCKED LIMIT 1`)).rows[0]
        if (!row) return null
        const leaseToken = randomUUID()
        await client.query(`UPDATE campaign_email_jobs SET state='leased',attempts=attempts+1,lease_token=$2,
          lease_expires_at=clock_timestamp()+$3::int*interval '1 second' WHERE id=$1`, [row.jobId, leaseToken, leaseSeconds])
        await client.query(`UPDATE campaign_email_dispatches SET state='sending',started_at=coalesce(started_at,clock_timestamp()),state_changed_at=clock_timestamp()
          WHERE id=$1`, [row.dispatchId])
        return { ...row, leaseToken }
      })
      if (!claimed) return 0

      const existing = (await query<CrmDeliveryReceipt>(`SELECT delivery_id AS "deliveryId",connector_instance_id AS "connectorInstanceId",
          provider_key AS "providerKey",purpose_key AS "purposeKey",status,error_code AS "errorCode",provider_receipt AS "providerReceipt",
          accepted_at::text AS "acceptedAt",confirmed_at::text AS "confirmedAt",redacted_at::text AS "redactedAt",
          created_at::text AS "createdAt",updated_at::text AS "updatedAt"
        FROM crm_delivery_receipts WHERE workspace_id=$1 AND delivery_id=$2`, [claimed.workspaceId, claimed.deliveryId])).rows[0]
      if (existing) {
        await this.applyReceipt(claimed, existing)
        return 1
      }

      const admission = await transaction(async client => {
        const locked = await client.query(`SELECT d.state FROM campaign_email_dispatches d JOIN campaign_email_jobs j ON j.dispatch_id=d.id
          WHERE d.workspace_id=$1 AND d.id=$2 AND j.id=$3 AND j.lease_token=$4 AND j.state='leased' FOR UPDATE OF d,j`,
        [claimed.workspaceId, claimed.dispatchId, claimed.jobId, claimed.leaseToken])
        if (!locked.rowCount || !['scheduled', 'sending'].includes(locked.rows[0].state)) return null
        const member = await client.query<{ role: 'owner' | 'admin' | 'member' }>(`SELECT role FROM workspace_members
          WHERE workspace_id=$1 AND user_id=$2 FOR SHARE`, [claimed.workspaceId, claimed.approvedBy])
        if (!member.rows[0]) {
          await client.query(`UPDATE campaign_email_jobs SET state='cancelled',lease_token=NULL,lease_expires_at=NULL,last_error='authority_revoked' WHERE id=$1`, [claimed.jobId])
          await client.query(`UPDATE campaign_email_recipients SET state='suppressed',exclusion_reason='authority_revoked',completed_at=clock_timestamp() WHERE id=$1`, [claimed.recipientId])
          await client.query(`UPDATE campaign_email_dispatches SET state='needs_attention',state_changed_at=clock_timestamp() WHERE id=$1`, [claimed.dispatchId])
          return null
        }
        await client.query(`UPDATE campaign_email_recipients SET state='admitted',admitted_at=clock_timestamp() WHERE id=$1 AND state='pending'`, [claimed.recipientId])
        const token = opaqueToken()
        await client.query(`INSERT INTO campaign_unsubscribe_tokens(workspace_id,recipient_id,purpose_key,token_hash,all_marketing,expires_at)
          VALUES($1,$2,$3,$4,true,clock_timestamp()+interval '180 days')`, [claimed.workspaceId, claimed.recipientId, claimed.purposeKey, sha256(token)])
        const links = (await client.query<{ id: string; publicId: string }>(`SELECT id,public_id AS "publicId" FROM campaign_links
          WHERE workspace_id=$1 AND placement_id=$2 AND enabled ORDER BY id`, [claimed.workspaceId, claimed.placementId])).rows
        const clickTokens: Array<{ publicId: string; token: string }> = []
        for (const link of links) {
          const clickToken = opaqueToken()
          await client.query(`INSERT INTO campaign_email_link_tokens(workspace_id,recipient_id,link_id,token_hash,expires_at)
            VALUES($1,$2,$3,$4,clock_timestamp()+interval '180 days')`,
          [claimed.workspaceId, claimed.recipientId, link.id, sha256(clickToken)])
          clickTokens.push({ publicId: link.publicId, token: clickToken })
        }
        return { role: member.rows[0].role, token, clickTokens }
      })
      if (!admission) return 1

      try {
        const projection = renderCampaignEmail(claimed.contentSnapshot.content, claimed.contentSnapshot.metadata, claimed.personalization)
        const unsubscribeUrl = new URL(`/c/unsubscribe/${admission.token}`, claimed.trackingOptions.publicOrigin).toString()
        let textBody = projection.text, htmlBody = projection.html
        for (const link of admission.clickTokens) {
          const ordinary = new URL(`/r/${link.publicId}`, claimed.trackingOptions.publicOrigin).toString()
          const tracked = new URL(`/e/${link.token}`, claimed.trackingOptions.publicOrigin).toString()
          textBody = textBody.replaceAll(ordinary, tracked)
          htmlBody = htmlBody.replaceAll(ordinary.replaceAll('&', '&amp;'), tracked.replaceAll('&', '&amp;'))
        }
        const text = `${textBody}\n\nUnsubscribe: ${unsubscribeUrl}`
        const html = htmlBody.replace('</body>', `<p><a href="${unsubscribeUrl.replaceAll('&', '&amp;')}">Unsubscribe</a></p></body>`)
        const deliveryContext: CrmOperationsContext = {
          workspaceId: claimed.workspaceId,
          actor: { kind: 'user', userId: claimed.approvedBy },
          authority: { role: admission.role, canWrite: true, canConfigure: admission.role !== 'member', trustedIdentitySources: [] },
        }
        const result = await options.deliveries.send(deliveryContext, {
          kind: 'send_message', deliveryId: claimed.deliveryId, connectorInstanceId: claimed.senderId,
          purposeKey: claimed.purposeKey, to: [claimed.emailAddress], cc: [], bcc: [], subject: projection.subject,
          body: text, attachments: [], campaignMail: {
            text, html, unsubscribeUrl, oneClick: claimed.trackingOptions.oneClick,
            ...(claimed.replyTo ? { replyTo: claimed.replyTo } : {}),
          },
        })
        await this.applyReceipt(claimed, result.receipt)
      } catch (error) {
        await transaction(async client => {
          const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
          const reason = error && typeof error === 'object' && 'details' in error
            && error.details && typeof error.details === 'object' && 'reason' in error.details
            ? String(error.details.reason) : ''
          // The CRM delivery port owns any safe pre-handoff retry and always
          // returns a durable receipt once it has claimed a delivery ID. An
          // exception here therefore needs operator review; retrying the job
          // would mint new public tokens around an unclassified authority or
          // transport failure.
          const failure = ['not_authorized', 'credential_revoked', 'forbidden'].includes(code)
            || reason.includes('account') || reason.includes('authority') ? 'authority_revoked' : 'pre_handoff_failure'
          await client.query(`UPDATE campaign_email_jobs SET state='failed',lease_token=NULL,lease_expires_at=NULL,last_error=$2 WHERE id=$1`,
            [claimed.jobId, failure])
          await client.query(`UPDATE campaign_email_recipients SET state='rejected',exclusion_reason=$2,completed_at=clock_timestamp() WHERE id=$1`,
            [claimed.recipientId, failure])
          await client.query(`UPDATE campaign_email_dispatches SET state='needs_attention',state_changed_at=clock_timestamp() WHERE id=$1`, [claimed.dispatchId])
        })
        await finishDispatch(claimed.workspaceId, claimed.dispatchId)
      }
      return 1
    },

    async applyReceipt(job: ClaimedJob, receipt: CrmDeliveryReceipt): Promise<void> {
      const state = receiptRecipientState(receipt)
      await transaction(async client => {
        await client.query(`UPDATE campaign_email_recipients SET state=$2,exclusion_reason=$3,completed_at=clock_timestamp()
          WHERE id=$1`, [job.recipientId, state, receipt.errorCode])
        await client.query(`UPDATE campaign_email_jobs SET state=$2,lease_token=NULL,lease_expires_at=NULL,last_error=$3
          WHERE id=$1`, [job.jobId, state === 'uncertain' ? 'needs_attention' : 'completed', receipt.errorCode])
        if (state === 'accepted') {
          await client.query(`INSERT INTO campaign_daily_metrics(workspace_id,metric_date,campaign_id,placement_id,attribution_model,email_accepted)
            VALUES($1,current_date,$2,$3,'last_touch',1)
            ON CONFLICT(workspace_id,metric_date,campaign_id,coalesce(placement_id,'00000000-0000-0000-0000-000000000000'::uuid),
              coalesce(link_id,'00000000-0000-0000-0000-000000000000'::uuid),coalesce(site_id,'00000000-0000-0000-0000-000000000000'::uuid),
              coalesce(conversion_kind,''),attribution_model,is_test)
            DO UPDATE SET email_accepted=campaign_daily_metrics.email_accepted+1,updated_at=clock_timestamp()`,
          [job.workspaceId, job.campaignId, job.placementId])
        }
      })
      await finishDispatch(job.workspaceId, job.dispatchId)
    },

    start(intervalMs = 1_000) {
      if (timer) return
      timer = setInterval(() => void service.tick().catch(error => {
        console.warn('[campaign-dispatch] worker tick failed:', error instanceof Error ? error.message : error)
      }), Math.max(250, intervalMs))
      timer.unref?.()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
  return service
}

export type CampaignDispatchService = ReturnType<typeof createCampaignDispatchService>
