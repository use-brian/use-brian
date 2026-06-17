/**
 * API key store — per-assistant credentials for the public API surface.
 *
 * See docs/architecture/features/public-api.md for the full design.
 * Component tag: [COMP:api/api-key-store].
 *
 * Plaintext format: `sk_live_<keyId>_<base64url(32)>`
 *   - The `sk_live_` prefix is fixed.
 *   - `<keyId>` is the row's UUID, used by the route to look up the row
 *     before doing the constant-time hash compare. Without it, every
 *     request would have to scrypt-compare against every active row.
 *   - `<base64url(32)>` is a 32-byte CSPRNG secret.
 *
 * The hash is scrypt with a per-record random salt, encoded as
 *   `scrypt$<N>$<r>$<p>$<saltB64>$<hashB64>`
 * so future parameter bumps stay verifiable. Constant-time comparison via
 * `timingSafeEqual` on equal-length Buffers.
 *
 * Plaintext is shown ONCE — at creation. Subsequent reads return only the
 * prefix and metadata. There is intentionally no `getPlaintext` method.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { query, queryWithRLS } from './client.js'

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options?: { N?: number; r?: number; p?: number; maxmem?: number },
) => Promise<Buffer>

// scrypt cost parameters. N=2^14 keeps a single verify ~30ms on a Cloud Run
// CPU which is the right ballpark — fast enough that legitimate API traffic
// isn't gated by hashing, slow enough that brute-forcing a leaked DB row
// requires meaningful compute. Bump only with a parallel verify path so
// existing rows still validate.
const SCRYPT_N = 1 << 14
const SCRYPT_r = 8
const SCRYPT_p = 1
const SCRYPT_KEYLEN = 32
const SCRYPT_SALT_BYTES = 16
// scrypt's default maxmem is too low for N=2^14. 64 MiB is comfortably
// above 128 * N * r = 16 MiB and matches what other production services
// use. Without this override scrypt throws ERR_CRYPTO_INVALID_SCRYPT_PARAMS.
const SCRYPT_MAXMEM = 64 * 1024 * 1024

const KEY_PREFIX = 'sk_live_'
// `sk_live_` (8) + `<keyId>_` (37) + `<base64url(32)>` (~43). 88 chars total.
const SECRET_BYTES = 32
const DISPLAY_PREFIX_LEN = 12 // `sk_live_<first 4 of keyId>` — enough to disambiguate, not enough to identify the secret.

// ── Types ──────────────────────────────────────────────────────

/**
 * Per-key purpose (migration 263). `chat` = the original external story —
 * the /messages endpoints only. `agent` = internal use — additionally opens
 * the assistant MCP endpoint (agent capability surface). Immutable
 * post-issue: mint a new key to change purpose (rotation flow), never
 * widen a distributed credential in place.
 */
export type ApiKeyScope = 'chat' | 'agent'

export type ApiKeyRow = {
  id: string
  assistantId: string
  name: string
  prefix: string
  scope: ApiKeyScope
  status: 'active' | 'revoked'
  createdBy: string | null
  createdAt: Date
  lastUsedAt: Date | null
}

/** Internal — includes the hash. Never returned from public store methods. */
type ApiKeyRowWithHash = ApiKeyRow & { keyHash: string }

export type CreatedApiKey = ApiKeyRow & {
  /** The plaintext API key. Returned ONCE at creation; never retrievable again. */
  plaintext: string
}

// ── Hashing ────────────────────────────────────────────────────

/**
 * Encode the hash as `scrypt$N$r$p$salt$hash` so a future parameter bump
 * stays verifiable against existing rows. Pure — exported for tests.
 */
export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_BYTES)
  const derived = await scrypt(secret, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_r,
    p: SCRYPT_p,
    maxmem: SCRYPT_MAXMEM,
  })
  return `scrypt$${SCRYPT_N}$${SCRYPT_r}$${SCRYPT_p}$${salt.toString('base64')}$${derived.toString('base64')}`
}

/** Constant-time verify against the encoded hash. Returns false on any parse error. */
export async function verifySecret(secret: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const N = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false
  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(parts[4], 'base64')
    expected = Buffer.from(parts[5], 'base64')
  } catch {
    return false
  }
  const derived = await scrypt(secret, salt, expected.length, { N, r, p, maxmem: SCRYPT_MAXMEM })
  if (derived.length !== expected.length) return false
  return timingSafeEqual(derived, expected)
}

// ── Plaintext format helpers ───────────────────────────────────

/**
 * Generate a fresh plaintext key bound to a row id. The row id must already
 * exist (or be about to be inserted with this id) — the route uses the
 * id segment to look up the row before scrypt-comparing the secret.
 */
export function mintPlaintext(keyId: string): { plaintext: string; secret: string; prefix: string } {
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
export function parseAuthToken(token: string): { keyId: string; secret: string } | null {
  if (!token.startsWith(KEY_PREFIX)) return null
  const rest = token.slice(KEY_PREFIX.length)
  // `<keyId>_<secret>` — the keyId is a UUID (36 chars, contains hyphens).
  // Split at the first underscore to allow underscores in the secret half
  // (base64url uses '-' and '_').
  const sep = rest.indexOf('_')
  if (sep < 0) return null
  const keyId = rest.slice(0, sep)
  const secret = rest.slice(sep + 1)
  if (!keyId || !secret) return null
  // Cheap UUID shape gate — protects scrypt from being run on garbage.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(keyId)) return null
  return { keyId, secret }
}

// ── Store ──────────────────────────────────────────────────────

export type ApiKeyStore = {
  /**
   * Create a new active API key. Returns the plaintext exactly once. RLS-gated:
   * `actingUserId` must own or admin the assistant.
   */
  create(params: {
    assistantId: string
    name: string
    actingUserId: string
    /** Omitted = 'chat' (the least-privilege external default). */
    scope?: ApiKeyScope
  }): Promise<CreatedApiKey>

  /** List keys for an assistant. RLS-gated. Plaintext never returned. */
  listForUser(actingUserId: string, assistantId: string): Promise<ApiKeyRow[]>

  /**
   * Webhook hot-path lookup by id. System-level (no RLS) — the request is
   * pre-auth and the returned hash is only used for the constant-time
   * compare, never exposed to the client.
   */
  getByIdSystem(id: string): Promise<(ApiKeyRowWithHash) | null>

  /** Soft-delete: status='revoked'. RLS-gated. Idempotent. */
  revokeForUser(actingUserId: string, id: string): Promise<boolean>

  /** Fire-and-forget. System-level. */
  touchLastUsedAt(id: string): Promise<void>
}

const COLS_PUBLIC = `
  id,
  assistant_id as "assistantId",
  name,
  key_prefix   as "prefix",
  scope,
  status,
  created_by   as "createdBy",
  created_at   as "createdAt",
  last_used_at as "lastUsedAt"
`

export function createDbApiKeyStore(): ApiKeyStore {
  return {
    async create(params) {
      // Two-phase insert: first a placeholder hash so the row's id is
      // available, then update with the real hash bound to that id. We can
      // also generate the id app-side via gen_random_uuid in JS (`crypto.randomUUID`)
      // and INSERT it explicitly — that's simpler and one round-trip.
      // Use the latter.
      const { randomUUID } = await import('node:crypto')
      const id = randomUUID()
      const { plaintext, secret, prefix } = mintPlaintext(id)
      const keyHash = await hashSecret(secret)

      const result = await queryWithRLS<ApiKeyRowWithHash>(
        params.actingUserId,
        `INSERT INTO api_keys (id, assistant_id, name, key_hash, key_prefix, scope, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${COLS_PUBLIC}, key_hash as "keyHash"`,
        [id, params.assistantId, params.name, keyHash, prefix, params.scope ?? 'chat', params.actingUserId],
      )
      if (result.rows.length === 0) {
        throw new Error('Not authorized to create API key for this assistant')
      }
      const row = result.rows[0]
      // Strip the hash before returning. Don't widen this leak — store
      // method results flow into JSON responses.
      const { keyHash: _omit, ...publicRow } = row
      return { ...publicRow, plaintext }
    },

    async listForUser(actingUserId, assistantId) {
      const result = await queryWithRLS<ApiKeyRow>(
        actingUserId,
        `SELECT ${COLS_PUBLIC}
         FROM api_keys
         WHERE assistant_id = $1
         ORDER BY created_at DESC`,
        [assistantId],
      )
      return result.rows
    },

    async getByIdSystem(id) {
      const result = await query<ApiKeyRowWithHash>(
        `SELECT ${COLS_PUBLIC}, key_hash as "keyHash"
         FROM api_keys
         WHERE id = $1
         LIMIT 1`,
        [id],
      )
      return result.rows[0] ?? null
    },

    async revokeForUser(actingUserId, id) {
      // Idempotent — revoking an already-revoked key returns true if the
      // caller is authorized for the row. Returning rowCount lets the caller
      // distinguish "no such key" (404) from "already revoked" (200).
      const result = await queryWithRLS<{ id: string }>(
        actingUserId,
        `UPDATE api_keys
         SET status = 'revoked'
         WHERE id = $1
         RETURNING id`,
        [id],
      )
      return result.rows.length > 0
    },

    async touchLastUsedAt(id) {
      await query(
        `UPDATE api_keys SET last_used_at = now() WHERE id = $1`,
        [id],
      )
    },
  }
}
