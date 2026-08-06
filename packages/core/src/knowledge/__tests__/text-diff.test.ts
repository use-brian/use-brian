import { describe, it, expect } from 'vitest'
import { unifiedDiffLines } from '../text-diff.js'

describe('[COMP:knowledge/text-diff] unifiedDiffLines', () => {
  it('returns an empty array for identical texts', () => {
    const text = '# Title\n\nBody line one.\nBody line two.\n'
    expect(unifiedDiffLines(text, text)).toEqual([])
  })

  it('treats a trailing-newline difference as no change', () => {
    expect(unifiedDiffLines('a\nb', 'a\nb\n')).toEqual([])
  })

  it('renders a single-line change as one hunk with context', () => {
    const oldText = 'line 1\nline 2\nline 3\nline 4\nline 5\n'
    const newText = 'line 1\nline 2\nline THREE\nline 4\nline 5\n'
    const diff = unifiedDiffLines(oldText, newText)
    expect(diff[0]).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/)
    expect(diff).toContain('- line 3')
    expect(diff).toContain('+ line THREE')
    // Context rides along (2 lines each side by default).
    expect(diff).toContain('  line 2')
    expect(diff).toContain('  line 4')
  })

  it('renders a pure addition at the end', () => {
    const diff = unifiedDiffLines('a\nb\n', 'a\nb\nc\n')
    expect(diff).toContain('+ c')
    expect(diff).not.toContain('- a')
  })

  it('splits distant changes into separate hunks', () => {
    const oldLines = Array.from({ length: 30 }, (_, i) => `line ${i}`)
    const newLines = [...oldLines]
    newLines[2] = 'changed early'
    newLines[27] = 'changed late'
    const diff = unifiedDiffLines(oldLines.join('\n'), newLines.join('\n'))
    const hunks = diff.filter((l) => l.startsWith('@@'))
    expect(hunks).toHaveLength(2)
    expect(diff).toContain('+ changed early')
    expect(diff).toContain('+ changed late')
  })

  it('caps output at maxLines with an elision marker', () => {
    const oldText = Array.from({ length: 60 }, (_, i) => `old ${i}`).join('\n')
    const newText = Array.from({ length: 60 }, (_, i) => `new ${i}`).join('\n')
    const diff = unifiedDiffLines(oldText, newText, { maxLines: 10 })
    expect(diff).toHaveLength(11)
    expect(diff[10]).toMatch(/^… \(\d+ more diff lines\)$/)
  })

  it('degrades an oversized middle to a whole-block replacement instead of an LCS blowup', () => {
    const oldText = Array.from({ length: 500 }, (_, i) => `o${i}`).join('\n')
    const newText = Array.from({ length: 500 }, (_, i) => `n${i}`).join('\n')
    const diff = unifiedDiffLines(oldText, newText, { maxLines: 2000 })
    // Every old line deleted, every new line added — no interleaving.
    expect(diff.filter((l) => l.startsWith('- '))).toHaveLength(500)
    expect(diff.filter((l) => l.startsWith('+ '))).toHaveLength(500)
  })

  it('hunk headers carry 1-based line numbers anchored to the original texts', () => {
    const oldText = 'a\nb\nc\nd\ne\nf\ng\nh\n'
    const newText = 'a\nb\nc\nd\ne\nf\nG\nh\n'
    const diff = unifiedDiffLines(oldText, newText)
    // Change at line 7 with 2 lines of context → hunk starts at line 5.
    expect(diff[0]).toBe('@@ -5,4 +5,4 @@')
  })
})
