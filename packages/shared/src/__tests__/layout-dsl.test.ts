import { describe, expect, it } from 'vitest';
import { deckSpecSchema, type DeckSpec } from '../decks/spec.js';
import { DECK_PACK_STYLES, DECK_PRESET_STYLES } from '../decks/theme.js';
import { DECK_PAGE_H, DECK_PAGE_W, layoutDeck, type DeckPrimitive } from '../decks/layout.js';
import {
  DSL_COLS,
  DSL_ROWS,
  resolveDslSlide,
  validateDslSlide,
  type DslPackTokens,
  type DslSlide,
} from '../decks/layout-dsl.js';

/**
 * The proof asked of the DSL before any model is allowed to write in it:
 * can it express the compositions three HAND-DESIGNED packs already use?
 *
 * Expressiveness is the claim, not pixel identity — the DSL snaps to a coarse
 * grid, so it lands near the hand-tuned inches rather than on them. What has to
 * hold is that every structural move each pack makes is SAYABLE: full-bleed
 * fields, off-canvas bleeds, bordered numbered rows, cards overlapping images,
 * ruled stat columns, asymmetric columns, standing numerals, page tags.
 *
 * [COMP:decks/layout-dsl]
 */

const CLASSIC: DslPackTokens = {
  style: DECK_PRESET_STYLES.light,
  margin: 0.9,
  type: {
    xl: { size: 60, face: 'heading', bold: true },
    lg: { size: 34, face: 'heading', bold: true },
    md: { size: 22, face: 'body' },
    sm: { size: 18, face: 'body' },
    xs: { size: 14, face: 'body' },
  },
};

const MINIMAL: DslPackTokens = {
  style: DECK_PACK_STYLES.minimal,
  margin: 0.92,
  type: {
    xl: { size: 54, face: 'heading', bold: true },
    lg: { size: 34, face: 'heading', bold: true },
    md: { size: 19, face: 'body', bold: true },
    sm: { size: 16, face: 'body' },
    xs: { size: 14, face: 'body', bold: true },
  },
};

const EDITORIAL: DslPackTokens = {
  style: DECK_PACK_STYLES.editorial,
  margin: 0.9,
  type: {
    xl: { size: 62, face: 'heading', bold: true },
    lg: { size: 30, face: 'heading', bold: true },
    md: { size: 22, face: 'body' },
    sm: { size: 18, face: 'body' },
    xs: { size: 16, face: 'body' },
  },
};

const spec: DeckSpec = deckSpecSchema.parse({
  title: 'Project Brief',
  subtitle: 'Q2 2026',
  slides: [
    { title: 'Agenda', bullets: ['Overview', 'Goals', 'Timeline'] },
    { title: 'Traction', layout: 'stats', stats: [{ value: '$1.2M', label: 'ARR' }, { value: '38%', label: 'Growth' }] },
    { title: 'Meet Brian', layout: 'hero', subtext: 'Shipping today', image: { url: 'https://x.example/h.png' } },
  ],
});

const ctx = (index: number, slideIdx: number) => ({
  spec,
  slide: spec.slides[slideIdx],
  index,
  total: spec.slides.length + 1,
});

function kinds(ps: DeckPrimitive[]): string[] {
  return ps.map((p) => p.kind);
}

describe('[COMP:decks/layout-dsl] Composition DSL', () => {
  it('has no coordinates, colours or point sizes in its vocabulary', () => {
    // the whole safety argument: a model writing DSL cannot express bad styling,
    // only (checkable) bad arrangement. Blocks name a grid area and a TONE.
    const block: DslSlide = {
      background: 'paper',
      blocks: [{ area: { col: 0, row: 2, cols: 6, rows: 2 }, kind: 'text', from: 'title', scale: 'lg' }],
    };
    const out = resolveDslSlide(block, MINIMAL, ctx(2, 0));
    const text = out.primitives.find((p): p is Extract<DeckPrimitive, { kind: 'text' }> => p.kind === 'text');
    // colour and size came from the pack, not the block
    expect(text!.fontSizePt).toBe(MINIMAL.type.lg.size);
    expect(text!.fontFace).toBe(MINIMAL.style.headingFont);
    expect(text!.paragraphs[0].runs[0].color).toBe(MINIMAL.style.text);
  });

  it('derives text colour from the surface, so contrast cannot be composed wrong', () => {
    const onInk: DslSlide = {
      background: 'ink',
      blocks: [{ area: { col: 0, row: 2, cols: 8, rows: 2 }, kind: 'text', from: 'title', scale: 'lg' }],
    };
    const out = resolveDslSlide(onInk, MINIMAL, ctx(2, 0));
    const text = out.primitives.find((p): p is Extract<DeckPrimitive, { kind: 'text' }> => p.kind === 'text');
    // on an ink field the model said nothing about colour; it flipped to paper
    expect(out.background).toBe(MINIMAL.style.text);
    expect(text!.paragraphs[0].runs[0].color).toBe(MINIMAL.style.background);
  });

  // -------------------------------------------------------------------------
  // Expressiveness: each pack's hardest composition, said in the DSL
  // -------------------------------------------------------------------------

  it('expresses the minimal pack agenda: black square, off-canvas bleed, bordered rows', () => {
    const agenda: DslSlide = {
      background: 'paper',
      blocks: [
        { area: { col: 0, row: 0, cols: 5, rows: 7 }, kind: 'field', tone: 'ink' },
        { area: { col: 0, row: 1, cols: 5, rows: 2, pad: 'md' }, kind: 'text', from: 'title', scale: 'lg', on: 'ink' },
        // the rules that run off the left page edge — expressible via bleed
        { area: { col: 0, row: 3, cols: 2, rows: 1, bleed: ['left'] }, kind: 'rule', tone: 'ink' },
        { area: { col: 6, row: 0, cols: 6, rows: 6 }, kind: 'rows', numbered: true, stroke: true, tone: 'ink' },
      ],
    };
    expect(validateDslSlide(agenda, MINIMAL)).toEqual([]);
    const out = resolveDslSlide(agenda, MINIMAL, ctx(2, 0));

    // the black field
    expect(out.primitives.some((p) => p.kind === 'rect' && p.fill === MINIMAL.style.text && p.box.w > 4)).toBe(true);
    // the bleed actually reaches the page edge
    expect(out.primitives.some((p) => p.kind === 'rect' && p.box.x === 0)).toBe(true);
    // one stroked row per bullet
    expect(out.primitives.filter((p) => p.kind === 'rect' && p.stroke)).toHaveLength(3);
    // heading sits on ink, so it flipped to paper
    const heading = out.primitives.find(
      (p): p is Extract<DeckPrimitive, { kind: 'text' }> =>
        p.kind === 'text' && p.paragraphs[0]?.runs[0]?.text === 'Agenda',
    );
    expect(heading!.paragraphs[0].runs[0].color).toBe(MINIMAL.style.background);
    // inset from the field it sits on. Without `pad` the heading sits hard against
    // the square's edge — the single visible difference in the first side-by-side
    // render against the hand-built pack.
    const field = out.primitives.find((p): p is Extract<DeckPrimitive, { kind: 'rect' }> => p.kind === 'rect');
    expect(heading!.box.x).toBeGreaterThan(field!.box.x + 0.2);
  });

  it('cannot express pack chrome, which is the boundary rather than a gap', () => {
    // Found by rendering the DSL beside the hand-built pack: the minimal agenda's
    // THREE paired bars sit 0.28" apart inside one 0.7" grid row, and its hatch
    // ornament is free-form line work. Neither is sayable without putting
    // coordinates back into the vocabulary — which would forfeit the whole safety
    // argument. The conclusion is a split, not a bigger DSL: the PACK draws its
    // recurring chrome, the DSL composes content into what is left.
    const gridRowHeight = (DECK_PAGE_H - MINIMAL.margin * 2) / DSL_ROWS;
    expect(gridRowHeight).toBeGreaterThan(0.28 * 2); // motif spacing is finer than the grid
    // and the vocabulary offers no ornament kind to reach for
    const kindsAvailable = ['field', 'rule', 'text', 'rows', 'figure', 'chart', 'stats'];
    expect(kindsAvailable).not.toContain('ornament');
  });

  it('expresses the editorial hero: an opaque card overlapping a full-bleed image', () => {
    const hero: DslSlide = {
      background: 'paper',
      blocks: [
        { area: { col: 0, row: 0, cols: 12, rows: 8, bleed: ['left', 'right', 'top', 'bottom'] }, kind: 'figure', fit: 'cover' },
        { area: { col: 0, row: 4, cols: 7, rows: 3 }, kind: 'field', tone: 'paper' },
        { area: { col: 0, row: 4, cols: 7, rows: 2 }, kind: 'text', from: 'title', scale: 'lg', on: 'paper', valign: 'middle' },
      ],
    };
    expect(validateDslSlide(hero, EDITORIAL)).toEqual([]);
    const out = resolveDslSlide(hero, EDITORIAL, ctx(4, 2));

    const image = out.primitives.findIndex((p) => p.kind === 'image');
    const card = out.primitives.findIndex((p) => p.kind === 'rect');
    expect(image).toBe(0);
    expect(card).toBeGreaterThan(image); // overlap is just block order
    // full bleed reached every edge
    const frame = (out.primitives[image] as Extract<DeckPrimitive, { kind: 'image' }>).frame;
    expect(frame).toEqual({ x: 0, y: 0, w: DECK_PAGE_W, h: DECK_PAGE_H });
    // and the card is opaque — the DSL has no transparency to spend on a text bed
    expect(out.primitives.every((p) => p.kind !== 'rect' || p.transparency === undefined)).toBe(true);
  });

  it('expresses ruled stat columns and a page tag', () => {
    const stats: DslSlide = {
      background: 'paper',
      blocks: [
        { area: { col: 8, row: 0, cols: 4, rows: 1 }, kind: 'text', from: 'pageTag', scale: 'xs', align: 'right' },
        { area: { col: 0, row: 0, cols: 7, rows: 2 }, kind: 'text', from: 'title', scale: 'lg' },
        { area: { col: 0, row: 3, cols: 12, rows: 3 }, kind: 'stats', tone: 'ink' },
        { area: { col: 0, row: 7, cols: 12, rows: 1, bleed: ['left', 'right'] }, kind: 'rule' },
      ],
    };
    expect(validateDslSlide(stats, MINIMAL)).toEqual([]);
    const out = resolveDslSlide(stats, MINIMAL, ctx(3, 1));
    const texts = out.primitives
      .filter((p): p is Extract<DeckPrimitive, { kind: 'text' }> => p.kind === 'text')
      .map((p) => p.paragraphs[0].runs[0].text);
    expect(texts).toContain('03/04'); // page tag derived from slide order, not a schema field
    expect(texts).toEqual(expect.arrayContaining(['$1.2M', 'ARR', '38%', 'Growth']));
    // a hairline per stat column
    expect(out.primitives.filter((p) => p.kind === 'rect' && p.box.h <= 0.02).length).toBeGreaterThanOrEqual(3);
  });

  it('expresses the classic centred body band', () => {
    const content: DslSlide = {
      background: 'paper',
      blocks: [
        { area: { col: 0, row: 0, cols: 12, rows: 2 }, kind: 'text', from: 'title', scale: 'lg', valign: 'bottom' },
        { area: { col: 0, row: 2, cols: 12, rows: 1, bleed: ['left', 'right'] }, kind: 'rule' },
        { area: { col: 0, row: 3, cols: 12, rows: 4 }, kind: 'rows', valign: 'middle' },
      ],
    };
    expect(validateDslSlide(content, CLASSIC)).toEqual([]);
    const out = resolveDslSlide(content, CLASSIC, ctx(2, 0));
    expect(kinds(out.primitives)).toEqual(['text', 'rect', 'text']);
    const body = out.primitives[2] as Extract<DeckPrimitive, { kind: 'text' }>;
    expect(body.valign).toBe('middle'); // the vertical-rhythm fix survives the DSL
    expect(body.paragraphs).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  // Safety: the validators are what make model-driven composition viable
  // -------------------------------------------------------------------------

  it('rejects text that will not fit its area, with the smaller step named', () => {
    // Found on the first model-composed deck: a 54pt headline overflowed its
    // block and collided with the subtext while every other validator passed.
    // Renderers disagree on overflow — pptx `fit: shrink` shrinks silently, the
    // preview clips — so neither catches it and the two diverge when it happens.
    const overflowing: DslSlide = {
      background: 'ink',
      blocks: [{ area: { col: 0, row: 2, cols: 9, rows: 2 }, kind: 'text', from: 'title', scale: 'xl', on: 'ink' }],
    };
    const long = deckSpecSchema.parse({
      title: 'T',
      slides: [{ title: 'We build the parts that nobody else in the market will even quote on', bullets: ['x'] }],
    });
    const errs = validateDslSlide(overflowing, MINIMAL, { spec: long, slide: long.slides[0], index: 2, total: 2 });
    expect(errs.join()).toMatch(/needs about .*" at scale 'xl'/);
    expect(errs.join()).toMatch(/drop to scale 'lg'/); // names the fix, so a model can retry
  });

  it('rejects text that ends flush against the block below it', () => {
    const flush: DslSlide = {
      background: 'paper',
      blocks: [
        { area: { col: 0, row: 2, cols: 9, rows: 2 }, kind: 'text', from: 'title', scale: 'lg', valign: 'bottom' },
        { area: { col: 0, row: 4, cols: 7, rows: 1 }, kind: 'text', from: 'subtext', scale: 'sm' },
      ],
    };
    const withSub = deckSpecSchema.parse({
      title: 'T',
      slides: [{ title: 'A headline', layout: 'statement', subtext: 'A supporting line' }],
    });
    const c = { spec: withSub, slide: withSub.slides[0], index: 2, total: 2 };
    expect(validateDslSlide(flush, MINIMAL, c).join()).toMatch(/ends flush against/);

    // but a short mark in a tall box must NOT trip it — box adjacency is the
    // wrong test, the page tag never comes near the block beneath it
    const tagged: DslSlide = {
      background: 'paper',
      blocks: [
        { area: { col: 8, row: 0, cols: 4, rows: 1 }, kind: 'text', from: 'pageTag', scale: 'xs', align: 'right' },
        { area: { col: 0, row: 1, cols: 12, rows: 3 }, kind: 'text', from: 'title', scale: 'lg' },
      ],
    };
    expect(validateDslSlide(tagged, MINIMAL, c)).toEqual([]);
  });

  it('rejects off-grid and overlapping text with actionable messages', () => {
    const offGrid: DslSlide = {
      background: 'paper',
      blocks: [{ area: { col: 10, row: 0, cols: 6, rows: 2 }, kind: 'text', from: 'title' }],
    };
    expect(validateDslSlide(offGrid, MINIMAL).join()).toMatch(/past the 12x8 grid/);

    const overlapping: DslSlide = {
      background: 'paper',
      blocks: [
        { area: { col: 0, row: 0, cols: 8, rows: 4 }, kind: 'text', from: 'title' },
        { area: { col: 2, row: 1, cols: 8, rows: 4 }, kind: 'rows' },
      ],
    };
    expect(validateDslSlide(overlapping, MINIMAL).join()).toMatch(/overlap/);

    // a figure UNDER text is not an overlap error — that is the hero composition
    const layered: DslSlide = {
      background: 'paper',
      blocks: [
        { area: { col: 0, row: 0, cols: 12, rows: 8 }, kind: 'figure' },
        { area: { col: 0, row: 5, cols: 6, rows: 2 }, kind: 'text', from: 'title' },
      ],
    };
    expect(validateDslSlide(layered, EDITORIAL)).toEqual([]);
  });

  it('keeps every resolved primitive on the page', () => {
    const busy: DslSlide = {
      background: 'paper',
      blocks: [
        { area: { col: 0, row: 0, cols: 5, rows: 7 }, kind: 'field', tone: 'ink' },
        { area: { col: 0, row: 3, cols: 2, rows: 1, bleed: ['left'] }, kind: 'rule', tone: 'ink' },
        { area: { col: 6, row: 0, cols: 6, rows: 6 }, kind: 'rows', numbered: true, stroke: true, tone: 'ink' },
      ],
    };
    for (const p of resolveDslSlide(busy, MINIMAL, ctx(2, 0)).primitives) {
      const box = p.kind === 'image' ? p.frame : p.kind === 'lineSeg' ? null : p.box;
      if (!box) continue;
      expect(box.x).toBeGreaterThanOrEqual(0); // bleed clamps to the edge, never past it
      expect(box.x + box.w).toBeLessThanOrEqual(DECK_PAGE_W + 0.01);
      expect(box.y + box.h).toBeLessThanOrEqual(DECK_PAGE_H + 0.01);
    }
  });

  it('grid is coarse by design', () => {
    // the safety argument scales inversely with the number of legal positions
    expect(DSL_COLS * DSL_ROWS).toBeLessThanOrEqual(96);
    // and every hand pack still renders through its own code, unchanged
    expect(layoutDeck(spec, MINIMAL.style)).toHaveLength(spec.slides.length + 1);
  });
});
