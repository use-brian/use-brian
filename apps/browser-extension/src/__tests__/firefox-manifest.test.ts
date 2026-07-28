import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../static-firefox/manifest.json', import.meta.url)), 'utf8'),
) as {
  manifest_version?: number
  permissions?: string[]
  optional_permissions?: string[]
  host_permissions?: string[]
  optional_host_permissions?: string[]
  content_scripts?: unknown[]
  background?: { page?: string; persistent?: boolean; service_worker?: string }
  browser_specific_settings?: {
    gecko?: { id?: string; data_collection_permissions?: { required?: string[] } }
  }
}

describe('[COMP:ext/firefox-agent] Firefox manifest parity and guardrails', () => {
  it('authorizes only the desktop native host transport and portable tab storage APIs', () => {
    expect(new Set(manifest.permissions)).toEqual(new Set(['tabs', 'storage', 'nativeMessaging']))
    expect(manifest.optional_permissions ?? []).toEqual([])
  })

  it('keeps the no-host-access and no-content-script security boundary', () => {
    expect(manifest.host_permissions ?? []).toEqual([])
    expect(manifest.optional_host_permissions ?? []).toEqual([])
    expect(manifest.content_scripts ?? []).toEqual([])
    expect(manifest.permissions).not.toContain('<all_urls>')
  })

  it('uses the stable id authorized by the desktop host manifest', () => {
    expect(manifest.browser_specific_settings?.gecko?.id).toBe('browser@usebrian.ai')
  })

  it('truthfully declares the functional data sent to the paired assistant', () => {
    expect(new Set(manifest.browser_specific_settings?.gecko?.data_collection_permissions?.required)).toEqual(
      new Set(['authenticationInfo', 'browsingActivity', 'websiteContent']),
    )
  })

  it('uses Firefox background-page lifecycle instead of a Chromium service worker', () => {
    expect(manifest.manifest_version).toBe(2)
    expect(manifest.background).toEqual({ page: 'background.html', persistent: true })
    expect(manifest.background?.service_worker).toBeUndefined()
  })
})
