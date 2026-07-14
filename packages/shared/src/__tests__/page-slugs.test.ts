import { describe, expect, it } from 'vitest';
import {
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

    it('rejects our own product surfaces', () => {
      expect(normalizeHostname('app.sidan.ai')).toBeNull();
      expect(normalizeHostname('sidan.ai')).toBeNull();
      expect(normalizeHostname('anything.vercel.app')).toBeNull();
      expect(normalizeHostname('evil.localhost')).toBeNull();
    });
  });
});
