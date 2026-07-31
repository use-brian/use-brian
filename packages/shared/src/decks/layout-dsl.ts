import type { DeckSlide, DeckSpec } from './spec.js';
import type { DeckStyle } from './theme.js';
import {
  DECK_PAGE_H,
  DECK_PAGE_W,
  bulletBlock,
  layoutChart,
  layoutImage,
  plainText,
  type DeckBox,
  type DeckPrimitive,
  type DeckSlideLayout,
} from './layout.js';

/**
 * Composition DSL — the vocabulary a model composes slides in.
 * Spec: docs/architecture/features/deck-generation.md → "Composition DSL".
 *
 * The split this exists to enforce: the model chooses COMPOSITION (which block
 * sits where), the pack chooses ART DIRECTION (palette, type scale, faces).
 * Blocks therefore address a coarse grid and a named tone — there are no
 * coordinates, colours or point sizes in the vocabulary, so the model cannot
 * get those wrong. A bad composition is reachable; bad styling is not.
 *
 * Status: proving. Not wired into layoutDeck — the packs still own their
 * compositions. The test suite re-expresses each pack here and checks the DSL
 * can reproduce it structurally; see [COMP:decks/layout-dsl].
 */

/** Coarse on purpose: fewer legal positions means fewer wrong ones. */
export const DSL_COLS = 12;
export const DSL_ROWS = 8;

export type DslTone = 'paper' | 'ink' | 'panel' | 'accent';
export type DslScale = 'xl' | 'lg' | 'md' | 'sm' | 'xs';

export type DslSource =
  | 'title'
  | 'subtitle'
  | 'subtext'
  | 'bullets'
  | 'stats'
  | 'quote'
  | 'attribution'
  | 'image'
  | 'chart'
  | 'index'
  | 'pageTag';

export type DslEdge = 'left' | 'right' | 'top' | 'bottom';

export interface DslArea {
  /** 0-based grid origin and span, inside the pack margin unless bled. */
  col: number;
  row: number;
  cols: number;
  rows: number;
  /** Extend to the page edge on these sides — how full-bleed fields and off-canvas rules are said. */
  bleed?: DslEdge[];
  /**
   * Inset from the grid area, as a NAMED step resolved from the pack — not a
   * number, so the model still cannot pick a measurement. Without this, text
   * laid over a field sits hard against its edge, which is the single thing
   * that separated the first DSL rendering from the hand-built pack.
   */
  pad?: 'sm' | 'md' | 'lg';
}

export interface DslBlock {
  area: DslArea;
  kind: 'field' | 'rule' | 'text' | 'rows' | 'figure' | 'chart' | 'stats';
  /** Fill for `field`/`rule`/`rows` borders. */
  tone?: DslTone;
  /** The surface this block sits on; drives text colour so contrast can't be chosen wrong. */
  on?: DslTone;
  from?: DslSource;
  scale?: DslScale;
  align?: 'left' | 'center' | 'right';
  valign?: 'top' | 'middle' | 'bottom';
  caps?: boolean;
  numbered?: boolean;
  stroke?: boolean;
  fit?: 'cover' | 'contain';
  /** Literal text, for marks that aren't in the spec (page tags render via `from`). */
  text?: string;
}

export interface DslTypeStep {
  size: number;
  face: 'heading' | 'body';
  bold?: boolean;
}

export interface DslPackTokens {
  style: DeckStyle;
  margin: number;
  /** Type scale. The model picks a STEP, never a size. */
  type: Record<DslScale, DslTypeStep>;
}

export interface DslSlideContext {
  slide?: DeckSlide;
  spec: DeckSpec;
  /** 1-based content-slide index, for numerals and page tags. */
  index: number;
  total: number;
}

/** A slide description: a background tone plus the blocks laid on it. */
export interface DslSlide {
  background: DslTone;
  blocks: DslBlock[];
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function toneColor(tone: DslTone | undefined, style: DeckStyle, fallback: string): string {
  switch (tone) {
    case 'paper':
      return style.background;
    case 'ink':
      return style.text;
    case 'panel':
      return style.panel;
    case 'accent':
      return style.accent;
    default:
      return fallback;
  }
}

/** Text colour is DERIVED from the surface, never chosen — contrast by construction. */
function textOn(tone: DslTone | undefined, style: DeckStyle): string {
  return tone === 'ink' || tone === 'accent' ? style.background : style.text;
}

function mutedOn(tone: DslTone | undefined, style: DeckStyle): string {
  return tone === 'ink' || tone === 'accent' ? style.background : style.muted;
}

export function dslAreaToBox(area: DslArea, margin: number): DeckBox {
  const innerW = DECK_PAGE_W - margin * 2;
  const innerH = DECK_PAGE_H - margin * 2;
  const cw = innerW / DSL_COLS;
  const rh = innerH / DSL_ROWS;
  let x = margin + area.col * cw;
  let y = margin + area.row * rh;
  let w = area.cols * cw;
  let h = area.rows * rh;
  for (const edge of area.bleed ?? []) {
    if (edge === 'left') {
      w += x;
      x = 0;
    }
    if (edge === 'right') w = DECK_PAGE_W - x;
    if (edge === 'top') {
      h += y;
      y = 0;
    }
    if (edge === 'bottom') h = DECK_PAGE_H - y;
  }
  if (area.pad) {
    const p = margin * (area.pad === 'sm' ? 0.2 : area.pad === 'md' ? 0.37 : 0.65);
    x += p;
    y += p;
    w -= p * 2;
    h -= p * 2;
  }
  return { x, y, w, h };
}

function sourceText(from: DslSource | undefined, ctx: DslSlideContext): string | undefined {
  const { slide, spec, index, total } = ctx;
  switch (from) {
    case 'title':
      return slide?.title ?? spec.title;
    case 'subtitle':
      return spec.subtitle;
    case 'subtext':
      return slide?.subtext;
    case 'quote':
      return slide?.quote?.text;
    case 'attribution':
      return slide?.quote?.attribution;
    case 'index':
      return String(index).padStart(2, '0');
    case 'pageTag':
      return `${String(index).padStart(2, '0')}/${String(total).padStart(2, '0')}`;
    default:
      return undefined;
  }
}

/** Resolves one DSL slide to the primitive display list both renderers consume. */
export function resolveDslSlide(
  dsl: DslSlide,
  tokens: DslPackTokens,
  ctx: DslSlideContext,
): DeckSlideLayout {
  const { style, margin, type } = tokens;
  const primitives: DeckPrimitive[] = [];

  for (const block of dsl.blocks) {
    const box = dslAreaToBox(block.area, margin);
    const on = block.on ?? dsl.background;
    const step = type[block.scale ?? 'md'];
    const face = step.face === 'heading' ? style.headingFont : style.bodyFont;

    switch (block.kind) {
      case 'field':
        primitives.push({ kind: 'rect', box, fill: toneColor(block.tone, style, style.panel) });
        break;

      case 'rule':
        primitives.push({
          kind: 'rect',
          box: { ...box, h: Math.min(box.h, 0.02) },
          fill: toneColor(block.tone, style, style.grid),
        });
        break;

      case 'text': {
        const raw = block.text ?? sourceText(block.from, ctx);
        if (!raw) break;
        const isMuted = block.from === 'subtitle' || block.from === 'subtext' || block.from === 'attribution';
        primitives.push(
          plainText(block.caps ? raw.toUpperCase() : raw, isMuted ? mutedOn(on, style) : textOn(on, style), box, {
            fontFace: face,
            fontSizePt: step.size,
            bold: step.bold,
            align: block.align ?? 'left',
            valign: block.valign ?? 'top',
            shrinkToFit: true,
          }),
        );
        break;
      }

      case 'rows': {
        const items = ctx.slide?.bullets ?? [];
        if (!items.length) break;
        if (!block.numbered && !block.stroke) {
          primitives.push(bulletBlock(style, items, box, step.size, block.valign === 'top' ? 'top' : 'middle'));
          break;
        }
        // bordered / numbered row set — the minimal pack's table
        const rowH = Math.min(0.66, box.h / Math.max(items.length, 1));
        const numW = 0.92;
        items.forEach((text, i) => {
          const y = box.y + i * rowH;
          if (block.stroke) {
            primitives.push(
              {
                kind: 'rect',
                box: { x: box.x, y, w: box.w, h: rowH },
                fill: toneColor(on, style, style.background),
                stroke: { color: toneColor(block.tone, style, style.text), widthPt: 1 },
              },
              { kind: 'rect', box: { x: box.x + numW, y, w: 0.012, h: rowH }, fill: toneColor(block.tone, style, style.text) },
            );
          }
          if (block.numbered) {
            primitives.push(
              plainText(String(i + 1).padStart(2, '0'), textOn(on, style), { x: box.x + 0.18, y, w: numW, h: rowH }, {
                fontFace: style.bodyFont,
                fontSizePt: step.size,
                bold: true,
                valign: 'middle',
              }),
            );
          }
          primitives.push(
            plainText(
              text,
              textOn(on, style),
              { x: box.x + (block.numbered ? numW + 0.26 : 0), y, w: box.w - (block.numbered ? numW + 0.44 : 0), h: rowH },
              { fontFace: style.bodyFont, fontSizePt: step.size, bold: true, valign: 'middle', shrinkToFit: true },
            ),
          );
        });
        break;
      }

      case 'figure': {
        const image = ctx.slide?.image;
        if (!image) break;
        primitives.push({ kind: 'image', frame: box, fit: block.fit ?? 'cover', source: { url: image.url, path: image.path } });
        break;
      }

      case 'chart': {
        const chart = ctx.slide?.chart;
        if (chart) primitives.push(...layoutChart(chart, style, box));
        break;
      }

      case 'stats': {
        const stats = ctx.slide?.stats ?? [];
        if (!stats.length) break;
        const gap = 0.5;
        const colW = (box.w - gap * (stats.length - 1)) / stats.length;
        stats.forEach((stat, i) => {
          const x = box.x + i * (colW + gap);
          primitives.push(
            { kind: 'rect', box: { x, y: box.y, w: colW, h: 0.02 }, fill: toneColor(block.tone, style, style.text) },
            plainText(stat.value, textOn(on, style), { x, y: box.y + 0.4, w: colW, h: 1.3 }, {
              fontFace: style.headingFont,
              fontSizePt: type.xl.size,
              bold: true,
              align: block.align ?? 'center',
              shrinkToFit: true,
            }),
            plainText(stat.label, mutedOn(on, style), { x, y: box.y + 1.8, w: colW, h: 0.6 }, {
              fontFace: style.bodyFont,
              fontSizePt: type.xs.size,
              bold: true,
              align: block.align ?? 'center',
            }),
          );
        });
        break;
      }
    }
  }

  // an image-bearing figure must never paint over its own caption text: paint
  // order is the block order, so composition owns z-order and nothing here reorders
  return { background: toneColor(dsl.background, style, style.background), primitives };
}

// ---------------------------------------------------------------------------
// Validators — what makes model-driven composition safe.
// Each returns actionable messages, matching the spec-schema idiom so a calling
// model can retry rather than silently shipping a broken slide.
// ---------------------------------------------------------------------------

export function validateDslSlide(dsl: DslSlide, tokens: DslPackTokens): string[] {
  const errors: string[] = [];
  const boxes = dsl.blocks.map((b) => ({ block: b, box: dslAreaToBox(b.area, tokens.margin) }));

  for (const { block, box } of boxes) {
    if (block.area.col < 0 || block.area.row < 0) {
      errors.push(`block '${block.kind}' starts off the grid — col/row must be >= 0, use \`bleed\` to reach a page edge`);
    }
    if (block.area.col + block.area.cols > DSL_COLS || block.area.row + block.area.rows > DSL_ROWS) {
      errors.push(
        `block '${block.kind}' runs past the ${DSL_COLS}x${DSL_ROWS} grid — use \`bleed\` if you meant it to reach the page edge`,
      );
    }
    if (box.w <= 0 || box.h <= 0) errors.push(`block '${block.kind}' has no area`);
  }

  // text may not overlap text: two readable blocks on the same pixels is the one
  // composition mistake that always reads as broken rather than as a choice
  const textish = boxes.filter((b) => ['text', 'rows', 'stats'].includes(b.block.kind));
  for (let i = 0; i < textish.length; i++) {
    for (let j = i + 1; j < textish.length; j++) {
      const a = textish[i].box;
      const b = textish[j].box;
      const overlapW = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const overlapH = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (overlapW > 0.05 && overlapH > 0.05) {
        errors.push(
          `text blocks '${textish[i].block.kind}' and '${textish[j].block.kind}' overlap — give them separate grid areas`,
        );
      }
    }
  }
  return errors;
}
