/**
 * Unit tests for the encryption layer of the channel_integrations store.
 * Component tag: [COMP:api/channel-integrations-store].
 *
 * These tests cover the pure crypto helpers only — the actual DB path
 * (upsert/get/list/delete) needs a live Postgres and is not in scope for
 * this suite. Run the API integration suite for end-to-end coverage once
 * it exists.
 */

import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  encryptCredentials,
  decryptCredentials,
  loadChannelCredentialKey,
} from '../channel-integrations.js'

function makeKey(): Buffer {
  return randomBytes(32)
}

describe('[COMP:api/channel-integrations-store] loadChannelCredentialKey', () => {
  it('accepts a valid 32-byte base64 key', () => {
    const raw = randomBytes(32).toString('base64')
    const key = loadChannelCredentialKey(raw)
    expect(key.length).toBe(32)
  })

  it('throws when undefined', () => {
    expect(() => loadChannelCredentialKey(undefined)).toThrow(/required/i)
  })

  it('throws when the decoded key is too short', () => {
    const shortKey = randomBytes(16).toString('base64')
    expect(() => loadChannelCredentialKey(shortKey)).toThrow(/32 bytes/)
  })

  it('throws when the decoded key is too long', () => {
    const longKey = randomBytes(64).toString('base64')
    expect(() => loadChannelCredentialKey(longKey)).toThrow(/32 bytes/)
  })
})

describe('[COMP:api/channel-integrations-store] encrypt/decrypt roundtrip', () => {
  const key = makeKey()
  const credentials = {
    bot_token: 'xoxb-1234567890-abcdef',
    signing_secret: 'deadbeefcafebabe',
  }

  it('roundtrips the same credentials', () => {
    const encrypted = encryptCredentials(credentials, key)
    const decrypted = decryptCredentials(encrypted, key)
    expect(decrypted).toEqual(credentials)
  })

  it('produces a different ciphertext every call (random IV)', () => {
    const a = encryptCredentials(credentials, key)
    const b = encryptCredentials(credentials, key)
    expect(a.equals(b)).toBe(false)
    // Both still decrypt to the same plaintext
    expect(decryptCredentials(a, key)).toEqual(credentials)
    expect(decryptCredentials(b, key)).toEqual(credentials)
  })

  it('stores the IV + auth tag in the envelope (>= 28 bytes overhead)', () => {
    const encrypted = encryptCredentials(credentials, key)
    const plaintextLen = Buffer.from(JSON.stringify(credentials), 'utf8').length
    // 12 (IV) + 16 (tag) = 28 byte overhead, plus the ciphertext itself.
    expect(encrypted.length).toBeGreaterThanOrEqual(plaintextLen + 28)
  })
})

describe('[COMP:api/channel-integrations-store] tampering detection', () => {
  const key = makeKey()
  const credentials = {
    bot_token: 'xoxb-test',
    signing_secret: 'signing-test',
  }

  it('fails when decrypted with the wrong key', () => {
    const encrypted = encryptCredentials(credentials, key)
    const wrongKey = makeKey()
    expect(() => decryptCredentials(encrypted, wrongKey)).toThrow()
  })

  it('fails when the ciphertext is tampered with', () => {
    const encrypted = encryptCredentials(credentials, key)
    // Flip a byte inside the ciphertext region (after the IV + tag header)
    encrypted[30] ^= 0xff
    expect(() => decryptCredentials(encrypted, key)).toThrow()
  })

  it('fails when the auth tag is tampered with', () => {
    const encrypted = encryptCredentials(credentials, key)
    // The tag sits between bytes 12 and 28
    encrypted[15] ^= 0xff
    expect(() => decryptCredentials(encrypted, key)).toThrow()
  })

  it('fails on a too-short blob', () => {
    expect(() => decryptCredentials(Buffer.alloc(10), key)).toThrow(/too short/)
  })
})
