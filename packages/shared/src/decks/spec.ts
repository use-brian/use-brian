import { z } from 'zod';

/**
 * Deck spec — the editing substrate for first-party PPTX generation.
 * Spec: docs/architecture/features/deck-generation.md
 *
 * Ported from sidanclaw-pptx-mcp with two deliberate deviations:
 * - images may come from a workspace_files `path` as well as a public `url`
 * - pie/doughnut charts reject negative values (bar/line render true ranges)
 */

export const DECK_THEMES = ['light', 'dark', 'brand'] as const;
export type DeckTheme = (typeof DECK_THEMES)[number];

export const DECK_CHART_TYPES = ['bar', 'line', 'pie', 'doughnut'] as const;
export type DeckChartType = (typeof DECK_CHART_TYPES)[number];

export const DECK_LAYOUTS = ['content', 'section', 'statement', 'stats', 'quote'] as const;
export type DeckLayout = (typeof DECK_LAYOUTS)[number];

const statSchema = z.object({
  value: z.string().min(1).max(20).describe("The big number, e.g. '$2.1M' or '40%'"),
  label: z.string().min(1).max(60).describe("What it measures, e.g. 'ARR' or 'MoM growth'"),
});

const quoteSchema = z.object({
  text: z.string().min(1).max(500).describe('The quotation text (no surrounding quote marks)'),
  attribution: z.string().max(120).optional().describe("Who said it, e.g. 'Jane Doe, CTO at Acme'"),
});

const imageSchema = z
  .object({
    url: z
      .string()
      .url()
      .max(2000)
      .optional()
      .describe('Public http(s) URL of a png/jpeg/gif image (max 10MB); fetched at build time'),
    path: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe('Path of an image file already stored in workspace files (preferred over url)'),
    caption: z.string().max(200).optional().describe('Optional caption shown under the image'),
  })
  .superRefine((image, ctx) => {
    if (!!image.url === !!image.path) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'image needs exactly one of `url` (public) or `path` (workspace file)',
      });
    }
  });

const chartSchema = z.object({
  type: z.enum(DECK_CHART_TYPES).describe('bar/line for trends (e.g. traction), pie/doughnut for shares'),
  labels: z.array(z.string().min(1).max(40)).min(1).max(12).describe('Category / x-axis labels'),
  values: z.array(z.number().finite()).min(1).max(12).describe('One number per label'),
  unit: z
    .string()
    .max(12)
    .optional()
    .describe("Optional unit prefix/suffix hint shown in labels, e.g. '$' or 'users'"),
});

export const deckSlideSchema = z
  .object({
    title: z
      .string()
      .min(1)
      .max(200)
      .describe('Slide title (for statement/section layouts this is the big headline)'),
    bullets: z
      .array(z.string().min(1).max(500))
      .max(10)
      .optional()
      .describe('Bullet points for the slide body (max 10). Keep to 3-5 short lines for pitch decks.'),
    subtext: z
      .string()
      .max(300)
      .optional()
      .describe('One supporting line under the headline (statement/section layouts)'),
    stats: z
      .array(statSchema)
      .min(1)
      .max(4)
      .optional()
      .describe("Big-number tiles; required when layout is 'stats' (1-4 tiles)"),
    quote: quoteSchema.optional().describe("Required when layout is 'quote'"),
    chart: chartSchema
      .optional()
      .describe('Optional chart rendered on a content slide (beside bullets, or full-width without them)'),
    image: imageSchema
      .optional()
      .describe('Optional image on a content slide (beside bullets, or large without them); not combinable with chart'),
    notes: z.string().max(4000).optional().describe('Speaker notes for the slide'),
    layout: z
      .enum(DECK_LAYOUTS)
      .optional()
      .describe(
        "'content' (default) = title + bullets and/or chart; 'section' = divider; 'statement' = one big centered claim; 'stats' = row of big-number tiles; 'quote' = testimonial",
      ),
  })
  // strict: silently dropping unknown fields (e.g. `content`, `body`) produces
  // slides with titles and empty bodies — reject so the calling model can retry
  .strict()
  .superRefine((slide, ctx) => {
    if (slide.layout === 'stats' && !slide.stats?.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "layout 'stats' requires a non-empty `stats` array" });
    }
    if (slide.layout === 'quote' && !slide.quote) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "layout 'quote' requires a `quote` object" });
    }
    if (slide.chart && slide.image) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `slide "${slide.title}": use either \`chart\` or \`image\`, not both — split them across two slides`,
      });
    }
    if ((slide.layout ?? 'content') === 'content' && !slide.bullets?.length && !slide.chart && !slide.image) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `content slide "${slide.title}" has no body — add \`bullets\`, \`chart\` or \`image\`, or use layout 'statement'/'section' for a title-only slide`,
      });
    }
    if (slide.chart && slide.chart.labels.length !== slide.chart.values.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `chart.labels (${slide.chart.labels.length}) and chart.values (${slide.chart.values.length}) must be the same length`,
      });
    }
    if (
      slide.chart &&
      (slide.chart.type === 'pie' || slide.chart.type === 'doughnut') &&
      slide.chart.values.some((v) => v < 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${slide.chart.type} charts cannot show negative values — use a bar chart for "${slide.title}"`,
      });
    }
  });

// ---------------------------------------------------------------------------
// Content budgets — enforced on MODEL INPUT only, never on a stored spec.
//
// applyDeckOps re-parses the whole deck with deckSpecSchema after every edit
// (see below). Putting these caps there would make decks that predate them
// fail on their next edit even when the edit itself is fine — a deck the user
// can no longer touch. So the caps live on the *input* schemas: new content is
// held to them, existing decks stay editable.
// ---------------------------------------------------------------------------

/**
 * Per-layout caps, measured against the `TYPE` scale in layout.ts — not derived.
 * They exist because `shrinkToFit` never fails: hand a title box a wall of text
 * and PowerPoint silently scales it to unreadable rather than erroring.
 *
 * Re-measure after any change to the display sizes in `TYPE`; a retuned scale
 * invalidates every number here. Chars/line is ~0.6 for Georgia headings and
 * ~0.5 for Arial body.
 */
const LAYOUT_LIMITS: Record<DeckLayout, { title: number; bullets?: { max: number; chars: number } }> = {
  statement: { title: 65 }, // 60pt Georgia, 23 ch/line, 3 lines in a 2.0in box
  section: { title: 48 }, // 56pt centred, 2 lines in a 1.6in box
  content: { title: 48, bullets: { max: 5, chars: 100 } }, // 30pt header, 1 line; body 17pt
  stats: { title: 48, bullets: { max: 2, chars: 120 } }, // 12pt supporting line
  quote: { title: 48 },
};

/**
 * Which content fields each layout actually renders. Anything else is dropped
 * on the floor by layout.ts — layoutQuoteSlide never reads `bullets` — so
 * accepting it is silent content loss. Reject instead.
 *
 * Note `quote` also ignores `title`; the schema requires it, but it renders
 * only as a label.
 */
const LAYOUT_FIELDS: Record<DeckLayout, readonly string[]> = {
  content: ['bullets', 'chart', 'image'],
  section: ['subtext'],
  statement: ['subtext'],
  stats: ['stats', 'bullets'],
  quote: ['quote'],
};

/** Content-bearing fields; `title`, `layout` and `notes` are valid everywhere. */
const CONTENT_FIELDS = ['bullets', 'subtext', 'stats', 'quote', 'chart', 'image'] as const;

/**
 * The slide schema the TOOLS accept: everything deckSlideSchema enforces, plus
 * the content budgets above. Used by generatePowerpoint's `slides` and by the
 * `slide` payload of replaceSlide / insertSlide.
 */
export const deckSlideInputSchema = deckSlideSchema.superRefine((slide, ctx) => {
  const layout: DeckLayout = slide.layout ?? 'content';
  const limits = LAYOUT_LIMITS[layout];

  if (slide.title.length > limits.title) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `title is ${slide.title.length} chars — layout '${layout}' fits ${limits.title}. Shorten it, or move the detail into \`subtext\`/\`bullets\`.`,
    });
  }

  const rendered = LAYOUT_FIELDS[layout];
  for (const field of CONTENT_FIELDS) {
    if (slide[field] !== undefined && !rendered.includes(field)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `layout '${layout}' does not render \`${field}\` — it would be dropped silently. Use ${rendered.map((f) => `\`${f}\``).join(' / ')}, or change the layout.`,
      });
    }
  }

  if (limits.bullets && slide.bullets?.length) {
    if (slide.bullets.length > limits.bullets.max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${slide.bullets.length} bullets on a '${layout}' slide — max ${limits.bullets.max}. Split across two slides.`,
      });
    }
    const overlong = slide.bullets.filter((b) => b.length > limits.bullets!.chars);
    if (overlong.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${overlong.length} bullet(s) exceed ${limits.bullets.chars} chars on a '${layout}' slide — they wrap past the body box. Tighten them.`,
      });
    }
  }
});

/** Deck-level cap shared by the stored and input specs. */
function assertImageCap(deck: { slides: { image?: unknown }[] }, ctx: z.RefinementCtx): void {
  const imageCount = deck.slides.filter((s) => s.image).length;
  if (imageCount > 10) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `deck uses ${imageCount} images — max 10 per deck`,
    });
  }
}

export const deckSpecShape = {
  title: z.string().min(1).max(200).describe('Deck title, shown on the title slide'),
  subtitle: z.string().max(300).optional().describe('Optional subtitle for the title slide'),
  theme: z
    .enum(DECK_THEMES)
    .optional()
    .describe("Preset theme: 'light' (default), 'dark', or 'brand'. Ignored when a reference style is applied."),
  slides: z
    .array(deckSlideSchema)
    .min(1)
    .max(50)
    .describe('Content slides, in order (1-50). The title slide is generated automatically.'),
};

/** The stored spec: what a deck row holds and what applyDeckOps re-validates. */
export const deckSpecSchema = z.object(deckSpecShape).superRefine(assertImageCap);

/**
 * The spec the tools accept — identical shape, but each slide is held to the
 * content budgets. `generatePowerpoint` parses with this; `applyDeckOps` does
 * not (see the note above LAYOUT_LIMITS).
 */
export const deckSpecInputShape = {
  ...deckSpecShape,
  slides: z
    .array(deckSlideInputSchema)
    .min(1)
    .max(50)
    .describe('Content slides, in order (1-50). The title slide is generated automatically.'),
};

export const deckSpecInputSchema = z.object(deckSpecInputShape).superRefine(assertImageCap);

export type DeckStat = z.infer<typeof statSchema>;
export type DeckImage = z.infer<typeof imageSchema>;
export type DeckQuote = z.infer<typeof quoteSchema>;
export type DeckChart = z.infer<typeof chartSchema>;
export type DeckSlide = z.infer<typeof deckSlideSchema>;
export type DeckSpec = z.infer<typeof deckSpecSchema>;

// ---------------------------------------------------------------------------
// Update operations — the iteration surface of updatePowerpoint.
// applyDeckOps is pure and shared so core tools, the API and tests agree on
// exactly what an op does.
// ---------------------------------------------------------------------------

const slideIndex = z.number().int().min(0).max(49).describe('0-based slide index (title slide excluded)');

export const deckOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('replaceSlide'), index: slideIndex, slide: deckSlideInputSchema }),
  z.object({
    op: z.literal('insertSlide'),
    index: slideIndex.describe('0-based position to insert at (existing slides shift right)'),
    slide: deckSlideInputSchema,
  }),
  z.object({ op: z.literal('deleteSlide'), index: slideIndex }),
  z.object({ op: z.literal('moveSlide'), from: slideIndex, to: slideIndex }),
  z.object({
    op: z.literal('setMeta'),
    title: z.string().min(1).max(200).optional(),
    subtitle: z.string().max(300).nullable().optional().describe('null clears the subtitle'),
    theme: z.enum(DECK_THEMES).optional(),
  }),
]);

export type DeckOp = z.infer<typeof deckOpSchema>;

/** Applies ops in order; throws Error with a model-actionable message on any invalid op. */
export function applyDeckOps(spec: DeckSpec, ops: DeckOp[]): DeckSpec {
  let next: DeckSpec = { ...spec, slides: [...spec.slides] };
  for (const op of ops) {
    switch (op.op) {
      case 'replaceSlide': {
        assertIndex(op.index, next.slides.length, 'replaceSlide');
        next.slides[op.index] = op.slide;
        break;
      }
      case 'insertSlide': {
        if (op.index < 0 || op.index > next.slides.length) {
          throw new Error(
            `insertSlide index ${op.index} out of range — deck has ${next.slides.length} slides (valid: 0..${next.slides.length})`,
          );
        }
        if (next.slides.length >= 50) throw new Error('deck already has 50 slides — the maximum');
        next.slides.splice(op.index, 0, op.slide);
        break;
      }
      case 'deleteSlide': {
        assertIndex(op.index, next.slides.length, 'deleteSlide');
        if (next.slides.length === 1) throw new Error('cannot delete the last remaining slide');
        next.slides.splice(op.index, 1);
        break;
      }
      case 'moveSlide': {
        assertIndex(op.from, next.slides.length, 'moveSlide.from');
        assertIndex(op.to, next.slides.length, 'moveSlide.to');
        const [moved] = next.slides.splice(op.from, 1);
        next.slides.splice(op.to, 0, moved);
        break;
      }
      case 'setMeta': {
        if (op.title !== undefined) next = { ...next, title: op.title };
        if (op.subtitle !== undefined) next = { ...next, subtitle: op.subtitle ?? undefined };
        if (op.theme !== undefined) next = { ...next, theme: op.theme };
        break;
      }
    }
  }
  // Re-validate the final shape so ops can never construct an invalid deck.
  return deckSpecSchema.parse(next);
}

function assertIndex(index: number, length: number, opName: string): void {
  if (index < 0 || index >= length) {
    throw new Error(`${opName} index ${index} out of range — deck has ${length} slides (valid: 0..${length - 1})`);
  }
}
