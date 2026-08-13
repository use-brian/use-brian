import { describe, expect, it } from 'vitest'
import { deriveOfficeSnapshot, prepareOfficeRelease, reviewOfficeRelease } from '../release.js'
import { nextOfficeLifecycleState } from '../lifecycle-worker.js'
import { completePresentationSnapshot, completeSpreadsheetSnapshot, documentSnapshot, id, resolveFixtureResource } from '../../../../core/src/office/__tests__/fixtures.js'

function input(overrides: Record<string, unknown> = {}) {
  return { snapshot: documentSnapshot(), expectedVersion: 3, currentVersion: 3, headVersionId: id(30), lifecycleState: 'active', canEdit: true, artifactSensitivity: 'internal' as const, action: 'export' as const, destination: { sensitivity: 'internal' as const, external: false }, claims: [], media: [], ...overrides }
}

describe('[COMP:api/office-release] Office exact-head release', () => {
  it('keeps hard barriers distinct from exact-version warning acknowledgements', () => {
    const claim = { id: id(31), classification: 'unsupported_conflicted', confidence: 0.2, severity: 'high', reasonCode: 'source_conflict', status: 'open' }
    const first = reviewOfficeRelease(input({ claims: [claim] }))
    expect(first).toMatchObject({ status: 'needs_ack', blocks: [], warnings: [{ subjectId: claim.id }] })
    expect(reviewOfficeRelease(input({ claims: [claim], acknowledgement: { version: 2, action: 'export', codes: first.warnings.map((warning) => warning.code) } }))).toMatchObject({ status: 'needs_ack' })
    expect(reviewOfficeRelease(input({ claims: [claim], acknowledgement: { version: 3, action: 'export', codes: first.warnings.map((warning) => warning.code) } }))).toMatchObject({ status: 'ready' })
    expect(reviewOfficeRelease(input({ destination: { sensitivity: 'public', external: true } }))).toMatchObject({ status: 'blocked', blocks: [{ code: 'access.derivative_required' }] })
    expect(reviewOfficeRelease(input({ destination: { sensitivity: 'internal', external: true, disclosureSatisfied: true }, media: [{ id: id(32), provenanceState: 'verified_reusable', disclosureRequired: true }] }))).toMatchObject({ status: 'blocked', blocks: [{ code: `media.${id(32)}.disclosure_required` }] })
  })

  it('creates a separately identified filtered derivative without mutating the source', () => {
    const source = documentSnapshot()
    const chosen = source.sections[0].nodes[0].id
    const derivative = deriveOfficeSnapshot({ source, artifactId: id(40), title: 'Public brief', selectedObjectIds: [chosen] })
    expect(derivative.artifactId).toBe(id(40))
    if (derivative.family !== 'document') throw new Error('expected document derivative')
    expect(derivative.sections.flatMap((section) => section.nodes).map((node) => node.id)).toEqual([chosen])
    expect(source.sections[0].nodes.length).toBeGreaterThan(1)
  })

  it('reviews a spreadsheet PDF against its explicit sheet and print area', () => {
    const snapshot = completeSpreadsheetSnapshot()
    const receipt = reviewOfficeRelease(input({ snapshot, format: 'pdf', spreadsheetPdf: { sheetId: snapshot.activeSheetId, printArea: 'A1:C20', calculationMode: 'automatic', expectedPageCount: 1, preset: 'worksheet' } }))
    expect(receipt).toMatchObject({ status: 'ready', spreadsheetPdf: { sheetId: snapshot.activeSheetId, sheetName: 'Invoice', printArea: 'A1:C20', expectedPageCount: 1, renderer: 'libreoffice', issues: [] } })
  })

  it('preflights and persists a Presentation PDF while native PPTX stays unchanged', async () => {
    const snapshot = completePresentationSnapshot()
    expect(reviewOfficeRelease(input({ snapshot, format: 'pdf' }))).toMatchObject({ status: 'ready' })
    const bytes = new Uint8Array([37, 80, 68, 70])
    const pdf = await prepareOfficeRelease({ ...input({ snapshot, format: 'pdf' }), resolveResource: resolveFixtureResource, presentationPdfPort: { convert: async () => bytes, pageCount: async () => snapshot.slides.length } })
    expect(pdf).toMatchObject({ bytes, mime: 'application/pdf', extension: 'pdf', receipt: { status: 'ready', presentationPdf: { expectedPageCount: 2, actualPageCount: 2, issues: [] } } })
    const native = await prepareOfficeRelease({ ...input({ snapshot, format: 'native' }), resolveResource: resolveFixtureResource })
    expect(native).toMatchObject({ mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', extension: 'pptx' })
    expect(Array.from(native.bytes?.slice(0, 2) ?? [])).toEqual([80, 75])
  })

  it('returns typed Presentation PDF failures', async () => {
    const snapshot = completePresentationSnapshot()
    const result = await prepareOfficeRelease({ ...input({ snapshot, format: 'pdf' }), resolveResource: resolveFixtureResource, presentationPdfPort: { convert: async () => new Uint8Array([1]), pageCount: async () => 1 } })
    expect(result.bytes).toBeUndefined()
    expect(result.receipt).toMatchObject({ status: 'blocked', blocks: [{ code: 'presentation.page_count_mismatch' }], presentationPdf: { expectedPageCount: 2, actualPageCount: 1 } })
  })

  it('advances the two retention clocks but never a legal hold', () => {
    const now = new Date('2026-08-05T00:00:00Z')
    expect(nextOfficeLifecycleState({ state: 'trash', retainAt: new Date('2026-08-04T00:00:00Z'), purgeAt: null, legalHold: false }, now)).toBe('retained')
    expect(nextOfficeLifecycleState({ state: 'retained', retainAt: null, purgeAt: new Date('2026-08-04T00:00:00Z'), legalHold: false }, now)).toBe('purged')
    expect(nextOfficeLifecycleState({ state: 'retained', retainAt: null, purgeAt: new Date('2026-08-04T00:00:00Z'), legalHold: true }, now)).toBeNull()
  })
})
