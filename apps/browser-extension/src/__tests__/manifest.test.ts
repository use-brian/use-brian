import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * §6 guardrail (docs/plans/my-browser.md): the extension drives the allowed tab
 * purely via `chrome.debugger` (CDP) — no content scripts, no cookies/scripting
 * APIs — so it needs NO host permissions. A broad `<all_urls>` grant is the
 * Manus Browser Operator anti-pattern (Mindgard "Rubra" credential-exfil +
 * Aurascape "SilentBridge" takeover) we explicitly refuse. This locks the
 * narrow surface so a future change cannot quietly re-widen it.
 */
const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../static/manifest.json', import.meta.url)), 'utf8'),
) as {
  permissions?: string[]
  host_permissions?: string[]
  externally_connectable?: { matches?: string[] }
  content_scripts?: unknown[]
}

describe('[COMP:ext/agent] Manifest — narrow permissions (my-browser.md §6)', () => {
  it('requests no host_permissions (the CDP drive needs none)', () => {
    expect(manifest.host_permissions ?? []).toEqual([])
  })

  it('never grants <all_urls> in any permission list', () => {
    const all = [...(manifest.permissions ?? []), ...(manifest.host_permissions ?? [])]
    expect(all).not.toContain('<all_urls>')
  })

  it('keeps only the narrow permission set', () => {
    expect(new Set(manifest.permissions)).toEqual(new Set(['debugger', 'tabs', 'storage']))
  })

  it('declares no content scripts', () => {
    expect(manifest.content_scripts ?? []).toEqual([])
  })
})

/**
 * One-click pairing (§ "Pairing" in computer-use.md) lets our own web app hand
 * the extension its relay address and pairing code, replacing two copy-pastes
 * against a 10-minute expiry. `externally_connectable` is an INBOUND message
 * channel, not a host grant — it gives the listed origins the right to
 * `sendMessage`, and gives the extension no new reach into any page. That is
 * why it does not breach the §6 guardrail above.
 *
 * The risk it does carry is the allowlist silently widening, so pin it: any
 * origin here can hand this extension a pairing token.
 */
describe('[COMP:ext/pairing] Manifest — externally_connectable stays first-party', () => {
  const matches = manifest.externally_connectable?.matches ?? []

  it('accepts messages only from our own app origins', () => {
    expect(new Set(matches)).toEqual(
      new Set(['https://app.usebrian.ai/*', 'http://localhost/*']),
    )
  })

  it('never opens the channel to a wildcard or bare TLD', () => {
    for (const pattern of matches) {
      expect(pattern).not.toBe('<all_urls>')
      expect(pattern).not.toMatch(/^\*:\/\//)
      // `*://*.com/*` and friends would let any site on that TLD pair the
      // extension to an account of its choosing.
      expect(pattern).not.toMatch(/\/\/\*\.[a-z]+\/\*$/)
    }
  })

  it('speaks https everywhere except loopback', () => {
    for (const pattern of matches) {
      if (pattern.startsWith('http://')) expect(pattern).toBe('http://localhost/*')
    }
  })
})
