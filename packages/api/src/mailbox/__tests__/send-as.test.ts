/**
 * Send-as alias config helpers (mailbox-imap.md → "Send-as aliases"): the
 * one reader/validator shared by the `/imap/send-as` routes, the send path's
 * allowlist, and the sync worker's `is_bot` guard.
 *
 * [COMP:api/mailbox-connect-routes]
 */

import { describe, it, expect } from 'vitest'
import {
  MAX_SEND_AS_ALIASES,
  bareEmailAddress,
  normalizeSendAsAliases,
  readSendAsAliases,
  senderIdentities,
} from '../send-as.js'

describe('[COMP:api/mailbox-connect-routes] send-as alias helpers', () => {
  it('bareEmailAddress strips display names and lowercases', () => {
    expect(bareEmailAddress('BD Team <BD@UseBrian.ai>')).toBe('bd@usebrian.ai')
    expect(bareEmailAddress('  Ops@Example.com ')).toBe('ops@example.com')
    expect(bareEmailAddress('')).toBe('')
  })

  it('normalizeSendAsAliases: bare + lowercased + deduped, account dropped, blanks ignored', () => {
    const r = normalizeSendAsAliases(['BD <BD@usebrian.ai>', 'bd@usebrian.ai', '  ', 'Contact@UseBrian.ai', 'ops@usebrian.ai'], 'contact@usebrian.ai')
    expect(r).toEqual({ ok: true, aliases: ['bd@usebrian.ai', 'ops@usebrian.ai'] })
  })

  it('normalizeSendAsAliases rejects the WHOLE write on any non-address so a typo cannot silently vanish', () => {
    const r = normalizeSendAsAliases(['bd@usebrian.ai', 'not-an-address', 42], 'contact@usebrian.ai')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.invalid).toEqual(['not-an-address', '42'])
      expect(r.error).toMatch(/Not an email address/)
    }
    expect(normalizeSendAsAliases('bd@usebrian.ai', 'contact@usebrian.ai').ok).toBe(false)
  })

  it('normalizeSendAsAliases caps the list', () => {
    const many = Array.from({ length: MAX_SEND_AS_ALIASES + 1 }, (_, i) => `a${i}@example.com`)
    const r = normalizeSendAsAliases(many, 'me@example.com')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/At most 16/)
    expect(normalizeSendAsAliases(many.slice(0, MAX_SEND_AS_ALIASES), 'me@example.com').ok).toBe(true)
  })

  it('readSendAsAliases tolerates a missing / malformed config and re-normalizes defensively', () => {
    expect(readSendAsAliases(undefined)).toEqual([])
    expect(readSendAsAliases({})).toEqual([])
    expect(readSendAsAliases({ sendAsAliases: 'nope' })).toEqual([])
    expect(readSendAsAliases({ sendAsAliases: ['BD@x.io', 7, 'bd@x.io', ' ops@x.io '] })).toEqual(['bd@x.io', 'ops@x.io'])
  })

  it('senderIdentities lists the account first, then aliases, deduped and bare', () => {
    expect(senderIdentities('Me <ME@x.io>', ['bd@x.io', 'me@x.io', 'BD@x.io'])).toEqual(['me@x.io', 'bd@x.io'])
  })
})
