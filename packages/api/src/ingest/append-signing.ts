/**
 * Outbound auth for `ub.ingest.append.v1` deliveries
 * (docs/architecture/brain/ingest-external-sink.md → "Outbound auth").
 *
 * Lives beside the relay (not in @use-brian/shared) because it needs
 * `node:crypto` — the shared contract module stays browser-safe.
 *
 * [COMP:api/ingest-external-relay]
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * `X-UB-Signature` value for `auth_kind: 'hmac'` sinks: `sha256=<hex>` of
 * HMAC-SHA256(secret, raw request body). Signed over the exact bytes sent —
 * consumers must verify against the raw body, before any JSON parse.
 */
export function signIngestAppendBody(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`
}

/**
 * Consumer-side verify helper (also used by tests): constant-time compare
 * of a received `X-UB-Signature` header against the raw body.
 */
export function verifyIngestAppendSignature(
  body: string,
  secret: string,
  signature: string,
): boolean {
  const expected = signIngestAppendBody(body, secret)
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(signature, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}
