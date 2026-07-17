/**
 * Brain MCP server — bearer authentication (dual-mode).
 *
 * Accepts either auth path on `Authorization: Bearer ...` and resolves both
 * to the same `BrainAuth{workspaceId, scope}` shape the rest of the brain
 * MCP server consumes:
 *
 *   1. **API key** — `sk_brain_<keyId>_<secret>` (migration 155). Direct,
 *      header-pasted credentials issued via Studio ▸ Programmatic Access.
 *      Workspace-scoped at the key level.
 *
 *   2. **OAuth 2.1 access token** — `oat_<authorizationId>_<secret>`
 *      (migration 208). Issued via the OAuth flow at /api/brain/oauth/*.
 *      Workspace-scoped at the grant level. Expires after 10 min; the
 *      client refreshes via `grant_type=refresh_token`.
 *
 * Both paths are scrypt-hashed at rest (`hashSecret`/`verifySecret`,
 * `api-key-store.ts`) and run a constant-time compare on the secret half
 * after a cheap id-shape gate. A failure of any kind returns null so the
 * caller emits a uniform 401 — a probe cannot distinguish "bad key" from
 * "revoked grant" from "expired access token."
 *
 * Component tag: [COMP:api/brain-mcp].
 */

import type { Request } from 'express'
import type { Sensitivity } from '@use-brian/core'
import { verifySecret } from '../db/api-key-store.js'
import {
  parseBrainAuthToken,
  type BrainKeyScope,
  type BrainKeyStore,
} from '../db/brain-keys-store.js'
import {
  parseOAuthBearerToken,
  type OAuthAuthorizationStore,
} from '../db/oauth-authorization-store.js'

export type BrainAuth = {
  /**
   * Identifier of the authenticating principal. For API keys this is the
   * brain_keys row id; for OAuth tokens it's the oauth_authorizations row
   * id. Used as a per-call provenance tag.
   */
  keyId: string
  workspaceId: string
  scope: BrainKeyScope
  /**
   * Per-credential clearance cap. NULL = the workspace primary assistant's
   * clearance governs; a tier caps the effective ceiling at
   * `min(primary.clearance, maxClearance)`. API keys carry the row's
   * `max_clearance` (migration 262); OAuth tokens stay pinned at the
   * historical 'internal' ceiling until oauth_authorizations grows its own
   * override. See docs/architecture/integrations/agent-capability-surface.md §12.1.
   */
  maxClearance: Sensitivity | null
  /** Which path resolved this principal. Useful for analytics + audit. */
  authKind: 'api_key' | 'oauth_token'
}

export type BrainAuthOptions = {
  brainKeyStore: BrainKeyStore
  /**
   * Optional — when unset the OAuth path is skipped. Keeps the OAuth
   * dependency injectable for tests + lets boot order vary across apps.
   */
  authorizationStore?: OAuthAuthorizationStore
}

/**
 * Authenticate a brain MCP request. Returns the resolved workspace + scope,
 * or null on any failure. On success, the appropriate `last_used_at` is
 * touched fire-and-forget.
 */
export async function authenticateBrainRequest(
  req: Request,
  opts: BrainAuthOptions,
): Promise<BrainAuth | null> {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length)

  // ── Path 1: legacy API key (sk_brain_*) ─────────────────────────
  const apiKeyParts = parseBrainAuthToken(token)
  if (apiKeyParts) {
    const row = await opts.brainKeyStore.getByIdSystem(apiKeyParts.keyId)
    if (!row) return null
    if (row.status !== 'active') return null
    const ok = await verifySecret(apiKeyParts.secret, row.keyHash)
    if (!ok) return null
    opts.brainKeyStore.touchLastUsedAt(row.id).catch((err) => {
      console.error('[brain-mcp] touchLastUsedAt failed:', err)
    })
    return {
      keyId: row.id,
      workspaceId: row.workspaceId,
      scope: row.scope,
      maxClearance: row.maxClearance,
      authKind: 'api_key',
    }
  }

  // ── Path 2: OAuth access token (oat_*) ──────────────────────────
  if (opts.authorizationStore) {
    const oatParts = parseOAuthBearerToken(token, 'oat')
    if (oatParts) {
      const row = await opts.authorizationStore.getByIdSystem(oatParts.id)
      if (!row) return null
      if (row.revokedAt) return null
      if (!row.accessTokenHash || !row.accessTokenExpiresAt) return null
      if (row.accessTokenExpiresAt.getTime() <= Date.now()) return null
      const ok = await verifySecret(oatParts.secret, row.accessTokenHash)
      if (!ok) return null
      opts.authorizationStore.touchLastUsedAt(row.id).catch((err) => {
        console.error('[brain-mcp] touchLastUsedAt failed:', err)
      })
      return {
        keyId: row.id,
        workspaceId: row.workspaceId,
        scope: row.scope as BrainKeyScope,
        // OAuth grants keep the historical fixed ceiling until
        // oauth_authorizations grows a per-grant override (follow-up).
        maxClearance: 'internal',
        authKind: 'oauth_token',
      }
    }
  }

  return null
}
