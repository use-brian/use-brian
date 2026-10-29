import { describe, it, expect } from 'vitest'
import { parseMarkdownFile } from '../parser.js'
import { parseMarkdownFile as parsePublicMarkdownFile, parseYamlSubset, readFrontmatter } from '@use-brian/brian-kb'

describe('[COMP:knowledge/parser] parseMarkdownFile', () => {
  describe('frontmatter parsing (Tier 1)', () => {
    it('extracts description, tags, related, and metadata from frontmatter', () => {
      const content = `---
description: "Vault — pooled investment vehicles."
tags: [index, product, vault]
related: [../perpetual-futures/index, ../../architecture/system-context]
status: current
last_reviewed: 2026-04-01
---

# Vault

Managed trading vaults.`

      const entry = parseMarkdownFile('products/vault/index.md', content)

      expect(entry.path).toBe('products/vault')
      expect(entry.title).toBe('Vault')
      expect(entry.summary).toBe('Vault — pooled investment vehicles.')
      expect(entry.tags).toEqual(['index', 'product', 'vault'])
      expect(entry.related).toContain('../perpetual-futures/index')
      expect(entry.related).toContain('../../architecture/system-context')
      expect(entry.metadata).toEqual({ status: 'current', last_reviewed: '2026-04-01' })
    })

    it('handles YAML list syntax for tags', () => {
      const content = `---
description: "Test"
tags:
  - alpha
  - beta
---

Content`

      const entry = parseMarkdownFile('test.md', content)
      expect(entry.tags).toEqual(['alpha', 'beta'])
    })

    it('uses frontmatter title when present', () => {
      const content = `---
title: Custom Title
---

# Heading Title

Body`

      const entry = parseMarkdownFile('file.md', content)
      expect(entry.title).toBe('Custom Title')
    })
  })

  describe('wikilink extraction', () => {
    it('extracts wikilinks from body', () => {
      const content = `---
description: "Root index"
tags: [index]
---

## Products

[[products/vault/index|Vault]] — description.
[[products/perpetual-futures/index|Perps]] — description.`

      const entry = parseMarkdownFile('index.md', content)
      expect(entry.related).toContain('products/vault/index')
      expect(entry.related).toContain('products/perpetual-futures/index')
    })

    it('strips alias from wikilinks', () => {
      const content = `See [[path/to/file|Display Name]] for details.`
      const entry = parseMarkdownFile('test.md', content)
      expect(entry.related).toContain('path/to/file')
    })
  })

  describe('standard markdown links', () => {
    it('extracts relative markdown links', () => {
      const content = `See [Vault Spec](./spec/vault-spec.md) for details.`
      const entry = parseMarkdownFile('products/vault/index.md', content)
      expect(entry.related).toContain('./spec/vault-spec')
    })

    it('ignores http links', () => {
      const content = `See [docs](https://example.com/docs.md) for details.`
      const entry = parseMarkdownFile('test.md', content)
      expect(entry.related).toHaveLength(0)
    })
  })

  describe('path normalization', () => {
    it('strips .md extension', () => {
      const entry = parseMarkdownFile('products/vault/fees.md', '# Fees')
      expect(entry.path).toBe('products/vault/fees')
    })

    it('collapses index.md to parent path', () => {
      const entry = parseMarkdownFile('products/vault/index.md', '# Vault')
      expect(entry.path).toBe('products/vault')
    })

    it('root index.md becomes "index"', () => {
      const entry = parseMarkdownFile('index.md', '# Root')
      expect(entry.path).toBe('index')
    })

    it('strips leading and trailing slashes', () => {
      const entry = parseMarkdownFile('/products/vault/', '# Vault')
      expect(entry.path).toBe('products/vault')
    })
  })

  describe('fallback title extraction (Tier 3)', () => {
    it('uses first heading when no frontmatter', () => {
      const entry = parseMarkdownFile('file.md', '# My Document\n\nSome content.')
      expect(entry.title).toBe('My Document')
    })

    it('falls back to filename when no heading', () => {
      const entry = parseMarkdownFile('my-cool-doc.md', 'Just some text.')
      expect(entry.title).toBe('My Cool Doc')
    })
  })

  describe('no frontmatter (Tier 3)', () => {
    it('returns empty tags, null summary, and empty metadata', () => {
      const entry = parseMarkdownFile('notes.md', '# Notes\n\nSome notes here.')
      expect(entry.summary).toBeNull()
      expect(entry.tags).toEqual([])
      expect(entry.metadata).toEqual({})
    })
  })
})

const lineEndings = [['LF', '\n'], ['CRLF', '\r\n']] as const

describe.each([['single', "'"], ['double', '"']] as const)(
  '[COMP:knowledge/parser] %s-quoted scalar strings', (_name, quote) => {
    it.each(lineEndings)('preserves %s scalar types through the actual public low-level parsers', (_ending, eol) => {
      const yaml = [
        `affirmative: ${quote}true${quote}`,
        `negative: ${quote}false${quote}`,
        `numeric: ${quote}123${quote}`,
        `reference: ${quote}001${quote}`,
        `empty: ${quote}${quote}`,
        `prose: ${quote}Quoted prose${quote}`,
        'enabled: true',
        'amount: 123',
      ].join(eol)
      const body = ['', '# Unchanged body', '', 'Literal text.', ''].join(eol)
      const expected = {
        affirmative: 'true', negative: 'false', numeric: '123', reference: '001',
        empty: '', prose: 'Quoted prose', enabled: true, amount: 123,
      }
      const scalarValues = parseYamlSubset(yaml)
      const frontmatter = readFrontmatter(`---${eol}${yaml}${eol}---${eol}${body}`)
      expect(frontmatter.body).toBe(body)
      expect(scalarValues).toEqual(expected)
      expect(frontmatter).toEqual({ frontmatter: expected, body, hasFrontmatter: true })
    })

    it.each(['true', 'false', '123', '001', '', 'Quoted prose'].flatMap(value =>
      lineEndings.map(([ending, eol]) => ({ value, ending, eol })),
    ))(
      '$ending retains "$value" as title, summary and metadata through public and compatibility parsers', ({ value, eol }) => {
        const body = ['# Fallback heading', '', 'Unchanged body.'].join(eol)
        const raw = [
          '---', `title: ${quote}${value}${quote}`, `description: ${quote}${value}${quote}`,
          `reference: ${quote}${value}${quote}`, 'enabled: true', 'amount: 7',
          'tags: [fixture, quoted]', 'sensitivity: internal', '---', '', body,
        ].join(eol)
        const filePath = '/notes/fixture/index.md'
        // Exercise both actual entrypoints before comparing their complete results.
        const publicEntry = parsePublicMarkdownFile(filePath, raw)
        const compatibilityEntry = parseMarkdownFile(filePath, raw)
        const expected = {
          path: 'notes/fixture', title: value, summary: value, content: body,
          tags: ['fixture', 'quoted'], related: [], sensitivity: 'internal', sensitivityExplicit: true,
          metadata: { reference: value, enabled: true, amount: 7 },
        }
        expect(publicEntry.content).toBe(body)
        expect(compatibilityEntry.content).toBe(body)
        expect(publicEntry).toEqual(expected)
        expect(compatibilityEntry).toEqual(expected)
        expect(typeof publicEntry.title).toBe('string')
        expect(typeof publicEntry.summary).toBe('string')
        expect(typeof publicEntry.metadata.reference).toBe('string')
      },
    )
  },
)

describe('[COMP:knowledge/parser] unquoted scalar compatibility', () => {
  it.each(lineEndings)('retains %s boolean and numeric inference with the existing typed parser fallbacks', (_ending, eol) => {
    const yaml = ['title: true', 'description: 123', 'reference: 001', 'enabled: false', 'amount: 7', 'tags: [fixture]', 'sensitivity: internal'].join(eol)
    const body = ['# Fallback heading', '', 'Unchanged body.'].join(eol)
    const raw = ['---', yaml, '---', body].join(eol)
    const scalarValues = parseYamlSubset(yaml)
    const frontmatter = readFrontmatter(raw)
    const publicEntry = parsePublicMarkdownFile('fixture.md', raw)
    const compatibilityEntry = parseMarkdownFile('fixture.md', raw)
    expect(scalarValues).toEqual({ title: true, description: 123, reference: 1, enabled: false, amount: 7, tags: ['fixture'], sensitivity: 'internal' })
    expect(frontmatter.frontmatter).toEqual(scalarValues)
    const expected = {
      path: 'fixture', title: 'Fallback heading', summary: null, content: body,
      tags: ['fixture'], related: [], sensitivity: 'internal', sensitivityExplicit: true,
      metadata: { reference: 1, enabled: false, amount: 7 },
    }
    expect(frontmatter.body).toBe(body)
    expect(publicEntry.content).toBe(body)
    expect(compatibilityEntry.content).toBe(body)
    expect(publicEntry).toEqual(expected)
    expect(compatibilityEntry).toEqual(expected)
  })
})
