import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { deckSpecSchema, layoutDeck, resolveDeckStyle, DECK_PRESET_STYLES } from '@use-brian/shared/decks';
import { isPrivateAddress } from '../image-resolve.js';
import { derivePackTokens } from '../pack-derive.js';
import { writeDeckPptx } from '../pptx-writer.js';
import { extractDeckStyle, parseThemeScheme } from '../style-extract.js';

const baseSpec = deckSpecSchema.parse({
  title: 'Quarterly Review',
  subtitle: 'Q2 2026',
  slides: [
    { title: 'Agenda', bullets: ['Numbers', 'Wins', 'Next quarter'], notes: 'Keep it brief' },
    { title: 'The Numbers', layout: 'section' },
    {
      title: 'Traction',
      layout: 'stats',
      stats: [
        { value: '$1.2M', label: 'ARR' },
        { value: '38%', label: 'MoM growth' },
      ],
    },
    { title: 'Customers', layout: 'quote', quote: { text: 'Life changing.', attribution: 'COO, Acme' } },
  ],
});

/** Zip stores entry filenames uncompressed, so slide files are findable in the raw buffer. */
function countSlides(buffer: Buffer): number {
  let count = 0;
  while (buffer.includes(`ppt/slides/slide${count + 1}.xml`)) count++;
  return count;
}

const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** One resolved image keyed by path. `width`/`height` drive the cover crop math. */
function imageMap(path: string, width: number, height: number) {
  return new Map([[path, { data: `data:image/png;base64,${TINY_PNG}`, width, height }]]);
}

async function slideXml(buffer: Buffer, slideNumber: number): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  return zip.file(`ppt/slides/slide${slideNumber}.xml`)!.async('string');
}

describe('[COMP:decks/builder] Deck pptx writer', () => {
  it('renders a valid pptx with one slide per spec slide plus the title slide', async () => {
    const buffer = await writeDeckPptx(baseSpec, null);
    expect(buffer.subarray(0, 2).toString('ascii')).toBe('PK');
    expect(countSlides(buffer)).toBe(baseSpec.slides.length + 1);
    expect(buffer.includes('ppt/notesSlides/notesSlide1.xml')).toBe(true);
  });

  it('builds with every preset theme and an extracted style', async () => {
    for (const theme of ['light', 'dark', 'brand', undefined] as const) {
      const buffer = await writeDeckPptx({ ...baseSpec, theme }, null);
      expect(buffer.subarray(0, 2).toString('ascii')).toBe('PK');
    }
    const styled = await writeDeckPptx(baseSpec, { ...DECK_PRESET_STYLES.dark, headingFont: 'Georgia' });
    expect(styled.subarray(0, 2).toString('ascii')).toBe('PK');
  });

  it('renders every chart type as portable shapes, never OOXML chart parts', async () => {
    for (const type of ['bar', 'line', 'pie', 'doughnut'] as const) {
      const values = type === 'bar' || type === 'line' ? [10, -25, 60] : [10, 25, 60];
      const buffer = await writeDeckPptx(
        deckSpecSchema.parse({
          title: 'Growth',
          slides: [{ title: 'Revenue', chart: { type, labels: ['Q1', 'Q2', 'Q3'], values, unit: '$' } }],
        }),
        null,
      );
      expect(countSlides(buffer)).toBe(2);
      // Keynote silently drops embedded chart XML, so none may exist
      expect(buffer.includes('ppt/charts/chart')).toBe(false);
    }
  });

  it('embeds resolved images into the pptx media folder', async () => {
    const spec = deckSpecSchema.parse({
      title: 'With Image',
      slides: [{ title: 'Screenshot', image: { path: 'uploads/shot.png', caption: 'Our app' } }],
    });
    const buffer = await writeDeckPptx(spec, null, imageMap('uploads/shot.png', 1, 1));
    expect(buffer.includes('ppt/media/image')).toBe(true);
  });

  it('builds the image-led hero and split layouts', async () => {
    const spec = deckSpecSchema.parse({
      title: 'Launch',
      slides: [
        { title: 'Meet Brian', layout: 'hero', subtext: 'Shipping today', image: { path: 'a.png' } },
        { title: 'How it works', layout: 'split', bullets: ['Fast', 'Simple'], image: { path: 'b.png' } },
      ],
    });
    const buffer = await writeDeckPptx(
      spec,
      null,
      new Map([...imageMap('a.png', 1600, 1200), ...imageMap('b.png', 1600, 1200)]),
    );
    expect(buffer.subarray(0, 2).toString('ascii')).toBe('PK');
    expect(countSlides(buffer)).toBe(3);
    expect(buffer.includes('ppt/charts/chart')).toBe(false);
  });

  it('crops cover images instead of stretching them, and leaves contain uncropped', async () => {
    // pptxgenjs derives the crop from the declared w/h ratio vs `sizing`; passing
    // the frame for both yields l=r=t=b=0 and a silently STRETCHED image, which
    // is exactly the bug this asserts against. 4:3 art in a 16:9 frame must lose
    // ~12.5% off top and bottom.
    const hero = deckSpecSchema.parse({
      title: 'Launch',
      slides: [{ title: 'Meet Brian', layout: 'hero', image: { path: 'a.png' } }],
    });
    const covered = await slideXml(await writeDeckPptx(hero, null, imageMap('a.png', 1600, 1200)), 2);
    const crop = /<a:srcRect l="(\d+)" r="(\d+)" t="(\d+)" b="(\d+)"\/>/.exec(covered);
    expect(crop).not.toBeNull();
    const [, l, r, t, b] = crop!.map(Number);
    expect(l).toBe(0);
    expect(r).toBe(0);
    expect(t).toBeGreaterThan(10_000); // >10% cropped off each edge
    expect(t).toBe(b); // centered crop

    // a plain content image still center-fits, so it must carry no crop at all
    const content = deckSpecSchema.parse({
      title: 'Plain',
      slides: [{ title: 'Screenshot', image: { path: 'a.png' } }],
    });
    const contained = await slideXml(await writeDeckPptx(content, null, imageMap('a.png', 1600, 1200)), 2);
    expect(contained).not.toContain('<a:srcRect');
  });

  it('washes the hero image but keeps the text bed opaque', async () => {
    const spec = deckSpecSchema.parse({
      title: 'Launch',
      slides: [{ title: 'Meet Brian', layout: 'hero', image: { path: 'a.png' } }],
    });
    const xml = await slideXml(await writeDeckPptx(spec, null, imageMap('a.png', 1600, 1200)), 2);
    // exactly one translucent fill — the full-page wash at 15% opacity
    expect(xml.match(/<a:alpha val="\d+"\/>/g)).toEqual(['<a:alpha val="15000"/>']);
    // the text bed must carry NO alpha: a translucent band lets a text-bearing
    // image bleed through behind the headline, which reads as a broken render
  });
});

describe('[COMP:decks/style-extract] Reference style extraction', () => {
  const THEME_XML = `<?xml version="1.0"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Custom">
  <a:themeElements>
    <a:clrScheme name="Custom">
      <a:dk1><a:sysClr val="windowText" lastClr="1A1A2E"/></a:dk1>
      <a:lt1><a:sysClr val="window" lastClr="FDFDFD"/></a:lt1>
      <a:dk2><a:srgbClr val="16213E"/></a:dk2>
      <a:lt2><a:srgbClr val="EEEEEE"/></a:lt2>
      <a:accent1><a:srgbClr val="E94560"/></a:accent1>
      <a:accent2><a:srgbClr val="0F3460"/></a:accent2>
      <a:accent3><a:srgbClr val="16C79A"/></a:accent3>
      <a:accent4><a:srgbClr val="533483"/></a:accent4>
      <a:accent5><a:srgbClr val="F0A500"/></a:accent5>
      <a:accent6><a:srgbClr val="798777"/></a:accent6>
    </a:clrScheme>
    <a:fontScheme name="Custom">
      <a:majorFont><a:latin typeface="Montserrat"/></a:majorFont>
      <a:minorFont><a:latin typeface="Lato"/></a:minorFont>
    </a:fontScheme>
  </a:themeElements>
</a:theme>`;

  it('parses scheme colors (srgbClr + sysClr) and latin typefaces', () => {
    const scheme = parseThemeScheme(THEME_XML);
    expect(scheme.dk1).toBe('1A1A2E');
    expect(scheme.lt1).toBe('FDFDFD');
    expect(scheme.accents).toEqual(['E94560', '0F3460', '16C79A', '533483', 'F0A500', '798777']);
    expect(scheme.majorFont).toBe('Montserrat');
    expect(scheme.minorFont).toBe('Lato');
  });

  it('extracts a style from a real .pptx zip', async () => {
    const zip = new JSZip();
    zip.file('ppt/theme/theme1.xml', THEME_XML);
    zip.file('[Content_Types].xml', '<Types/>');
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });
    const style = await extractDeckStyle(bytes);
    expect(style.background).toBe('FDFDFD');
    expect(style.headingFont).toBe('Montserrat');
    expect(style.bodyFont).toBe('Lato');
    expect(style.accent).toBeDefined();
  });

  it('extracts from a deck our own writer produced (round-trip smoke)', async () => {
    const buffer = await writeDeckPptx(baseSpec, null);
    const style = await extractDeckStyle(buffer);
    // pptxgenjs writes a default Office theme — extraction mechanics still work
    expect(style.background).toMatch(/^[0-9A-F]{6}$/);
    expect(style.chartCategorical.length).toBeGreaterThanOrEqual(6);
  });

  it('rejects non-pptx input with an actionable message', async () => {
    await expect(extractDeckStyle(Buffer.from('not a zip'))).rejects.toThrow(/not a valid \.pptx/);
    const zip = new JSZip();
    zip.file('hello.txt', 'hi');
    const noTheme = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(extractDeckStyle(noTheme)).rejects.toThrow(/no PowerPoint theme/);
  });

  it("skips '+mn-lt' placeholder typefaces", () => {
    const xml = THEME_XML.replace('typeface="Montserrat"', 'typeface="+mj-lt"');
    expect(parseThemeScheme(xml).majorFont).toBeUndefined();
  });
});

describe('[COMP:decks/image-resolve] SSRF private-address detection', () => {
  it('flags private, loopback, link-local, CGNAT and v6-local addresses', () => {
    for (const addr of [
      '10.1.2.3',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '192.168.1.1',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      '::',
      'fe80::1',
      'fd12::1',
      '::ffff:10.0.0.1',
      '[::1]',
    ]) {
      expect(isPrivateAddress(addr), addr).toBe(true);
    }
  });

  it('passes public addresses', () => {
    for (const addr of ['8.8.8.8', '104.16.0.1', '2606:4700::6810:1', '172.32.0.1', '100.128.0.1']) {
      expect(isPrivateAddress(addr), addr).toBe(false);
    }
  });
});

describe('[COMP:decks/pack-derive] Pack derivation from a reference', () => {
  /**
   * Round-trip: build a deck from tokens we KNOW, then measure those tokens back
   * out of the binary. Anything the deriver gets wrong here it would also get
   * wrong on a real customer reference — and unlike a real reference, this one
   * has a ground truth to check against.
   */
  const deck = (pack: 'minimal' | 'editorial') =>
    deckSpecSchema.parse({
      title: 'Reference Deck',
      subtitle: 'For derivation',
      pack,
      slides: [
        { title: 'Agenda', bullets: ['Where we are', 'What changed', 'What we are asking for'] },
        { title: 'Traction', layout: 'stats', stats: [{ value: '$1.2M', label: 'ARR' }] },
        { title: 'A claim worth a slide', layout: 'statement', subtext: 'With a supporting line beneath it.' },
      ],
    });

  it('recovers margin, faces and a strictly decreasing type scale', async () => {
    const buffer = await writeDeckPptx(deck('minimal'), null);
    const { tokens, notes } = await derivePackTokens(buffer);

    expect(tokens.margin).toBeCloseTo(0.92, 1); // the minimal pack's actual margin
    expect(tokens.style.headingFont).toBe('Arial Black');
    expect(tokens.style.bodyFont).toBe('Arial');

    const steps = [tokens.type.xl, tokens.type.lg, tokens.type.md, tokens.type.sm, tokens.type.xs].map((s) => s.size);
    expect(steps[0]).toBeGreaterThanOrEqual(40); // a real headline step was found
    for (let i = 1; i < steps.length; i++) {
      // a collapsed step would make two named steps render identically and
      // silently remove a level of hierarchy from every deck built on it
      expect(steps[i]).toBeLessThan(steps[i - 1]);
    }
    expect(notes.join()).toMatch(/chrome .* is not derived/);
  });

  it('reads the art direction, not just the numbers', async () => {
    const min = await derivePackTokens(await writeDeckPptx(deck('minimal'), null));
    const ed = await derivePackTokens(await writeDeckPptx(deck('editorial'), null));

    expect(min.tokens.style.headingFont).not.toBe(ed.tokens.style.headingFont);
    expect(ed.tokens.style.headingFont).toBe('Georgia');
    // minimal sets its covers and dividers in caps; editorial does not
    expect(min.headingCaps).toBe(true);
    expect(ed.headingCaps).toBe(false);
  });

  it('observes slide colours rather than trusting the theme', async () => {
    // pptxgenjs (like most producers) leaves theme1.xml at the Office default
    // and colours every shape directly, so theme-only extraction returns a
    // confident white/black/blue that appears nowhere in the deck.
    const { tokens } = await derivePackTokens(await writeDeckPptx(deck('minimal'), null));
    expect(tokens.style.background).toBe('EFEBE3'); // the pack's warm paper
    expect(tokens.style.text).toBe('111111');
    expect(tokens.style.background).not.toBe('FFFFFF'); // what the theme would have said
  });

  it('keeps a monochrome reference monochrome', async () => {
    // rules and panels are greys between paper and ink; taking the most-used
    // non-text fill promotes one of those to "accent" on every monochrome deck
    const min = await derivePackTokens(await writeDeckPptx(deck('minimal'), null));
    expect(min.tokens.style.accent).toBe(min.tokens.style.text);
    expect(min.notes.join()).toMatch(/monochrome/);

    // a reference that does carry a hue keeps it
    const ed = await derivePackTokens(await writeDeckPptx(deck('editorial'), null));
    expect(ed.tokens.style.accent).not.toBe(ed.tokens.style.text);
  });

  it('refuses a non-pptx rather than returning a confident default', async () => {
    await expect(derivePackTokens(Buffer.from('PK not really a deck'))).rejects.toThrow();
  });

  it('carries type scale and caps on the style, and applies them to the layout', async () => {
    const { tokens } = await derivePackTokens(await writeDeckPptx(deck('minimal'), null));
    expect(tokens.style.typeScale).toBeGreaterThan(0);
    expect(tokens.style.headingCaps).toBe(true);

    // the scale must actually reach the rendered type, or derivation is decorative
    const spec = deckSpecSchema.parse({ title: 'Scaled', slides: [{ title: 'A slide', bullets: ['one'] }] });
    const plain = layoutDeck(spec, { ...tokens.style, typeScale: 1 });
    const scaled = layoutDeck(spec, { ...tokens.style, typeScale: 0.8 });
    const firstSize = (l: typeof plain) =>
      (l[1].primitives.find((p) => p.kind === 'text') as { fontSizePt: number }).fontSizePt;
    expect(firstSize(scaled)).toBeLessThan(firstSize(plain));
    expect(firstSize(scaled)).toBe(Math.round(firstSize(plain) * 0.8));
  });

  it('suppresses a pack caps treatment when the reference does not shout', async () => {
    const spec = deckSpecSchema.parse({ title: 'Quiet Deck', pack: 'minimal', slides: [{ title: 'S', bullets: ['a'] }] });
    const style = resolveDeckStyle(undefined, null, 'minimal');
    const shouty = layoutDeck(spec, style);
    const quiet = layoutDeck(spec, { ...style, headingCaps: false });
    const coverText = (l: typeof shouty) =>
      (l[0].primitives.find((p) => p.kind === 'text') as { paragraphs: { runs: { text: string }[] }[] }).paragraphs[0]
        .runs[0].text;
    expect(coverText(shouty)).toBe('QUIET DECK');
    expect(coverText(quiet)).toBe('Quiet Deck');
  });

  it('degrades to the theme when a reference has no readable slides', async () => {
    // derivation must never fail where plain extraction would have succeeded
    const zip = new JSZip();
    zip.file(
      'ppt/theme/theme1.xml',
      `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements>
        <a:clrScheme name="x"><a:dk1><a:srgbClr val="101010"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
        <a:accent1><a:srgbClr val="CC3366"/></a:accent1></a:clrScheme>
        <a:fontScheme name="x"><a:majorFont><a:latin typeface="Georgia"/></a:majorFont>
        <a:minorFont><a:latin typeface="Verdana"/></a:minorFont></a:fontScheme>
      </a:themeElements></a:theme>`,
    );
    const { tokens, notes } = await derivePackTokens(await zip.generateAsync({ type: 'nodebuffer' }));
    expect(tokens.style.headingFont).toBe('Georgia');
    expect(notes.join()).toMatch(/no readable slides/);
  });
});
