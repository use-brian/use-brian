import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Verify Slack request signature.
 * Uses HMAC-SHA256 with the signing secret and the request body + timestamp.
 */
export function verifySlackSignature(params: {
  signingSecret: string
  signature: string | undefined
  timestamp: string | undefined
  body: string
}): boolean {
  if (!params.signature || !params.timestamp) return false

  // Reject requests older than 5 minutes
  const ts = parseInt(params.timestamp, 10)
  if (isNaN(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false

  const baseString = `v0:${params.timestamp}:${params.body}`
  const expected = 'v0=' + createHmac('sha256', params.signingSecret).update(baseString).digest('hex')

  try {
    return timingSafeEqual(Buffer.from(params.signature), Buffer.from(expected))
  } catch {
    return false
  }
}
