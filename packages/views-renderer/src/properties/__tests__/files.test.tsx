/**
 * [COMP:views/property-files] Files property — Cell stack, "+N more"
 * overflow, cover detection (first image wins), sortFn (count → name),
 * registry presence, structural validation, and `getCoverImageRef`
 * helper exported for Gallery view.
 *
 * Test strategy mirrors `__tests__/properties.test.tsx` and
 * `status.test.tsx`:
 *   * Cells are pure functions of value — invoke directly and inspect
 *     the returned React element tree.
 *   * Editors use hooks — drive them through `renderToStaticMarkup` and
 *     inspect the resulting HTML.
 */

import React, { type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { A2UIRowValue, FileRef } from '../../types.js'
import { PROPERTIES } from '../index.js'
import { FilesProperty, getCoverImageRef } from '../files.js'
import type { PropertyEditorProps } from '../types.js'

function elName(el: ReactElement): string {
  if (typeof el.type === 'string') return el.type
  if (typeof el.type === 'function') return (el.type as { name?: string }).name ?? 'anonymous'
  return String(el.type)
}

function isEmptyMarker(el: ReactElement): boolean {
  if (typeof el.type === 'function') {
    return (el.type as { name?: string }).name === 'Empty'
  }
  return false
}

function renderEditorHtml(
  Editor: (props: PropertyEditorProps) => ReactElement | null,
  props: PropertyEditorProps,
): string {
  const el = React.createElement(Editor as React.FC<typeof props>, props)
  return renderToStaticMarkup(el)
}

// ── Fixtures ────────────────────────────────────────────────────────

function pdf(name: string, size = 1024): FileRef {
  return {
    bucket: 'file_cache',
    path: `pdf-${name}`,
    mimeType: 'application/pdf',
    sizeBytes: size,
    name,
  }
}

function img(name: string, size = 2048): FileRef {
  return {
    bucket: 'file_cache',
    path: `img-${name}`,
    mimeType: 'image/png',
    sizeBytes: size,
    name,
  }
}

function widget(files: FileRef[]): A2UIRowValue {
  return { type: 'files', files }
}

// ── Module registration ─────────────────────────────────────────────

describe('[COMP:views/property-files] files property — registry', () => {
  it('is registered in PROPERTIES under "files"', () => {
    expect(PROPERTIES.files).toBe(FilesProperty)
  })

  it('declares kind="files"', () => {
    expect(FilesProperty.kind).toBe('files')
  })
})

// ── Cell ────────────────────────────────────────────────────────────

describe('[COMP:views/property-files] files property — Cell', () => {
  const { Cell } = FilesProperty

  it('renders Empty for null', () => {
    expect(isEmptyMarker(Cell({ value: null }))).toBe(true)
  })

  it('renders Empty for an empty files widget', () => {
    expect(isEmptyMarker(Cell({ value: widget([]) }))).toBe(true)
  })

  it('renders multiple file pills below the 3-item threshold', () => {
    const v = widget([pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')])
    const html = renderToStaticMarkup(Cell({ value: v }))
    expect(html).toContain('a.pdf')
    expect(html).toContain('b.pdf')
    expect(html).toContain('c.pdf')
    // No overflow chip when count <= threshold.
    expect(html).not.toMatch(/\+\d+ more/)
  })

  it('renders "+N more" when more than 3 files are present', () => {
    const v = widget([
      pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf'),
      pdf('d.pdf'), pdf('e.pdf'),
    ])
    const html = renderToStaticMarkup(Cell({ value: v }))
    expect(html).toContain('a.pdf')
    expect(html).toContain('b.pdf')
    expect(html).toContain('c.pdf')
    // d and e collapse into the overflow chip.
    expect(html).not.toContain('d.pdf')
    expect(html).not.toContain('e.pdf')
    expect(html).toMatch(/\+2 more/)
  })

  it('renders a cover image when the first file is an image mime', () => {
    const v = widget([img('cover.png'), pdf('a.pdf')])
    const html = renderToStaticMarkup(Cell({ value: v }))
    // An <img> tag with the cover's preview URL appears.
    expect(html).toMatch(/<img[^>]+src="[^"]*\/api\/files\/img-cover\.png\/preview"/)
    expect(html).toMatch(/loading="lazy"/)
  })

  it('renders a cover image with 16:9 aspect class', () => {
    const v = widget([img('cover.png')])
    const html = renderToStaticMarkup(Cell({ value: v }))
    expect(html).toMatch(/aspect-\[16\/9\]/)
  })

  it('does not render a cover when no image is present', () => {
    const v = widget([pdf('a.pdf'), pdf('b.pdf')])
    const html = renderToStaticMarkup(Cell({ value: v }))
    expect(html).not.toMatch(/<img[^>]+\/api\/files/)
  })
})

// ── getCoverImageRef ────────────────────────────────────────────────

describe('[COMP:views/property-files] files property — getCoverImageRef', () => {
  it('returns null for null', () => {
    expect(getCoverImageRef(null)).toBeNull()
  })

  it('returns null for an empty files widget', () => {
    expect(getCoverImageRef(widget([]))).toBeNull()
  })

  it('returns the first image ref when present', () => {
    const first = img('first.png')
    const second = img('second.png')
    const ref = getCoverImageRef(widget([pdf('skip.pdf'), first, second]))
    expect(ref).toBe(first)
  })

  it('returns the first image even when other files precede it', () => {
    const cover = img('cover.png')
    const ref = getCoverImageRef(widget([pdf('a.pdf'), pdf('b.pdf'), cover, img('z.png')]))
    expect(ref).toBe(cover)
  })

  it('returns null when no image-mime file is present', () => {
    expect(getCoverImageRef(widget([pdf('a.pdf'), pdf('b.pdf')]))).toBeNull()
  })

  it('matches any image/* mime', () => {
    const svg: FileRef = { ...img('a'), mimeType: 'image/svg+xml' }
    const ref = getCoverImageRef(widget([svg]))
    expect(ref).toBe(svg)
  })

  it('ignores non-image mimes that happen to contain "image" later', () => {
    const weird: FileRef = { ...pdf('a'), mimeType: 'application/x-image-archive' }
    expect(getCoverImageRef(widget([weird]))).toBeNull()
  })
})

// ── Icon ────────────────────────────────────────────────────────────

describe('[COMP:views/property-files] files property — Icon', () => {
  it('renders an svg', () => {
    expect(elName(FilesProperty.Icon({}))).toBe('svg')
  })
})

// ── sortFn ──────────────────────────────────────────────────────────

describe('[COMP:views/property-files] files property — sortFn', () => {
  const { sortFn } = FilesProperty

  it('orders by file count ascending', () => {
    const a = widget([pdf('x.pdf'), pdf('y.pdf')])
    const b = widget([pdf('z.pdf')])
    expect(sortFn(a, b)).toBeGreaterThan(0)
    expect(sortFn(b, a)).toBeLessThan(0)
  })

  it('breaks count ties alphabetically on the first file name', () => {
    const a = widget([pdf('banana.pdf')])
    const b = widget([pdf('apple.pdf')])
    expect(sortFn(a, b)).toBeGreaterThan(0)
    expect(sortFn(b, a)).toBeLessThan(0)
  })

  it('treats null and empty arrays as the smallest (lowest count)', () => {
    const v: A2UIRowValue[] = [
      widget([pdf('a.pdf'), pdf('b.pdf')]),
      widget([]),
      null,
      widget([pdf('c.pdf')]),
    ]
    v.sort(sortFn)
    // The first slot is "no files" — either null or an empty widget.
    const head = v[0]
    if (head !== null) {
      expect((head as { files: FileRef[] }).files.length).toBe(0)
    }
    // Last slot is the largest list.
    expect((v[3] as { files: FileRef[] }).files.length).toBe(2)
  })

  it('returns 0 when both sides are empty', () => {
    expect(sortFn(null, null)).toBe(0)
    expect(sortFn(widget([]), widget([]))).toBe(0)
  })
})

// ── validate ────────────────────────────────────────────────────────

describe('[COMP:views/property-files] files property — validate', () => {
  const validate = FilesProperty.validate!

  it('accepts null', () => {
    expect(validate(null)).toBe(true)
  })

  it('accepts an empty files widget', () => {
    expect(validate(widget([]))).toBe(true)
  })

  it('accepts a widget with fully-populated refs', () => {
    expect(validate(widget([pdf('a.pdf'), img('b.png')]))).toBe(true)
  })

  it('rejects a widget with a ref missing a field', () => {
    const broken = {
      type: 'files' as const,
      files: [{ bucket: 'file_cache', path: 'p', mimeType: 'image/png', sizeBytes: 10 } as unknown as FileRef],
    }
    expect(validate(broken)).toBe(false)
  })

  it('rejects a widget with a negative sizeBytes', () => {
    const broken = widget([{ ...pdf('a.pdf'), sizeBytes: -1 }])
    expect(validate(broken)).toBe(false)
  })

  it('rejects a widget whose files is not an array', () => {
    const broken = { type: 'files' as const, files: 'nope' as unknown as FileRef[] }
    expect(validate(broken)).toBe(false)
  })

  it('rejects unrelated widgets', () => {
    expect(validate({ type: 'badge', text: 'x' })).toBe(false)
    expect(validate({ type: 'date', iso: '2026-05-28T00:00:00Z' })).toBe(false)
  })

  it('rejects bare strings and numbers', () => {
    expect(validate('whatever')).toBe(false)
    expect(validate(42)).toBe(false)
  })
})

// ── Editor ──────────────────────────────────────────────────────────

describe('[COMP:views/property-files] files property — Editor', () => {
  const { Editor } = FilesProperty

  it('renders a drop affordance when the cell is empty', () => {
    const html = renderEditorHtml(Editor!, {
      value: null,
      onCommit: vi.fn(),
      onCancel: vi.fn(),
    })
    // Drop hint + Pick button.
    expect(html).toMatch(/Drop files or pick from disk|Uploading/)
    expect(html).toMatch(/<button[^>]*>[^<]*Pick/)
  })

  it('renders existing files as removable list items', () => {
    const html = renderEditorHtml(Editor!, {
      value: widget([pdf('keepme.pdf'), img('cover.png')]),
      onCommit: vi.fn(),
      onCancel: vi.fn(),
    })
    expect(html).toContain('keepme.pdf')
    expect(html).toContain('cover.png')
    // Each row carries a remove (×) button.
    expect((html.match(/×/g) ?? []).length).toBeGreaterThanOrEqual(2)
    // Save + Cancel actions are present.
    expect(html).toMatch(/<button[^>]*>[^<]*Save/)
    expect(html).toMatch(/<button[^>]*>[^<]*Cancel/)
  })
})
