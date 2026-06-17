/**
 * Signed OAuth-state helpers — OPEN, pure HMAC.
 *
 * `signOAuthState` produces `<base64url(payload)>.<hmac-sha256>` (entirely
 * `[A-Za-z0-9_-]`, so there is nothing for an OAuth provider to normalize in
 * transit); `verifyOAuthState` checks the signature and recovers the payload.
 * Relocated out of the closed `feed/oauth-helpers.ts` so OPEN consumers (the
 * brain-MCP OAuth code flow) can import them without a closed dependency.
 */
import { createHmac } from 'node:crypto'

export function signOAuthState(payload: string, secret: string): string {
  const encoded = Buffer.from(payload, 'utf8').toString('base64url')
  const sig = createHmac('sha256', secret).update(encoded).digest('base64url')
  return `${encoded}.${sig}`
}

/** Verify and recover the original payload. Returns null on tampering or malformed input. */
export function verifyOAuthState(signed: string, secret: string): string | null {
  const dotIdx = signed.lastIndexOf('.')
  if (dotIdx < 0) return null
  const encoded = signed.slice(0, dotIdx)
  const sig = signed.slice(dotIdx + 1)
  const expected = createHmac('sha256', secret).update(encoded).digest('base64url')
  if (sig !== expected) return null
  try {
    return Buffer.from(encoded, 'base64url').toString('utf8')
  } catch {
    return null
  }
}
