/**
 * [COMP:shared/brian-app-lint] — the custom Home app manifest + bundle
 * validator.
 *
 * This is the file that decides what third-party code we will host and what it
 * is allowed to reach, so the tests lean on the security-relevant edges:
 * traversal in paths, header injection through `scopes.net`, unknown scope
 * keys failing closed, and the T3 drift rule.
 */

import { describe, it, expect } from 'vitest'
import {
  MANIFEST_FILENAME,
  contentTypeFor,
  isSafeBundlePath,
  isSafeNetOrigin,
  lintBundle,
  parseManifest,
  scopesExceedGrant,
  storeScopeRank,
  validateBundle,
} from '../index.js'

const VALID = {
  manifestVersion: 1,
  name: 'CRM widget',
  description: 'Shows the deal pipeline',
  icon: 'Users',
  entry: 'index.html',
  scopes: { data: 'read' },
}

function issuePaths(result: ReturnType<typeof parseManifest>) {
  return result.ok ? [] : result.issues.map((i) => i.path)
}

describe('[COMP:shared/brian-app-lint] parseManifest', () => {
  it('accepts a minimal valid manifest and defaults the entry', () => {
    const result = parseManifest({ manifestVersion: 1, name: 'X', scopes: { data: 'read' } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.entry).toBe('index.html')
    expect(result.manifest.scopes).toEqual({ data: 'read' })
  })

  it('reports EVERY problem at once, not just the first', () => {
    const result = parseManifest({ manifestVersion: 9, name: '', scopes: { data: 'god' } })
    expect(issuePaths(result)).toEqual(
      expect.arrayContaining(['manifestVersion', 'name', 'scopes.data']),
    )
  })

  it('rejects an unknown manifestVersion — a permission schema may not be guessed at', () => {
    expect(parseManifest({ ...VALID, manifestVersion: 2 }).ok).toBe(false)
  })

  it('fails closed on an unknown SCOPE key', () => {
    // Unknown top-level fields fall through to metadata; unknown scopes do not.
    // Tolerating one would let an app request something this build cannot show
    // on the consent screen but a later build might start honouring.
    const result = parseManifest({
      ...VALID,
      scopes: { data: 'read', filesystem: true },
    })
    expect(issuePaths(result)).toContain('scopes.filesystem')
  })

  it('keeps unknown TOP-LEVEL fields as metadata (forward compatibility)', () => {
    const result = parseManifest({ ...VALID, futureThing: { a: 1 } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.metadata).toEqual({ futureThing: { a: 1 } })
  })

  it('rejects an entry that escapes the bundle', () => {
    for (const entry of ['../secrets.html', '/etc/passwd.html', 'C:\\x.html', 'a/../../b.html']) {
      expect(issuePaths(parseManifest({ ...VALID, entry }))).toContain('entry')
    }
  })

  it('requires the entry to be HTML', () => {
    expect(issuePaths(parseManifest({ ...VALID, entry: 'index.js' }))).toContain('entry')
  })
})

describe('[COMP:shared/brian-app-lint] path + origin safety', () => {
  it('accepts ordinary relative bundle paths', () => {
    for (const p of ['index.html', 'assets/app.js', 'a/b/c.png']) {
      expect(isSafeBundlePath(p)).toBe(true)
    }
  })

  it('rejects traversal, absolutes, backslashes, and control characters', () => {
    for (const p of [
      '../x',
      '/x',
      'a/../b',
      'a/./b',
      'a//b',
      'a\\b',
      'C:/x',
      'https://evil/x',
      'a\u0000b',
      '',
    ]) {
      expect(isSafeBundlePath(p)).toBe(false)
    }
  })

  it('accepts only bare https origins for scopes.net', () => {
    expect(isSafeNetOrigin('https://api.example.com')).toBe(true)
    for (const bad of [
      'http://api.example.com', // plaintext
      'https://api.example.com/v1', // path
      'https://*.example.com', // wildcard — legal CSP, but grants a whole subdomain tree
      'https://example', // single label
      'https://-x.example.com', // leading hyphen
      'https://u:p@example.com', // credentials
      "https://x.com';script-src *", // CSP header injection
      'https://x.com ', // whitespace
      'wss://x.com',
      'not a url',
    ]) {
      expect(isSafeNetOrigin(bad)).toBe(false)
    }
  })
})

describe('[COMP:shared/brian-app-lint] validateBundle', () => {
  const files = [
    { path: MANIFEST_FILENAME, bytes: 200 },
    { path: 'index.html', bytes: 1000 },
    { path: 'assets/app.js', bytes: 2000 },
  ]

  it('accepts a well-formed bundle', () => {
    const result = validateBundle({ files, manifestJson: VALID })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.totalBytes).toBe(3200)
  })

  it('requires the manifest and the declared entry to be present', () => {
    expect(
      validateBundle({ files: [{ path: 'index.html', bytes: 1 }], manifestJson: VALID }),
    ).toMatchObject({ ok: false })
    expect(
      validateBundle({
        files: [{ path: MANIFEST_FILENAME, bytes: 1 }],
        manifestJson: VALID,
      }),
    ).toMatchObject({ ok: false })
  })

  it('rejects a file type the bundle route would not serve', () => {
    // Not "serve it as octet-stream" — a file we would not serve has no
    // business in the bundle, and a silent drop makes the author debug a 404.
    const result = validateBundle({
      files: [...files, { path: 'run.wasm', bytes: 10 }],
      manifestJson: VALID,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.some((i) => i.path === 'run.wasm')).toBe(true)
  })

  it('rejects a path that collides case-insensitively', () => {
    const result = validateBundle({
      files: [...files, { path: 'Index.html', bytes: 10 }],
      manifestJson: VALID,
    })
    expect(result.ok).toBe(false)
  })

  it('enforces the file-count, per-file, and total-size caps', () => {
    const many = Array.from({ length: 120 }, (_, i) => ({
      path: `assets/a${i}.js`,
      bytes: 10,
    }))
    expect(
      validateBundle({ files: [...files, ...many], manifestJson: VALID }).ok,
    ).toBe(false)
    expect(
      validateBundle({
        files: [...files, { path: 'big.js', bytes: 3 * 1024 * 1024 }],
        manifestJson: VALID,
      }).ok,
    ).toBe(false)
    expect(
      validateBundle({
        files: [
          ...files,
          ...Array.from({ length: 5 }, (_, i) => ({
            path: `assets/b${i}.png`,
            bytes: 1024 * 1024 + 1,
          })),
        ],
        manifestJson: VALID,
      }).ok,
    ).toBe(false)
  })
})

describe('[COMP:shared/brian-app-lint] content types are pinned, never sniffed', () => {
  it('maps known extensions and refuses everything else', () => {
    expect(contentTypeFor('index.html')).toBe('text/html; charset=utf-8')
    expect(contentTypeFor('a/b.js')).toBe('text/javascript; charset=utf-8')
    expect(contentTypeFor('logo.svg')).toBe('image/svg+xml')
    expect(contentTypeFor('run.wasm')).toBeNull()
    expect(contentTypeFor('Dockerfile')).toBeNull()
    expect(contentTypeFor('x.PNG')).toBe('image/png')
  })
})

describe('[COMP:shared/brian-app-lint] scopesExceedGrant (T3 drift rule)', () => {
  it('treats a missing grant as exceeded', () => {
    expect(scopesExceedGrant({ data: 'read' }, null)).toBe(true)
  })

  it('is false when the request is within the grant', () => {
    expect(scopesExceedGrant({ data: 'read' }, { data: 'read_write' })).toBe(false)
    expect(
      scopesExceedGrant({ data: 'read' }, { data: 'read', identity: true }),
    ).toBe(false)
  })

  it('catches every widening axis — this is what voids a grant on sync', () => {
    expect(scopesExceedGrant({ data: 'read_write' }, { data: 'read' })).toBe(true)
    expect(
      scopesExceedGrant({ data: 'read', identity: true }, { data: 'read' }),
    ).toBe(true)
    expect(
      scopesExceedGrant(
        { data: 'read', net: ['https://a.example.com', 'https://b.example.com'] },
        { data: 'read', net: ['https://a.example.com'] },
      ),
    ).toBe(true)
  })
})

describe('[COMP:shared/brian-app-lint] lintBundle is advisory only', () => {
  it('warns without failing', () => {
    const parsed = parseManifest({
      manifestVersion: 1,
      name: 'X',
      scopes: { data: 'read_write', net: ['https://api.example.com'] },
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const findings = lintBundle({ files: [], manifest: parsed.manifest })
    expect(findings.every((f) => f.severity === 'warning')).toBe(true)
    expect(findings.some((f) => f.message.includes('read_write'))).toBe(true)
    expect(findings.some((f) => f.message.includes('api.example.com'))).toBe(true)
  })
})

describe('[COMP:shared/brian-app-lint] scopes.store', () => {
  function parse(store: unknown) {
    return parseManifest({ ...VALID, scopes: { data: 'read', store } })
  }

  it('defaults to absent, so a pre-store manifest keeps its old meaning', () => {
    const result = parseManifest(VALID)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.scopes.store).toBeUndefined()
    expect(storeScopeRank(result.manifest.scopes.store)).toBe(0)
  })

  it("normalizes an explicit 'none' away rather than storing it", () => {
    const result = parse('none')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.scopes.store).toBeUndefined()
  })

  it('accepts read and write', () => {
    for (const tier of ['read', 'write'] as const) {
      const result = parse(tier)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.manifest.scopes.store).toBe(tier)
    }
  })

  it('rejects an unknown tier instead of coercing it', () => {
    // A silent coercion to 'none' would let an app that MEANT to ask for
    // access render as though it had been granted nothing, and a coercion the
    // other way is worse. Fail the parse.
    expect(issuePaths(parse('admin'))).toContain('scopes.store')
    expect(issuePaths(parse(true))).toContain('scopes.store')
    expect(issuePaths(parse('read_write'))).toContain('scopes.store')
  })

  it('is independent of scopes.data — neither tier implies the other', () => {
    // The whole reason store is a separate axis. A store-only app must not be
    // forced to request brain access, and brain read_write must not confer
    // any store reach at all.
    const storeOnly = parseManifest({ ...VALID, scopes: { data: 'read', store: 'write' } })
    expect(storeOnly.ok).toBe(true)
    if (!storeOnly.ok) return
    expect(storeOnly.manifest.scopes.data).toBe('read')

    expect(scopesExceedGrant({ data: 'read_write' }, { data: 'read_write', store: 'write' })).toBe(
      false,
    )
    // brain read_write does NOT cover store read
    expect(scopesExceedGrant({ data: 'read', store: 'read' }, { data: 'read_write' })).toBe(true)
  })

  it('voids a grant when the store tier widens', () => {
    expect(scopesExceedGrant({ data: 'read', store: 'read' }, { data: 'read' })).toBe(true)
    expect(scopesExceedGrant({ data: 'read', store: 'write' }, { data: 'read', store: 'read' })).toBe(
      true,
    )
    // Narrowing is not a widening — a re-sync that drops to read keeps the grant.
    expect(scopesExceedGrant({ data: 'read', store: 'read' }, { data: 'read', store: 'write' })).toBe(
      false,
    )
  })
})
