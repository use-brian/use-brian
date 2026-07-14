import { describe, it, expect } from 'vitest'
import { isAuthWalledUrl, authWalledGuidance } from '../base/auth-walled-hosts.js'
import { urlReaderTool } from '../base/url-reader.js'
import type { ToolContext } from '../types.js'

// A minimal context — the auth-walled short-circuit returns before touching
// any of it, so only `abortSignal` needs to be present for the type.
const ctx = { abortSignal: new AbortController().signal } as ToolContext

describe('[COMP:tools/fetch] Auth-walled host detection', () => {
  it('flags LinkedIn member + organisation pages', () => {
    expect(isAuthWalledUrl('https://www.linkedin.com/in/david-yeung')).toBe(true)
    expect(isAuthWalledUrl('https://linkedin.com/in/david-yeung/')).toBe(true)
    expect(isAuthWalledUrl('https://www.linkedin.com/in/david-yeung?originalSubdomain=hk')).toBe(true)
    expect(isAuthWalledUrl('https://hk.linkedin.com/pub/some-person/1/2/3')).toBe(true)
    expect(isAuthWalledUrl('https://www.linkedin.com/company/green-monday')).toBe(true)
    expect(isAuthWalledUrl('https://www.linkedin.com/school/mit')).toBe(true)
    expect(isAuthWalledUrl('https://m.linkedin.com/in/david-yeung')).toBe(true)
  })

  it('flags Instagram at the host level', () => {
    expect(isAuthWalledUrl('https://www.instagram.com/greenmonday')).toBe(true)
    expect(isAuthWalledUrl('https://instagram.com/p/Cabc123')).toBe(true)
  })

  it('leaves incidentally-public LinkedIn paths to the normal stack', () => {
    expect(isAuthWalledUrl('https://www.linkedin.com/pulse/some-article')).toBe(false)
    expect(isAuthWalledUrl('https://www.linkedin.com/jobs/view/12345')).toBe(false)
    expect(isAuthWalledUrl('https://www.linkedin.com/')).toBe(false)
  })

  it('does not false-positive on look-alike hosts or normal sites', () => {
    expect(isAuthWalledUrl('https://notlinkedin.com/in/x')).toBe(false)
    expect(isAuthWalledUrl('https://myinstagram.com/foo')).toBe(false)
    expect(isAuthWalledUrl('https://www.cathaypacific.com/cx/en_HK/book')).toBe(false)
    expect(isAuthWalledUrl('https://en.wikipedia.org/wiki/LinkedIn')).toBe(false)
  })

  it('returns false for malformed URLs', () => {
    expect(isAuthWalledUrl('not a url')).toBe(false)
    expect(isAuthWalledUrl('')).toBe(false)
  })

  it('guidance echoes the URL and forbids reporting failure', () => {
    const g = authWalledGuidance('https://www.linkedin.com/in/david-yeung')
    expect(g).toContain('https://www.linkedin.com/in/david-yeung')
    expect(g).toMatch(/do not report/i)
  })
})

describe('[COMP:tools/fetch] urlReader auth-walled short-circuit', () => {
  it('returns an actionable non-error result without touching the fetch stack', async () => {
    const out = await urlReaderTool.execute(
      { url: 'https://www.linkedin.com/in/david-yeung' },
      ctx,
    )
    expect(out.isError).toBeFalsy()
    const data = out.data as { url: string; readable: boolean; reason: string; note: string }
    expect(data.readable).toBe(false)
    expect(data.reason).toBe('login_required')
    expect(data.url).toBe('https://www.linkedin.com/in/david-yeung')
    expect(data.note).toContain('login wall')
  })
})
