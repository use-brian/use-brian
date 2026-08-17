/**
 * Local persistence for the paid Feed Cloud Link.
 *
 * [COMP:api/self-host-feed-cloud-link]
 */

import { decryptCredentials, encryptCredentials } from './credential-crypto.js'
import { query } from './client.js'

export type FeedCloudCredential = {
  deviceSecret?: string
  accessToken?: string
}

export type FeedCloudLinkStatus =
  | 'pending'
  | 'linked'
  | 'plan_required'
  | 'error'

export type FeedCloudLink = {
  workspaceId: string
  assistantId: string
  installationId: string
  cloudBaseUrl: string
  localOrigin: string
  status: FeedCloudLinkStatus
  deviceCode: string | null
  userCode: string | null
  verificationUrl: string | null
  hostedLinkId: string | null
  hostedWorkspaceId: string | null
  hostedWorkspaceName: string | null
  hostedAssistantId: string | null
  hostedAssistantName: string | null
  hostedPlan: string | null
  entitlements: Record<string, boolean>
  expiresAt: Date | null
  lastCheckedAt: Date | null
  lastError: string | null
}

type LinkRow = FeedCloudLink & { credentialBlob: Buffer | null }

const LINK_COLUMNS = `
  workspace_id::text AS "workspaceId",
  assistant_id::text AS "assistantId",
  installation_id::text AS "installationId",
  cloud_base_url AS "cloudBaseUrl",
  local_origin AS "localOrigin",
  status,
  device_code AS "deviceCode",
  user_code AS "userCode",
  verification_url AS "verificationUrl",
  credential_blob AS "credentialBlob",
  hosted_link_id::text AS "hostedLinkId",
  hosted_workspace_id::text AS "hostedWorkspaceId",
  hosted_workspace_name AS "hostedWorkspaceName",
  hosted_assistant_id::text AS "hostedAssistantId",
  hosted_assistant_name AS "hostedAssistantName",
  hosted_plan AS "hostedPlan",
  entitlements,
  expires_at AS "expiresAt",
  last_checked_at AS "lastCheckedAt",
  last_error AS "lastError"
`

export interface SelfHostFeedCloudLinkStore {
  get(workspaceId: string): Promise<FeedCloudLink | null>
  getWithCredential(
    workspaceId: string,
  ): Promise<{ link: FeedCloudLink; credential: FeedCloudCredential } | null>
  savePending(input: {
    workspaceId: string
    assistantId: string
    installationId: string
    cloudBaseUrl: string
    localOrigin: string
    deviceCode: string
    deviceSecret: string
    userCode: string
    verificationUrl: string
    expiresAt: Date
    createdBy: string
  }): Promise<FeedCloudLink>
  markLinked(input: {
    workspaceId: string
    accessToken: string
    hostedLinkId: string
    hostedWorkspaceId: string
    hostedWorkspaceName: string
    hostedAssistantId: string
    hostedAssistantName: string
    hostedPlan: string
    entitlements: Record<string, boolean>
  }): Promise<void>
  markPlanRequired(workspaceId: string, plan?: string): Promise<void>
  markError(workspaceId: string, error: string): Promise<void>
  touchEntitlement(input: {
    workspaceId: string
    plan: string
    entitlements: Record<string, boolean>
  }): Promise<void>
  remove(workspaceId: string): Promise<void>
}

export function createSelfHostFeedCloudLinkStore(
  encryptionKey: Buffer,
): SelfHostFeedCloudLinkStore {
  async function getRow(workspaceId: string): Promise<LinkRow | null> {
    const result = await query<LinkRow>(
      `SELECT ${LINK_COLUMNS}
         FROM self_host_feed_cloud_links
        WHERE workspace_id = $1`,
      [workspaceId],
    )
    return result.rows[0] ?? null
  }

  function publicLink(row: LinkRow): FeedCloudLink {
    const { credentialBlob: _credentialBlob, ...link } = row
    return link
  }

  return {
    async get(workspaceId) {
      const row = await getRow(workspaceId)
      return row ? publicLink(row) : null
    },

    async getWithCredential(workspaceId) {
      const row = await getRow(workspaceId)
      if (!row?.credentialBlob) return null
      return {
        link: publicLink(row),
        credential: decryptCredentials<FeedCloudCredential>(
          row.credentialBlob,
          encryptionKey,
        ),
      }
    },

    async savePending(input) {
      const encrypted = encryptCredentials<FeedCloudCredential>(
        { deviceSecret: input.deviceSecret },
        encryptionKey,
      )
      const result = await query<LinkRow>(
        `INSERT INTO self_host_feed_cloud_links (
           workspace_id, assistant_id, installation_id, cloud_base_url,
           local_origin, status,
           device_code, user_code, verification_url, credential_blob,
           expires_at, created_by, last_error
         ) VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9,$10,$11,NULL)
         ON CONFLICT (workspace_id) DO UPDATE SET
           assistant_id=EXCLUDED.assistant_id,
           installation_id=EXCLUDED.installation_id,
           cloud_base_url=EXCLUDED.cloud_base_url,
           local_origin=EXCLUDED.local_origin,
           status='pending',
           device_code=EXCLUDED.device_code,
           user_code=EXCLUDED.user_code,
           verification_url=EXCLUDED.verification_url,
           credential_blob=EXCLUDED.credential_blob,
           hosted_link_id=NULL,
           hosted_workspace_id=NULL,
           hosted_workspace_name=NULL,
           hosted_assistant_id=NULL,
           hosted_assistant_name=NULL,
           hosted_plan=NULL,
           entitlements='{}'::jsonb,
           expires_at=EXCLUDED.expires_at,
           last_checked_at=NULL,
           last_error=NULL,
           updated_at=now()
         RETURNING ${LINK_COLUMNS}`,
        [
          input.workspaceId,
          input.assistantId,
          input.installationId,
          input.cloudBaseUrl,
          input.localOrigin,
          input.deviceCode,
          input.userCode,
          input.verificationUrl,
          encrypted,
          input.expiresAt,
          input.createdBy,
        ],
      )
      return publicLink(result.rows[0])
    },

    async markLinked(input) {
      const encrypted = encryptCredentials<FeedCloudCredential>(
        { accessToken: input.accessToken },
        encryptionKey,
      )
      await query(
        `UPDATE self_host_feed_cloud_links SET
           status='linked', credential_blob=$2, device_code=NULL,
           hosted_link_id=$3, hosted_workspace_id=$4,
           hosted_workspace_name=$5, hosted_assistant_id=$6,
           hosted_assistant_name=$7, hosted_plan=$8, entitlements=$9,
           expires_at=NULL, last_checked_at=now(), last_error=NULL,
           updated_at=now()
         WHERE workspace_id=$1`,
        [
          input.workspaceId,
          encrypted,
          input.hostedLinkId,
          input.hostedWorkspaceId,
          input.hostedWorkspaceName,
          input.hostedAssistantId,
          input.hostedAssistantName,
          input.hostedPlan,
          JSON.stringify(input.entitlements),
        ],
      )
    },

    async markPlanRequired(workspaceId, plan) {
      await query(
        `UPDATE self_host_feed_cloud_links SET status='plan_required',
           hosted_plan=COALESCE($2, hosted_plan), last_checked_at=now(),
           last_error='A paid hosted plan is required.', updated_at=now()
         WHERE workspace_id=$1`,
        [workspaceId, plan ?? null],
      )
    },

    async markError(workspaceId, error) {
      await query(
        `UPDATE self_host_feed_cloud_links SET status='error',
           last_checked_at=now(), last_error=$2, updated_at=now()
         WHERE workspace_id=$1`,
        [workspaceId, error.slice(0, 500)],
      )
    },

    async touchEntitlement(input) {
      await query(
        `UPDATE self_host_feed_cloud_links SET status='linked',
           hosted_plan=$2, entitlements=$3, last_checked_at=now(),
           last_error=NULL, updated_at=now()
         WHERE workspace_id=$1`,
        [input.workspaceId, input.plan, JSON.stringify(input.entitlements)],
      )
    },

    async remove(workspaceId) {
      await query('DELETE FROM self_host_feed_cloud_links WHERE workspace_id=$1', [workspaceId])
    },
  }
}
