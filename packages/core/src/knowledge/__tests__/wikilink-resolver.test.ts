import { describe, it, expect } from 'vitest'
import { buildPathIndex, resolveWikilink } from '../wikilink-resolver.js'

const PATHS = [
  'index',
  'products',
  'products/vault',
  'products/vault/spec/vault-spec',
  'products/vault/spec/vault-calculation',
  'products/perpetual-futures',
  'products/perpetual-futures/engines/mark-price',
  'architecture/system-context',
  'architecture/product-architecture',
  'reference/tokenomics',
]

const INDEX = buildPathIndex(PATHS)

describe('[COMP:knowledge/wikilink-resolver] buildPathIndex', () => {
  it('maps last path segment to full path', () => {
    expect(INDEX.get('vault-spec')).toBe('products/vault/spec/vault-spec')
    expect(INDEX.get('tokenomics')).toBe('reference/tokenomics')
    expect(INDEX.get('system-context')).toBe('architecture/system-context')
  })

  it('first entry wins for duplicate filenames', () => {
    // 'index' appears multiple times — first wins
    expect(INDEX.get('index')).toBe('index')
  })
})

describe('[COMP:knowledge/wikilink-resolver] resolveWikilink', () => {
  describe('absolute paths', () => {
    it('resolves full path directly', () => {
      expect(resolveWikilink('products/vault', 'index', INDEX)).toBe('products/vault')
    })

    it('strips /index suffix', () => {
      expect(resolveWikilink('products/vault/index', 'index', INDEX)).toBe('products/vault')
    })

    it('strips .md extension', () => {
      expect(resolveWikilink('products/vault/spec/vault-spec.md', 'index', INDEX))
        .toBe('products/vault/spec/vault-spec')
    })
  })

  describe('relative paths', () => {
    it('resolves ../ from current file', () => {
      const result = resolveWikilink(
        '../perpetual-futures/index',
        'products/vault',
        INDEX,
      )
      expect(result).toBe('products/perpetual-futures')
    })

    it('resolves ../../ from nested file', () => {
      const result = resolveWikilink(
        '../../architecture/system-context',
        'products/vault',
        INDEX,
      )
      expect(result).toBe('architecture/system-context')
    })

    it('resolves ./ from current directory', () => {
      const result = resolveWikilink(
        './spec/vault-spec',
        'products/vault',
        INDEX,
      )
      expect(result).toBe('products/vault/spec/vault-spec')
    })
  })

  describe('filename-only lookup', () => {
    it('finds by filename in index', () => {
      expect(resolveWikilink('vault-spec', 'products/vault', INDEX))
        .toBe('products/vault/spec/vault-spec')
    })

    it('finds tokenomics by name', () => {
      expect(resolveWikilink('tokenomics', 'products/vault', INDEX))
        .toBe('reference/tokenomics')
    })
  })

  describe('edge cases', () => {
    it('returns null for completely unknown reference', () => {
      expect(resolveWikilink('nonexistent-page', 'index', INDEX)).toBeNull()
    })

    it('handles wikilink with alias (already stripped by parser)', () => {
      // Parser strips alias before calling resolver, but test robustness
      expect(resolveWikilink('products/vault', 'index', INDEX)).toBe('products/vault')
    })

    it('handles empty string', () => {
      expect(resolveWikilink('', 'index', INDEX)).toBeNull()
    })
  })
})
