/**
 * HMAC-SHA256 verification of GitHub's `X-Hub-Signature-256` header.
 *
 * GitHub signs the raw request body with the shared webhook secret and
 * delivers `sha256=<hex>` in the header. Constant-time comparison via
 * `timingSafeEqual` on equal-length buffers; reject obviously malformed
 * headers without spending a comparison.
 *
 * Mirrors the pattern at packages/api/src/routes/threads-webhook.ts:175.
 *
 * [COMP:brain/source-adapters/github]
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

const PREFIX = 'sha256='

/**
 * @param rawBody  the exact bytes (as UTF-8 string) GitHub signed — must
 *                 NOT be re-serialised by the JSON parser before this is
 *                 called
 * @param header   the `X-Hub-Signature-256` value, e.g. `sha256=<hex>`
 * @param secret   the shared webhook secret configured on the
 *                 connector_instance
 */
export function verifyGithubSignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header || !secret) return false
  if (!header.startsWith(PREFIX)) return false
  const provided = header.slice(PREFIX.length)
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  if (provided.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'))
}

/** Case-insensitive header lookup — Express/Node lower-cases by default but webhook callers may not. */
export function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key]
  }
  return undefined
}
