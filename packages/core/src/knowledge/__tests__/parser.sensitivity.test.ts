import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { parseMarkdownFile } from '../parser.js'

describe('[COMP:knowledge/parser] sensitivity frontmatter', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('extracts sensitivity=public from frontmatter', () => {
    const content = `---
title: Public FAQ
sensitivity: public
---

Body.`
    const entry = parseMarkdownFile('faq.md', content)
    expect(entry.sensitivity).toBe('public')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('extracts sensitivity=internal from frontmatter', () => {
    const content = `---
title: Team roadmap
sensitivity: internal
---

Body.`
    const entry = parseMarkdownFile('roadmap.md', content)
    expect(entry.sensitivity).toBe('internal')
  })

  it('extracts sensitivity=confidential from frontmatter', () => {
    const content = `---
title: Cap table
sensitivity: confidential
---

Body.`
    const entry = parseMarkdownFile('fundraising/cap-table.md', content)
    expect(entry.sensitivity).toBe('confidential')
  })

  it('defaults to internal when sensitivity is absent', () => {
    const content = `---
title: Some doc
description: A doc with no sensitivity specified.
---

Body.`
    const entry = parseMarkdownFile('some-doc.md', content)
    expect(entry.sensitivity).toBe('internal')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('defaults to internal and warns when sensitivity value is invalid', () => {
    const content = `---
title: Bad
sensitivity: top-secret
---

Body.`
    const entry = parseMarkdownFile('bad.md', content)
    expect(entry.sensitivity).toBe('internal')
    expect(warnSpy).toHaveBeenCalledOnce()
    expect(warnSpy.mock.calls[0][0]).toContain('invalid sensitivity')
    expect(warnSpy.mock.calls[0][0]).toContain('bad.md')
  })

  it('defaults to internal when there is no frontmatter at all', () => {
    const content = `# No frontmatter

Just a body.`
    const entry = parseMarkdownFile('no-fm.md', content)
    expect(entry.sensitivity).toBe('internal')
  })

  it('does not include sensitivity in metadata JSONB', () => {
    const content = `---
title: X
sensitivity: confidential
status: stable
owner: alice
---

Body.`
    const entry = parseMarkdownFile('x.md', content)
    expect(entry.metadata).toEqual({ status: 'stable', owner: 'alice' })
    expect(entry.metadata.sensitivity).toBeUndefined()
  })
})
