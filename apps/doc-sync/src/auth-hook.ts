/**
 * WS-connect authentication for the doc sync service. Pure + injectable
 * (the JWT verifier is a param) so it unit-tests without minting real tokens.
 *
 * Three outcomes:
 *   - `user`    — a valid end-user access token; the clearance gate runs next.
 *   - `service` — the privileged server-side AI client (token === the shared
 *     DOC_SYNC_SECRET); bypasses the per-user clearance gate (it acts on
 *     behalf of the workspace assistant, already governed at the chat layer).
 *   - `reject`  — missing/invalid token; the connection is refused.
 *
 * [COMP:doc-sync/auth]
 */

import { verifyAccessToken } from '@sidanclaw/api/auth/jwt.js'

export type AuthResult =
  | { kind: 'user'; userId: string }
  | { kind: 'service' }
  | { kind: 'reject'; reason: string }

export type VerifyFn = (token: string, secret: string) => string | null

export function resolveAuth(params: {
  token: string | undefined
  jwtSecret: string
  syncSecret?: string
  /** Injectable for tests; defaults to the real HS256 verifier. */
  verify?: VerifyFn
}): AuthResult {
  const token = (params.token ?? '').trim()
  if (!token) return { kind: 'reject', reason: 'missing_token' }
  if (params.syncSecret && token === params.syncSecret) return { kind: 'service' }
  const verify = params.verify ?? verifyAccessToken
  const userId = verify(token, params.jwtSecret)
  if (!userId) return { kind: 'reject', reason: 'invalid_token' }
  return { kind: 'user', userId }
}
