import PptxGenJSImport from 'pptxgenjs';
import {
  DECK_PAGE_H,
  DECK_PAGE_W,
  layoutDeck,
  resolveDeckStyle,
  type DeckPrimitive,
  type DeckSpec,
  type DeckStyle,
} from '@use-brian/shared/decks';

// ESM/CJS interop guard: depending on the loader (node, vitest, tsx) the
// default import is either the PptxGenJS class itself or a namespace whose
// .default is the class. Unwrap defensively so both shapes work.
const PptxGenJS =
  (PptxGenJSImport as { default?: typeof PptxGenJSImport }).default ?? PptxGenJSImport;
type PptxGen = InstanceType<typeof PptxGenJS>;
type Slide = ReturnType<PptxGen['addSlide']>;

export interface ResolvedDeckImage {
  /** data URI for pptxgenjs */
  data: string;
  /** intrinsic px, for aspect-ratio fitting */
  width: number;
  height: number;
}

/** Keyed by the slide image's `url` or `path` — whichever the spec used. */
export type ResolvedImages = Map<string, ResolvedDeckImage>;

/**
 * Renders a DeckSpec to a .pptx Buffer by walking the SHARED layout engine's
 * primitive display list — this file maps primitives to pptxgenjs calls and
 * contains NO layout math (see deck-generation.md → "parity by construction").
 * Charts arrive as shape primitives; `slide.addChart` is never used (Keynote
 * silently drops OOXML chart parts).
 */
export async function writeDeckPptx(
  spec: DeckSpec,
  style: DeckStyle | null | undefined,
  images: ResolvedImages = new Map(),
): Promise<Buffer> {
  const resolved = resolveDeckStyle(spec.theme, style);
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'WIDE', width: DECK_PAGE_W, height: DECK_PAGE_H });
  pptx.layout = 'WIDE';
  pptx.title = spec.title;

  for (const slideLayout of layoutDeck(spec, resolved)) {
    const slide = pptx.addSlide();
    slide.background = { color: slideLayout.background };
    for (const primitive of slideLayout.primitives) {
      writePrimitive(slide, primitive, images);
    }
    if (slideLayout.notes) slide.addNotes(slideLayout.notes);
  }

  return (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
}

function writePrimitive(slide: Slide, p: DeckPrimitive, images: ResolvedImages): void {
  switch (p.kind) {
    case 'text': {
      const items = p.paragraphs.flatMap((para, pi) =>
        para.runs.map((run, ri) => ({
          text: run.text,
          options: {
            color: run.color,
            bold: run.bold,
            italic: run.italic,
            bullet: para.bullet ? { code: '2022', indent: p.bulletIndentPt ?? 14 } : undefined,
            // break to a new paragraph after the last run of every non-final paragraph
            breakLine: ri === para.runs.length - 1 && pi < p.paragraphs.length - 1 ? true : undefined,
          },
        })),
      );
      slide.addText(items, {
        x: p.box.x,
        y: p.box.y,
        w: p.box.w,
        h: p.box.h,
        fontFace: p.fontFace,
        fontSize: p.fontSizePt,
        align: p.align,
        valign: p.valign,
        fit: p.shrinkToFit ? 'shrink' : undefined,
        lineSpacingMultiple: p.lineSpacingMultiple,
        paraSpaceAfter: p.paraSpaceAfterPt,
      });
      return;
    }
    case 'rect': {
      slide.addShape(p.radiusIn ? 'roundRect' : 'rect', {
        x: p.box.x,
        y: p.box.y,
        w: p.box.w,
        h: p.box.h,
        fill: { color: p.fill },
        line: { type: 'none' },
        rectRadius: p.radiusIn,
      });
      return;
    }
    case 'lineSeg': {
      // pptx 'line' shapes draw top-left → bottom-right within their box; flip
      // vertically for an upward segment. Layouts always emit x2 >= x1.
      slide.addShape('line', {
        x: p.x1,
        y: Math.min(p.y1, p.y2),
        w: p.x2 - p.x1,
        h: Math.abs(p.y2 - p.y1),
        flipV: p.y2 < p.y1,
        line: { color: p.color, width: p.widthPt },
      });
      return;
    }
    case 'ellipse': {
      slide.addShape('ellipse', {
        x: p.box.x,
        y: p.box.y,
        w: p.box.w,
        h: p.box.h,
        fill: { color: p.fill },
        line: p.outline ? { color: p.outline.color, width: p.outline.widthPt } : { type: 'none' },
      });
      return;
    }
    case 'pieArc': {
      slide.addShape(p.thicknessRatio !== undefined ? 'blockArc' : 'pie', {
        x: p.box.x,
        y: p.box.y,
        w: p.box.w,
        h: p.box.h,
        angleRange: [p.startDeg, (p.startDeg + p.sweepDeg) % 360],
        arcThicknessRatio: p.thicknessRatio,
        fill: { color: p.fill },
        line: { color: p.outline.color, width: p.outline.widthPt },
      });
      return;
    }
    case 'image': {
      const key = p.source.url ?? p.source.path;
      const image = key ? images.get(key) : undefined;
      if (!image) return; // resolution failures surface earlier, at fetch/read time
      // center-fit inside the frame preserving intrinsic aspect ratio
      const scale = Math.min(p.frame.w / image.width, p.frame.h / image.height);
      const w = image.width * scale;
      const h = image.height * scale;
      slide.addImage({
        data: image.data,
        x: p.frame.x + (p.frame.w - w) / 2,
        y: p.frame.y + (p.frame.h - h) / 2,
        w,
        h,
      });
      return;
    }
  }
}
