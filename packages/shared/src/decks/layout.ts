import type { DeckChart, DeckImage, DeckSlide, DeckSpec, DeckStat } from './spec.js';
import type { DeckStyle } from './theme.js';

/**
 * Shared deck layout engine — parity by construction.
 * Spec: docs/architecture/features/deck-generation.md → "Live preview".
 *
 * layoutDeck(spec, style) emits a display list of primitives per slide.
 * The core pptx writer maps primitives → pptxgenjs calls; the app-web
 * preview maps the same primitives → HTML/SVG. Neither side computes
 * layout on its own — layout math changes ONLY in this module.
 *
 * Units: inches on a 13.33 × 7.5 page; font sizes in points; colors hex
 * without '#'. Ported from sidanclaw-pptx-mcp deck.ts with the negative-
 * value bar fix and heading/body font split.
 */

export const DECK_PAGE_W = 13.33;
export const DECK_PAGE_H = 7.5;
const MARGIN = 0.9;
const BODY_W = DECK_PAGE_W - 2 * MARGIN;

/**
 * The content band on a chromed slide, between the header rule and the footer.
 * Body content is CENTERED in this band rather than top-anchored: boxes are
 * sized for the maximum a slide may hold (10 bullets), so a realistic 3-bullet
 * slide top-anchored in one leaves ~55% of the page visibly empty and the deck
 * reads as unfinished. Centering costs nothing when a slide is full and fixes
 * the common case.
 */
const BODY_TOP = 2.15;
const BODY_BOTTOM = DECK_PAGE_H - 0.85;
const BODY_H = BODY_BOTTOM - BODY_TOP;

export interface DeckBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DeckTextRun {
  text: string;
  color: string;
  bold?: boolean;
  italic?: boolean;
}

export interface DeckParagraph {
  runs: DeckTextRun[];
  bullet?: boolean;
}

export type DeckPrimitive =
  | {
      kind: 'text';
      box: DeckBox;
      paragraphs: DeckParagraph[];
      fontFace: string;
      fontSizePt: number;
      align: 'left' | 'center' | 'right';
      valign: 'top' | 'middle' | 'bottom';
      /** pptx `fit: shrink`; the preview approximates with CSS clamping. */
      shrinkToFit?: boolean;
      lineSpacingMultiple?: number;
      paraSpaceAfterPt?: number;
      bulletIndentPt?: number;
    }
  | {
      kind: 'rect';
      box: DeckBox;
      fill: string;
      radiusIn?: number;
      /** pptx fill transparency, 0-100 (0/absent = opaque). Used for image scrims. */
      transparency?: number;
    }
  | { kind: 'lineSeg'; x1: number; y1: number; x2: number; y2: number; color: string; widthPt: number }
  | { kind: 'ellipse'; box: DeckBox; fill: string; outline?: { color: string; widthPt: number } }
  | {
      kind: 'pieArc';
      box: DeckBox;
      /** Degrees, 0 = 3 o'clock, clockwise (pptx angleRange convention). */
      startDeg: number;
      sweepDeg: number;
      /** Present for doughnut arcs (pptx blockArc arcThicknessRatio). */
      thicknessRatio?: number;
      fill: string;
      outline: { color: string; widthPt: number };
    }
  | {
      kind: 'image';
      /** The frame to fit the image into. */
      frame: DeckBox;
      /**
       * 'contain' (default) center-fits inside the frame, preserving aspect and
       * leaving letterbox gaps. 'cover' fills the frame edge to edge, cropping
       * the overflow — what full-bleed layouts need.
       */
      fit?: 'contain' | 'cover';
      source: { url?: string; path?: string };
    };

export interface DeckSlideLayout {
  background: string;
  primitives: DeckPrimitive[];
  notes?: string;
}

export function layoutDeck(spec: DeckSpec, style: DeckStyle): DeckSlideLayout[] {
  const slides: DeckSlideLayout[] = [layoutTitleSlide(spec, style)];
  // Split slides mirror on how many splits came BEFORE them, not on their page
  // number — splits are rarely adjacent, and two of them landing on the same
  // page parity (say pages 4 and 6) would silently never mirror at all.
  let splitOrdinal = 0;
  spec.slides.forEach((slide, i) => {
    const pageNum = i + 2;
    let out: DeckSlideLayout;
    switch (slide.layout) {
      case 'section':
        out = layoutSectionSlide(slide, style);
        break;
      case 'statement':
        out = layoutStatementSlide(slide, style);
        break;
      case 'stats':
        out = withFooter(layoutStatsSlide(slide, style), style, spec.title, pageNum);
        break;
      case 'quote':
        out = withFooter(layoutQuoteSlide(slide, style), style, spec.title, pageNum);
        break;
      // hero/split run to the page edge, so they take no header and no footer —
      // chrome inside a full-bleed image reads as a mistake, and the footer's
      // right-aligned page number would land on top of the artwork.
      case 'hero':
        out = layoutHeroSlide(slide, style);
        break;
      case 'split':
        out = layoutSplitSlide(slide, style, splitOrdinal++);
        break;
      default:
        out = withFooter(layoutContentSlide(slide, style), style, spec.title, pageNum);
    }
    if (slide.notes) out.notes = slide.notes;
    slides.push(out);
  });
  return slides;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function plainText(
  text: string,
  color: string,
  box: DeckBox,
  opts: {
    fontFace: string;
    fontSizePt: number;
    bold?: boolean;
    italic?: boolean;
    align?: 'left' | 'center' | 'right';
    valign?: 'top' | 'middle' | 'bottom';
    shrinkToFit?: boolean;
    lineSpacingMultiple?: number;
  },
): DeckPrimitive {
  return {
    kind: 'text',
    box,
    paragraphs: [{ runs: [{ text, color, bold: opts.bold, italic: opts.italic }] }],
    fontFace: opts.fontFace,
    fontSizePt: opts.fontSizePt,
    align: opts.align ?? 'left',
    valign: opts.valign ?? 'top',
    shrinkToFit: opts.shrinkToFit,
    lineSpacingMultiple: opts.lineSpacingMultiple,
  };
}

function bulletBlock(
  style: DeckStyle,
  bullets: string[],
  box: DeckBox,
  fontSizePt = 22,
  valign: 'top' | 'middle' = 'middle',
): DeckPrimitive {
  return {
    kind: 'text',
    box,
    paragraphs: bullets.map((text) => ({ runs: [{ text, color: style.text }], bullet: true })),
    fontFace: style.bodyFont,
    fontSizePt,
    align: 'left',
    valign,
    shrinkToFit: true,
    lineSpacingMultiple: 1.25,
    paraSpaceAfterPt: Math.round(fontSizePt * 0.85),
    bulletIndentPt: 16,
  };
}

// ---------------------------------------------------------------------------
// Slide chrome
// ---------------------------------------------------------------------------

/**
 * Title slide: a full-height accent spine on the left edge anchors the page so
 * the generous whitespace reads as deliberate rather than as a slide nobody
 * finished. Title block sits on the lower-middle third, the way a book cover
 * carries its title.
 */
function layoutTitleSlide(spec: DeckSpec, style: DeckStyle): DeckSlideLayout {
  const primitives: DeckPrimitive[] = [
    { kind: 'rect', box: { x: 0, y: 0, w: 0.32, h: DECK_PAGE_H }, fill: style.accent },
    plainText(spec.title, style.text, { x: MARGIN, y: 2.75, w: BODY_W, h: 2.2 }, {
      fontFace: style.headingFont,
      fontSizePt: 60,
      bold: true,
      valign: 'bottom',
      shrinkToFit: true,
      lineSpacingMultiple: 1.05,
    }),
  ];
  if (spec.subtitle) {
    primitives.push(
      plainText(spec.subtitle, style.muted, { x: MARGIN, y: 5.42, w: BODY_W, h: 0.8 }, {
        fontFace: style.bodyFont,
        fontSizePt: 22,
      }),
    );
  }
  return { background: style.background, primitives };
}

/**
 * Header rule spans the full body width rather than the old 0.75" accent stub,
 * which read as a stray artifact. The accent is the leading segment of the
 * rule, so the motif survives while the line does real compositional work.
 */
function header(style: DeckStyle, title: string): DeckPrimitive[] {
  const ruleY = 1.72;
  return [
    plainText(title, style.text, { x: MARGIN, y: 0.62, w: BODY_W, h: 1.0 }, {
      fontFace: style.headingFont,
      fontSizePt: 34,
      bold: true,
      valign: 'bottom',
      shrinkToFit: true,
    }),
    { kind: 'rect', box: { x: MARGIN, y: ruleY, w: BODY_W, h: 0.02 }, fill: style.grid },
    { kind: 'rect', box: { x: MARGIN, y: ruleY - 0.03, w: 1.6, h: 0.08 }, fill: style.accent },
  ];
}

function withFooter(slide: DeckSlideLayout, style: DeckStyle, deckTitle: string, pageNum: number): DeckSlideLayout {
  slide.primitives.push(
    plainText(deckTitle, style.muted, { x: MARGIN, y: DECK_PAGE_H - 0.5, w: 6, h: 0.3 }, {
      fontFace: style.bodyFont,
      fontSizePt: 9,
    }),
    plainText(String(pageNum), style.muted, { x: DECK_PAGE_W - MARGIN - 1, y: DECK_PAGE_H - 0.5, w: 1, h: 0.3 }, {
      fontFace: style.bodyFont,
      fontSizePt: 9,
      align: 'right',
    }),
  );
  return slide;
}

// ---------------------------------------------------------------------------
// Layouts
// ---------------------------------------------------------------------------

function layoutContentSlide(slide: DeckSlide, style: DeckStyle): DeckSlideLayout {
  const primitives = header(style, slide.title);
  const hasBullets = !!slide.bullets?.length;
  const textW = 5.5;
  const sideBox: DeckBox = { x: MARGIN + textW + 0.5, y: BODY_TOP, w: DECK_PAGE_W - MARGIN * 2 - textW - 0.5, h: BODY_H };
  const fullBox: DeckBox = { x: MARGIN, y: BODY_TOP, w: BODY_W, h: BODY_H };
  const textBox: DeckBox = { x: MARGIN, y: BODY_TOP, w: textW, h: BODY_H };

  if (slide.chart && hasBullets) {
    primitives.push(bulletBlock(style, slide.bullets!, textBox, 18));
    primitives.push(...layoutChart(slide.chart, style, sideBox));
  } else if (slide.chart) {
    primitives.push(...layoutChart(slide.chart, style, fullBox));
  } else if (slide.image && hasBullets) {
    primitives.push(bulletBlock(style, slide.bullets!, textBox, 18));
    primitives.push(...layoutImage(slide.image, style, sideBox));
  } else if (slide.image) {
    primitives.push(...layoutImage(slide.image, style, fullBox));
  } else if (hasBullets) {
    // few bullets => bigger type, so a 3-point slide still fills the band
    const size = slide.bullets!.length <= 4 ? 26 : slide.bullets!.length <= 6 ? 22 : 19;
    primitives.push(bulletBlock(style, slide.bullets!, fullBox, size));
  }
  return { background: style.background, primitives };
}

function layoutImage(image: DeckImage, style: DeckStyle, box: DeckBox): DeckPrimitive[] {
  const captionH = image.caption ? 0.45 : 0;
  const primitives: DeckPrimitive[] = [
    {
      kind: 'image',
      frame: { ...box, h: box.h - captionH },
      source: { url: image.url, path: image.path },
    },
  ];
  if (image.caption) {
    primitives.push(
      plainText(image.caption, style.muted, { x: box.x, y: box.y + box.h - captionH, w: box.w, h: captionH }, {
        fontFace: style.bodyFont,
        fontSizePt: 12,
        align: 'center',
      }),
    );
  }
  return primitives;
}

/**
 * Full-bleed image with the headline under it. The image is `cover`-fit to the
 * whole page, gets a light background-color wash, and an OPAQUE bottom band
 * carries the text while the top ~57% stays photo.
 *
 * The band is the background color and the text the normal text color, so the
 * palette's existing contrast guarantee (see deriveDeckStyle) carries over
 * unchanged — no per-image color analysis needed. A soft top-to-bottom fade
 * would be nicer, but pptxgenjs 4.x has no gradient fill.
 *
 * Paint order matters and is contractual: image, wash, band, then text.
 */
function layoutHeroSlide(slide: DeckSlide, style: DeckStyle): DeckSlideLayout {
  const bandY = 4.25;
  const primitives: DeckPrimitive[] = [];
  if (slide.image) {
    primitives.push({
      kind: 'image',
      frame: { x: 0, y: 0, w: DECK_PAGE_W, h: DECK_PAGE_H },
      fit: 'cover',
      source: { url: slide.image.url, path: slide.image.path },
    });
  }
  primitives.push(
    // A light wash of the background color over the whole photo, pulling an
    // arbitrary image toward the deck's palette. Subtle enough to keep the
    // picture, and legibility never depends on it — the text sits on the solid
    // band below.
    {
      kind: 'rect',
      box: { x: 0, y: 0, w: DECK_PAGE_W, h: DECK_PAGE_H },
      fill: style.background,
      transparency: 85,
    },
    // The text bed is OPAQUE on purpose. We cannot inspect the image the author
    // picked, and a partly transparent band lets a busy or text-bearing graphic
    // (a screenshot, a marketing banner) bleed through behind the headline —
    // which reads as a rendering fault, not a design. Solid is the only choice
    // that is legible over every possible image.
    {
      kind: 'rect',
      box: { x: 0, y: bandY, w: DECK_PAGE_W, h: DECK_PAGE_H - bandY },
      fill: style.background,
    },
    // Same accent tick as the title slide — the motif is what ties the deck together.
    { kind: 'rect', box: { x: MARGIN, y: bandY + 0.5, w: 1.1, h: 0.14 }, fill: style.accent },
    plainText(slide.title, style.text, { x: MARGIN, y: bandY + 0.78, w: BODY_W, h: 1.25 }, {
      fontFace: style.headingFont,
      fontSizePt: 48,
      bold: true,
      shrinkToFit: true,
    }),
  );
  if (slide.subtext) {
    primitives.push(
      plainText(slide.subtext, style.muted, { x: MARGIN, y: bandY + 2.05, w: BODY_W, h: 0.7 }, {
        fontFace: style.bodyFont,
        fontSizePt: 18,
      }),
    );
  }
  return { background: style.background, primitives };
}

/**
 * Image filling one half of the page edge to edge, title + bullets on the
 * other. Sides alternate on `splitOrdinal` (the count of split slides before
 * this one) so successive splits mirror each other — the rhythm a designer
 * would apply by hand, without spending a model-facing knob on it (primitives
 * and composition stay internal).
 */
function layoutSplitSlide(slide: DeckSlide, style: DeckStyle, splitOrdinal: number): DeckSlideLayout {
  const imageW = 6.43;
  const imageOnRight = splitOrdinal % 2 === 0;
  const imageX = imageOnRight ? DECK_PAGE_W - imageW : 0;
  const textX = imageOnRight ? MARGIN : imageW + MARGIN * 0.7;
  const textW = DECK_PAGE_W - imageW - MARGIN * 1.7;

  const primitives: DeckPrimitive[] = [];
  if (slide.image) {
    primitives.push({
      kind: 'image',
      frame: { x: imageX, y: 0, w: imageW, h: DECK_PAGE_H },
      fit: 'cover',
      source: { url: slide.image.url, path: slide.image.path },
    });
  }
  primitives.push(
    plainText(slide.title, style.text, { x: textX, y: 1.5, w: textW, h: 1.5 }, {
      fontFace: style.headingFont,
      fontSizePt: 34,
      bold: true,
      valign: 'bottom',
      shrinkToFit: true,
    }),
    { kind: 'rect', box: { x: textX, y: 3.2, w: 1.6, h: 0.08 }, fill: style.accent },
  );
  if (slide.bullets?.length) {
    primitives.push(bulletBlock(style, slide.bullets, { x: textX, y: 3.6, w: textW, h: 2.9 }, 19, 'top'));
  }
  return { background: style.background, primitives };
}

function layoutSectionSlide(slide: DeckSlide, style: DeckStyle): DeckSlideLayout {
  const primitives: DeckPrimitive[] = [
    plainText(slide.title, style.background, { x: MARGIN, y: 2.55, w: BODY_W, h: 1.9 }, {
      fontFace: style.headingFont,
      fontSizePt: 54,
      bold: true,
      align: 'center',
      valign: 'middle',
      shrinkToFit: true,
    }),
  ];
  if (slide.subtext) {
    primitives.push(
      plainText(slide.subtext, style.background, { x: MARGIN + 1.5, y: 4.6, w: BODY_W - 3, h: 0.8 }, {
        fontFace: style.bodyFont,
        fontSizePt: 20,
        align: 'center',
      }),
    );
  }
  // Inverted: accent background, background-colored text.
  return { background: style.accent, primitives };
}

function layoutStatementSlide(slide: DeckSlide, style: DeckStyle): DeckSlideLayout {
  const primitives: DeckPrimitive[] = [
    { kind: 'rect', box: { x: DECK_PAGE_W / 2 - 0.8, y: 2.1, w: 1.6, h: 0.1 }, fill: style.accent },
    plainText(slide.title, style.text, { x: MARGIN, y: 2.65, w: BODY_W, h: 2.1 }, {
      fontFace: style.headingFont,
      fontSizePt: 48,
      bold: true,
      align: 'center',
      valign: 'middle',
      shrinkToFit: true,
      lineSpacingMultiple: 1.1,
    }),
  ];
  if (slide.subtext) {
    primitives.push(
      plainText(slide.subtext, style.muted, { x: MARGIN + 1.5, y: 5.0, w: BODY_W - 3, h: 0.9 }, {
        fontFace: style.bodyFont,
        fontSizePt: 20,
        align: 'center',
      }),
    );
  }
  return { background: style.background, primitives };
}

function layoutStatsSlide(slide: DeckSlide, style: DeckStyle): DeckSlideLayout {
  const primitives = header(style, slide.title);
  const stats: DeckStat[] = slide.stats ?? [];
  const gap = 0.36;
  const tileW = (BODY_W - gap * (stats.length - 1)) / stats.length;
  // A tile holds two lines, so it is capped rather than stretched to the band —
  // a full-height tile ends up taller than it is wide and reads as an empty box
  // with text floating in it. Cap, then centre the row in the band.
  const notes = slide.bullets?.length ? 1.5 : 0;
  const availH = BODY_H - notes;
  const tileH = Math.min(availH, 3.3);
  const tileY = BODY_TOP + (availH - tileH) / 2;
  stats.forEach((stat, i) => {
    const x = MARGIN + i * (tileW + gap);
    primitives.push(
      { kind: 'rect', box: { x, y: tileY, w: tileW, h: tileH }, fill: style.panel, radiusIn: 0.1 },
      plainText(stat.value, style.accent, { x, y: tileY + tileH * 0.24, w: tileW, h: tileH * 0.34 }, {
        fontFace: style.headingFont,
        fontSizePt: 60,
        bold: true,
        align: 'center',
        valign: 'middle',
        shrinkToFit: true,
      }),
      plainText(stat.label, style.muted, { x: x + 0.2, y: tileY + tileH * 0.6, w: tileW - 0.4, h: 0.65 }, {
        fontFace: style.bodyFont,
        fontSizePt: 16,
        align: 'center',
      }),
    );
  });
  if (slide.bullets?.length) {
    primitives.push(
      bulletBlock(style, slide.bullets, { x: MARGIN, y: tileY + tileH + 0.3, w: BODY_W, h: notes - 0.3 }, 16),
    );
  }
  return { background: style.background, primitives };
}

/**
 * A pull quote is one idea, so it gets the whole page: no header, an accent
 * rule instead of the old stranded 120pt glyph, and the block optically
 * centered. The previous version left ~2.4" dead under the attribution.
 */
function layoutQuoteSlide(slide: DeckSlide, style: DeckStyle): DeckSlideLayout {
  const quote = slide.quote;
  if (!quote) return { background: style.background, primitives: [] };
  const inset = MARGIN + 0.8;
  const width = DECK_PAGE_W - inset - MARGIN - 0.8;
  const primitives: DeckPrimitive[] = [
    { kind: 'rect', box: { x: inset, y: 2.15, w: 1.6, h: 0.09 }, fill: style.accent },
    plainText(quote.text, style.text, { x: inset, y: 2.75, w: width, h: 2.4 }, {
      fontFace: style.headingFont,
      fontSizePt: 34,
      italic: true,
      valign: 'middle',
      shrinkToFit: true,
      lineSpacingMultiple: 1.25,
    }),
  ];
  if (quote.attribution) {
    primitives.push(
      plainText(quote.attribution, style.muted, { x: inset, y: 5.45, w: width, h: 0.5 }, {
        fontFace: style.bodyFont,
        fontSizePt: 17,
      }),
    );
  }
  return { background: style.background, primitives };
}

// ---------------------------------------------------------------------------
// Charts — drawn from primitives, never OOXML chart parts (Keynote drops them)
// ---------------------------------------------------------------------------

export function formatChartValue(value: number, unit?: string): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  let num: string;
  if (abs >= 1e9) num = `${trimZero(abs / 1e9)}B`;
  else if (abs >= 1e6) num = `${trimZero(abs / 1e6)}M`;
  else if (abs >= 1e4) num = `${trimZero(abs / 1e3)}K`;
  else num = abs % 1 === 0 ? String(abs) : abs.toFixed(1);
  const magnitude = `${sign}${num}`;
  if (!unit) return magnitude;
  if (unit === '%') return `${magnitude}%`;
  // Currency symbols read as a prefix; anything else (e.g. 'users') as a suffix.
  return /^[$€£¥₩₹]$/.test(unit) ? `${sign}${unit}${num}` : `${magnitude} ${unit}`;
}

function trimZero(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '');
}

function layoutChart(chart: DeckChart, style: DeckStyle, box: DeckBox): DeckPrimitive[] {
  if (chart.type === 'pie' || chart.type === 'doughnut') return layoutPieChart(chart, style, box);
  if (chart.type === 'line') return layoutLineChart(chart, style, box);
  return layoutBarChart(chart, style, box);
}

/**
 * Bars render a true min/max range: negative values hang below the zero
 * baseline with their value labels underneath (the source repo clamped
 * negatives to zero — silent misrepresentation).
 */
function layoutBarChart(chart: DeckChart, style: DeckStyle, box: DeckBox): DeckPrimitive[] {
  const n = chart.values.length;
  const maxVal = Math.max(...chart.values, 0);
  const minVal = Math.min(...chart.values, 0);
  const range = maxVal - minVal || 1;
  const labelH = 0.32; // category labels under the plot
  const valueH = 0.3; // value labels above/below bars
  const plot: DeckBox = { x: box.x, y: box.y + valueH, w: box.w, h: box.h - valueH - labelH };
  const zeroY = plot.y + (maxVal / range) * plot.h;

  const primitives: DeckPrimitive[] = [];
  const slotW = plot.w / n;
  const barW = Math.min(slotW * 0.62, 1.4);
  chart.values.forEach((value, i) => {
    const barH = Math.max((Math.abs(value) / range) * plot.h, 0.02);
    const x = plot.x + i * slotW + (slotW - barW) / 2;
    const barY = value >= 0 ? zeroY - barH : zeroY;
    primitives.push({ kind: 'rect', box: { x, y: barY, w: barW, h: barH }, fill: style.accent });
    primitives.push(
      plainText(
        formatChartValue(value, chart.unit),
        style.text,
        value >= 0
          ? { x: plot.x + i * slotW, y: barY - valueH, w: slotW, h: valueH }
          : { x: plot.x + i * slotW, y: barY + barH + 0.02, w: slotW, h: valueH },
        {
          fontFace: style.bodyFont,
          fontSizePt: 10,
          align: 'center',
          valign: value >= 0 ? 'bottom' : 'top',
        },
      ),
    );
    primitives.push(
      plainText(chart.labels[i], style.muted, { x: plot.x + i * slotW, y: plot.y + plot.h + 0.06, w: slotW, h: labelH }, {
        fontFace: style.bodyFont,
        fontSizePt: 11,
        align: 'center',
      }),
    );
  });
  primitives.push({ kind: 'lineSeg', x1: plot.x, y1: zeroY, x2: plot.x + plot.w, y2: zeroY, color: style.grid, widthPt: 1 });
  return primitives;
}

function layoutLineChart(chart: DeckChart, style: DeckStyle, box: DeckBox): DeckPrimitive[] {
  const n = chart.values.length;
  const maxVal = Math.max(...chart.values, 0);
  const minVal = Math.min(...chart.values, 0);
  const range = maxVal - minVal || 1;
  const labelH = 0.32;
  const valueH = 0.3;
  const plot: DeckBox = { x: box.x + 0.2, y: box.y + valueH, w: box.w - 0.4, h: box.h - valueH - labelH };
  const baselineY = plot.y + plot.h;
  const showValues = n <= 8;

  const px = (i: number) => plot.x + (n === 1 ? plot.w / 2 : (i / (n - 1)) * plot.w);
  const py = (v: number) => baselineY - ((v - minVal) / range) * plot.h;

  const primitives: DeckPrimitive[] = [
    { kind: 'lineSeg', x1: plot.x, y1: baselineY, x2: plot.x + plot.w, y2: baselineY, color: style.grid, widthPt: 1 },
  ];
  for (let i = 0; i < n - 1; i++) {
    primitives.push({
      kind: 'lineSeg',
      x1: px(i),
      y1: py(chart.values[i]),
      x2: px(i + 1),
      y2: py(chart.values[i + 1]),
      color: style.accent,
      widthPt: 2.5,
    });
  }
  const marker = 0.11;
  chart.values.forEach((value, i) => {
    primitives.push({
      kind: 'ellipse',
      box: { x: px(i) - marker / 2, y: py(value) - marker / 2, w: marker, h: marker },
      fill: style.accent,
      outline: { color: style.background, widthPt: 1.5 }, // surface ring over crossing marks
    });
    if (showValues) {
      primitives.push(
        plainText(formatChartValue(value, chart.unit), style.text, { x: px(i) - 0.6, y: py(value) - marker / 2 - valueH, w: 1.2, h: valueH }, {
          fontFace: style.bodyFont,
          fontSizePt: 10,
          align: 'center',
          valign: 'bottom',
        }),
      );
    }
    primitives.push(
      plainText(chart.labels[i], style.muted, { x: px(i) - 0.75, y: baselineY + 0.06, w: 1.5, h: labelH }, {
        fontFace: style.bodyFont,
        fontSizePt: 11,
        align: 'center',
      }),
    );
  });
  return primitives;
}

function layoutPieChart(chart: DeckChart, style: DeckStyle, box: DeckBox): DeckPrimitive[] {
  const total = chart.values.reduce((sum, v) => sum + Math.max(v, 0), 0) || 1;
  const legendW = 2.9;
  const side = Math.min(box.h, box.w - legendW - 0.3);
  const cx = box.x + (box.w - legendW - 0.3 - side) / 2;
  const cy = box.y + (box.h - side) / 2;

  const primitives: DeckPrimitive[] = [];
  let angle = 270; // start at 12 o'clock, sweep clockwise
  chart.values.forEach((value, i) => {
    const sweep = (Math.max(value, 0) / total) * 360;
    if (sweep <= 0) return;
    primitives.push({
      kind: 'pieArc',
      box: { x: cx, y: cy, w: side, h: side },
      startDeg: angle % 360,
      sweepDeg: sweep,
      thicknessRatio: chart.type === 'doughnut' ? 0.35 : undefined,
      fill: style.chartCategorical[i % style.chartCategorical.length],
      outline: { color: style.background, widthPt: 2 }, // surface gap between slices
    });
    angle += sweep;
  });

  const rows = chart.labels.length;
  const rowH = 0.34;
  const legendX = box.x + box.w - legendW;
  const legendY = box.y + Math.max((box.h - rows * rowH) / 2, 0);
  chart.labels.forEach((label, i) => {
    const y = legendY + i * rowH;
    primitives.push({
      kind: 'rect',
      box: { x: legendX, y: y + 0.09, w: 0.16, h: 0.16 },
      fill: style.chartCategorical[i % style.chartCategorical.length],
    });
    const pct = Math.round((Math.max(chart.values[i], 0) / total) * 100);
    const detail =
      chart.unit === '%' ? `${pct}%` : `${formatChartValue(chart.values[i], chart.unit)} · ${pct}%`;
    primitives.push({
      kind: 'text',
      box: { x: legendX + 0.28, y, w: legendW - 0.28, h: rowH },
      paragraphs: [
        {
          runs: [
            { text: `${label}  `, color: style.text },
            { text: detail, color: style.muted },
          ],
        },
      ],
      fontFace: style.bodyFont,
      fontSizePt: 12,
      align: 'left',
      valign: 'middle',
    });
  });
  return primitives;
}
