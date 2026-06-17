/**
 * Unit tests for the pure layer of the API key store.
 * Component tag: [COMP:api/api-key-store].
 *
 * Covers the security-critical primitives: scrypt hash/verify, plaintext
 * minting, and Authorization-header parsing. The DB-touching paths
 * (create/list/revoke) need a live Postgres and are deferred to the
 * integration test harness — same posture as channel-integrations.test.ts.
 */

import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  hashSecret,
  verifySecret,
  mintPlaintext,
  parseAuthToken,
} from '../api-key-store.js'

describe('[COMP:api/api-key-store] hashSecret / verifySecret', () => {
  it('roundtrips a correct secret', async () => {
    const hash = await hashSecret('correct-secret')
    expect(await verifySecret('correct-secret', hash)).toBe(true)
  })

  it('rejects a wrong secret', async () => {
    const hash = await hashSecret('correct-secret')
    expect(await verifySecret('wrong-secret', hash)).toBe(false)
  })

  it('produces a different hash each call (random salt)', async () => {
    const a = await hashSecret('same-secret')
    const b = await hashSecret('same-secret')
    expect(a).not.toBe(b)
    // Both still verify
    expect(await verifySecret('same-secret', a)).toBe(true)
    expect(await verifySecret('same-secret', b)).toBe(true)
  })

  it('returns false on a malformed encoded hash', async () => {
    expect(await verifySecret('s', 'not-a-hash')).toBe(false)
    expect(await verifySecret('s', 'scrypt$bad$bad$bad$bad$bad')).toBe(false)
    expect(await verifySecret('s', '')).toBe(false)
  })

  it('returns false when the algorithm prefix is wrong', async () => {
    // Looks like a hash but uses a different KDF — must not be accepted.
    expect(await verifySecret('s', 'bcrypt$14$8$1$YQ==$YQ==')).toBe(false)
  })

  it('encoded form contains the documented parameters', async () => {
    const hash = await hashSecret('secret')
    const parts = hash.split('$')
    expect(parts[0]).toBe('scrypt')
    expect(Number(parts[1])).toBeGreaterThan(0) // N
    expect(Number(parts[2])).toBeGreaterThan(0) // r
    expect(Number(parts[3])).toBeGreaterThan(0) // p
    expect(parts.length).toBe(6)
  })
})

describe('[COMP:api/api-key-store] mintPlaintext', () => {
  it('produces sk_live_<keyId>_<base64url> shape', () => {
    const id = randomUUID()
    const { plaintext, prefix, secret } = mintPlaintext(id)
    expect(plaintext.startsWith('sk_live_')).toBe(true)
    expect(plaintext.includes(`_${id}_`)).toBe(true)
    expect(plaintext.endsWith(secret)).toBe(true)
    // base64url alphabet only — no `+`, `/`, or `=` padding
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('returns a 12-char display prefix', () => {
    const { prefix } = mintPlaintext(randomUUID())
    expect(prefix.length).toBe(12)
    expect(prefix.startsWith('sk_live_')).toBe(true)
  })

  it('produces a different secret each call', () => {
    const a = mintPlaintext(randomUUID()).secret
    const b = mintPlaintext(randomUUID()).secret
    expect(a).not.toBe(b)
  })

  it('binds the provided keyId — round-trippable via parseAuthToken', () => {
    const id = randomUUID()
    const { plaintext } = mintPlaintext(id)
    const parsed = parseAuthToken(plaintext)
    expect(parsed?.keyId).toBe(id)
  })
})

describe('[COMP:api/api-key-store] parseAuthToken', () => {
  it('parses a valid token', () => {
    const id = randomUUID()
    const { plaintext } = mintPlaintext(id)
    const parsed = parseAuthToken(plaintext)
    expect(parsed).not.toBeNull()
    expect(parsed!.keyId).toBe(id)
    expect(parsed!.secret.length).toBeGreaterThan(0)
  })

  it('returns null without the sk_live_ prefix', () => {
    const id = randomUUID()
    expect(parseAuthToken(`${id}_secret`)).toBeNull()
    expect(parseAuthToken('Bearer foo')).toBeNull()
    expect(parseAuthToken('')).toBeNull()
  })

  it('returns null when the keyId segment is not a UUID', () => {
    expect(parseAuthToken('sk_live_not-a-uuid_secret')).toBeNull()
    expect(parseAuthToken('sk_live_abc_secret')).toBeNull()
  })

  it('returns null when the secret segment is empty', () => {
    const id = randomUUID()
    expect(parseAuthToken(`sk_live_${id}_`)).toBeNull()
  })

  it('returns null when there is no separator after the keyId', () => {
    const id = randomUUID()
    expect(parseAuthToken(`sk_live_${id}`)).toBeNull()
  })

  it('preserves underscores within the secret segment', () => {
    // base64url alphabet includes `_` — split must not be greedy.
    const id = randomUUID()
    // Hand-craft a secret that contains an underscore in the middle.
    const secret = 'AAAA_BBBB-CCCC'
    const token = `sk_live_${id}_${secret}`
    const parsed = parseAuthToken(token)
    expect(parsed?.secret).toBe(secret)
  })
})
