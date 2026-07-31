/**
 * [COMP:api/home-app-zip] — the zip import/export codecs.
 *
 * The claims that matter:
 *
 *   1. export → import round-trips byte-exactly, including binary assets —
 *      the exported bundle + manifest is the unit of sharing (C2), so a
 *      re-import must reproduce the app, not an approximation of it;
 *   2. a folder-zip imports like a content-zip (single top dir stripped) and
 *      macOS archive junk never fails an import;
 *   3. the v1 caps bound extraction itself — a decompression bomb is refused
 *      while inflating, not after it has been held in memory.
 */

import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { buildBundleZip, filesFromZipBuffer } from '../zip.js'

const MANIFEST = JSON.stringify({
  manifestVersion: 1,
  name: 'Pipeline board',
  entry: 'index.html',
  scopes: { data: 'read' },
})

/** A tiny valid PNG header — enough to prove bytes survive untouched. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0xfe, 0xff])

async function zipOf(entries: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new JSZip()
  for (const [path, data] of Object.entries(entries)) zip.file(path, data)
  return zip.generateAsync({ type: 'nodebuffer' })
}

describe('[COMP:api/home-app-zip] filesFromZipBuffer', () => {
  it('extracts text as content and binary as bytes, byte-exactly', async () => {
    const buf = await zipOf({
      'brian-app.json': MANIFEST,
      'index.html': '<h1>hi</h1>',
      'assets/icon.png': PNG,
    })
    const result = await filesFromZipBuffer(buf)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const byPath = new Map(result.files.map((f) => [f.path, f]))
    expect(byPath.get('index.html')).toMatchObject({ content: '<h1>hi</h1>' })
    const icon = byPath.get('assets/icon.png')
    expect(icon && 'bytes' in icon && Buffer.from(icon.bytes).equals(PNG)).toBe(true)
  })

  it('strips a single shared top-level folder — a folder-zip imports like a content-zip', async () => {
    const buf = await zipOf({
      'MyApp/brian-app.json': MANIFEST,
      'MyApp/index.html': '<h1>hi</h1>',
    })
    const result = await filesFromZipBuffer(buf)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.files.map((f) => f.path).sort()).toEqual(['brian-app.json', 'index.html'])
  })

  it('keeps paths intact when the root already holds the manifest', async () => {
    const buf = await zipOf({
      'brian-app.json': MANIFEST,
      'assets/app.js': 'x',
    })
    const result = await filesFromZipBuffer(buf)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // `assets/` is NOT a strippable top dir — the manifest sits beside it.
    expect(result.files.map((f) => f.path).sort()).toEqual(['assets/app.js', 'brian-app.json'])
  })

  it('drops macOS archive junk and repo furniture without failing', async () => {
    const buf = await zipOf({
      'brian-app.json': MANIFEST,
      'index.html': 'x',
      '__MACOSX/._index.html': 'resource fork',
      '.DS_Store': 'junk',
      'assets/._icon.png': 'fork with an allowed extension',
      'README.md': 'furniture',
      LICENSE: 'furniture',
    })
    const result = await filesFromZipBuffer(buf)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.files.map((f) => f.path).sort()).toEqual(['brian-app.json', 'index.html'])
  })

  it('refuses a non-zip and an empty zip with a user-facing message', async () => {
    expect(await filesFromZipBuffer(Buffer.from('not a zip'))).toMatchObject({ ok: false })
    const empty = await filesFromZipBuffer(await zipOf({ 'README.md': 'only furniture' }))
    // Only-furniture extracts to zero files; the validator downstream reports
    // the missing manifest. A literally empty archive is refused here.
    expect(empty.ok).toBe(true)
    expect(await filesFromZipBuffer(await zipOf({}))).toMatchObject({ ok: false })
  })

  it('enforces the per-file cap DURING extraction — a bomb is refused while inflating', async () => {
    const buf = await zipOf({
      'brian-app.json': MANIFEST,
      'assets/huge.js': Buffer.alloc(2 * 1024 * 1024 + 1, 0x61),
    })
    const result = await filesFromZipBuffer(buf)
    expect(result).toMatchObject({ ok: false })
    if (result.ok) return
    expect(result.message).toContain('assets/huge.js')
  })
})

describe('[COMP:api/home-app-zip] round-trip', () => {
  it('buildBundleZip → filesFromZipBuffer reproduces the bundle byte-exactly', async () => {
    const buf = await buildBundleZip([
      { path: 'brian-app.json', bytes: Buffer.from(MANIFEST) },
      { path: 'index.html', bytes: Buffer.from('<h1>hi</h1>') },
      { path: 'assets/icon.png', bytes: PNG },
    ])
    const result = await filesFromZipBuffer(buf)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const byPath = new Map(result.files.map((f) => [f.path, f]))
    expect(byPath.get('brian-app.json')).toMatchObject({ content: MANIFEST })
    const icon = byPath.get('assets/icon.png')
    expect(icon && 'bytes' in icon && Buffer.from(icon.bytes).equals(PNG)).toBe(true)
  })
})
