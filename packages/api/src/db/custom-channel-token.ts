/**
 * Custom channel bridge tokens — mint / hash / compare.
 *
 * A bridge token authenticates a PROCESS (the operator-run bridge), never a
 * person. It is shown to the workspace once at channel creation (or
 * rotation); only its SHA-256 hex hash is stored, inside the encrypted
 * `channel_integrations.credentials` blob as `bridge_token_hash`. Tokens are
 * 32 random bytes, base64url, prefixed `ubc_` so a leaked one is greppable.
 * Comparison is constant-time over the hash and fails closed on any shape
 * mismatch. See docs/architecture/channels/custom-channel.md → "Workspace-facing
 * routes". Component tag: [COMP:api/custom-channel-store].
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const BRIDGE_TOKEN_PREFIX = 'ubc_'

/** New bridge token: `ubc_` + 32 random bytes base64url. */
export function mintBridgeToken(): string {
  return `${BRIDGE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
}

/** SHA-256 hex of the token — the only thing ever persisted. */
export function hashBridgeToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * Constant-time check of a presented token against the stored hash. Hashing
 * first normalizes both sides to a fixed length so `timingSafeEqual` never
 * throws and the comparison leaks nothing about the stored value.
 */
export function bridgeTokenMatches(provided: unknown, storedHash: unknown): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false
  if (typeof storedHash !== 'string' || storedHash.length === 0) return false
  const a = Buffer.from(hashBridgeToken(provided), 'utf8')
  const b = Buffer.from(storedHash.toLowerCase(), 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}
