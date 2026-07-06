import { describe, it, expect } from 'vitest'
import { chunkFileText, MAX_SEGMENTS_PER_FILE, type FileChunk } from '../file-segments-store.js'

/** Assert the exact-slice invariant over every segment of a chunk result. */
function expectExactSlices(text: string, segments: FileChunk[]) {
  const normalized = text.replace(/\r\n/g, '\n')
  for (const s of segments) {
    expect(s.content).toBe(normalized.slice(s.charStart, s.charEnd))
  }
}

const para = (s: string, n: number) => Array.from({ length: n }, () => s).join(' ')

describe('[COMP:brain/file-segments-store] chunkFileText', () => {
  it('empty / whitespace-only input yields no segments', () => {
    expect(chunkFileText('').segments).toEqual([])
    expect(chunkFileText('  \n\n \t ').segments).toEqual([])
    expect(chunkFileText('').truncatedAtChar).toBeNull()
  })

  it('a small document is one segment with the exact-slice invariant', () => {
    const text = 'Hello world.\n\nSecond paragraph here.'
    const { segments } = chunkFileText(text)
    expect(segments).toHaveLength(1)
    expect(segments[0].charStart).toBe(0)
    expectExactSlices(text, segments)
  })

  it('normalizes \\r\\n to \\n before slicing (offsets are into the normalized text)', () => {
    const text = 'Line one.\r\n\r\nLine two.'
    const { segments } = chunkFileText(text)
    expectExactSlices(text, segments)
    expect(segments[0].content).toContain('Line one.')
  })

  it('builds a level-aware headingPath breadcrumb (h2 pops back to h1)', () => {
    const text = [
      '# Report',
      para('Intro text.', 40),
      '## Finance',
      para('Numbers go here.', 40),
      '### Revenue',
      para('Revenue detail.', 40),
      '## Hiring',
      para('Hiring detail.', 40),
    ].join('\n\n')
    const { segments } = chunkFileText(text)
    expectExactSlices(text, segments)

    const paths = segments.map((s) => s.headingPath.join(' > '))
    expect(paths.some((p) => p === 'Report')).toBe(true)
    expect(paths.some((p) => p === 'Report > Finance')).toBe(true)
    expect(paths.some((p) => p === 'Report > Finance > Revenue')).toBe(true)
    // h2 "Hiring" pops Revenue AND Finance before pushing itself.
    expect(paths.some((p) => p === 'Report > Hiring')).toBe(true)
    expect(paths.some((p) => p.includes('Revenue > Hiring'))).toBe(false)
  })

  it('a heading change is a soft break: the heading starts the next segment', () => {
    const text = ['# One', para('Alpha section text.', 30), '# Two', para('Beta section text.', 30)].join('\n\n')
    const { segments } = chunkFileText(text)
    expectExactSlices(text, segments)
    const second = segments.find((s) => s.headingPath.join('') === 'Two')
    expect(second).toBeDefined()
    expect(second!.content.startsWith('# Two')).toBe(true)
  })

  it('keeps fenced code atomic across blank lines and never sentence-splits it', () => {
    const code = '```ts\nconst a = 1\n\n\nconst b = 2. and this? is! not a sentence\n```'
    const text = `Intro paragraph.\n\n${code}\n\nOutro paragraph.`
    const { segments } = chunkFileText(text)
    expectExactSlices(text, segments)
    // The fence body (including its interior blank lines) stays in one segment.
    const withCode = segments.find((s) => s.content.includes('const a = 1'))
    expect(withCode).toBeDefined()
    expect(withCode!.content).toContain('const b = 2')
  })

  it('an over-long fence hard-splits on line boundaries, not sentences', () => {
    const lines = Array.from({ length: 120 }, (_, i) => `const line_${i} = 'x'.repeat(10) // filler comment`)
    const text = '```js\n' + lines.join('\n') + '\n```'
    const { segments } = chunkFileText(text)
    expectExactSlices(text, segments)
    expect(segments.length).toBeGreaterThan(1)
    // Line-boundary cuts: no segment starts mid-line (every non-first segment
    // begins exactly where a line begins).
    for (const s of segments.slice(1)) {
      expect(text.replace(/\r\n/g, '\n')[s.charStart - 1]).toBe('\n')
    }
  })

  it('splits an over-long CJK paragraph at fullwidth sentence boundaries', () => {
    const sentence = '這是一句相當長的中文句子，用來測試分段器是否理解全形標點。'
    const text = Array.from({ length: 60 }, () => sentence).join('')
    const { segments } = chunkFileText(text)
    expectExactSlices(text, segments)
    expect(segments.length).toBeGreaterThan(1)
    // Every cut lands after a fullwidth terminator, not mid-sentence.
    for (const s of segments.slice(0, -1)) {
      expect(s.content.endsWith('。')).toBe(true)
    }
  })

  it('respects TARGET/MAX bounds and merges a tiny tail backward', () => {
    const body = Array.from({ length: 12 }, (_, i) => para(`Paragraph ${i} sentence.`, 20)).join('\n\n')
    const text = body + '\n\nTiny tail.'
    const { segments } = chunkFileText(text)
    expectExactSlices(text, segments)
    for (const s of segments) {
      expect(s.content.length).toBeLessThanOrEqual(1500 + 200) // MAX + merged-tail slack
    }
    // The tiny tail merged into its predecessor rather than standing alone.
    expect(segments[segments.length - 1].content).toContain('Tiny tail.')
    expect(segments[segments.length - 1].content.length).toBeGreaterThanOrEqual(200)
  })

  it('segment indexes are dense and monotonic', () => {
    const text = Array.from({ length: 30 }, (_, i) => para(`Block ${i} text.`, 25)).join('\n\n')
    const { segments } = chunkFileText(text)
    segments.forEach((s, i) => expect(s.segmentIndex).toBe(i))
  })

  it(`stops at MAX_SEGMENTS_PER_FILE (${MAX_SEGMENTS_PER_FILE}) and reports the truncation offset`, () => {
    // ~1300 chars per paragraph → one segment each → cap + margin paragraphs.
    const p = para('Filler sentence for cap test.', 44)
    const text = Array.from({ length: MAX_SEGMENTS_PER_FILE + 40 }, () => p).join('\n\n')
    const { segments, truncatedAtChar } = chunkFileText(text)
    expect(segments.length).toBeLessThanOrEqual(MAX_SEGMENTS_PER_FILE)
    expect(truncatedAtChar).not.toBeNull()
    expect(truncatedAtChar!).toBeGreaterThan(0)
    expectExactSlices(text, segments)
  })
})
