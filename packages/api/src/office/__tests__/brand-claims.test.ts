/**
 * [COMP:brand/claim-gate] — the brand claims register at the Office release gate.
 *
 * Two properties carry the weight.
 *
 * `prohibited` must BLOCK, not warn. It is the only place in the system where
 * a standing "never say this" decision is enforced, and a warning is
 * acknowledgeable — which would make the register advisory.
 *
 * And the matcher's limits must be the documented ones, not accidental ones.
 * It is a normalized exact-phrase rule: it misses paraphrase and it fires on
 * negation. Both are asserted here on purpose, so a future change to either
 * behaviour is a deliberate decision rather than a silent drift in what a
 * release gate lets through.
 *
 * Fixture data is invented.
 */

import { describe, it, expect } from 'vitest'
import type { BrandClaim } from '@use-brian/shared'
import type { DocumentSnapshot, PresentationSnapshot } from '@use-brian/office-model'
import { normalizeClaimText, reviewBrandClaims } from '../brand-claims.js'

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`
const style = { fontFamily: 'Arial', fontSizePt: 11, bold: false, italic: false, underline: false, strike: false, color: '#111111' }

// Fixtures are built here rather than imported from office-model's test dir:
// that package exports only `.`, so reaching into its dist/__tests__ would
// route around its own exports map.

/** A document whose body says exactly `text`. */
function docSaying(text: string): DocumentSnapshot {
  return {
    schemaVersion: 1, capabilityVersion: 1,
    artifactId: id(1), workspaceId: id(2), family: 'document',
    locale: 'en-US', defaultLanguage: 'en-US', templateVersionId: id(3), rootId: id(4),
    title: 'Quarterly update', resources: [], accessibility: { title: 'Quarterly update' },
    sections: [{
      id: id(5),
      page: { widthPt: 612, heightPt: 792, marginTopPt: 72, marginRightPt: 72, marginBottomPt: 72, marginLeftPt: 72, orientation: 'portrait' },
      header: [], footer: [], showPageNumber: true,
      nodes: [{ id: id(90), kind: 'paragraph', styleName: 'Body', alignment: 'start', runs: [{ id: id(91), text, style }] }],
    }],
  } as DocumentSnapshot
}

/** A one-slide deck whose only text object says exactly `text`. */
function deckSaying(text: string): PresentationSnapshot {
  return {
    schemaVersion: 1, capabilityVersion: 1,
    artifactId: id(11), workspaceId: id(2), family: 'presentation',
    locale: 'en-US', defaultLanguage: 'en-US', templateVersionId: id(3), rootId: id(12),
    title: 'Pitch', resources: [], accessibility: { title: 'Pitch' },
    slideSize: { widthPt: 960, heightPt: 540 }, themeId: id(13),
    masters: [{ id: id(14), name: 'Master', lockedObjectIds: [] }],
    layouts: [{ id: id(15), masterId: id(14), name: 'Title', placeholderIds: [] }],
    slides: [{
      id: id(16), title: 'Opening', masterId: id(14), layoutId: id(15), notes: [],
      objects: [{
        id: id(95), kind: 'text',
        geometry: { xPt: 0, yPt: 0, widthPt: 100, heightPt: 100, rotationDeg: 0 },
        locked: false, alignment: 'start', verticalAlignment: 'top',
        runs: [{ id: id(96), text, style }],
      }],
      readingOrder: [id(95)],
    }],
  } as PresentationSnapshot
}

const PROHIBITED: BrandClaim = { text: 'The safest crossing available.', status: 'prohibited' }
const UNVERIFIED: BrandClaim = { text: 'The largest coastal operator in the region.', status: 'unverified' }
const APPROVED: BrandClaim = { text: '98% of sailings depart within ten minutes of schedule.', status: 'approved' }

describe('[COMP:brand/claim-gate] severity', () => {
  it('blocks a prohibited claim', () => {
    const out = reviewBrandClaims({ snapshot: docSaying('We are the safest crossing available.'), claims: [PROHIBITED] })
    expect(out.blocks).toHaveLength(1)
    expect(out.warnings).toHaveLength(0)
    expect(out.blocks[0].code).toMatch(/^brand\.claim\.prohibited\./)
  })

  it('warns on an unverified claim', () => {
    const out = reviewBrandClaims({ snapshot: docSaying('We are the largest coastal operator in the region.'), claims: [UNVERIFIED] })
    expect(out.blocks).toHaveLength(0)
    expect(out.warnings).toHaveLength(1)
  })

  it('says nothing about an approved claim', () => {
    // Finding one is the system working, not a finding.
    const out = reviewBrandClaims({ snapshot: docSaying('98% of sailings depart within ten minutes of schedule.'), claims: [APPROVED] })
    expect(out.blocks).toHaveLength(0)
    expect(out.warnings).toHaveLength(0)
  })

  it('contributes nothing when the register is empty', () => {
    const out = reviewBrandClaims({ snapshot: docSaying('Anything at all.'), claims: [] })
    expect(out).toEqual({ blocks: [], warnings: [] })
  })
})

describe('[COMP:brand/claim-gate] locating the finding', () => {
  it('names where the claim appears', () => {
    const out = reviewBrandClaims({ snapshot: docSaying('We are the safest crossing available.'), claims: [PROHIBITED] })
    // "somewhere in this document" leaves the author hunting; "section 1" does not.
    expect(out.blocks[0].subjectId).toBe('section 1')
    expect(out.blocks[0].message).toContain('section 1')
  })

  it('finds a claim on a slide and names the slide', () => {
    const out = reviewBrandClaims({ snapshot: deckSaying('The safest crossing available.'), claims: [PROHIBITED] })
    expect(out.blocks[0].subjectId).toBe('slide 1')
  })

  it('truncates a long claim in the message rather than pasting a paragraph', () => {
    const long = `${'A very long standing claim about the service. '.repeat(6)}`
    const out = reviewBrandClaims({ snapshot: docSaying(long), claims: [{ text: long, status: 'prohibited' }] })
    expect(out.blocks[0].message).toContain('...')
    expect(out.blocks[0].message.length).toBeLessThan(400)
  })
})

describe('[COMP:brand/claim-gate] normalization', () => {
  it('ignores case, punctuation, and whitespace runs', () => {
    const out = reviewBrandClaims({
      snapshot: docSaying('we are   THE SAFEST crossing available'),
      claims: [PROHIBITED],
    })
    expect(out.blocks).toHaveLength(1)
  })

  it('matches across a curly apostrophe', () => {
    // A register entry typed in a form and the same sentence typed into a deck
    // routinely differ only by this character.
    const claim: BrandClaim = { text: "The world's safest crossing.", status: 'prohibited' }
    const out = reviewBrandClaims({ snapshot: docSaying('We offer the world’s safest crossing.'), claims: [claim] })
    expect(out.blocks).toHaveLength(1)
  })

  it('normalizes hyphens and dashes to spaces', () => {
    expect(normalizeClaimText('best-in-class service')).toBe('best in class service')
    expect(normalizeClaimText('best — in — class service')).toBe('best in class service')
  })
})

describe('[COMP:brand/claim-gate] documented limits', () => {
  it('MISSES a paraphrase — the gate is a floor, not a guarantee', () => {
    const out = reviewBrandClaims({ snapshot: docSaying('We are the safest crossing there is.'), claims: [PROHIBITED] })
    expect(out.blocks).toHaveLength(0)
  })

  it('FIRES on a negation — which is why a block stays reviewable', () => {
    // "we never claim X" contains X. A literal matcher cannot tell them apart,
    // and a fuzzy one would be unpredictable on a path that blocks an export.
    // The remedy is that an author can rephrase and an admin can edit the
    // register — not that the matcher gets cleverer.
    const out = reviewBrandClaims({
      snapshot: docSaying('We never claim to be the safest crossing available.'),
      claims: [PROHIBITED],
    })
    expect(out.blocks).toHaveLength(1)
  })

  it('skips a claim too short to match without coincidence', () => {
    // "We deliver." would fire on any artifact containing that fragment.
    const out = reviewBrandClaims({
      snapshot: docSaying('We deliver. And we do it well.'),
      claims: [{ text: 'We deliver.', status: 'prohibited' }],
    })
    expect(out.blocks).toHaveLength(0)
  })
})

describe('[COMP:brand/claim-gate] coverage', () => {
  it('finds a claim hidden in image alt text', () => {
    const doc = docSaying('An ordinary sentence.')
    doc.sections[0].nodes.push({
      id: id(97), kind: 'image', resourceId: id(98),
      altText: 'A photo captioned: the safest crossing available.',
      decorative: false, widthPt: 100, heightPt: 100,
    })
    // It still ships to the customer and is still read aloud.
    expect(reviewBrandClaims({ snapshot: doc, claims: [PROHIBITED] }).blocks).toHaveLength(1)
  })

  it('reports each matching claim separately', () => {
    const out = reviewBrandClaims({
      snapshot: docSaying('The safest crossing available. The largest coastal operator in the region.'),
      claims: [PROHIBITED, UNVERIFIED],
    })
    expect(out.blocks).toHaveLength(1)
    expect(out.warnings).toHaveLength(1)
    expect(out.blocks[0].code).not.toBe(out.warnings[0].code)
  })
})
