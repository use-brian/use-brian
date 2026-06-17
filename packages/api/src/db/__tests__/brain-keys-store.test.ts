/**
 * Unit tests for the pure layer of the brain key store.
 * Component tag: [COMP:api/brain-key-store].
 *
 * Covers plaintext minting and Authorization-header parsing for the
 * `sk_brain_` key format. scrypt hash/verify is shared with api-key-store
 * and tested there; the DB-touching paths (create/list/revoke) need a live
 * Postgres and are deferred to the integration harness.
 */

import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mintBrainPlaintext, parseBrainAuthToken } from '../brain-keys-store.js'

describe('[COMP:api/brain-key-store] mintBrainPlaintext', () => {
  it('produces sk_brain_<keyId>_<base64url> shape', () => {
    const id = randomUUID()
    const { plaintext, secret } = mintBrainPlaintext(id)
    expect(plaintext.startsWith('sk_brain_')).toBe(true)
    expect(plaintext.includes(`_${id}_`)).toBe(true)
    expect(plaintext.endsWith(secret)).toBe(true)
    // base64url alphabet only — no `+`, `/`, or `=` padding
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('returns a 13-char display prefix', () => {
    const { prefix } = mintBrainPlaintext(randomUUID())
    expect(prefix.length).toBe(13)
    expect(prefix.startsWith('sk_brain_')).toBe(true)
  })

  it('produces a different secret each call', () => {
    const a = mintBrainPlaintext(randomUUID()).secret
    const b = mintBrainPlaintext(randomUUID()).secret
    expect(a).not.toBe(b)
  })

  it('binds the provided keyId — round-trippable via parseBrainAuthToken', () => {
    const id = randomUUID()
    const { plaintext } = mintBrainPlaintext(id)
    expect(parseBrainAuthToken(plaintext)?.keyId).toBe(id)
  })
})

describe('[COMP:api/brain-key-store] parseBrainAuthToken', () => {
  it('parses a valid token', () => {
    const id = randomUUID()
    const { plaintext } = mintBrainPlaintext(id)
    const parsed = parseBrainAuthToken(plaintext)
    expect(parsed).not.toBeNull()
    expect(parsed!.keyId).toBe(id)
    expect(parsed!.secret.length).toBeGreaterThan(0)
  })

  it('returns null without the sk_brain_ prefix', () => {
    const id = randomUUID()
    // An sk_live_ public-API key must NOT authenticate against the brain.
    expect(parseBrainAuthToken(`sk_live_${id}_secret`)).toBeNull()
    expect(parseBrainAuthToken(`${id}_secret`)).toBeNull()
    expect(parseBrainAuthToken('')).toBeNull()
  })

  it('returns null when the keyId segment is not a UUID', () => {
    expect(parseBrainAuthToken('sk_brain_not-a-uuid_secret')).toBeNull()
    expect(parseBrainAuthToken('sk_brain_abc_secret')).toBeNull()
  })

  it('returns null when the secret segment is empty', () => {
    expect(parseBrainAuthToken(`sk_brain_${randomUUID()}_`)).toBeNull()
  })

  it('returns null when there is no separator after the keyId', () => {
    expect(parseBrainAuthToken(`sk_brain_${randomUUID()}`)).toBeNull()
  })

  it('preserves underscores within the secret segment', () => {
    // base64url includes `_` — the split must not be greedy.
    const id = randomUUID()
    const secret = 'AAAA_BBBB-CCCC'
    expect(parseBrainAuthToken(`sk_brain_${id}_${secret}`)?.secret).toBe(secret)
  })
})
