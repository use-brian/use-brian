import { describe, it, expect } from 'vitest'
import {
  LINK_CODE_ALPHABET,
  LINK_CODE_LENGTH,
  generateLinkCode,
  normalizeLinkCode,
  parseWechatLinkCommand,
  parseWechatSessionChannelId,
  wechatSessionChannelId,
} from '../channel-identity-bindings.js'

const CHANNEL = '00000000-0000-4000-a000-0000000000cc'
const BINDING = '00000000-0000-4000-a000-0000000000bb'

describe('[COMP:api/channel-identity-bindings] codes, control command and session keys', () => {
  it('generates 8-character codes from an unambiguous uppercase alphabet', () => {
    expect(LINK_CODE_ALPHABET).not.toMatch(/[ILO01]/)
    const codes = new Set(Array.from({ length: 200 }, generateLinkCode))
    expect(codes.size).toBe(200)
    for (const code of codes) {
      expect(code).toHaveLength(LINK_CODE_LENGTH)
      for (const ch of code) expect(LINK_CODE_ALPHABET).toContain(ch)
    }
  })

  it('normalizes case and separators but rejects anything that cannot be a code', () => {
    expect(normalizeLinkCode('abcd-efgh')).toBe('ABCDEFGH')
    expect(normalizeLinkCode('ABCD EFGH')).toBe('ABCDEFGH')
    expect(normalizeLinkCode('ABCDEFG')).toBeNull()
    expect(normalizeLinkCode('ABCDEFG0')).toBeNull()
    expect(normalizeLinkCode('ABCDEFGHJ')).toBeNull()
  })

  it('recognizes only the exact LINK command, before anything else reads the text', () => {
    expect(parseWechatLinkCommand('LINK ABCDEFGH')).toEqual({ code: 'ABCDEFGH' })
    expect(parseWechatLinkCommand('  link abcd-efgh ')).toEqual({ code: 'ABCDEFGH' })
    // A malformed code is still the control command: it must not reach a model.
    expect(parseWechatLinkCommand('LINK nope')).toEqual({ code: null })
    expect(parseWechatLinkCommand('please link ABCDEFGH')).toBeNull()
    expect(parseWechatLinkCommand('LINKABCDEFGH')).toBeNull()
    expect(parseWechatLinkCommand('link my account to u_123')).toEqual({ code: null })
  })

  it('round-trips the versioned session key and refuses a raw peer id', () => {
    const key = wechatSessionChannelId({ channelId: CHANNEL, bindingId: BINDING, version: 3, transportGeneration: 7 })
    expect(key).toBe(`wechat:${CHANNEL}:b:${BINDING}:v3:g7`)
    expect(parseWechatSessionChannelId(key)).toEqual({ channelId: CHANNEL, bindingId: BINDING, version: 3, transportGeneration: 7 })
    expect(parseWechatSessionChannelId('o9cq80abc@im.wechat')).toBeNull()
    expect(parseWechatSessionChannelId(undefined)).toBeNull()
  })
})
