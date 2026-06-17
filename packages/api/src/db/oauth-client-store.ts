/**
 * OAuth client store — RFC 7591 dynamic client registration.
 *
 * Clients are global (not workspace-scoped). One client = one third-party
 * MCP consumer (Claude.ai, Claude Desktop, ChatGPT). Each user's grants
 * against a workspace live in `oauth_authorizations` (208) — that's the
 * workspace-scoped table.
 *
 * Plaintext format for a confidential client's secret: `oac_<id_short>_<base64url(32)>`.
 * Public clients have `clientSecretHash = null` and authenticate by PKCE
 * alone (the default for browser-based MCP clients).
 *
 * Spec: docs/architecture/features/programmatic-access.md → "OAuth 2.1 mode".
 * Component tag: [COMP:api/oauth-client-store].
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { query } from './client.js'
import { hashSecret } from './api-key-store.js'

const SECRET_BYTES = 32

export type OAuthTokenEndpointAuthMethod = 'none' | 'client_secret_post'

export type OAuthClientRow = {
  id: string
  clientId: string
  clientName: string | null
  clientUri: string | null
  redirectUris: string[]
  tokenEndpointAuthMethod: OAuthTokenEndpointAuthMethod
  createdAt: Date
  lastUsedAt: Date | null
  revokedAt: Date | null
}

type OAuthClientRowWithHash = OAuthClientRow & { clientSecretHash: string | null }

export type CreatedOAuthClient = OAuthClientRow & {
  /** Returned ONCE at registration when auth method is `client_secret_post`. */
  clientSecret: string | null
}

const COLS_PUBLIC = `
  id,
  client_id                  AS "clientId",
  client_name                AS "clientName",
  client_uri                 AS "clientUri",
  redirect_uris              AS "redirectUris",
  token_endpoint_auth_method AS "tokenEndpointAuthMethod",
  created_at                 AS "createdAt",
  last_used_at               AS "lastUsedAt",
  revoked_at                 AS "revokedAt"
`

export type OAuthClientStore = {
  /**
   * Register a new OAuth client. System-level — RFC 7591 DCR runs pre-auth.
   * If `tokenEndpointAuthMethod = 'client_secret_post'`, mints a fresh
   * client_secret and returns it exactly once.
   */
  register(params: {
    clientName: string | null
    clientUri: string | null
    redirectUris: string[]
    tokenEndpointAuthMethod: OAuthTokenEndpointAuthMethod
  }): Promise<CreatedOAuthClient>

  /** Lookup by client_id for /authorize + /token. System-level. */
  getByClientIdSystem(clientId: string): Promise<OAuthClientRowWithHash | null>

  /** Fire-and-forget bump on successful token issuance. System-level. */
  touchLastUsedAt(clientId: string): Promise<void>
}

export function createDbOAuthClientStore(): OAuthClientStore {
  return {
    async register(params) {
      const id = randomUUID()
      // Public client_id shape: `oac_<8-char prefix>` (8 hex chars from the
      // row id). Keeps it short for display while staying unguessable.
      const clientId = `oac_${id.replace(/-/g, '').slice(0, 16)}`

      let clientSecret: string | null = null
      let clientSecretHash: string | null = null
      if (params.tokenEndpointAuthMethod === 'client_secret_post') {
        const secret = randomBytes(SECRET_BYTES).toString('base64url')
        clientSecret = secret
        clientSecretHash = await hashSecret(secret)
      }

      const result = await query<OAuthClientRowWithHash>(
        `INSERT INTO oauth_clients (
           id, client_id, client_secret_hash, client_name, client_uri,
           redirect_uris, token_endpoint_auth_method
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${COLS_PUBLIC}, client_secret_hash AS "clientSecretHash"`,
        [
          id,
          clientId,
          clientSecretHash,
          params.clientName,
          params.clientUri,
          params.redirectUris,
          params.tokenEndpointAuthMethod,
        ],
      )
      const row = result.rows[0]
      const { clientSecretHash: _omit, ...publicRow } = row
      return { ...publicRow, clientSecret }
    },

    async getByClientIdSystem(clientId) {
      const result = await query<OAuthClientRowWithHash>(
        `SELECT ${COLS_PUBLIC}, client_secret_hash AS "clientSecretHash"
         FROM oauth_clients
         WHERE client_id = $1
         LIMIT 1`,
        [clientId],
      )
      return result.rows[0] ?? null
    },

    async touchLastUsedAt(clientId) {
      await query(
        `UPDATE oauth_clients SET last_used_at = now() WHERE client_id = $1`,
        [clientId],
      )
    },
  }
}
