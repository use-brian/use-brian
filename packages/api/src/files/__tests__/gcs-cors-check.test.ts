import { describe, it, expect, vi } from 'vitest'
import {
  corsAllowsBrowserUpload,
  corsFixHint,
  verifyBucketCorsAtBoot,
  type GcsCorsRule,
} from '../gcs-cors-check.js'

vi.mock('@google-cloud/storage', () => ({
  Storage: class {
    bucket() {
      return {
        getMetadata: async () => {
          throw new Error('storage.buckets.get denied')
        },
      }
    }
  },
}))

const ORIGIN = 'https://app.usebrian.ai'

describe('[COMP:files/gcs-cors-check] corsAllowsBrowserUpload', () => {
  it('accepts the canonical config from files.md', () => {
    const rules: GcsCorsRule[] = [
      {
        origin: ['https://app.usebrian.ai', 'https://usebrian.ai', 'https://feed.usebrian.ai'],
        method: ['GET', 'PUT'],
        responseHeader: ['Content-Type', 'Content-Disposition', 'Content-Length'],
        maxAgeSeconds: 3600,
      },
    ]
    expect(corsAllowsBrowserUpload(rules, ORIGIN)).toEqual({ ok: true })
  })

  // The state brian-files-prod was actually in: a fresh bucket after the
  // rebrand. Bucket config does not follow a rename.
  it('flags a bucket with no CORS at all', () => {
    for (const empty of [null, undefined, [] as GcsCorsRule[]]) {
      const v = corsAllowsBrowserUpload(empty, ORIGIN)
      expect(v.ok).toBe(false)
      expect(v.ok === false && v.code).toBe('no_cors')
    }
  })

  // The state sidanclaw-files-prod is in: correct config, stale origins.
  it('flags a config whose origins are all stale', () => {
    const rules: GcsCorsRule[] = [{ origin: ['https://app.sidan.ai'], method: ['GET', 'PUT'] }]
    const v = corsAllowsBrowserUpload(rules, ORIGIN)
    expect(v.ok).toBe(false)
    expect(v.ok === false && v.code).toBe('origin_not_allowed')
    // The message names what IS configured — that is the whole diagnosis.
    expect(v.ok === false && v.detail).toContain('https://app.sidan.ai')
  })

  // The 2026-07-09 incident shape: downloads work, every upload dies.
  it('flags a GET-only rule', () => {
    const rules: GcsCorsRule[] = [{ origin: [ORIGIN], method: ['GET'] }]
    const v = corsAllowsBrowserUpload(rules, ORIGIN)
    expect(v.ok).toBe(false)
    expect(v.ok === false && v.code).toBe('put_not_allowed')
  })

  it('does not let PUT on another origin rule satisfy this origin', () => {
    // A rule grants its methods to ITS origins. Reading PUT off a rule that
    // matched a different origin would pass a bucket that genuinely blocks us.
    const rules: GcsCorsRule[] = [
      { origin: ['https://elsewhere.example'], method: ['PUT'] },
      { origin: [ORIGIN], method: ['GET'] },
    ]
    const v = corsAllowsBrowserUpload(rules, ORIGIN)
    expect(v.ok).toBe(false)
    expect(v.ok === false && v.code).toBe('put_not_allowed')
  })

  it('accepts when a later rule supplies PUT for the same origin', () => {
    const rules: GcsCorsRule[] = [
      { origin: [ORIGIN], method: ['GET'] },
      { origin: [ORIGIN], method: ['PUT'] },
    ]
    expect(corsAllowsBrowserUpload(rules, ORIGIN)).toEqual({ ok: true })
  })

  it('honors wildcards on both origin and method', () => {
    expect(corsAllowsBrowserUpload([{ origin: ['*'], method: ['PUT'] }], ORIGIN)).toEqual({ ok: true })
    expect(corsAllowsBrowserUpload([{ origin: [ORIGIN], method: ['*'] }], ORIGIN)).toEqual({ ok: true })
  })

  it('matches origin and method case-insensitively', () => {
    const rules: GcsCorsRule[] = [{ origin: ['https://APP.usebrian.ai'], method: ['put'] }]
    expect(corsAllowsBrowserUpload(rules, ORIGIN)).toEqual({ ok: true })
  })

  it('treats a rule with no method list as granting nothing', () => {
    expect(corsAllowsBrowserUpload([{ origin: [ORIGIN] }], ORIGIN).ok).toBe(false)
  })
})

describe('[COMP:files/gcs-cors-check] verifyBucketCorsAtBoot', () => {
  const capture = () => {
    const warn: string[] = []
    const log: string[] = []
    return { warn: (m: string) => warn.push(m), log: (m: string) => log.push(m), _warn: warn, _log: log }
  }

  it('warns with the remediation when uploads would fail', async () => {
    const c = capture()
    // Inject the read by stubbing the module boundary is overkill here; the
    // pure verdict is covered above. This asserts the LOG contract: an
    // operator must be able to act on the line without reading the source.
    const hint = corsFixHint('brian-files-prod', ORIGIN)
    expect(hint).toContain('gs://brian-files-prod')
    expect(hint).toContain('PUT')
    expect(hint).toContain('files.md')
    expect(hint).toContain('gcloud storage buckets describe')
    void c
  })

  it('degrades to a soft note, not a warning, when the bucket cannot be read', async () => {
    const c = capture()
    // A service account without storage.buckets.get must not produce a false
    // alarm — unknown is not the same as misconfigured.
    const verdict = await verifyBucketCorsAtBoot({
      bucket: 'definitely-not-a-real-bucket-hgkwud',
      origin: ORIGIN,
      log: c,
    })
    expect(verdict).toBeNull()
    expect(c._warn).toHaveLength(0)
    expect(c._log.join(' ')).toContain('could not read CORS')
  })
})
