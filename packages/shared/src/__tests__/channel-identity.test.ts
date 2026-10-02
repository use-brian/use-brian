import { describe, it, expect } from 'vitest'
import { CHANNEL_IDENTITY, CHANNEL_IDENTITY_KINDS, channelIdentityFor } from '../channel-identity.js'

describe('[COMP:shared/channel-identity] channel identity registry', () => {
  it('gives every connectable channel a code endpoint and a link provider, and no other channel either', () => {
    for (const kind of CHANNEL_IDENTITY_KINDS) {
      const row = CHANNEL_IDENTITY[kind]
      expect(row.kind).toBe(kind)
      if (row.connect === 'unavailable') {
        expect(row.codeEndpoint).toBeNull()
        expect(row.linkProvider).toBeNull()
      } else {
        expect(row.codeEndpoint).toMatch(/^\/api\/account\/[a-z]+\/link-code$/)
        expect(row.linkProvider).toBe(kind)
      }
    }
  })

  it('treats a WhatsApp Cloud API channel as unavailable (its route reads no links)', () => {
    expect(channelIdentityFor('whatsapp', 'cloud_api').connect).toBe('unavailable')
    expect(channelIdentityFor('whatsapp', null).connect).toBe('code')
  })

  it('falls back to the custom row for an unknown channel type', () => {
    expect(channelIdentityFor('carrier-pigeon').kind).toBe('custom')
  })
})
