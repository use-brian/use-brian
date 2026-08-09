import { describe, expect, it } from 'vitest'
import {
  supportFilePointer,
  supportFileMarkdownLink,
  validateSupportFile,
  validateSupportFileSet,
  SUPPORT_FILE_NAME_MAX,
} from '../support-files.js'
import {
  IMPORT_MAX_SUPPORT_FILES,
  IMPORT_MAX_SUPPORT_FILE_BYTES,
  IMPORT_MAX_SUPPORT_TOTAL_BYTES,
} from '../import-service.js'

const ok = (kind: string, name: string, content = 'body') => ({ kind, name, content })

describe('[COMP:api/skill-support-files] Single-file validation', () => {
  it('accepts each bundle kind and trims the name', () => {
    for (const kind of ['reference', 'asset', 'template', 'script']) {
      const result = validateSupportFile({ kind, name: '  notes.md  ', content: 'hi' })
      expect(result).toMatchObject({
        ok: true,
        value: { kind, name: 'notes.md', content: 'hi' },
      })
    }
  })

  it('keeps an optional description and drops a blank one', () => {
    expect(validateSupportFile({ ...ok('reference', 'a.md'), description: ' why ' })).toMatchObject({
      ok: true,
      value: { kind: 'reference', name: 'a.md', content: 'body', description: 'why' },
    })
    expect(validateSupportFile({ ...ok('reference', 'a.md'), description: '   ' })).toMatchObject({
      ok: true,
      value: { kind: 'reference', name: 'a.md', content: 'body' },
    })
  })

  it('rejects an unknown kind', () => {
    expect(validateSupportFile(ok('binary', 'logo.png'))).toMatchObject({ ok: false })
    expect(validateSupportFile(ok('', 'a.md'))).toMatchObject({ ok: false })
  })

  it('rejects a missing, blank, or over-long name', () => {
    expect(validateSupportFile(ok('reference', ''))).toMatchObject({ ok: false })
    expect(validateSupportFile(ok('reference', '   '))).toMatchObject({ ok: false })
    expect(
      validateSupportFile(ok('reference', 'x'.repeat(SUPPORT_FILE_NAME_MAX + 1))),
    ).toMatchObject({ ok: false })
  })

  // The rules track POINTER_RE (packages/core/src/skills/loader.ts), whose
  // name group is `[^{}\r\n]+?`. Slashes and colons resolve fine there, and
  // the curator's `add_support_file` writes without passing through here — so
  // rejecting them would strand a curator file as uneditable, the exact
  // failure these routes exist to fix.
  it('accepts the path-like and colon-bearing names the resolver accepts', () => {
    for (const good of ['refs/notes.md', 'refs\\notes.md', 'a:b.md', 'v1.2/notes.md']) {
      expect(validateSupportFile(ok('reference', good))).toMatchObject({ ok: true })
    }
  })

  it('rejects a bare path segment', () => {
    expect(validateSupportFile(ok('reference', '.'))).toMatchObject({ ok: false })
    expect(validateSupportFile(ok('reference', '..'))).toMatchObject({ ok: false })
  })

  it('rejects a name carrying the pointer delimiters or a line break', () => {
    expect(validateSupportFile(ok('reference', 'a{{b}}.md'))).toMatchObject({ ok: false })
    expect(validateSupportFile(ok('reference', 'a}b.md'))).toMatchObject({ ok: false })
    expect(validateSupportFile(ok('reference', 'a\nb.md'))).toMatchObject({ ok: false })
  })

  it('rejects empty content and content over the per-file byte cap', () => {
    expect(validateSupportFile(ok('reference', 'a.md', ''))).toMatchObject({ ok: false })
    expect(
      validateSupportFile(ok('reference', 'a.md', 'x'.repeat(IMPORT_MAX_SUPPORT_FILE_BYTES + 1))),
    ).toMatchObject({ ok: false })
  })

  // Byte length, not string length — a multi-byte body that fits in chars can
  // still blow the cap the folder-walk import measures in bytes.
  it('measures the content cap in bytes, not characters', () => {
    const justOverInBytes = '毫'.repeat(Math.ceil(IMPORT_MAX_SUPPORT_FILE_BYTES / 3))
    expect(justOverInBytes.length).toBeLessThan(IMPORT_MAX_SUPPORT_FILE_BYTES)
    expect(validateSupportFile(ok('reference', 'a.md', justOverInBytes))).toMatchObject({
      ok: false,
    })
  })

  it('rejects a non-object input', () => {
    expect(validateSupportFile(null)).toMatchObject({ ok: false })
    expect(validateSupportFile('a.md')).toMatchObject({ ok: false })
    expect(validateSupportFile([])).toMatchObject({ ok: false })
  })
})

describe('[COMP:api/skill-support-files] Set validation', () => {
  it('accepts an empty array', () => {
    expect(validateSupportFileSet([])).toEqual({ ok: true, value: [] })
  })

  it('rejects a non-array', () => {
    expect(validateSupportFileSet({})).toMatchObject({ ok: false })
  })

  it('rejects more files than the count cap', () => {
    const many = Array.from({ length: IMPORT_MAX_SUPPORT_FILES + 1 }, (_, i) =>
      ok('reference', `f${i}.md`),
    )
    expect(validateSupportFileSet(many)).toMatchObject({ ok: false })
  })

  it('rejects a duplicate (kind, name) but allows the same name under two kinds', () => {
    expect(
      validateSupportFileSet([ok('reference', 'a.md'), ok('reference', 'a.md')]),
    ).toMatchObject({ ok: false })
    expect(
      validateSupportFileSet([ok('reference', 'a.md'), ok('template', 'a.md')]),
    ).toMatchObject({ ok: true })
  })

  it('rejects a set over the total byte cap', () => {
    const half = 'x'.repeat(IMPORT_MAX_SUPPORT_FILE_BYTES)
    const count = Math.ceil(IMPORT_MAX_SUPPORT_TOTAL_BYTES / IMPORT_MAX_SUPPORT_FILE_BYTES) + 1
    const files = Array.from({ length: count }, (_, i) => ok('reference', `f${i}.md`, half))
    expect(validateSupportFileSet(files)).toMatchObject({ ok: false })
  })

  it('names the offending file in the error', () => {
    const result = validateSupportFileSet([ok('reference', 'good.md'), ok('binary', 'bad.png')])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('bad.png')
  })
})

describe('[COMP:api/skill-support-files] Pointer rendering', () => {
  it('renders the loader pointer for a file', () => {
    expect(supportFilePointer({ kind: 'template', name: 'weekly-status.md' })).toBe(
      '{{template:weekly-status.md}}',
    )
    expect(supportFilePointer({ kind: 'reference', name: 'tone.md' })).toBe(
      '{{reference:tone.md}}',
    )
  })

  it('renders a portable relative Markdown link for bundle v2', () => {
    expect(supportFileMarkdownLink({ name: 'tone.md', path: 'references/tone.md' })).toBe(
      '[tone.md](references/tone.md)',
    )
    expect(supportFileMarkdownLink({ name: 'tone.md' })).toBeNull()
  })
})
