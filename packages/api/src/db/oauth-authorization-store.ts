/**
 * OAuth authorization store — active grants + issued tokens.
 *
 * One row per (client × user × workspace) consent. The row threads through
 * three lifecycle states stored in the same record:
 *
 *   1. **Code issued.** Consent screen Allow → row created with `code_hash`,
 *      `code_challenge`, `code_redirect_uri` set, tokens null. Returned to
 *      the OAuth client as `?code=oac_<id>_<secret>`.
 *   2. **Tokens issued.** Client POSTs to /token with code + code_verifier;
 *      the row's `code_hash` is atomically cleared and the access + refresh
 *      hashes set. Returned as `{access_token, refresh_token}`.
 *   3. **Refresh rotated.** Each /token refresh_token grant clears the old
 *      refresh hash and writes a new pair. Replay of the old refresh token
 *      fails the hash compare.
 *
 * The brain MCP endpoint looks up by `oat_*`'s id segment, scrypt-compares
 * `access_token_hash`, and resolves to `BrainAuth{workspaceId, scope}` —
 * the same shape the `sk_brain_*` path returns.
 *
 * Spec: docs/architecture/features/programmatic-access.md → "OAuth 2.1 mode".
 * Component tag: [COMP:api/oauth-authorization-store].
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { query, queryWithRLS } from './client.js'
import { hashSecret, verifySecret } from './api-key-store.js'

const SECRET_BYTES = 32

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const AUTH_CODE_TTL_SECONDS = 10 * 60
export const ACCESS_TOKEN_TTL_SECONDS = 10 * 60
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60

export type OAuthScope = 'read' | 'read_write'

export type OAuthAuthorizationRow = {
  id: string
  clientId: string
  userId: string
  workspaceId: string
  scope: OAuthScope
  /** Legacy mocks/rows without the discriminator retain the Brain audience only. */
  audience?: 'brain' | 'application'
  applicationClientId?: string | null
  createdAt: Date
  lastUsedAt: Date | null
  revokedAt: Date | null
  accessTokenExpiresAt: Date | null
  refreshTokenExpiresAt: Date | null
  captureAssistantId?: string | null
  captureProfileId?: string | null
}

/** Row joined with the client display fields — what the Studio UI lists. */
export type OAuthAuthorizationWithClient = OAuthAuthorizationRow & {
  clientName: string | null
  clientUri: string | null
}

type OAuthAuthorizationWithSecrets = OAuthAuthorizationRow & {
  codeHash: string | null
  codeExpiresAt: Date | null
  codeChallenge: string | null
  codeRedirectUri: string | null
  accessTokenHash: string | null
  refreshTokenHash: string | null
}

export type MintedTokenPair = {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

export type OAuthAuthorizationStore = {
  /**
   * Create a new grant in the "code issued" state. Auto-revokes any prior
   * active grant for the same (client, user, workspace) so the Studio UI
   * shows one row per app, not a stack. Returns the auth-code plaintext.
   * System-level — runs from the consent endpoint before token-issuance.
   */
  createGrantWithCode(params: {
    clientId: string
    userId: string
    workspaceId: string
    scope: OAuthScope
    codeChallenge: string
    redirectUri: string
    /** Only the explicit application audience accepts a reviewed maximum. */
    applicationConsent?: { grantIds: string[]; maximumHash: string; clientRevision: string }
  }): Promise<{ row: OAuthAuthorizationRow; codePlaintext: string }>

  /**
   * Exchange an authorization code for an access+refresh token pair. Atomic
   * single-use: the UPDATE that mints the tokens also clears the code_hash,
   * so a replay finds `code_hash IS NULL` and fails. Verifies:
   *   - code id structurally valid; row exists, not revoked
   *   - code_hash matches the supplied secret (scrypt)
   *   - code_expires_at in the future
   *   - PKCE: SHA256(code_verifier) === code_challenge
   *   - redirectUri matches the original code_redirect_uri
   * Returns the new token pair, or null on any failure.
   */
  exchangeCodeForTokens(params: {
    codeId: string
    codeSecret: string
    codeVerifier: string
    redirectUri: string
    clientId: string
  }): Promise<{ row: OAuthAuthorizationRow; tokens: MintedTokenPair } | null>

  /**
   * Rotate access+refresh on a refresh_token grant. Verifies:
   *   - row exists, not revoked
   *   - refresh_token_hash matches
   *   - refresh_token_expires_at in the future
   *   - clientId matches the row's client_id
   * Returns the new token pair, or null on any failure.
   */
  rotateOnRefresh(params: {
    refreshId: string
    refreshSecret: string
    clientId: string
  }): Promise<{ row: OAuthAuthorizationRow; tokens: MintedTokenPair } | null>

  /** Hot-path lookup by id (extracted from oat_* token). System-level. */
  getByIdSystem(id: string): Promise<OAuthAuthorizationWithSecrets | null>

  /** Fire-and-forget on a successful MCP call. System-level. */
  touchLastUsedAt(id: string): Promise<void>

  /** Studio UI: list grants for a workspace. RLS-gated (owner/admin). */
  listForWorkspace(
    actingUserId: string,
    workspaceId: string,
  ): Promise<OAuthAuthorizationWithClient[]>

  /** Studio UI: revoke a grant. RLS-gated. Idempotent. */
  revoke(actingUserId: string, id: string): Promise<boolean>

  /** Configure routed programmatic capture for this exact OAuth grant. */
  updateCaptureBinding(
    actingUserId: string,
    id: string,
    workspaceId: string,
    captureAssistantId: string | null,
    captureProfileId: string | null,
  ): Promise<boolean>
}

const COLS_ROW = `
  id,
  client_id                AS "clientId",
  user_id                  AS "userId",
  workspace_id             AS "workspaceId",
  scope,
  coalesce(to_jsonb(oauth_authorizations)->>'audience','brain') AS audience,
  (to_jsonb(oauth_authorizations)->>'application_client_id')::uuid AS "applicationClientId",
  created_at               AS "createdAt",
  last_used_at             AS "lastUsedAt",
  revoked_at               AS "revokedAt",
  access_token_expires_at  AS "accessTokenExpiresAt",
  refresh_token_expires_at AS "refreshTokenExpiresAt",
  capture_assistant_id     AS "captureAssistantId",
  capture_profile_id       AS "captureProfileId"
`

const COLS_WITH_SECRETS = `
  ${COLS_ROW},
  code_hash                AS "codeHash",
  code_expires_at          AS "codeExpiresAt",
  code_challenge           AS "codeChallenge",
  code_redirect_uri        AS "codeRedirectUri",
  access_token_hash        AS "accessTokenHash",
  refresh_token_hash       AS "refreshTokenHash"
`

function mintTokenPlaintext(
  prefix: 'oac' | 'oat' | 'ort',
  authorizationId: string,
): { plaintext: string; secret: string } {
  const secret = randomBytes(SECRET_BYTES).toString('base64url')
  return { plaintext: `${prefix}_${authorizationId}_${secret}`, secret }
}

/**
 * Parse an inbound bearer token. Returns null for any structural problem so
 * the caller returns a uniform 401.
 */
export function parseOAuthBearerToken(
  token: string,
  expected: 'oac' | 'oat' | 'ort',
): { id: string; secret: string } | null {
  const prefix = `${expected}_`
  if (!token.startsWith(prefix)) return null
  const rest = token.slice(prefix.length)
  const sep = rest.indexOf('_')
  if (sep < 0) return null
  const id = rest.slice(0, sep)
  const secret = rest.slice(sep + 1)
  if (!id || !secret) return null
  if (!UUID_RE.test(id)) return null
  return { id, secret }
}

export type OAuthAuthorizationAudience = { audience: 'brain' } | { audience: 'application'; applicationClientId: string }

/** One code/PKCE/refresh implementation, pinned to an explicit credential audience. */
export function createDbOAuthAuthorizationStore(profile: OAuthAuthorizationAudience = { audience: 'brain' }): OAuthAuthorizationStore {
  if (profile.audience !== 'brain' && profile.audience !== 'application'
    || profile.audience === 'application' && !UUID_RE.test(profile.applicationClientId)) throw new Error('Invalid OAuth audience profile')
  const applicationClientId = profile.audience === 'application' ? profile.applicationClientId : null
  // Both pieces are enum/UUID validated above; callers cannot supply SQL vocabulary.
  const audienceSql = (alias = '') => {
    const row = alias ? alias.slice(0,-1) : 'oauth_authorizations'
    return `coalesce(to_jsonb(${row})->>'audience','brain')='${profile.audience}' AND (to_jsonb(${row})->>'application_client_id') ${applicationClientId ? `='${applicationClientId}'` : 'IS NULL'}`
  }
  const applicationCurrentSql = () => applicationClientId
    ? ` AND application_oauth_binding_current(oauth_authorizations.id,'${applicationClientId}'::uuid)` : ''
  return {
    async createGrantWithCode(params) {
      if (!applicationClientId && params.applicationConsent) throw new Error('Application consent requires its application audience')
      if (applicationClientId) {
        const admitted = await query<{id:string}>(`SELECT id FROM application_clients WHERE id=$1 AND workspace_id=$2
          AND oauth_client_id=$3 AND status='active' AND application_runtime_qualified(workspace_id,'application_data')`,
        [applicationClientId,params.workspaceId,params.clientId])
        if (!admitted.rows[0]) throw new Error('Application OAuth issuance is not qualified')
      }
      const id = randomUUID()
      const code = mintTokenPlaintext('oac', id)
      const codeHash = await hashSecret(code.secret)
      const codeExpiresAt = new Date(Date.now() + AUTH_CODE_TTL_SECONDS * 1000)

      if (applicationClientId) {
        if (!params.applicationConsent) throw new Error('Reviewed application consent is required')
        const consent = params.applicationConsent
        const result = await query<OAuthAuthorizationRow>(`WITH review AS MATERIALIZED (
            SELECT application_oauth_consent_snapshot($10,$3,$11) AS value
          ), admitted AS MATERIALIZED (
            SELECT value FROM review WHERE value IS NOT NULL AND value->>'clientId'=$2 AND value->>'workspaceId'=$4::text
              AND value->>'revision'=$12 AND value->>'maximumHash'=$13 AND application_runtime_qualified($4,'application_data')
              AND EXISTS(SELECT 1 FROM application_clients client WHERE client.id=$10 AND $9=ANY(client.redirect_uris))
          ), revoked AS (
            UPDATE oauth_authorizations SET revoked_at=now(),access_token_hash=NULL,refresh_token_hash=NULL,code_hash=NULL
              WHERE client_id=$2 AND user_id=$3 AND workspace_id=$4 AND revoked_at IS NULL AND ${audienceSql()}
                AND EXISTS(SELECT 1 FROM admitted) RETURNING id
          ), issued AS (
            INSERT INTO oauth_authorizations(id,client_id,user_id,workspace_id,scope,audience,application_client_id,
              code_hash,code_expires_at,code_challenge,code_redirect_uri)
            SELECT $1,$2,$3,$4,$5,'application',$10,$6,$7,$8,$9 FROM admitted RETURNING *
          ), bound AS (
            INSERT INTO application_oauth_bindings(authorization_id,app_id,workspace_id,principal_user_id,parent_grant_id,maximum_grants,maximum_hash)
            SELECT issued.id,$10,$4,$3,(admitted.value->>'parentGrantId')::uuid,admitted.value->'maxima',admitted.value->>'maximumHash' FROM issued CROSS JOIN admitted RETURNING authorization_id
          ) SELECT ${COLS_ROW} FROM issued oauth_authorizations WHERE EXISTS(SELECT 1 FROM bound WHERE authorization_id=oauth_authorizations.id)`,
        [id,params.clientId,params.userId,params.workspaceId,params.scope,codeHash,codeExpiresAt,params.codeChallenge,params.redirectUri,
          applicationClientId,consent.grantIds,consent.clientRevision,consent.maximumHash])
        if (!result.rows[0]) throw new Error('Application consent changed or is not qualified')
        return { row: result.rows[0], codePlaintext: code.plaintext }
      }

      // Auto-revoke any prior active grant for the same (client × user ×
      // workspace) so the user sees one live row per app. Audit-preserving:
      // revoked rows stay with `revoked_at = now()`.
      const result = await query<OAuthAuthorizationRow>(
        `WITH revoked AS (
           UPDATE oauth_authorizations
           SET revoked_at = now(),
               access_token_hash = NULL,
               refresh_token_hash = NULL,
               code_hash = NULL
           WHERE client_id = $2 AND user_id = $3 AND workspace_id = $4
             AND revoked_at IS NULL AND ${audienceSql()}
           RETURNING id
         )
         INSERT INTO oauth_authorizations (
           id, client_id, user_id, workspace_id, scope${applicationClientId ? ', audience, application_client_id' : ''},
           code_hash, code_expires_at, code_challenge, code_redirect_uri
         ) VALUES ($1, $2, $3, $4, $5${applicationClientId ? `, 'application', '${applicationClientId}'::uuid` : ''}, $6, $7, $8, $9)
         RETURNING ${COLS_ROW}`,
        [
          id,
          params.clientId,
          params.userId,
          params.workspaceId,
          params.scope,
          codeHash,
          codeExpiresAt,
          params.codeChallenge,
          params.redirectUri,
        ],
      )
      return { row: result.rows[0], codePlaintext: code.plaintext }
    },

    async exchangeCodeForTokens(params) {
      const result = await query<OAuthAuthorizationWithSecrets>(
        `SELECT ${COLS_WITH_SECRETS}
         FROM oauth_authorizations
         WHERE id = $1 AND revoked_at IS NULL AND ${audienceSql()}${applicationCurrentSql()}
         LIMIT 1`,
        [params.codeId],
      )
      const row = result.rows[0]
      if (!row) return null
      if (!row.codeHash || !row.codeExpiresAt) return null
      if (row.clientId !== params.clientId) return null
      if (row.codeRedirectUri !== params.redirectUri) return null
      if (row.codeExpiresAt.getTime() <= Date.now()) return null
      const ok = await verifySecret(params.codeSecret, row.codeHash)
      if (!ok) return null
      // PKCE: code_challenge = BASE64URL(SHA256(code_verifier)).
      const { createHash } = await import('node:crypto')
      const challenge = createHash('sha256').update(params.codeVerifier).digest('base64url')
      if (challenge !== row.codeChallenge) return null

      // Mint and atomically clear the code. The CAS `code_hash IS NOT NULL`
      // gate is the single-use enforcement — a parallel replay finds it
      // already-consumed and gets 0 rows back.
      const access = mintTokenPlaintext('oat', row.id)
      const refresh = mintTokenPlaintext('ort', row.id)
      const accessHash = await hashSecret(access.secret)
      const refreshHash = await hashSecret(refresh.secret)
      const accessExpiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000)
      const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000)
      const upd = await query<OAuthAuthorizationRow>(
        `UPDATE oauth_authorizations
         SET code_hash               = NULL,
             code_expires_at         = NULL,
             code_challenge          = NULL,
             code_redirect_uri       = NULL,
             access_token_hash       = $2,
             access_token_expires_at = $3,
             refresh_token_hash      = $4,
             refresh_token_expires_at = $5
         WHERE id = $1 AND code_hash = $6 AND revoked_at IS NULL AND ${audienceSql()}${applicationCurrentSql()}
         RETURNING ${COLS_ROW}`,
        [row.id, accessHash, accessExpiresAt, refreshHash, refreshExpiresAt, row.codeHash],
      )
      const updated = upd.rows[0]
      if (!updated) return null
      return {
        row: updated,
        tokens: {
          accessToken: access.plaintext,
          refreshToken: refresh.plaintext,
          expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        },
      }
    },

    async rotateOnRefresh(params) {
      const result = await query<OAuthAuthorizationWithSecrets>(
        `SELECT ${COLS_WITH_SECRETS}
         FROM oauth_authorizations
         WHERE id = $1 AND revoked_at IS NULL AND ${audienceSql()}${applicationCurrentSql()}
         LIMIT 1`,
        [params.refreshId],
      )
      const row = result.rows[0]
      if (!row) return null
      if (!row.refreshTokenHash || !row.refreshTokenExpiresAt) return null
      if (row.clientId !== params.clientId) return null
      if (row.refreshTokenExpiresAt.getTime() <= Date.now()) return null
      const ok = await verifySecret(params.refreshSecret, row.refreshTokenHash)
      if (!ok) return null

      const access = mintTokenPlaintext('oat', row.id)
      const refresh = mintTokenPlaintext('ort', row.id)
      const accessHash = await hashSecret(access.secret)
      const refreshHash = await hashSecret(refresh.secret)
      const accessExpiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000)
      const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000)
      // CAS on the existing refresh hash — a parallel reuse of the same
      // refresh token races and one side gets 0 rows.
      const upd = await query<OAuthAuthorizationRow>(
        `UPDATE oauth_authorizations
         SET access_token_hash        = $2,
             access_token_expires_at  = $3,
             refresh_token_hash       = $4,
             refresh_token_expires_at = $5,
             last_used_at             = now()
         WHERE id = $1 AND refresh_token_hash = $6 AND revoked_at IS NULL AND ${audienceSql()}${applicationCurrentSql()}
         RETURNING ${COLS_ROW}`,
        [row.id, accessHash, accessExpiresAt, refreshHash, refreshExpiresAt, row.refreshTokenHash],
      )
      const updated = upd.rows[0]
      if (!updated) return null
      return {
        row: updated,
        tokens: {
          accessToken: access.plaintext,
          refreshToken: refresh.plaintext,
          expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        },
      }
    },

    async getByIdSystem(id) {
      const result = await query<OAuthAuthorizationWithSecrets>(
        `SELECT ${COLS_WITH_SECRETS}
         FROM oauth_authorizations
         WHERE id = $1 AND ${audienceSql()}${applicationCurrentSql()}
           AND EXISTS (SELECT 1 FROM oauth_clients c WHERE c.client_id=oauth_authorizations.client_id AND c.revoked_at IS NULL)
         LIMIT 1`,
        [id],
      )
      return result.rows[0] ?? null
    },

    async touchLastUsedAt(id) {
      await query(
        `UPDATE oauth_authorizations SET last_used_at = now() WHERE id = $1 AND ${audienceSql()}`,
        [id],
      )
    },

    async listForWorkspace(actingUserId, workspaceId) {
      const result = await queryWithRLS<OAuthAuthorizationWithClient>(
        actingUserId,
        `SELECT a.id,
                a.client_id                AS "clientId",
                a.user_id                  AS "userId",
                a.workspace_id             AS "workspaceId",
                a.scope,
                coalesce(to_jsonb(a)->>'audience','brain') AS audience,
                (to_jsonb(a)->>'application_client_id')::uuid AS "applicationClientId",
                a.created_at               AS "createdAt",
                a.last_used_at             AS "lastUsedAt",
                a.revoked_at               AS "revokedAt",
                a.access_token_expires_at  AS "accessTokenExpiresAt",
                a.refresh_token_expires_at AS "refreshTokenExpiresAt",
                a.capture_assistant_id     AS "captureAssistantId",
                a.capture_profile_id       AS "captureProfileId",
                c.client_name              AS "clientName",
                c.client_uri               AS "clientUri"
         FROM oauth_authorizations a
         JOIN oauth_clients c ON c.client_id = a.client_id
         WHERE a.workspace_id = $1 AND ${audienceSql('a.')}
         ORDER BY a.created_at DESC`,
        [workspaceId],
      )
      return result.rows
    },

    async revoke(actingUserId, id) {
      const result = await queryWithRLS<{ id: string }>(
        actingUserId,
        `UPDATE oauth_authorizations
         SET revoked_at         = now(),
             access_token_hash  = NULL,
             refresh_token_hash = NULL,
             code_hash          = NULL
         WHERE id = $1 AND revoked_at IS NULL AND ${audienceSql()}
         RETURNING id`,
        [id],
      )
      return result.rows.length > 0
    },

    async updateCaptureBinding(
      actingUserId,
      id,
      workspaceId,
      captureAssistantId,
      captureProfileId,
    ) {
      if (profile.audience !== 'brain') return false
      const result = await queryWithRLS<{ id: string }>(
        actingUserId,
        `UPDATE oauth_authorizations oa
            SET capture_assistant_id = $3,
                capture_profile_id = $4
          WHERE oa.id = $1 AND oa.workspace_id = $2 AND ${audienceSql('oa.')}
            AND oa.revoked_at IS NULL
            AND ($3::uuid IS NOT NULL OR $4::uuid IS NULL)
            AND (
              $3::uuid IS NULL
              OR EXISTS (SELECT 1 FROM assistants a WHERE a.id = $3 AND a.workspace_id = $2)
            )
            AND (
              $4::uuid IS NULL
              OR EXISTS (
                SELECT 1 FROM programmatic_capture_profiles p
                 WHERE p.id = $4 AND p.workspace_id = $2
              )
            )
          RETURNING oa.id`,
        [id, workspaceId, captureAssistantId, captureProfileId],
      )
      return result.rows.length > 0
    },
  }
}
