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
) as { permissions?: string[]; host_permissions?: string[] }

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
})
