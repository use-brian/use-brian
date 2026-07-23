/**
 * Just enough font metrics to size a single line of display text so it actually
 * fits its box. Lives in shared, beside layout.ts, because choosing a point size
 * IS layout math — the size it returns rides in the `text` primitive's
 * `fontSizePt`, so the pptx writer and the web preview receive the same number
 * and cannot disagree about it.
 * Spec: docs/architecture/features/deck-generation.md → "Live preview".
 * [COMP:decks/text-metrics]
 *
 * `fit: 'shrink'` is not a substitute. It emits a bare `<a:normAutofit/>` — a
 * request to shrink with no scale computed — so Keynote and Quick Look ignore it
 * and the text spills, while PowerPoint shrinks *each box independently*. Across
 * a row of stat tiles that means "47,000" renders visibly smaller than "68%",
 * which is worse than either failure alone. The preview's CSS clamping is a
 * third behaviour again, so `shrink` is also the one place the two renderers are
 * structurally allowed to drift.
 *
 * Widths are advance widths in em, read off the shipped macOS font files with
 * fontTools and normalised by unitsPerEm. They are measured, not estimated: the
 * ~0.5 chars/line factor used for Arial body copy under-counts Georgia's
 * proportional figures by a third ('0' is 0.701 em, '1' is 0.490 em), which is
 * exactly how 54pt "47,000" ended up 15% wider than its tile.
 *
 * The tables cover the characters a number can plausibly contain. Anything else
 * — a letter in "3.2 hrs", an unlisted symbol — falls back to the font's widest
 * capital, so an unrecognised string is sized conservatively rather than
 * overflowing.
 */

interface FontMetrics {
  /** Advance width in em, per character. */
  readonly chars: Readonly<Record<string, number>>;
  /** Width assumed for characters absent from `chars`: the widest capital. */
  readonly fallback: number;
}

/** Bold weights, since display numbers are set bold. */
const METRICS: Record<string, FontMetrics> = {
  Georgia: {
    chars: {
      '0': 0.701, '1': 0.49, '2': 0.626, '3': 0.625, '4': 0.649, '5': 0.599,
      '6': 0.648, '7': 0.554, '8': 0.676, '9': 0.648, '$': 0.641, '%': 0.879,
      '.': 0.328, ',': 0.328, '+': 0.703, '-': 0.379, '/': 0.472, x: 0.588,
      '×': 0.703, '€': 0.715, '£': 0.69, '¥': 0.732, ' ': 0.254,
    },
    fallback: 1.126,
  },
  Arial: {
    chars: {
      '0': 0.556, '1': 0.556, '2': 0.556, '3': 0.556, '4': 0.556, '5': 0.556,
      '6': 0.556, '7': 0.556, '8': 0.556, '9': 0.556, '$': 0.556, '%': 0.889,
      '.': 0.278, ',': 0.278, '+': 0.584, '-': 0.333, '/': 0.278, x: 0.556,
      '×': 0.584, '€': 0.556, '£': 0.556, '¥': 0.556, ' ': 0.278,
    },
    fallback: 0.944,
  },
  'Trebuchet MS': {
    chars: {
      '0': 0.586, '1': 0.586, '2': 0.586, '3': 0.586, '4': 0.586, '5': 0.586,
      '6': 0.586, '7': 0.586, '8': 0.586, '9': 0.586, '$': 0.586, '%': 0.684,
      '.': 0.367, ',': 0.367, '+': 0.586, '-': 0.367, '/': 0.39, x: 0.552,
      '×': 0.586, '€': 0.586, '£': 0.524, '¥': 0.57, ' ': 0.301,
    },
    fallback: 0.884,
  },
};

/**
 * pptxgenjs does not set `lIns`/`rIns`, so every text box keeps OOXML's default
 * 0.1in inset on each side. Sizing against the box width would overflow by 0.2in.
 */
export const TEXT_INSET = 0.1;

/**
 * Width of `text` in em at the given face. Faces we have no table for (a style
 * extracted from a reference .pptx can name any installed font) fall back to
 * Arial's metrics — the narrowest of the three, so the size chosen is the
 * conservative one rather than an optimistic guess that overflows.
 */
export function widthInEm(text: string, fontFace: string): number {
  const metrics = METRICS[fontFace] ?? METRICS.Arial;
  let em = 0;
  for (const ch of text) em += metrics.chars[ch] ?? metrics.fallback;
  return em;
}

/**
 * The largest point size in `[min, max]` at which *every* string in `texts` fits
 * `width` inches on one line — one size for the whole set, so a row of tiles is
 * typographically even instead of each box shrinking to its own content.
 *
 * `width` is the box width; the 0.1in-per-side OOXML inset is subtracted here so
 * callers pass the box they laid out, not the box minus insets.
 *
 * Clamped at `min` rather than allowed to vanish; a caller who puts a sentence in
 * a number field gets small type, not a 6pt one. The renderer keeps `shrinkToFit`
 * on the box purely as a net for that clamped case — it never engages for input
 * the schema admits.
 */
export function fitOneLine(
  texts: readonly string[],
  width: number,
  fontFace: string,
  max: number,
  min: number,
): number {
  const widest = Math.max(0, ...texts.map((t) => widthInEm(t, fontFace)));
  if (widest === 0) return max;
  const usable = Math.max(0.1, width - 2 * TEXT_INSET);
  const points = (usable * 72) / widest; // inches -> points
  return Math.max(min, Math.min(max, Math.floor(points)));
}
