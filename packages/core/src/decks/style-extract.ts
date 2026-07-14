import JSZip from 'jszip';
import { deriveDeckStyle, type DeckStyle, type ExtractedThemeScheme } from '@sidanclaw/shared/decks';

/**
 * Extracts a DeckStyle from a reference .pptx — palette + typography only.
 * Reads ppt/theme/theme1.xml (color scheme + font scheme); it does NOT clone
 * slide geometry or master layouts. Spec: deck-generation.md → "Style-from-
 * reference".
 *
 * Throws Error with a model-actionable message on non-pptx input.
 */
export async function extractDeckStyle(bytes: Buffer | Uint8Array): Promise<DeckStyle> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new Error('reference file is not a valid .pptx (could not read it as a zip archive)');
  }

  // theme1.xml is the deck-level theme; numbered variants exist per master.
  const themeEntry =
    zip.file('ppt/theme/theme1.xml') ?? zip.file(/^ppt\/theme\/theme\d+\.xml$/)[0] ?? null;
  if (!themeEntry) {
    throw new Error('reference file has no PowerPoint theme (ppt/theme/theme1.xml missing) — is it really a .pptx?');
  }
  const xml = await themeEntry.async('string');
  return deriveDeckStyle(parseThemeScheme(xml));
}

/**
 * Minimal OOXML theme parsing via targeted regexes — the four scheme colors,
 * six accents, and the major/minor latin typefaces. A full XML parser buys
 * nothing here: DrawingML theme files are machine-generated with a fixed
 * element vocabulary.
 */
export function parseThemeScheme(xml: string): ExtractedThemeScheme {
  return {
    dk1: schemeColor(xml, 'dk1'),
    lt1: schemeColor(xml, 'lt1'),
    dk2: schemeColor(xml, 'dk2'),
    lt2: schemeColor(xml, 'lt2'),
    accents: ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6']
      .map((name) => schemeColor(xml, name))
      .filter((c): c is string => !!c),
    majorFont: latinTypeface(xml, 'majorFont'),
    minorFont: latinTypeface(xml, 'minorFont'),
  };
}

/** <a:dk1><a:srgbClr val="1F2937"/></a:dk1> or <a:sysClr val="windowText" lastClr="000000"/> */
function schemeColor(xml: string, name: string): string | undefined {
  const block = xml.match(new RegExp(`<a:${name}>([\\s\\S]*?)</a:${name}>`))?.[1];
  if (!block) return undefined;
  const srgb = block.match(/<a:srgbClr[^>]*\bval="([0-9A-Fa-f]{6})"/)?.[1];
  if (srgb) return srgb.toUpperCase();
  const sys = block.match(/<a:sysClr[^>]*\blastClr="([0-9A-Fa-f]{6})"/)?.[1];
  return sys?.toUpperCase();
}

/** <a:majorFont><a:latin typeface="Montserrat"/>… */
function latinTypeface(xml: string, scope: 'majorFont' | 'minorFont'): string | undefined {
  const block = xml.match(new RegExp(`<a:${scope}>([\\s\\S]*?)</a:${scope}>`))?.[1];
  const face = block?.match(/<a:latin[^>]*\btypeface="([^"]*)"/)?.[1]?.trim();
  // '+mn-lt'-style placeholder references and empty faces mean "inherit" — skip
  return face && !face.startsWith('+') ? face : undefined;
}
