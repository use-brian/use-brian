import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { verifySvixSignature } from '../webhook-verify.js'

const SECRET_BYTES = Buffer.from('0123456789abcdef0123456789abcdef')
const SECRET = `whsec_${SECRET_BYTES.toString('base64')}`

function sign(id: string, timestamp: string, body: string, key: Buffer = SECRET_BYTES): string {
  const mac = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')
  return `v1,${mac}`
}

describe('[COMP:api/agentmail-webhook-verify] Svix signature verification', () => {
  const now = 1_760_000_000
  const body = JSON.stringify({ event_type: 'message.received' })
  const headers = (sig: string, ts = String(now)) => ({
    'svix-id': 'msg_abc',
    'svix-timestamp': ts,
    'svix-signature': sig,
  })

  it('accepts a valid v1 signature over the raw body', () => {
    const sig = sign('msg_abc', String(now), body)
    expect(
      verifySvixSignature({ secret: SECRET, headers: headers(sig), rawBody: body, nowSeconds: now }),
    ).toBe(true)
  })

  it('accepts when any candidate in a space-delimited list matches', () => {
    const good = sign('msg_abc', String(now), body)
    const sig = `v1,${Buffer.from('garbage-signature-value-here').toString('base64')} ${good}`
    expect(
      verifySvixSignature({ secret: SECRET, headers: headers(sig), rawBody: body, nowSeconds: now }),
    ).toBe(true)
  })

  it('accepts a raw base64 secret without the whsec_ prefix', () => {
    const sig = sign('msg_abc', String(now), body)
    expect(
      verifySvixSignature({
        secret: SECRET_BYTES.toString('base64'),
        headers: headers(sig),
        rawBody: body,
        nowSeconds: now,
      }),
    ).toBe(true)
  })

  it('accepts a Buffer body identical to the signed bytes', () => {
    const sig = sign('msg_abc', String(now), body)
    expect(
      verifySvixSignature({
        secret: SECRET,
        headers: headers(sig),
        rawBody: Buffer.from(body, 'utf8'),
        nowSeconds: now,
      }),
    ).toBe(true)
  })

  it('rejects a tampered body', () => {
    const sig = sign('msg_abc', String(now), body)
    expect(
      verifySvixSignature({ secret: SECRET, headers: headers(sig), rawBody: body + 'x', nowSeconds: now }),
    ).toBe(false)
  })

  it('rejects a signature from the wrong secret', () => {
    const sig = sign('msg_abc', String(now), body, Buffer.from('another-key-another-key-another!'))
    expect(
      verifySvixSignature({ secret: SECRET, headers: headers(sig), rawBody: body, nowSeconds: now }),
    ).toBe(false)
  })

  it('rejects a stale timestamp (>5 min drift) even with a valid signature', () => {
    const staleTs = String(now - 6 * 60)
    const sig = sign('msg_abc', staleTs, body)
    expect(
      verifySvixSignature({ secret: SECRET, headers: headers(sig, staleTs), rawBody: body, nowSeconds: now }),
    ).toBe(false)
  })

  it('rejects missing headers and non-v1 versions', () => {
    const sig = sign('msg_abc', String(now), body)
    expect(
      verifySvixSignature({
        secret: SECRET,
        headers: { 'svix-id': 'msg_abc', 'svix-signature': sig },
        rawBody: body,
        nowSeconds: now,
      }),
    ).toBe(false)
    expect(
      verifySvixSignature({
        secret: SECRET,
        headers: headers(sig.replace(/^v1,/, 'v2,')),
        rawBody: body,
        nowSeconds: now,
      }),
    ).toBe(false)
  })

  it('rejects an empty or undecodable secret', () => {
    const sig = sign('msg_abc', String(now), body)
    expect(
      verifySvixSignature({ secret: 'whsec_', headers: headers(sig), rawBody: body, nowSeconds: now }),
    ).toBe(false)
  })
})
