/** PostgreSQL persistence for native campaigns. [COMP:campaigns/store] */
import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { CampaignCommandReceipt, CampaignContext } from '@use-brian/core/campaigns/types.js'
import type { CampaignUtm, CampaignChannel } from '@use-brian/shared/campaigns'
import { CampaignError } from '@use-brian/core/campaigns/types.js'
import { getPool } from './client.js'

export type CampaignQueryable = Pick<PoolClient, 'query'>

export async function requireCampaignPlacement(
  client: CampaignQueryable,
  input: { workspaceId: string; campaignId: string; placementId: string },
): Promise<void> {
  const placement = await client.query(
    `SELECT 1 FROM campaign_placements
      WHERE workspace_id=$1 AND campaign_id=$2 AND id=$3`,
    [input.workspaceId, input.campaignId, input.placementId],
  )
  if (!placement.rowCount) {
    throw new CampaignError('not_found', 'The campaign placement does not belong to this campaign.')
  }
}

export type CampaignRow = {
  id: string
  workspaceId: string
  ownerUserId: string | null
  name: string
  objective: string
  state: 'draft' | 'active' | 'completed' | 'archived'
  timezone: string
  primaryConversion: string
  startsAt: Date | null
  endsAt: Date | null
  version: number
  createdAt: Date
  updatedAt: Date
  archivedAt: Date | null
}

export type CampaignPlacementRow = {
  id: string
  workspaceId: string
  campaignId: string
  sessionId: string
  channel: CampaignChannel
  placementKind: 'body' | 'first_comment' | 'profile' | 'email_body'
  placementKey: string
  approvedRevision: number | null
  publicationReference: string | null
  publishedAt: Date | null
  dispatchId: string | null
}

export type CampaignLinkRow = {
  id: string
  workspaceId: string
  campaignId: string
  placementId: string
  publicId: string
  destination: string
  utm: CampaignUtm
  enabled: boolean
  createdAt: Date
}

function actorReference(context: CampaignContext): string {
  return context.actor.userId ?? context.actor.assistantId ?? context.actor.credentialId ?? context.actor.sessionId ?? context.actor.kind
}

async function transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const value = await run(client)
    await client.query('COMMIT')
    return value
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

function mapCampaign(row: Record<string, unknown>): CampaignRow {
  return {
    id: row.id as string,
    workspaceId: row.workspaceId as string,
    ownerUserId: row.ownerUserId as string | null,
    name: row.name as string,
    objective: row.objective as string,
    state: row.state as CampaignRow['state'],
    timezone: row.timezone as string,
    primaryConversion: row.primaryConversion as string,
    startsAt: row.startsAt as Date | null,
    endsAt: row.endsAt as Date | null,
    version: row.version as number,
    createdAt: row.createdAt as Date,
    updatedAt: row.updatedAt as Date,
    archivedAt: row.archivedAt as Date | null,
  }
}

export type CampaignStore = ReturnType<typeof createDbCampaignStore>

export function createDbCampaignStore() {
  return {
    async executeIdempotent(
      context: CampaignContext,
      idempotencyKey: string,
      fingerprint: string,
      run: (client: PoolClient) => Promise<Record<string, unknown>>,
    ): Promise<CampaignCommandReceipt> {
      return transaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${context.workspaceId}:${idempotencyKey}`])
        const replay = await client.query<{ fingerprint: string; result: Record<string, unknown> }>(
          `SELECT request_fingerprint AS fingerprint,result
             FROM campaign_command_receipts
            WHERE workspace_id=$1 AND idempotency_key=$2`,
          [context.workspaceId, idempotencyKey],
        )
        const existing = replay.rows[0]
        if (existing) {
          if (existing.fingerprint !== fingerprint) {
            throw new CampaignError('conflict', 'The idempotency key was already used for a different campaign request.', { idempotencyKey })
          }
          return { idempotencyKey, fingerprint, replayed: true, result: existing.result }
        }
        const result = await run(client)
        // Receipts cross a JSON boundary on replay, so return the same canonical
        // wire representation on the first execution as well (not Date objects
        // on the first call and ISO strings on subsequent calls).
        const serializedResult = JSON.stringify(result)
        const canonicalResult = JSON.parse(serializedResult) as Record<string, unknown>
        await client.query(
          `INSERT INTO campaign_command_receipts
             (workspace_id,idempotency_key,request_fingerprint,actor_kind,actor_reference,result)
           VALUES($1,$2,$3,$4,$5,$6)`,
          [context.workspaceId, idempotencyKey, fingerprint, context.actor.kind, actorReference(context), serializedResult],
        )
        return { idempotencyKey, fingerprint, replayed: false, result: canonicalResult }
      })
    },

    async saveCampaign(client: CampaignQueryable, input: {
      workspaceId: string
      ownerUserId: string | null
      campaignId?: string
      name: string
      objective: string
      timezone: string
      primaryConversion: string
      startsAt?: string | null
      endsAt?: string | null
      expectedVersion?: number
    }): Promise<CampaignRow> {
      if (!input.campaignId) {
        const created = await client.query<Record<string, unknown>>(
          `INSERT INTO campaigns
             (workspace_id,owner_user_id,name,objective,timezone,primary_conversion_kind,starts_at,ends_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING id,workspace_id AS "workspaceId",owner_user_id AS "ownerUserId",name,objective,state,timezone,
             primary_conversion_kind AS "primaryConversion",starts_at AS "startsAt",ends_at AS "endsAt",version,
             created_at AS "createdAt",updated_at AS "updatedAt",archived_at AS "archivedAt"`,
          [input.workspaceId, input.ownerUserId, input.name, input.objective, input.timezone, input.primaryConversion, input.startsAt ?? null, input.endsAt ?? null],
        )
        return mapCampaign(created.rows[0]!)
      }
      if (!input.expectedVersion) throw new CampaignError('conflict', 'expectedVersion is required when editing a campaign.')
      const updated = await client.query<Record<string, unknown>>(
        `UPDATE campaigns SET name=$3,objective=$4,timezone=$5,primary_conversion_kind=$6,starts_at=$7,ends_at=$8,version=version+1
          WHERE workspace_id=$1 AND id=$2 AND version=$9 AND state<>'archived'
          RETURNING id,workspace_id AS "workspaceId",owner_user_id AS "ownerUserId",name,objective,state,timezone,
            primary_conversion_kind AS "primaryConversion",starts_at AS "startsAt",ends_at AS "endsAt",version,
            created_at AS "createdAt",updated_at AS "updatedAt",archived_at AS "archivedAt"`,
        [input.workspaceId, input.campaignId, input.name, input.objective, input.timezone, input.primaryConversion, input.startsAt ?? null, input.endsAt ?? null, input.expectedVersion],
      )
      if (!updated.rows[0]) throw new CampaignError('conflict', 'Campaign revision changed or the campaign is archived.')
      return mapCampaign(updated.rows[0])
    },

    async archiveCampaign(client: CampaignQueryable, workspaceId: string, campaignId: string): Promise<CampaignRow> {
      const archived = await client.query<Record<string, unknown>>(
        `UPDATE campaigns SET state='archived',archived_at=coalesce(archived_at,clock_timestamp()),version=version+1
          WHERE workspace_id=$1 AND id=$2
          RETURNING id,workspace_id AS "workspaceId",owner_user_id AS "ownerUserId",name,objective,state,timezone,
            primary_conversion_kind AS "primaryConversion",starts_at AS "startsAt",ends_at AS "endsAt",version,
            created_at AS "createdAt",updated_at AS "updatedAt",archived_at AS "archivedAt"`,
        [workspaceId, campaignId],
      )
      if (!archived.rows[0]) throw new CampaignError('not_found', 'Campaign not found.')
      return mapCampaign(archived.rows[0])
    },

    async attachContent(client: CampaignQueryable, input: {
      workspaceId: string
      campaignId: string
      sessionId: string
      channel: CampaignChannel
      placementKind: 'body' | 'first_comment' | 'profile' | 'email_body'
      placementKey: string
      actorUserId: string | null
    }): Promise<CampaignPlacementRow> {
      const row = await client.query<CampaignPlacementRow>(
        `INSERT INTO campaign_placements
           (workspace_id,campaign_id,session_id,channel,placement_kind,placement_key,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(campaign_id,session_id,channel,placement_key) DO UPDATE SET placement_key=EXCLUDED.placement_key
         RETURNING id,workspace_id AS "workspaceId",campaign_id AS "campaignId",session_id AS "sessionId",channel,
           placement_kind AS "placementKind",placement_key AS "placementKey",approved_revision AS "approvedRevision",
           publication_reference AS "publicationReference",published_at AS "publishedAt",dispatch_id AS "dispatchId"`,
        [input.workspaceId, input.campaignId, input.sessionId, input.channel, input.placementKind, input.placementKey, input.actorUserId],
      )
      return row.rows[0]!
    },

    async recordManualPublication(client: CampaignQueryable, input: { workspaceId: string; placementId: string; permalink: string; publishedAt: string; approvedRevision: number }): Promise<CampaignPlacementRow> {
      const row = await client.query<CampaignPlacementRow>(
        `UPDATE campaign_placements
            SET publication_reference=$3,published_at=$4,approved_revision=$5
          WHERE workspace_id=$1 AND id=$2
          RETURNING id,workspace_id AS "workspaceId",campaign_id AS "campaignId",session_id AS "sessionId",channel,
            placement_kind AS "placementKind",placement_key AS "placementKey",approved_revision AS "approvedRevision",
            publication_reference AS "publicationReference",published_at AS "publishedAt",dispatch_id AS "dispatchId"`,
        [input.workspaceId, input.placementId, input.permalink, input.publishedAt, input.approvedRevision],
      )
      if (!row.rows[0]) throw new CampaignError('not_found', 'Campaign placement not found.')
      return row.rows[0]
    },

    async createLink(client: CampaignQueryable, input: {
      workspaceId: string
      campaignId: string
      placementId: string
      publicId: string
      destination: string
      utm: CampaignUtm
      actorUserId: string | null
    }): Promise<CampaignLinkRow> {
      await requireCampaignPlacement(client, input)
      const destinationHash = createHash('sha256').update(input.destination).digest('hex')
      const row = await client.query<CampaignLinkRow>(
        `INSERT INTO campaign_links
           (workspace_id,campaign_id,placement_id,public_id,destination_url,destination_hash,utm_snapshot,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id,workspace_id AS "workspaceId",campaign_id AS "campaignId",placement_id AS "placementId",
           public_id AS "publicId",destination_url AS destination,utm_snapshot AS utm,enabled,created_at AS "createdAt"`,
        [input.workspaceId, input.campaignId, input.placementId, input.publicId, input.destination, destinationHash, JSON.stringify(input.utm), input.actorUserId],
      )
      return row.rows[0]!
    },

    async getLinkByPublicId(publicId: string): Promise<CampaignLinkRow | null> {
      const result = await getPool().query<CampaignLinkRow>(
        `SELECT id,workspace_id AS "workspaceId",campaign_id AS "campaignId",placement_id AS "placementId",
           public_id AS "publicId",destination_url AS destination,utm_snapshot AS utm,enabled,created_at AS "createdAt"
         FROM campaign_links WHERE public_id=$1 AND enabled=true`,
        [publicId],
      )
      return result.rows[0] ?? null
    },

    async listCampaigns(workspaceId: string, filters: { state?: string; limit?: number } = {}): Promise<CampaignRow[]> {
      const result = await getPool().query<Record<string, unknown>>(
        `SELECT id,workspace_id AS "workspaceId",owner_user_id AS "ownerUserId",name,objective,state,timezone,
            primary_conversion_kind AS "primaryConversion",starts_at AS "startsAt",ends_at AS "endsAt",version,
            created_at AS "createdAt",updated_at AS "updatedAt",archived_at AS "archivedAt"
           FROM campaigns WHERE workspace_id=$1 AND ($2::text IS NULL OR state=$2)
          ORDER BY updated_at DESC,id DESC LIMIT $3`,
        [workspaceId, filters.state ?? null, Math.min(100, Math.max(1, filters.limit ?? 50))],
      )
      return result.rows.map(mapCampaign)
    },

    async getCampaign(workspaceId: string, campaignId: string): Promise<Record<string, unknown> | null> {
      const campaign = await getPool().query<Record<string, unknown>>(
        `SELECT id,workspace_id AS "workspaceId",owner_user_id AS "ownerUserId",name,objective,state,timezone,
            primary_conversion_kind AS "primaryConversion",starts_at AS "startsAt",ends_at AS "endsAt",version,
            created_at AS "createdAt",updated_at AS "updatedAt",archived_at AS "archivedAt"
           FROM campaigns WHERE workspace_id=$1 AND id=$2`, [workspaceId, campaignId],
      )
      if (!campaign.rows[0]) return null
      const [placements, links] = await Promise.all([
        getPool().query(`SELECT id,session_id AS "sessionId",channel,placement_kind AS "placementKind",placement_key AS "placementKey",approved_revision AS "approvedRevision",publication_reference AS "publicationReference",published_at AS "publishedAt",dispatch_id AS "dispatchId" FROM campaign_placements WHERE workspace_id=$1 AND campaign_id=$2 ORDER BY created_at,id`, [workspaceId, campaignId]),
        getPool().query(`SELECT id,placement_id AS "placementId",public_id AS "publicId",destination_url AS destination,utm_snapshot AS utm,enabled,created_at AS "createdAt" FROM campaign_links WHERE workspace_id=$1 AND campaign_id=$2 ORDER BY created_at,id`, [workspaceId, campaignId]),
      ])
      return { ...mapCampaign(campaign.rows[0]), placements: placements.rows, links: links.rows }
    },

    async listLinks(workspaceId: string, campaignId: string): Promise<CampaignLinkRow[]> {
      return (await getPool().query<CampaignLinkRow>(
        `SELECT id,workspace_id AS "workspaceId",campaign_id AS "campaignId",placement_id AS "placementId",
           public_id AS "publicId",destination_url AS destination,utm_snapshot AS utm,enabled,created_at AS "createdAt"
         FROM campaign_links WHERE workspace_id=$1 AND campaign_id=$2 ORDER BY created_at,id`,
        [workspaceId, campaignId],
      )).rows
    },

    async setLinkEnabled(client: CampaignQueryable, workspaceId: string, linkId: string, enabled: boolean): Promise<void> {
      const result = await client.query(
        `UPDATE campaign_links SET enabled=$3,disabled_at=CASE WHEN $3 THEN NULL ELSE clock_timestamp() END
          WHERE workspace_id=$1 AND id=$2`, [workspaceId, linkId, enabled],
      )
      if (!result.rowCount) throw new CampaignError('not_found', 'Campaign link not found.')
    },

    async seedReceiptForTest(context: CampaignContext, idempotencyKey: string, fingerprint: string, result: Record<string, unknown>): Promise<void> {
      await getPool().query(
        `INSERT INTO campaign_command_receipts(workspace_id,idempotency_key,request_fingerprint,actor_kind,actor_reference,result)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [context.workspaceId, idempotencyKey, fingerprint, context.actor.kind, actorReference(context), JSON.stringify(result)],
      )
    },
  }
}

export function campaignOpaqueToken(): string {
  return randomUUID().replaceAll('-', '')
}
