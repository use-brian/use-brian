import { describe, it, expect } from 'vitest'
import { parseMarkdownFile } from '../parser.js'

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
