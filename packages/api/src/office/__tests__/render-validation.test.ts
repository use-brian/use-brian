import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { renderedPdfPageCount } from '@use-brian/core/files/libreoffice.js'
import { validateOfficeCandidateRendering, validateOfficeInternalCandidateRendering } from '../render-validation.js'
import { documentSnapshot, completePresentationSnapshot, completeSpreadsheetSnapshot, resolveFixtureResource } from '../../../../core/src/office/__tests__/fixtures.js'
import { minimalPdf } from '../../../../core/src/files/__tests__/pdf-fixture.js'

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const port = (pdf = minimalPdf()) => ({ convert: vi.fn(async () => pdf), pageCount: renderedPdfPageCount })
describe('[COMP:api/office-render-validation] candidate render validation', () => {
  it('converts the exact exported DOCX bytes, parses a real PDF and binds the receipt', async () => {
    const snapshot = documentSnapshot()
    const original = structuredClone(snapshot)
    const mock = port()
    const result = await validateOfficeCandidateRendering({ snapshot, port: mock })
    expect(result.receipt).toMatchObject({ ok: true, estimatedPageCount: 1, actualPageCount: 1, renderer: 'libreoffice', issues: [] })
    expect(Array.from(result.exportBytes!.slice(0, 2))).toEqual([80, 75])
    expect(mock.convert).toHaveBeenCalledWith(new Uint8Array(result.exportBytes!), expect.objectContaining({ inputName: 'candidate.docx' }))
    expect(result.receipt.exportHash).toBe(digest(result.exportBytes!))
    expect(result.receipt.pdfHash).toBe(digest(minimalPdf()))
    expect(result.receipt.limitations.join(' ')).toContain('not a guarantee')
    expect(snapshot).toEqual(original)
    snapshot.title = 'New candidate'
    const newer = await validateOfficeCandidateRendering({ snapshot, port: port() })
    expect(newer.receipt.candidateHash).not.toBe(result.receipt.candidateHash)
  })
  it('exports PPTX through the same converter with slide count checks', async () => {
    const snapshot = completePresentationSnapshot()
    snapshot.slides = [snapshot.slides[0]]
    snapshot.resources = []
    snapshot.slides[0].objects = snapshot.slides[0].objects.filter(object => object.kind === 'text')
    snapshot.slides[0].readingOrder = snapshot.slides[0].objects.map(object => object.id)
    const mock = port()
    const result = await validateOfficeCandidateRendering({ snapshot, port: mock })
    expect(result.receipt, JSON.stringify(result.receipt)).toMatchObject({ ok: true })
    expect(mock.convert).toHaveBeenCalledWith(new Uint8Array(result.exportBytes!), expect.objectContaining({ inputName: 'candidate.pptx' }))
  })
  it('validates XLSX without silently changing print scope', async () => {
    const snapshot = completeSpreadsheetSnapshot()
    const request = { sheetId: snapshot.activeSheetId, printArea: 'A1:C20', expectedPageCount: 1, preset: 'worksheet' as const, calculationMode: 'automatic' as const }
    const mock = port()
    const result = await validateOfficeCandidateRendering({ snapshot, spreadsheetPdf: request, port: mock, resolveResource: resolveFixtureResource })
    expect(result.receipt, JSON.stringify(result.receipt)).toMatchObject({ ok: true })
    expect(mock.convert).toHaveBeenCalledWith(new Uint8Array(result.exportBytes!), expect.objectContaining({ inputName: 'candidate.xlsx' }))
    const denied = await validateOfficeCandidateRendering({ snapshot, spreadsheetPdf: { ...request, printArea: 'A1:B2' }, port: mock })
    expect(denied.receipt).toMatchObject({ ok: false, issues: [expect.objectContaining({ code: 'print_scope_required' })] })
    expect(mock.convert).toHaveBeenCalledTimes(1)
    expect((await validateOfficeCandidateRendering({ snapshot, port: mock })).receipt.ok).toBe(false)
  })
  it.each([new Uint8Array(), Buffer.from('%PDF fake'), Buffer.from('not PDF')])('fails closed for empty or unreadable conversion output', async pdf => {
    const result = await validateOfficeCandidateRendering({ snapshot: documentSnapshot(), port: port(Buffer.from(pdf)) })
    expect(result.receipt).toMatchObject({ ok: false, issues: [expect.objectContaining({ code: 'invalid_pdf' })] })
  })
  it('fails closed when a converter returns no output at runtime', async () => {
    const result = await validateOfficeCandidateRendering({ snapshot: documentSnapshot(), port: { ...port(), convert: async () => undefined as unknown as Uint8Array } })
    expect(result.receipt).toMatchObject({ ok: false, issues: [{ code: 'invalid_pdf' }] })
  })
  it.each([0, NaN, Infinity, 1.5])('rejects invalid parsed page count %s', async count => {
    const result = await validateOfficeCandidateRendering({ snapshot: documentSnapshot(), port: { convert: async () => minimalPdf(), pageCount: async () => count } })
    expect(result.receipt.ok).toBe(false)
  })
  it('blocks page mismatch and converter failure', async () => {
    const mismatch = await validateOfficeCandidateRendering({ snapshot: documentSnapshot(), documentPageConstraints: { exact: 1 }, port: port(minimalPdf(2)) })
    expect(mismatch.receipt).toMatchObject({ ok: false, actualPageCount: 2, issues: [{ code: 'page_count_mismatch' }] })
    const failed = await validateOfficeCandidateRendering({ snapshot: documentSnapshot(), port: { ...port(), convert: async () => { throw new Error('converter_unavailable') } } })
    expect(failed.receipt).toMatchObject({ ok: false, issues: [{ code: 'conversion' }] })
  })
  it('does not treat heuristic Word pagination as an exact production constraint', async () => {
    const result = await validateOfficeCandidateRendering({ snapshot: documentSnapshot(), port: port(minimalPdf(3)) })
    expect(result.receipt).toMatchObject({ ok: true, estimatedPageCount: 1, actualPageCount: 3, minimumPageCount: 1 })
    expect(result.receipt.expectedPageCount).toBeUndefined()
    expect(result.receipt.warnings.join(' ')).toContain('LibreOffice rendered 3')
    const limited = await validateOfficeCandidateRendering({ snapshot: documentSnapshot(), fitBudget: { maxPages: 2 }, port: port(minimalPdf(3)) })
    expect(limited.receipt).toMatchObject({ ok: false, maximumPageCount: 2, actualPageCount: 3, issues: [expect.objectContaining({ code: 'page_count_mismatch' })] })
    const fitsLimit = await validateOfficeCandidateRendering({ snapshot: documentSnapshot(), documentPageConstraints: { max: 4 }, port: port(minimalPdf(3)) })
    expect(fitsLimit.receipt.ok).toBe(true)
  })
  it.each([NaN, 0, -1, 1.5])('rejects invalid explicit Word page constraints: %s', async max => {
    const mock = port()
    expect((await validateOfficeCandidateRendering({ snapshot: documentSnapshot(), documentPageConstraints: { max }, port: mock })).receipt.ok).toBe(false)
    expect(mock.convert).not.toHaveBeenCalled()
  })
  it('internal promotion reparses the exact converted bytes and rejects an unrelated native export', async () => {
    const snapshot = documentSnapshot()
    const original = await validateOfficeInternalCandidateRendering({ snapshot, port: port(minimalPdf(2)) })
    expect(original.receipt).toMatchObject({ ok: true, actualPageCount: 2 })
    const changed = structuredClone(snapshot)
    changed.title = 'Different candidate'
    const mismatched = await validateOfficeInternalCandidateRendering({ snapshot: changed, exportBytes: original.exportBytes, port: port(minimalPdf(2)) })
    expect(mismatched.receipt).toMatchObject({ ok: false, issues: [expect.objectContaining({ code: 'export_reparse_mismatch' })] })
  })
  it('does not convert deterministic failures', async () => {
    const mock = port()
    const result = await validateOfficeCandidateRendering({ snapshot: documentSnapshot(), fitBudget: { maxPages: 0 }, port: mock })
    expect(result.receipt.ok).toBe(false)
    expect(mock.convert).not.toHaveBeenCalled()
  })
  it.runIf(process.env.OFFICE_RENDER_VALIDATION_REAL === '1')('uses the production LibreOffice converter and real PDF parser', async () => {
    const result = await validateOfficeCandidateRendering({ snapshot: documentSnapshot() })
    expect(result.receipt).toMatchObject({ ok: true, actualPageCount: 1, issues: [] })
  }, 120_000)
})
