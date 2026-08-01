import type { DeckTheme } from './spec.js';

/**
 * Deck styling — preset themes + reference-style derivation.
 * Spec: docs/architecture/features/deck-generation.md → "Style-from-reference".
 *
 * All colors are UPPERCASE hex WITHOUT '#' (pptxgenjs convention); the web
 * preview prepends '#'. Font sizes elsewhere are points; fonts here are
 * fontFace name strings (no embedding — non-installed fonts fall back at
 * open time, same as PowerPoint itself).
 */

export interface DeckStyle {
  background: string;
  text: string;
  muted: string;
  accent: string;
  panel: string; // subtle tile/panel fill
  grid: string; // recessive chart gridlines
  /** Categorical chart palette, contrast-checked against `background`. */
  chartCategorical: string[];
  headingFont: string;
  bodyFont: string;
  /**
   * Multiplier applied to every type size a pack emits, so a derived reference
   * can set the deck's typographic WEIGHT without flattening the pack.
   *
   * A pack uses a dozen carefully-related sizes; mapping those onto a five-step
   * token scale would collapse the hierarchy it depends on. Scaling preserves
   * every ratio and only moves the whole system. Absent = 1 (no change).
   */
  typeScale?: number;
  /**
   * Whether the reference sets its headings in caps. Only ever used to SUPPRESS
   * a pack's own caps treatment (`false` = "my reference isn't shouty"); it
   * never adds caps to a pack that didn't ask for them, because forcing caps
   * onto a serif face looks worse than leaving it alone.
   */
  headingCaps?: boolean;
}

/**
 * The headline size the packs are tuned around. A derived reference's largest
 * step is expressed relative to this to get `typeScale`. All three packs sit in
 * the 54-62pt range, so this is an approximation with a known small error, not
 * a measurement.
 */
export const DECK_CANONICAL_HEADLINE_PT = 54;

/** Clamped so a bad derivation cannot produce absurd type. */
export function deckTypeScaleFor(headlinePt: number): number {
  return Math.min(Math.max(headlinePt / DECK_CANONICAL_HEADLINE_PT, 0.75), 1.25);
}

/**
 * There is no font embedding (see the header note), so a face must be present
 * on the opening machine or it silently falls back. Choices are therefore
 * drawn from the Office/OS-bundled set — a web font (Inter, Söhne) would look
 * WORSE than Arial wherever it isn't installed, which is most machines.
 * Georgia and Calibri ship on Windows, macOS and Office; Georgia is already
 * assumed present (the quote glyph in layout.ts hardcodes it).
 */
const DEFAULT_HEADING_FONT = 'Georgia';
const DEFAULT_BODY_FONT = 'Calibri';
/** Sans heading for saturated backgrounds, where a serif reads oddly. */
const SANS_HEADING_FONT = 'Trebuchet MS';

/** Preset palettes ported from sidanclaw-pptx-mcp (CVD + contrast validated). */
export const DECK_PRESET_STYLES: Record<DeckTheme, DeckStyle> = {
  light: {
    background: 'FFFFFF',
    text: '111827',
    muted: '6B7280',
    accent: '2563EB',
    panel: 'F3F4F6',
    grid: 'E5E7EB',
    chartCategorical: ['2A78D6', '1BAF7A', 'EDA100', '4A3AA7', 'E34948', 'EB6834'],
    headingFont: DEFAULT_HEADING_FONT,
    bodyFont: DEFAULT_BODY_FONT,
  },
  dark: {
    background: '111827',
    text: 'F9FAFB',
    muted: '9CA3AF',
    accent: '60A5FA',
    panel: '1F2937',
    grid: '374151',
    chartCategorical: ['3987E5', '199E70', 'C98500', '9085E9', 'E66767', 'D95926'],
    headingFont: SANS_HEADING_FONT,
    bodyFont: DEFAULT_BODY_FONT,
  },
  brand: {
    background: '0B2545',
    text: 'FFFFFF',
    muted: '8DA9C4',
    accent: '2DD4BF',
    panel: '13315C',
    grid: '1E3A5F',
    chartCategorical: ['0D9488', '3987E5', 'C98500', '9085E9', 'E66767', 'D95926'],
    headingFont: SANS_HEADING_FONT,
    bodyFont: DEFAULT_BODY_FONT,
  },
};

/**
 * Pack palettes. A pack is one art direction, so it has ONE palette rather than
 * a light/dark/brand matrix — the whole point is a committed look. Warm paper
 * instead of white is the single largest reason the editorial pack reads as
 * designed rather than generated: a white background is the default nobody
 * chose.
 */
export const DECK_PACK_STYLES: Record<'editorial' | 'minimal', DeckStyle> = {
  /**
   * Beige-and-black minimalist, built against a specific reference deck rather
   * than invented. Deliberately MONOCHROME — `accent` is the same near-black as
   * `text`, because the reference carries no accent hue at all and gets its
   * contrast from solid black fields against warm paper instead. Charts run a
   * greyscale ramp for the same reason.
   *
   * Arial Black is the heading face: the reference uses an ultra-heavy
   * grotesque, and Arial Black is the only genuinely ultra-heavy sans in the
   * Office/OS-bundled set (fonts are never embedded — see the header note).
   */
  minimal: {
    background: 'EFEBE3', // warm paper
    text: '111111',
    muted: '5A554E',
    accent: '111111', // monochrome by design, not an oversight
    panel: 'E4DFD5',
    grid: 'B0A89C',
    chartCategorical: ['1A1A1A', '4D4D4D', '737373', '9C9C9C', '333333', '616161'],
    headingFont: 'Arial Black',
    bodyFont: 'Arial',
  },
  editorial: {
    background: 'FAF6F0', // warm paper
    text: '1F1B18', // deep ink
    muted: '7D7168',
    accent: 'B4451F', // rust
    panel: 'F0E7DC',
    grid: 'DCD0C2',
    chartCategorical: ['B4451F', '5C6B5A', 'C98A3C', '7A5C4F', '8C6B8A', '4E6472'],
    headingFont: 'Georgia',
    bodyFont: 'Calibri',
  },
};

/** Precedence: an extracted reference style wins, then the pack, then the theme preset. */
export function resolveDeckStyle(
  theme: DeckTheme | undefined,
  style: DeckStyle | null | undefined,
  pack?: 'classic' | 'editorial' | 'minimal',
): DeckStyle {
  if (style) return style;
  if (pack && pack !== 'classic') return DECK_PACK_STYLES[pack];
  return DECK_PRESET_STYLES[theme ?? 'light'];
}

// ---------------------------------------------------------------------------
// Reference-style derivation: OOXML theme scheme → DeckStyle
// ---------------------------------------------------------------------------

/** Raw values pulled from a reference pptx's ppt/theme/theme1.xml. */
export interface ExtractedThemeScheme {
  dk1?: string;
  lt1?: string;
  dk2?: string;
  lt2?: string;
  accents: string[]; // accent1..accent6, hex without '#'
  majorFont?: string; // headings
  minorFont?: string; // body
}

/**
 * Derives a full DeckStyle from an extracted scheme with a contrast guard:
 * - background = lt1, text = dk1 (the OOXML light-surface convention); if
 *   their contrast is < 4.5 the text snaps to black/white by luminance.
 * - accent = first accent with ≥ 2:1 contrast against background (nudged
 *   toward the text color until it clears, if none do).
 * - panel/grid/muted are background→text mixes; chart palette = accents
 *   re-ordered/nudged for ≥ 2:1 against background.
 */
export function deriveDeckStyle(scheme: ExtractedThemeScheme): DeckStyle {
  const fallback = DECK_PRESET_STYLES.light;
  const background = normalizeHex(scheme.lt1) ?? fallback.background;
  let text = normalizeHex(scheme.dk1) ?? fallback.text;
  if (contrastRatio(background, text) < 4.5) {
    text = relativeLuminance(background) > 0.5 ? '111827' : 'F9FAFB';
  }

  const accents = scheme.accents.map(normalizeHex).filter((c): c is string => !!c);
  let accent = accents.find((c) => contrastRatio(background, c) >= 2) ?? accents[0] ?? fallback.accent;
  accent = nudgeForContrast(accent, background, 2);

  const chartCategorical = (accents.length >= 3 ? accents : fallback.chartCategorical).map((c) =>
    nudgeForContrast(c, background, 2),
  );

  return {
    background,
    text,
    muted: mix(background, text, 0.55),
    accent,
    panel: mix(background, text, 0.07),
    grid: mix(background, text, 0.15),
    chartCategorical,
    headingFont: scheme.majorFont?.trim() || DEFAULT_HEADING_FONT,
    bodyFont: scheme.minorFont?.trim() || DEFAULT_BODY_FONT,
  };
}

// ---------------------------------------------------------------------------
// Color math (hex without '#')
// ---------------------------------------------------------------------------

export function normalizeHex(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const hex = raw.replace(/^#/, '').toUpperCase();
  return /^[0-9A-F]{6}$/.test(hex) ? hex : undefined;
}

function channel(hex: string, i: number): number {
  return parseInt(hex.slice(i * 2, i * 2 + 2), 16);
}

export function relativeLuminance(hex: string): number {
  const srgb = [0, 1, 2].map((i) => {
    const c = channel(hex, i) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Linear per-channel mix: 0 → a, 1 → b. */
export function mix(a: string, b: string, t: number): string {
  return [0, 1, 2]
    .map((i) => {
      const v = Math.round(channel(a, i) + (channel(b, i) - channel(a, i)) * t);
      return Math.min(255, Math.max(0, v)).toString(16).padStart(2, '0');
    })
    .join('')
    .toUpperCase();
}

/** Steps a color toward black/white (away from bg) until it clears `target` contrast. */
function nudgeForContrast(color: string, background: string, target: number): string {
  let current = color;
  const towards = relativeLuminance(background) > 0.5 ? '000000' : 'FFFFFF';
  for (let i = 0; i < 10 && contrastRatio(background, current) < target; i++) {
    current = mix(current, towards, 0.15);
  }
  return current;
}
