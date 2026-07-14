import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { deckSpecSchema, DECK_PRESET_STYLES } from '@sidanclaw/shared/decks';
import { isPrivateAddress } from '../image-resolve.js';
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
    const TINY_PNG =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const spec = deckSpecSchema.parse({
      title: 'With Image',
      slides: [{ title: 'Screenshot', image: { path: 'uploads/shot.png', caption: 'Our app' } }],
    });
    const buffer = await writeDeckPptx(
      spec,
      null,
      new Map([['uploads/shot.png', { data: `data:image/png;base64,${TINY_PNG}`, width: 1, height: 1 }]]),
    );
    expect(buffer.includes('ppt/media/image')).toBe(true);
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
