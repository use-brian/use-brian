/**
 * [COMP:brand/typography-gate] — the brand typography register at template admission.
 *
 * The judgment this encodes is severity. These are WARNINGS, and the tests
 * that matter most are the ones proving they cannot become errors by
 * accident: a brand record is usually incomplete (only `naming.name` is
 * required), and failing template admission over an unfinished register would
 * make the whole primitive something people route around.
 *
 * The other property worth pinning is the empty-register case. "No typography
 * recorded" means "not captured yet", never "nothing is licensed" — warning on
 * every family there would make the check pure noise for the many workspaces
 * whose brand is still a name and a tagline.
 *
 * Fixture data is invented.
 */

import { describe, it, expect } from 'vitest'
import type { DocumentSnapshot } from '@use-brian/office-model'
import type { BrandRight, TypeRole } from '@use-brian/shared'
import { reviewBrandTypography } from '../brand-typography.js'

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`

/** A one-paragraph document set in `family`. */
function docInFont(family: string): DocumentSnapshot {
  return {
    schemaVersion: 1, capabilityVersion: 1,
    artifactId: id(1), workspaceId: id(2), family: 'document',
    locale: 'en-US', defaultLanguage: 'en-US', templateVersionId: id(3), rootId: id(4),
    title: 'Template', resources: [], accessibility: { title: 'Template' },
    sections: [{
      id: id(5),
      page: { widthPt: 612, heightPt: 792, marginTopPt: 72, marginRightPt: 72, marginBottomPt: 72, marginLeftPt: 72, orientation: 'portrait' },
      header: [], footer: [], showPageNumber: true,
      nodes: [{
        id: id(6), kind: 'paragraph', styleName: 'Body', alignment: 'start',
        runs: [{
          id: id(7), text: 'Body copy.',
          style: { fontFamily: family, fontSizePt: 11, bold: false, italic: false, underline: false, strike: false, color: '#111111' },
        }],
      }],
    }],
  } as DocumentSnapshot
}

const INTER: TypeRole = {
  role: 'body', family: 'Inter', treatment: '400 weight',
  fallback: 'Helvetica Neue, Arial, sans-serif', licence: 'SIL Open Font License 1.1',
}

const codes = (d: { code: string }[]) => d.map((x) => x.code)

describe('[COMP:brand/typography-gate] severity is warning, never error', () => {
  it('never emits an error diagnostic', () => {
    // `ok` on the compile receipt keys off errors only. If any of these became
    // an error, an incomplete brand record would start failing template
    // admission — which is how a governance feature becomes a thing people
    // route around.
    const out = reviewBrandTypography({
      snapshot: docInFont('Comic Sans MS'),
      brand: { typography: [INTER], rights: [] },
    })
    expect(out.length).toBeGreaterThan(0)
    expect(out.every((d) => d.severity === 'warning')).toBe(true)
  })
})

describe('[COMP:brand/typography-gate] what it flags', () => {
  it('flags a family the brand does not account for', () => {
    const out = reviewBrandTypography({
      snapshot: docInFont('Comic Sans MS'),
      brand: { typography: [INTER], rights: [] },
    })
    expect(codes(out)).toEqual(['template.brand_font_unlisted'])
    expect(out[0].message).toContain('Comic Sans MS')
  })

  it('accepts the declared family', () => {
    expect(reviewBrandTypography({ snapshot: docInFont('Inter'), brand: { typography: [INTER], rights: [] } })).toEqual([])
  })

  it('accepts a family named in the fallback stack', () => {
    // A brand declaring `fallback: "Helvetica Neue, Arial, sans-serif"` has
    // considered those; flagging them would be noise on every template.
    expect(reviewBrandTypography({ snapshot: docInFont('Arial'), brand: { typography: [INTER], rights: [] } })).toEqual([])
    expect(reviewBrandTypography({ snapshot: docInFont('Helvetica Neue'), brand: { typography: [INTER], rights: [] } })).toEqual([])
  })

  it('ignores case and whitespace differences', () => {
    expect(reviewBrandTypography({ snapshot: docInFont('  inter '), brand: { typography: [INTER], rights: [] } })).toEqual([])
  })

  it('accepts a family the rights register names even without a type role', () => {
    // A brand can license a face for one artifact without giving it a standing
    // role in the type system.
    const right: BrandRight = { asset: 'Playfair Display', creator: 'Invented Foundry', licence: 'Desktop + embedding' }
    expect(reviewBrandTypography({
      snapshot: docInFont('Playfair Display'),
      brand: { typography: [INTER], rights: [right] },
    })).toEqual([])
  })

  it('flags a listed family whose licence is unrecorded', () => {
    const noLicence: TypeRole = { ...INTER, licence: undefined }
    const out = reviewBrandTypography({ snapshot: docInFont('Inter'), brand: { typography: [noLicence], rights: [] } })
    expect(codes(out)).toEqual(['template.brand_font_licence_unrecorded'])
    expect(out[0].message).toContain('body')
  })
})

describe('[COMP:brand/typography-gate] what it stays quiet about', () => {
  it('says nothing when the typography register is empty', () => {
    // "Not captured yet", not "nothing is licensed".
    expect(reviewBrandTypography({ snapshot: docInFont('Anything'), brand: { typography: [], rights: [] } })).toEqual([])
  })

  it('does not treat a generic CSS keyword as a licensable typeface', () => {
    const out = reviewBrandTypography({ snapshot: docInFont('sans-serif'), brand: { typography: [INTER], rights: [] } })
    // `sans-serif` reaches the check via the fallback stack, but nobody
    // licenses it — and flagging it would be nonsense either way.
    expect(out).toEqual([])
  })

  it('reports each unlisted family once, not once per run', () => {
    const doc = docInFont('Comic Sans MS')
    doc.sections[0].nodes.push({
      id: id(8), kind: 'paragraph', styleName: 'Body', alignment: 'start',
      runs: [{
        id: id(9), text: 'More body copy.',
        style: { fontFamily: 'Comic Sans MS', fontSizePt: 11, bold: false, italic: false, underline: false, strike: false, color: '#111111' },
      }],
    })
    expect(reviewBrandTypography({ snapshot: doc, brand: { typography: [INTER], rights: [] } })).toHaveLength(1)
  })
})
