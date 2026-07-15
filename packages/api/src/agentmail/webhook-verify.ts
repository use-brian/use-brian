/**
 * Svix webhook signature verification — implemented directly (no dependency).
 *
 * AgentMail delivers webhooks through Svix. Each delivery carries three
 * headers; the signature is HMAC-SHA256 over `${id}.${timestamp}.${rawBody}`
 * keyed by the base64-decoded secret (after its `whsec_` prefix):
 *
 *   svix-id         unique delivery id (stable across retries)
 *   svix-timestamp  unix seconds when sent (±5 min tolerance enforced here)
 *   svix-signature  space-delimited candidates, each `v1,<base64 hmac>`
 *
 * Verification MUST run over the raw request body bytes — any JSON re-parse/
 * re-stringify breaks the signature. The webhook route mounts express.raw for
 * this path.
 *
 * See docs/architecture/integrations/agentmail.md → "Provider seam".
 * Component tag: [COMP:api/agentmail-webhook-verify]
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

const TOLERANCE_SECONDS = 5 * 60

export type SvixHeaders = {
  'svix-id'?: string | undefined
  'svix-timestamp'?: string | undefined
  'svix-signature'?: string | undefined
}

export function verifySvixSignature(params: {
  /** Signing secret, `whsec_`-prefixed base64 (raw base64 also accepted). */
  secret: string
  headers: SvixHeaders
  /** Raw request body bytes, exactly as received. */
  rawBody: Buffer | string
  /** Injectable clock for tests (unix seconds). */
  nowSeconds?: number
}): boolean {
  const id = params.headers['svix-id']
  const timestamp = params.headers['svix-timestamp']
  const signatureHeader = params.headers['svix-signature']
  if (!id || !timestamp || !signatureHeader) return false

  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return false
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000)
  if (Math.abs(now - ts) > TOLERANCE_SECONDS) return false

  let key: Buffer
  try {
    key = Buffer.from(params.secret.replace(/^whsec_/, ''), 'base64')
  } catch {
    return false
  }
  if (key.length === 0) return false

  const body = typeof params.rawBody === 'string' ? Buffer.from(params.rawBody, 'utf8') : params.rawBody
  const signedContent = Buffer.concat([Buffer.from(`${id}.${timestamp}.`, 'utf8'), body])
  const expected = createHmac('sha256', key).update(signedContent).digest()

  for (const candidate of signatureHeader.split(' ')) {
    const [version, sig] = candidate.split(',', 2)
    if (version !== 'v1' || !sig) continue
    let given: Buffer
    try {
      given = Buffer.from(sig, 'base64')
    } catch {
      continue
    }
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true
  }
  return false
}
