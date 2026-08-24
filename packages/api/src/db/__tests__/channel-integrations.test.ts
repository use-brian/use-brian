/**
 * Unit tests for the encryption layer of the channel_integrations store.
 * Component tag: [COMP:api/channel-integrations-store].
 *
 * These tests cover the pure crypto helpers only — the actual DB path
 * (upsert/get/list/delete) needs a live Postgres and is not in scope for
 * this suite. Run the API integration suite for end-to-end coverage once
 * it exists.
 */

import { describe, it, expect, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
vi.mock('../client.js', () => ({
  getPool: vi.fn(),
  query: vi.fn(),
  queryWithRLS: vi.fn(),
}))

import {
  createDbChannelIntegrationStore,
  encryptCredentials,
  decryptCredentials,
  loadChannelCredentialKey,
  pinTrustedTelegramUsernameInConfig,
  trustedGuestAuthorityChanged,
} from '../channel-integrations.js'
import { getPool } from '../client.js'

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

describe('[COMP:api/channel-integrations-store] trusted guest authority changes', () => {
  it('detects the full-access toggle and its active allowlist surface', () => {
    expect(trustedGuestAuthorityChanged({}, { allowTrustedGuestFullAccess: true })).toBe(true)
    expect(trustedGuestAuthorityChanged(
      { allowTrustedGuestFullAccess: true, userAccessMode: 'allowlist', allowedUserIds: ['42'] },
      { allowTrustedGuestFullAccess: true, userAccessMode: 'allowlist', allowedUserIds: ['84'] },
    )).toBe(true)
    expect(trustedGuestAuthorityChanged(
      { allowGuestConnectorTools: false },
      { allowGuestConnectorTools: true },
    )).toBe(false)
  })

  it('pins a case-insensitive username to one stable numeric id', () => {
    expect(pinTrustedTelegramUsernameInConfig(
      {
        userAccessMode: 'allowlist',
        allowTrustedGuestFullAccess: true,
        allowedUserIds: ['@FrIeNd', '42', '@colleague'],
      },
      '@friend',
      '42',
    )).toMatchObject({
      allowedUserIds: ['42', '@colleague'],
    })
  })

  it('refuses to pin after the trusted username grant is no longer active', () => {
    expect(pinTrustedTelegramUsernameInConfig(
      {
        userAccessMode: 'allowlist',
        allowTrustedGuestFullAccess: false,
        allowedUserIds: ['@friend'],
      },
      '@friend',
      '42',
    )).toBeNull()
  })

  it('locks and persists the username-to-id pin in one transaction', async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{
            config: {
              userAccessMode: 'allowlist',
              allowTrustedGuestFullAccess: true,
              allowedUserIds: ['@friend'],
            },
          }],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    vi.mocked(getPool).mockReturnValue({
      connect: vi.fn(async () => client),
    } as never)

    const store = createDbChannelIntegrationStore(makeKey())
    await expect(store.pinTrustedTelegramUsernameSystem?.(
      'integration_1',
      '@friend',
      '42',
    )).resolves.toBe(true)

    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('FOR UPDATE'),
      ['integration_1'],
    )
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE channel_integrations'),
      ['integration_1', expect.stringContaining('"allowedUserIds":["42"]')],
    )
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      expect.stringContaining('FOR UPDATE'),
      expect.stringContaining('UPDATE channel_integrations'),
      'COMMIT',
    ])
    expect(client.release).toHaveBeenCalled()
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
