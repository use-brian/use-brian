/**
 * Brain key store — workspace-scoped API keys for the brain MCP server.
 *
 * See docs/architecture/features/programmatic-access.md for the full design.
 * Component tag: [COMP:api/brain-key-store].
 *
 * Plaintext format: `sk_brain_<keyId>_<base64url(32)>` — the same shape as
 * the public-API `sk_live_` keys (docs/architecture/features/public-api.md),
 * with a distinct prefix. The scrypt hashing util (`hashSecret` /
 * `verifySecret`) is shared with `api-key-store.ts`; only the plaintext
 * format helpers differ — `brain_keys` is a separate, *workspace*-scoped
 * table (api_keys is *assistant*-scoped).
 *
 * Plaintext is shown ONCE — at creation. Subsequent reads return only the
 * prefix and metadata.
 */

import { randomBytes } from 'node:crypto'
import type { Sensitivity } from '@sidanclaw/core'
import { query, queryWithRLS } from './client.js'
import { hashSecret } from './api-key-store.js'

const KEY_PREFIX = 'sk_brain_'
const SECRET_BYTES = 32
// `sk_brain_` (9) + the first 4 chars of the keyId UUID — enough to
// disambiguate keys in the settings UI, not enough to identify the secret.
const DISPLAY_PREFIX_LEN = 13

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ── Types ──────────────────────────────────────────────────────

export type BrainKeyScope = 'read' | 'read_write'

export type BrainKeyRow = {
  id: string
  workspaceId: string
  name: string
  prefix: string
  scope: BrainKeyScope
  status: 'active' | 'revoked'
  /**
   * Per-key clearance override (migration 262). NULL = the workspace primary
   * assistant's clearance governs; a tier = `min(primary, max_clearance)`.
   * Pre-262 keys are backfilled to 'internal' (no silent widening — see
   * docs/plans/agent-facing-capability-surface.md §12.1).
   */
  maxClearance: Sensitivity | null
  createdBy: string | null
  createdAt: Date
  lastUsedAt: Date | null
}

/** Internal — includes the hash. Never returned from public store methods. */
type BrainKeyRowWithHash = BrainKeyRow & { keyHash: string }

export type CreatedBrainKey = BrainKeyRow & {
  /** The plaintext key. Returned ONCE at creation; never retrievable again. */
  plaintext: string
}

// ── Plaintext format helpers ───────────────────────────────────

/**
 * Generate a fresh plaintext key bound to a row id. The row id must already
 * exist (or be inserted with this id) — the MCP endpoint uses the id segment
 * to look up the row before scrypt-comparing the secret.
 */
export function mintBrainPlaintext(keyId: string): {
  plaintext: string
  secret: string
  prefix: string
} {
  const secret = randomBytes(SECRET_BYTES).toString('base64url')
  const plaintext = `${KEY_PREFIX}${keyId}_${secret}`
  const prefix = plaintext.slice(0, DISPLAY_PREFIX_LEN)
  return { plaintext, secret, prefix }
}

/**
 * Parse an inbound `Authorization: Bearer ...` token. Returns null on any
 * structural problem so the caller returns a uniform 401 without leaking
 * which part was wrong.
 */
export function parseBrainAuthToken(
  token: string,
): { keyId: string; secret: string } | null {
  if (!token.startsWith(KEY_PREFIX)) return null
  const rest = token.slice(KEY_PREFIX.length)
  // `<keyId>_<secret>` — keyId is a UUID (contains hyphens). Split at the
  // first underscore so underscores in the base64url secret are preserved.
  const sep = rest.indexOf('_')
  if (sep < 0) return null
  const keyId = rest.slice(0, sep)
  const secret = rest.slice(sep + 1)
  if (!keyId || !secret) return null
  // Cheap UUID shape gate — protects scrypt from being run on garbage.
  if (!UUID_RE.test(keyId)) return null
  return { keyId, secret }
}

// ── Store ──────────────────────────────────────────────────────

export type BrainKeyStore = {
  /**
   * Create a new active brain key. Returns the plaintext exactly once.
   * RLS-gated: `actingUserId` must own or admin the workspace.
   */
  create(params: {
    workspaceId: string
    name: string
    scope: BrainKeyScope
    actingUserId: string
    /** Omitted / null = the workspace primary assistant's clearance governs. */
    maxClearance?: Sensitivity | null
  }): Promise<CreatedBrainKey>

  /** List keys for a workspace. RLS-gated (owner/admin). Plaintext never returned. */
  listForWorkspace(actingUserId: string, workspaceId: string): Promise<BrainKeyRow[]>

  /**
   * MCP-endpoint hot-path lookup by id. System-level (no RLS) — the request
   * is pre-auth and the returned hash is only used for the constant-time
   * compare, never exposed to the client.
   */
  getByIdSystem(id: string): Promise<BrainKeyRowWithHash | null>

  /** Soft-delete: status='revoked'. RLS-gated. Idempotent. */
  revoke(actingUserId: string, id: string): Promise<boolean>

  /**
   * Set or clear the per-key clearance override. RLS-gated (owner/admin).
   * `null` clears the cap — the primary assistant's clearance then governs.
   * Returns false when the key is not visible to the caller.
   */
  updateMaxClearance(
    actingUserId: string,
    id: string,
    maxClearance: Sensitivity | null,
  ): Promise<boolean>

  /** Fire-and-forget. System-level. */
  touchLastUsedAt(id: string): Promise<void>
}

const COLS_PUBLIC = `
  id,
  workspace_id as "workspaceId",
  name,
  key_prefix   as "prefix",
  scope,
  status,
  max_clearance as "maxClearance",
  created_by   as "createdBy",
  created_at   as "createdAt",
  last_used_at as "lastUsedAt"
`

export function createDbBrainKeyStore(): BrainKeyStore {
  return {
    async create(params) {
      const { randomUUID } = await import('node:crypto')
      const id = randomUUID()
      const { plaintext, secret, prefix } = mintBrainPlaintext(id)
      const keyHash = await hashSecret(secret)

      const result = await queryWithRLS<BrainKeyRowWithHash>(
        params.actingUserId,
        `INSERT INTO brain_keys (id, workspace_id, name, key_hash, key_prefix, scope, max_clearance, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING ${COLS_PUBLIC}, key_hash as "keyHash"`,
        [
          id,
          params.workspaceId,
          params.name,
          keyHash,
          prefix,
          params.scope,
          params.maxClearance ?? null,
          params.actingUserId,
        ],
      )
      if (result.rows.length === 0) {
        // RLS WITH CHECK rejected the insert — caller is not owner/admin.
        throw new Error('Not authorized to create a brain key for this workspace')
      }
      // Strip the hash before returning — store results flow into JSON.
      const { keyHash: _omit, ...publicRow } = result.rows[0]
      return { ...publicRow, plaintext }
    },

    async listForWorkspace(actingUserId, workspaceId) {
      const result = await queryWithRLS<BrainKeyRow>(
        actingUserId,
        `SELECT ${COLS_PUBLIC}
         FROM brain_keys
         WHERE workspace_id = $1
         ORDER BY created_at DESC`,
        [workspaceId],
      )
      return result.rows
    },

    async getByIdSystem(id) {
      const result = await query<BrainKeyRowWithHash>(
        `SELECT ${COLS_PUBLIC}, key_hash as "keyHash"
         FROM brain_keys
         WHERE id = $1
         LIMIT 1`,
        [id],
      )
      return result.rows[0] ?? null
    },

    async revoke(actingUserId, id) {
      // Idempotent — revoking an already-revoked key still returns true if
      // the caller is authorized for the row. RLS scopes the UPDATE to
      // workspaces the caller owns/admins.
      const result = await queryWithRLS<{ id: string }>(
        actingUserId,
        `UPDATE brain_keys
         SET status = 'revoked'
         WHERE id = $1
         RETURNING id`,
        [id],
      )
      return result.rows.length > 0
    },

    async updateMaxClearance(actingUserId, id, maxClearance) {
      const result = await queryWithRLS<{ id: string }>(
        actingUserId,
        `UPDATE brain_keys
         SET max_clearance = $2
         WHERE id = $1
         RETURNING id`,
        [id, maxClearance],
      )
      return result.rows.length > 0
    },

    async touchLastUsedAt(id) {
      await query(`UPDATE brain_keys SET last_used_at = now() WHERE id = $1`, [id])
    },
  }
}
