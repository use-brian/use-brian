import JSZip from 'jszip';
import { DECK_PAGE_H, DECK_PAGE_W, contrastRatio, mix, type DslPackTokens, type DslScale } from '@use-brian/shared/decks';
import { extractDeckStyle } from './style-extract.js';

/**
 * Pack derivation — measure an art direction off a reference `.pptx`.
 * Spec: docs/architecture/features/deck-generation.md → "Pack derivation".
 *
 * `extractDeckStyle` already recovers palette and font faces from the theme.
 * This recovers the rest of what a pack is made of — type SCALE, margin, and
 * whether headings are set in caps — by measuring what the reference actually
 * does across its slides rather than what its master declares. Together they
 * produce a `DslPackTokens`, which is exactly what the composition DSL consumes,
 * so a reference deck plus a model becomes: any style someone can point at.
 *
 * What is deliberately NOT derived: chrome. Ornaments, rules and recurring
 * marks are free-form vector work with no reliable structure to read, and
 * guessing at them would produce a worse imitation than omitting them. A
 * derived pack is tokens only, and `notes` says so.
 *
 * [COMP:decks/pack-derive]
 */

const EMU_PER_IN = 914400;

export interface DerivedPack {
  tokens: DslPackTokens;
  /** Headings appeared in caps in the reference; compositions should set `caps`. */
  headingCaps: boolean;
  /**
   * What could not be measured and was defaulted. Surfaced so a caller never
   * over-trusts a derivation — the honest failure is a stated gap, not a guess.
   */
  notes: string[];
}

interface Run {
  sizePt: number;
  face?: string;
  text: string;
}

function textRuns(slideXml: string): Run[] {
  const runs: Run[] = [];
  for (const m of slideXml.matchAll(/<a:r>([\s\S]*?)<\/a:r>/g)) {
    const body = m[1];
    const sz = /sz="(\d+)"/.exec(body);
    const t = /<a:t>([\s\S]*?)<\/a:t>/.exec(body);
    if (!sz || !t) continue;
    const text = t[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    if (!text.trim()) continue;
    runs.push({ sizePt: Number(sz[1]) / 100, face: /typeface="([^"]+)"/.exec(body)?.[1], text });
  }
  return runs;
}

/**
 * Colours actually used on the slides.
 *
 * The theme is NOT a reliable source: a deck that sets colour per shape leaves
 * `theme1.xml` at the Office default, and extraction then returns a confident
 * white/black/blue that was never in the deck. Our own writer does exactly
 * this, and so does every export that does not build on a themed master. So
 * observation wins and the theme is only the fallback.
 */
function observePalette(slideXmls: string[]): {
  background?: string;
  text?: string;
  accent?: string;
  panel?: string;
} {
  const bg = new Map<string, number>();
  const ink = new Map<string, number>();
  const fills = new Map<string, number>();

  for (const xml of slideXmls) {
    const b = /<p:bg>[\s\S]*?<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(xml);
    if (b) bg.set(b[1].toUpperCase(), (bg.get(b[1].toUpperCase()) ?? 0) + 1);

    // text colour, weighted by how much text is set in it
    for (const m of xml.matchAll(/<a:r>([\s\S]*?)<\/a:r>/g)) {
      const c = /<a:rPr[\s\S]*?<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(m[1]);
      const t = /<a:t>([\s\S]*?)<\/a:t>/.exec(m[1]);
      if (c && t) ink.set(c[1].toUpperCase(), (ink.get(c[1].toUpperCase()) ?? 0) + t[1].length);
    }
    // shape fills, weighted by area — a full-bleed field says more about the
    // palette than a hairline does
    for (const m of xml.matchAll(/<p:spPr>([\s\S]*?)<\/p:spPr>/g)) {
      const c = /<a:solidFill><a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(m[1]);
      const ext = /<a:ext cx="(\d+)" cy="(\d+)"/.exec(m[1]);
      if (!c) continue;
      const area = ext ? (Number(ext[1]) / EMU_PER_IN) * (Number(ext[2]) / EMU_PER_IN) : 1;
      fills.set(c[1].toUpperCase(), (fills.get(c[1].toUpperCase()) ?? 0) + area);
    }
  }
  const top = (m: Map<string, number>, exclude: string[] = []) =>
    [...m.entries()].filter(([k]) => !exclude.includes(k)).sort((a, b) => b[1] - a[1])[0]?.[0];

  const background = top(bg) ?? top(fills);
  const text = top(ink, background ? [background] : []);
  const exclude = [background, text].filter(Boolean) as string[];

  // An accent is a deliberate COLOUR. Rules, hairlines and panels are greys
  // sitting between paper and ink, and taking the most-used non-text fill
  // picks one of those every time on a monochrome reference — which is how a
  // beige-and-black deck came back with a grey "accent" it never had.
  const candidate = top(fills, exclude);
  const chromatic = candidate ? chroma(candidate) >= 25 : false;
  const accent = chromatic ? candidate : undefined;
  const panel = chromatic ? top(fills, [...exclude, candidate!]) : candidate;
  return { background, text, accent, panel };
}

/** Distance from grey: max channel minus min channel, 0-255. */
function chroma(hex: string): number {
  const ch = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return Math.max(...ch) - Math.min(...ch);
}

/** Left edges of positioned shapes, in inches; the modal one is the margin. */
function leftEdges(slideXml: string): number[] {
  return [...slideXml.matchAll(/<a:off x="(-?\d+)" y="(-?\d+)"\/>/g)]
    .map((m) => Number(m[1]) / EMU_PER_IN)
    .filter((x) => x > 0.05 && x < DECK_PAGE_W / 2);
}

/**
 * Five steps from the sizes the reference actually uses, weighted by how much
 * text is set at each. Weighting matters: a 9pt page number appears as often as
 * a 54pt headline but is not a scale step anyone designed around.
 */
function deriveTypeScale(runs: Run[]): { scale: Record<DslScale, number>; note?: string } {
  const weight = new Map<number, number>();
  for (const r of runs) weight.set(r.sizePt, (weight.get(r.sizePt) ?? 0) + r.text.length);
  const distinct = [...weight.keys()].sort((a, b) => b - a);
  if (!distinct.length) {
    return { scale: { xl: 54, lg: 34, md: 20, sm: 16, xs: 13 }, note: 'no sized text found — type scale is a default, not measured' };
  }
  const xl = distinct[0];
  const xs = distinct[distinct.length - 1];
  // the body step is whatever carries the most text, not whatever sits in the middle
  const md = [...weight.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const between = (lo: number, hi: number) => distinct.find((s) => s > lo && s < hi);
  const lg = between(md, xl) ?? Math.round((md + xl) / 2);
  const sm = between(xs, md) ?? Math.round((xs + md) / 2);
  // force a strictly decreasing scale — a collapsed step would make two named
  // steps render identically and quietly remove a level of hierarchy
  const out = [xl, lg, md, sm, xs];
  for (let i = 1; i < out.length; i++) if (out[i] >= out[i - 1]) out[i] = Math.max(out[i - 1] - 2, 8);
  const note = distinct.length < 5 ? `reference uses only ${distinct.length} distinct sizes — some steps interpolated` : undefined;
  return { scale: { xl: out[0], lg: out[1], md: out[2], sm: out[3], xs: out[4] }, note };
}

export async function derivePackTokens(bytes: Uint8Array | Buffer): Promise<DerivedPack> {
  const notes: string[] = [];
  const zip = await JSZip.loadAsync(bytes);

  const presentation = await zip.file('ppt/presentation.xml')?.async('string');
  if (presentation) {
    const sz = /<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/.exec(presentation);
    if (sz) {
      const w = Number(sz[1]) / EMU_PER_IN;
      const h = Number(sz[2]) / EMU_PER_IN;
      if (Math.abs(w / h - DECK_PAGE_W / DECK_PAGE_H) > 0.02) {
        notes.push(
          `reference is ${w.toFixed(2)}x${h.toFixed(2)}" (${(w / h).toFixed(2)}:1); decks render 16:9, so its proportions will not transfer exactly`,
        );
      }
    }
  }

  const slideNames = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  if (!slideNames.length) throw new Error('that file has no slides — is it a .pptx?');
  const runs: Run[] = [];
  const edges: number[] = [];
  const slideXmls: string[] = [];
  for (const name of slideNames) {
    const xml = await zip.file(name)!.async('string');
    slideXmls.push(xml);
    runs.push(...textRuns(xml));
    edges.push(...leftEdges(xml));
  }

  const { scale, note } = deriveTypeScale(runs);
  if (note) notes.push(note);

  // margin: the most common left edge, to the nearest 0.05"
  let margin = 0.9;
  if (edges.length) {
    const buckets = new Map<number, number>();
    for (const e of edges) {
      const k = Math.round(e * 20) / 20;
      buckets.set(k, (buckets.get(k) ?? 0) + 1);
    }
    margin = [...buckets.entries()].sort((a, b) => b[1] - a[1])[0][0];
  } else {
    notes.push('no positioned shapes found — margin is a default, not measured');
  }

  // faces: prefer what the reference actually sets at each step over the theme,
  // since a deck can and often does override its own theme fonts
  const faceAt = (pt: number) => runs.filter((r) => r.sizePt === pt && r.face).sort((a, b) => b.text.length - a.text.length)[0]?.face;
  const headingFace = faceAt(scale.xl) ?? faceAt(scale.lg);
  const bodyFace = faceAt(scale.md) ?? faceAt(scale.sm);

  const style = await extractDeckStyle(bytes);
  if (headingFace) style.headingFont = headingFace;
  if (bodyFace) style.bodyFont = bodyFace;
  if (!headingFace && !bodyFace) notes.push('no run-level fonts found — faces come from the theme scheme');

  // Observed colour beats the theme wherever it exists (see observePalette).
  const seen = observePalette(slideXmls);
  if (seen.background && seen.text) {
    style.background = seen.background;
    style.text = seen.text;
    // A reference with no distinct accent is MONOCHROME by design, not missing
    // one — collapse accent onto text rather than importing a stray theme blue.
    style.accent = seen.accent ?? seen.text;
    style.panel = seen.panel ?? mix(seen.background, seen.text, 0.07);
    style.muted = mix(seen.background, seen.text, 0.55);
    style.grid = mix(seen.background, seen.text, 0.2);
    if (!seen.accent) notes.push('no accent colour distinct from text — treating the reference as monochrome');
    if (contrastRatio(style.background, style.text) < 4.5) {
      notes.push('observed background/text contrast is below 4.5:1 — the reference may rely on imagery for legibility');
    }
    style.chartCategorical = style.chartCategorical.map((c) => (contrastRatio(style.background, c) >= 2 ? c : style.text));
  } else {
    notes.push('could not observe slide colours — palette comes from the theme, which many decks leave at the Office default');
  }

  // caps: measured on the largest step, where a caps treatment actually shows
  const big = runs.filter((r) => r.sizePt >= scale.lg && /[A-Za-z]/.test(r.text));
  const headingCaps = big.length > 0 && big.filter((r) => r.text === r.text.toUpperCase()).length / big.length > 0.6;

  notes.push('chrome (ornaments, recurring marks) is not derived — a derived pack is tokens only');

  return {
    tokens: {
      style,
      margin,
      type: {
        xl: { size: scale.xl, face: 'heading', bold: true },
        lg: { size: scale.lg, face: 'heading', bold: true },
        md: { size: scale.md, face: 'body' },
        sm: { size: scale.sm, face: 'body' },
        xs: { size: scale.xs, face: 'body', bold: true },
      },
    },
    headingCaps,
    notes,
  };
}
