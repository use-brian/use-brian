import { describe, it, expect } from 'vitest'
import {
  mintFilePreviewToken,
  verifyFilePreviewToken,
  FILE_PREVIEW_TOKEN_AUD,
} from '../file-preview-token.js'

const SECRET = 'test-signing-secret'

describe('[COMP:api/file-preview-token] File preview capability tokens', () => {
  it('mints a compact base64url token that round-trips for the bound file', () => {
    const token = mintFilePreviewToken({ fid: 'f_1', ttlMs: 60_000, secret: SECRET })
    // Two base64url segments, `.`-joined — nothing an intermediary would rewrite.
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)

    const result = verifyFilePreviewToken({ token, fid: 'f_1', secret: SECRET })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.payload.fid).toBe('f_1')
      expect(result.payload.aud).toBe(FILE_PREVIEW_TOKEN_AUD)
    }
  })

  it('rejects a forged signature (wrong secret)', () => {
    const token = mintFilePreviewToken({ fid: 'f_1', ttlMs: 60_000, secret: SECRET })
    const result = verifyFilePreviewToken({ token, fid: 'f_1', secret: 'attacker-secret' })
    expect(result).toEqual({ ok: false, reason: 'bad-signature' })
  })

  it('rejects a tampered payload (id swapped inside the token, sig unchanged)', () => {
    const token = mintFilePreviewToken({ fid: 'f_1', ttlMs: 60_000, secret: SECRET })
    const [encoded, sig] = token.split('.')
    const forgedPayload = Buffer.from(
      JSON.stringify({ fid: 'f_victim', aud: FILE_PREVIEW_TOKEN_AUD, exp: Date.now() + 60_000 }),
      'utf8',
    ).toString('base64url')
    const forged = `${forgedPayload}.${sig}`
    // Same length as the original encoded segment is not required; the HMAC over
    // the new payload won't match the old sig regardless.
    expect(encoded).not.toBe(forgedPayload)
    const result = verifyFilePreviewToken({ token: forged, fid: 'f_victim', secret: SECRET })
    expect(result).toEqual({ ok: false, reason: 'bad-signature' })
  })

  it('rejects a valid token replayed against a DIFFERENT file id', () => {
    const token = mintFilePreviewToken({ fid: 'f_1', ttlMs: 60_000, secret: SECRET })
    // The signature itself is valid, but it's bound to f_1 — verifying it for
    // f_2 must fail (cross-id replay is the IDOR this closes).
    const result = verifyFilePreviewToken({ token, fid: 'f_2', secret: SECRET })
    expect(result).toEqual({ ok: false, reason: 'wrong-file' })
  })

  it('rejects an expired token', () => {
    const past = () => 1_000_000
    const token = mintFilePreviewToken({ fid: 'f_1', ttlMs: 1_000, secret: SECRET, now: past })
    // Verify a second later than the 1s TTL.
    const result = verifyFilePreviewToken({
      token,
      fid: 'f_1',
      secret: SECRET,
      now: () => 1_000_000 + 2_000,
    })
    expect(result).toEqual({ ok: false, reason: 'expired' })
  })

  it('rejects a token minted for a different audience', () => {
    // Hand-mint a well-signed token whose `aud` is not the preview audience.
    const payload = Buffer.from(
      JSON.stringify({ fid: 'f_1', aud: 'media', exp: Date.now() + 60_000 }),
      'utf8',
    ).toString('base64url')
    const { createHmac } = require('node:crypto') as typeof import('node:crypto')
    const sig = createHmac('sha256', SECRET).update(payload).digest('base64url')
    const result = verifyFilePreviewToken({ token: `${payload}.${sig}`, fid: 'f_1', secret: SECRET })
    expect(result).toEqual({ ok: false, reason: 'wrong-audience' })
  })

  it('rejects a malformed token (no dot separator)', () => {
    const result = verifyFilePreviewToken({ token: 'not-a-token', fid: 'f_1', secret: SECRET })
    expect(result).toEqual({ ok: false, reason: 'malformed' })
  })
})
