import { describe, it, expect } from 'vitest'
import { credentialsForConfigure, isTrustedPairingOrigin } from '../pairing.js'

/**
 * The credential transition behind every "Connect" — popup button or one-click
 * pair from the web app. Extracted as a pure function because the bug it fixes
 * was invisible inside the service worker's message handler: `configure`
 * removed `sessionToken` unconditionally, so clicking Connect with an empty
 * token field logged a working extension out. The popup's token field is empty
 * every time it opens, and Connect is the obvious button to press when the
 * assistant says it cannot connect — so the recovery action was the thing that
 * broke the pairing.
 */
describe('[COMP:ext/pairing] Configure credential transition', () => {
  const RELAY = 'wss://relay.example/ext'

  it('keeps a live session when Connect is pressed with no new pairing token', () => {
    const write = credentialsForConfigure({ relayUrl: RELAY })
    expect(write.remove).not.toContain('sessionToken')
  })

  it('drops the old session when a NEW pairing token arrives', () => {
    // A fresh token may belong to a different account; the old session must not
    // outlive it, or the extension keeps acting as whoever paired last.
    const write = credentialsForConfigure({ relayUrl: RELAY, pairingToken: 'pair-xyz' })
    expect(write.remove).toContain('sessionToken')
    expect(write.set.pairingToken).toBe('pair-xyz')
  })

  it('never writes a blank relay URL over a working one', () => {
    // The popup posts whatever is in the input. An empty string is not a relay
    // address, and storing it strands the user on `unpaired` with no hint as to
    // which of the two fields was wrong.
    expect(credentialsForConfigure({ relayUrl: '   ' }).set.relayUrl).toBeUndefined()
  })

  it('accepts a relay URL when none is stored yet', () => {
    expect(credentialsForConfigure({ relayUrl: RELAY }).set.relayUrl).toBe(RELAY)
  })

  it('trims surrounding whitespace off a pasted token', () => {
    expect(credentialsForConfigure({ pairingToken: '  pair-xyz\n' }).set.pairingToken).toBe(
      'pair-xyz',
    )
  })

  it('is a no-op when Connect is pressed with both fields blank', () => {
    const write = credentialsForConfigure({})
    expect(write.set).toEqual({})
    expect(write.remove).toEqual([])
  })
})

/**
 * The sender check behind one-click pairing. `externally_connectable` already
 * filters origins, so this is defence in depth — but it is checked against the
 * manifest's OWN list (`chrome.runtime.getManifest()`) rather than a second
 * hardcoded copy, because two lists that must agree eventually will not.
 */
describe('[COMP:ext/pairing] Trusted pairing origin', () => {
  const MATCHES = ['https://app.usebrian.ai/*', 'http://localhost/*']

  it('accepts the app origin', () => {
    expect(isTrustedPairingOrigin('https://app.usebrian.ai', MATCHES)).toBe(true)
  })

  it('accepts loopback on any dev port', () => {
    expect(isTrustedPairingOrigin('http://localhost:3003', MATCHES)).toBe(true)
  })

  it('rejects look-alike hosts', () => {
    // The prize for spoofing this is a pairing token bound to someone's
    // account, so suffix and prefix confusions both have to miss.
    for (const origin of [
      'https://app.usebrian.ai.evil.com',
      'https://evil-app.usebrian.ai',
      'https://notapp.usebrian.ai',
      'https://usebrian.ai',
    ]) {
      expect(isTrustedPairingOrigin(origin, MATCHES), origin).toBe(false)
    }
  })

  it('rejects the right host over the wrong scheme', () => {
    expect(isTrustedPairingOrigin('http://app.usebrian.ai', MATCHES)).toBe(false)
  })

  it('rejects a missing or unparseable origin', () => {
    expect(isTrustedPairingOrigin(undefined, MATCHES)).toBe(false)
    expect(isTrustedPairingOrigin('', MATCHES)).toBe(false)
    expect(isTrustedPairingOrigin('not a url', MATCHES)).toBe(false)
  })

  it('does not honour wildcard-subdomain patterns even if one appears', () => {
    // We never use them, and silently supporting them would let a widened
    // manifest hand any subdomain the right to pair this extension.
    expect(isTrustedPairingOrigin('https://any.usebrian.ai', ['https://*.usebrian.ai/*'])).toBe(
      false,
    )
  })
})
