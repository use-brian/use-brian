import { describe, expect, it } from 'vitest';
import {
  deriveOwnApexBlocks,
  isValidPageSlug,
  normalizeHostname,
  PAGE_SLUG_MAX_LENGTH,
  RESERVED_PAGE_SLUGS,
  suggestPageSlug,
} from '../page-slugs.js';

describe('[COMP:doc/page-slug-helpers] Page slug + hostname helpers', () => {
  describe('isValidPageSlug', () => {
    it('accepts lowercase kebab slugs', () => {
      expect(isValidPageSlug('getting-started')).toBe(true);
      expect(isValidPageSlug('v2')).toBe(true);
      expect(isValidPageSlug('a')).toBe(true);
    });

    it('rejects bad shapes', () => {
      expect(isValidPageSlug('')).toBe(false);
      expect(isValidPageSlug('Getting-Started')).toBe(false);
      expect(isValidPageSlug('-lead')).toBe(false);
      expect(isValidPageSlug('trail-')).toBe(false);
      expect(isValidPageSlug('double--hyphen')).toBe(false);
      expect(isValidPageSlug('under_score')).toBe(false);
      expect(isValidPageSlug('dot.txt')).toBe(false);
      expect(isValidPageSlug('a'.repeat(PAGE_SLUG_MAX_LENGTH + 1))).toBe(false);
    });

    it('rejects every reserved slug', () => {
      for (const reserved of RESERVED_PAGE_SLUGS) {
        expect(isValidPageSlug(reserved)).toBe(false);
      }
    });
  });

  describe('suggestPageSlug', () => {
    it('kebab-cases titles', () => {
      expect(suggestPageSlug('Getting Started!')).toBe('getting-started');
      expect(suggestPageSlug('  Q3 / OKRs — draft ')).toBe('q3-okrs-draft');
    });

    it('falls back to "page" when nothing survives (CJK-only titles)', () => {
      expect(suggestPageSlug('製品ロードマップ')).toBe('page');
      expect(suggestPageSlug('')).toBe('page');
    });

    it('never suggests a reserved slug', () => {
      expect(suggestPageSlug('API')).toBe('api-page');
      expect(isValidPageSlug(suggestPageSlug('Login'))).toBe(true);
    });

    it('de-dupes against taken slugs with numeric suffixes', () => {
      const taken = new Set(['guide', 'guide-2']);
      expect(suggestPageSlug('Guide', taken)).toBe('guide-3');
    });

    it('keeps suffixed suggestions within the max length', () => {
      const long = 'x'.repeat(PAGE_SLUG_MAX_LENGTH);
      const taken = new Set([long]);
      const next = suggestPageSlug(long, taken);
      expect(next.length).toBeLessThanOrEqual(PAGE_SLUG_MAX_LENGTH);
      expect(next.endsWith('-2')).toBe(true);
    });
  });

  describe('normalizeHostname', () => {
    it('normalizes case, protocol, and paths away', () => {
      expect(normalizeHostname('https://Docs.Acme.com/some/path')).toBe('docs.acme.com');
      expect(normalizeHostname('  docs.acme.com  ')).toBe('docs.acme.com');
    });

    it('punycodes IDN input', () => {
      expect(normalizeHostname('ドキュメント.acme.com')).toBe('xn--nckucb1hta9f.acme.com');
    });

    it('rejects unusable hosts', () => {
      expect(normalizeHostname('')).toBeNull();
      expect(normalizeHostname('localhost')).toBeNull();
      expect(normalizeHostname('no-dots')).toBeNull();
      expect(normalizeHostname('192.168.0.1')).toBeNull();
      expect(normalizeHostname('has space.acme.com')).toBeNull();
    });

    it('always rejects non-routable hosts (universal, not policy)', () => {
      expect(normalizeHostname('evil.localhost')).toBeNull();
      expect(normalizeHostname('localhost')).toBeNull();
    });

    it('honors the config-provided blocklist: exact hosts and .suffix entries', () => {
      const block = ['app.example.com', '.example.io'];
      // exact entry blocks only that host
      expect(normalizeHostname('app.example.com', { block })).toBeNull();
      expect(normalizeHostname('page.example.com', { block })).toBe('page.example.com');
      // .suffix entry blocks the apex and every subdomain
      expect(normalizeHostname('example.io', { block })).toBeNull();
      expect(normalizeHostname('deep.sub.example.io', { block })).toBeNull();
      // suffix tricks don't match
      expect(normalizeHostname('notexample.io', { block })).toBe('notexample.io');
      // no blocklist -> any well-shaped public hostname is accepted
      expect(normalizeHostname('app.example.com')).toBe('app.example.com');
    });
  });

  describe('deriveOwnApexBlocks', () => {
    it('derives a `.apex` suffix from a 3-label origin host', () => {
      expect(deriveOwnApexBlocks(['app.usebrian.ai', 'api.usebrian.ai'])).toEqual([
        '.usebrian.ai',
      ]);
    });

    it('blocks the apex and every subdomain once derived', () => {
      const block = deriveOwnApexBlocks(['app.usebrian.ai']);
      // apex itself, a bare subdomain, and a deep subdomain are all blocked
      expect(normalizeHostname('usebrian.ai', { block })).toBeNull();
      expect(normalizeHostname('saas.usebrian.ai', { block })).toBeNull();
      expect(normalizeHostname('deep.saas.usebrian.ai', { block })).toBeNull();
      // a lookalike registrable domain is NOT blocked
      expect(normalizeHostname('notusebrian.ai', { block })).toBe('notusebrian.ai');
    });

    it('yields nothing for a 2-label apex origin (no bare-TLD block)', () => {
      expect(deriveOwnApexBlocks(['usebrian.ai'])).toEqual([]);
    });

    it('skips a parent that is a known public suffix (multi-part TLD safety)', () => {
      // app served directly at a registrable apex under a public suffix:
      // stripping a label would leave `co.uk`, which must never be blocked.
      expect(deriveOwnApexBlocks(['example.co.uk'])).toEqual([]);
      // but a real subdomain under it derives the registrable apex correctly
      expect(deriveOwnApexBlocks(['app.example.co.uk'])).toEqual(['.example.co.uk']);
    });
  });
});
