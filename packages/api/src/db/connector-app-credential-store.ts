/**
 * `connector-app-credential-store.ts` — workspace-owned OAuth *app* credentials.
 *
 * Data-access layer over `connector_app_credentials` (migration 394). This is
 * the third source of a built-in connector's app pair, after the optional
 * config file and `process.env` — see `../connectors/app-credentials.ts` for
 * the resolution order, and docs/architecture/integrations/msgraph.md → "Auth".
 *
 * The distinction that matters: `connector_instance.credentials` holds the
 * per-USER grant (a refresh token). This table holds the per-WORKSPACE *app*
 * the grant was issued against (client id + secret). One workspace, one
 * registration, N members consenting into it.
 *
 * Secrets are AES-256-GCM blobs (`credential-crypto.ts`) under the
 * CHANNEL_CREDENTIAL_KEY master key. The decrypted pair is exposed only
 * through `getSystem`, which the OAuth exchange and nothing else calls; the
 * DTO every route returns carries `hasSecret` instead. A secret that has been
 * written can never be read back out through the API — the UI re-collects it
 * to change it, exactly like the Shopify BYO form and every channel credential.
 *
 * Two different boundaries guard writes and must not be conflated:
 *   - RLS (`workspace_members`) is the TENANCY boundary — you cannot touch
 *     another workspace's row at all.
 *   - `assertWorkspaceAdmin` is the AUTHORITY boundary — an ordinary member of
 *     your own workspace may read that an app is configured, but only an
 *     owner/admin may set or clear it. Repointing the app silently re-aims
 *     every future consent in the workspace.
 *
 * [COMP:api/connector-app-credential-store]
 */

import { query, queryWithRLS } from './client.js'
import { decryptCredentials, encryptCredentials } from './credential-crypto.js'

/** The decrypted pair. Never leaves the process except onto the token endpoint. */
export type ConnectorAppCredentials = {
  clientId: string
  clientSecret: string
  /** Provider-specific authority hint (msgraph: the Entra directory id). */
  tenantId?: string
}

/** What a route may return: everything except the secret. */
export type ConnectorAppCredentialSummary = {
  provider: string
  workspaceId: string
  clientId: string
  tenantId: string | null
  hasSecret: true
  updatedAt: Date
}

type SecretBlob = { clientSecret: string }

type Row = {
  workspace_id: string
  provider: string
  client_id: string
  tenant_id: string | null
  updated_at: Date
}

export type SetConnectorAppCredentialsParams = {
  actingUserId: string
  workspaceId: string
  provider: string
  clientId: string
  clientSecret: string
  tenantId?: string | null
}

export type ConnectorAppCredentialStore = {
  /**
   * RLS-gated summary for the Studio panel. Returns null when the workspace
   * has no row — which is NOT the same as "the connector is unconfigured",
   * because deployment config may still supply a pair. That merge is
   * `resolveConnectorAppConfig`'s job, not this store's.
   */
  get(actingUserId: string, workspaceId: string, provider: string): Promise<ConnectorAppCredentialSummary | null>
  /**
   * Decrypted pair for the OAuth exchange. System-level (owner pool): the
   * caller has already proved workspace access, and the exchange must also
   * work on paths where the acting user is not the row's author.
   */
  getSystem(workspaceId: string, provider: string): Promise<ConnectorAppCredentials | null>
  /** Upsert. Owner/admin only — throws `not_admin` otherwise. */
  set(params: SetConnectorAppCredentialsParams): Promise<ConnectorAppCredentialSummary>
  /** Remove the workspace's app, falling the workspace back to deployment config. */
  remove(actingUserId: string, workspaceId: string, provider: string): Promise<boolean>
}

/** Thrown when a non-admin attempts a write. Routes map this to 403. */
export class ConnectorAppCredentialAuthError extends Error {
  constructor(readonly reason: 'not_admin' | 'not_member') {
    super(`connector-app-credential-store: ${reason}`)
    this.name = 'ConnectorAppCredentialAuthError'
  }
}

async function assertWorkspaceAdmin(userId: string, workspaceId: string): Promise<void> {
  const result = await query<{ role: string }>(
    `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, userId],
  )
  const role = result.rows[0]?.role
  if (!role) throw new ConnectorAppCredentialAuthError('not_member')
  if (role !== 'owner' && role !== 'admin') throw new ConnectorAppCredentialAuthError('not_admin')
}

function toSummary(row: Row): ConnectorAppCredentialSummary {
  return {
    provider: row.provider,
    workspaceId: row.workspace_id,
    clientId: row.client_id,
    tenantId: row.tenant_id,
    hasSecret: true,
    updatedAt: row.updated_at,
  }
}

export function createConnectorAppCredentialStore(
  encryptionKey: Buffer | null,
): ConnectorAppCredentialStore {
  function encryptSecret(clientSecret: string): Buffer {
    if (!encryptionKey) {
      throw new Error(
        'connector-app-credential-store: CHANNEL_CREDENTIAL_KEY is required to store an app secret — refusing to store plaintext',
      )
    }
    return encryptCredentials<SecretBlob>({ clientSecret }, encryptionKey)
  }

  return {
    async get(actingUserId, workspaceId, provider) {
      const result = await queryWithRLS<Row>(
        actingUserId,
        `SELECT workspace_id, provider, client_id, tenant_id, updated_at
           FROM connector_app_credentials
          WHERE workspace_id = $1 AND provider = $2`,
        [workspaceId, provider],
      )
      const row = result.rows[0]
      return row ? toSummary(row) : null
    },

    async getSystem(workspaceId, provider) {
      const result = await query<Row & { client_secret_ciphertext: Buffer }>(
        `SELECT workspace_id, provider, client_id, tenant_id, updated_at, client_secret_ciphertext
           FROM connector_app_credentials
          WHERE workspace_id = $1 AND provider = $2`,
        [workspaceId, provider],
      )
      const row = result.rows[0]
      if (!row) return null
      if (!encryptionKey) {
        throw new Error(
          'connector-app-credential-store: CHANNEL_CREDENTIAL_KEY is required to read an app secret',
        )
      }
      const { clientSecret } = decryptCredentials<SecretBlob>(row.client_secret_ciphertext, encryptionKey)
      return {
        clientId: row.client_id,
        clientSecret,
        ...(row.tenant_id ? { tenantId: row.tenant_id } : {}),
      }
    },

    async set(params) {
      await assertWorkspaceAdmin(params.actingUserId, params.workspaceId)
      const ciphertext = encryptSecret(params.clientSecret)
      const result = await queryWithRLS<Row>(
        params.actingUserId,
        `INSERT INTO connector_app_credentials
           (workspace_id, provider, client_id, client_secret_ciphertext, tenant_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (workspace_id, provider) DO UPDATE
            SET client_id = EXCLUDED.client_id,
                client_secret_ciphertext = EXCLUDED.client_secret_ciphertext,
                tenant_id = EXCLUDED.tenant_id,
                updated_at = now()
         RETURNING workspace_id, provider, client_id, tenant_id, updated_at`,
        [
          params.workspaceId,
          params.provider,
          params.clientId,
          ciphertext,
          params.tenantId ?? null,
          params.actingUserId,
        ],
      )
      return toSummary(result.rows[0]!)
    },

    async remove(actingUserId, workspaceId, provider) {
      await assertWorkspaceAdmin(actingUserId, workspaceId)
      const result = await queryWithRLS(
        actingUserId,
        `DELETE FROM connector_app_credentials WHERE workspace_id = $1 AND provider = $2`,
        [workspaceId, provider],
      )
      return (result.rowCount ?? 0) > 0
    },
  }
}
