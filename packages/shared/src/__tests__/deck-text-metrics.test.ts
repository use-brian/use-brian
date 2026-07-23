import { describe, expect, it } from 'vitest';
import { TEXT_INSET, fitOneLine, widthInEm } from '../decks/text-metrics.js';
import { TYPE } from '../decks/layout.js';

/**
 * Ported from sidanclaw-pptx-mcp test/text-metrics.test.ts. One deliberate
 * difference: fitOneLine subtracts TEXT_INSET itself, so these pass the full
 * tile width rather than the pre-inset width the connector's callers computed.
 */
describe('[COMP:decks/text-metrics] widthInEm', () => {
  it("counts Georgia's proportional figures individually", () => {
    // The bug this module exists for: a flat ~0.5 factor makes "47,000" 3.0em,
    // when Georgia Bold actually sets it at 3.63em — 21% wider than assumed.
    expect(widthInEm('47,000', 'Georgia')).toBeCloseTo(3.634, 3);
    expect(widthInEm('1', 'Georgia')).toBeLessThan(widthInEm('0', 'Georgia'));
    // Arial's figures are tabular, so every digit is the same width.
    expect(widthInEm('111', 'Arial')).toBeCloseTo(widthInEm('000', 'Arial'), 5);
  });

  it('charges unknown characters the widest capital rather than under-counting', () => {
    const known = widthInEm('12', 'Georgia');
    expect(widthInEm('12h', 'Georgia')).toBeCloseTo(known + 1.126, 3);
  });

  it('falls back to Arial metrics for an unknown face', () => {
    // A style extracted from a reference .pptx can name any installed font.
    expect(widthInEm('$1.5M', 'Comic Sans MS')).toBe(widthInEm('$1.5M', 'Arial'));
  });
});

describe('[COMP:decks/text-metrics] fitOneLine', () => {
  /** A tile in a four-up stats row: (11.53 - 0.4*3) / 4. */
  const TILE = 2.5825;
  const usable = TILE - 2 * TEXT_INSET;

  it('returns one size at which every string in the set fits', () => {
    const values = ['47,000', '$1.55M', '68%'];
    const size = fitOneLine(values, TILE, 'Georgia', TYPE.statValue, TYPE.statValueMin);
    for (const v of values) {
      expect((widthInEm(v, 'Georgia') * size) / 72, v).toBeLessThanOrEqual(usable);
    }
  });

  it('is driven by the widest member, not by each string on its own', () => {
    const size = fitOneLine(['47,000', '68%'], TILE, 'Georgia', TYPE.statValue, TYPE.statValueMin);
    expect(size).toBe(fitOneLine(['47,000'], TILE, 'Georgia', TYPE.statValue, TYPE.statValueMin));
    // "68%" alone would have taken the full display size; the row holds it back.
    expect(fitOneLine(['68%'], TILE, 'Georgia', TYPE.statValue, TYPE.statValueMin)).toBe(TYPE.statValue);
    expect(size).toBeLessThan(TYPE.statValue);
  });

  it('subtracts the OOXML text inset the caller cannot see', () => {
    // pptxgenjs never sets lIns/rIns, so the box keeps 0.1in each side. Sizing
    // against the raw width would overflow by 0.2in.
    expect(fitOneLine(['47,000'], TILE, 'Georgia', TYPE.statValue, 1)).toBeLessThan(
      Math.floor((TILE * 72) / widthInEm('47,000', 'Georgia')),
    );
  });

  it('never exceeds the display maximum, however short the text', () => {
    expect(fitOneLine(['7'], 20, 'Georgia', TYPE.statValue, TYPE.statValueMin)).toBe(TYPE.statValue);
  });

  it('clamps at the minimum instead of vanishing', () => {
    expect(fitOneLine(['%%%%%%%%%%'], TILE, 'Georgia', TYPE.statValue, TYPE.statValueMin)).toBe(TYPE.statValueMin);
  });

  it('holds the schema-capped worst case above the clamp for a realistic value', () => {
    // 9 chars, the longest a formatted currency stat plausibly gets.
    expect(fitOneLine(['€1,234.5M'], TILE, 'Georgia', TYPE.statValue, TYPE.statValueMin)).toBeGreaterThan(
      TYPE.statValueMin,
    );
  });
});
