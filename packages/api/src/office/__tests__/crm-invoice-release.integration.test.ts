import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { extractPdfText, importOfficeSpreadsheet, renderedPdfPageCount } from '@use-brian/core'
import { recalculateSpreadsheet, type SpreadsheetSnapshot } from '@use-brian/office-model'
import { getAppPool, getPool } from '../../db/client.js'
import { createCommercialDocumentHarness, lines, seedInvoiceWorkspace } from '../../crm-operations/__tests__/commercial-document-fixture.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
const harness = await createCommercialDocumentHarness(pool)
afterAll(async () => { await pool.end(); await getAppPool().end(); await getPool().end() })

async function issued(classification?: 'confidential') {
  const f = await seedInvoiceWorkspace(pool, harness)
  let accountId = f.accountId
  if (classification) {
    const account = await f.exec(f.owner, { kind: 'save_customer_account', account: { sellerKey: 'studio', companyId: f.company, label: 'Restricted retainer account',
      billingAddress: '2 Example Road, Example City' }, classification: { sensitivity: classification } })
    accountId = (account.record.account as { id: string }).id
  }
  const prepared = await f.exec(f.owner, { kind: 'prepare_commercial_document', operationKey: 'invoice', accountId, dealIds: [f.deal],
    servicePeriodStart: '2026-06-01', servicePeriodEnd: '2026-06-30', lines: lines(3) })
  const id = (prepared.record as { preparation: { id: string } }).preparation.id
  await f.exec(f.owner, { kind: 'mark_preparation_ready', preparationId: id, expectedVersion: 1 })
  await f.exec(f.owner, { kind: 'issue_invoice', preparationId: id, expectedVersion: 1, issueDate: '2026-07-03' })
  const invoice = (await pool.query(`SELECT id,state,number,total::text AS total,subtotal::text AS subtotal,sensitivity,compartments,office_artifact_id,
    xlsx_file_id,xlsx_sha256,pdf_file_id,pdf_sha256,pdf_page_count FROM crm_invoices WHERE workspace_id=$1 AND preparation_id=$2`, [f.workspaceId, id])).rows[0]
  return { f, invoice }
}

describe('[COMP:office/crm-invoice-release] issued invoice through Office and LibreOffice', () => {
  it('I5 reopens the released XLSX with reconciled values and renders a one-page invoice-only PDF with the logo', async () => {
    const { f, invoice } = await issued()
    expect(invoice).toMatchObject({ state: 'issued', number: 'INV-2026-000123', total: '3500.010000', pdf_page_count: 1 })
    const xlsx = await harness.runtime.readBoundOfficeFile({ userId: f.owner, workspaceId: f.workspaceId, fileId: invoice.xlsx_file_id })
    expect(xlsx).not.toBeNull()
    expect(createHash('sha256').update(xlsx!.bytes).digest('hex')).toBe(invoice.xlsx_sha256)
    const reopened = await importOfficeSpreadsheet(xlsx!.bytes, { artifactId: invoice.office_artifact_id, workspaceId: f.workspaceId, templateVersionId: f.template.versionId,
      locale: 'en-US', defaultLanguage: 'en-US', title: 'Reopened invoice' })
    expect(reopened.ok).toBe(true)
    const book = recalculateSpreadsheet(reopened.snapshot as SpreadsheetSnapshot).snapshot
    const sheet = book.worksheets.find((candidate) => candidate.name === 'Invoice')!
    const at = (address: string) => sheet.cells.find((cell) => cell.address === address)
    expect(at('G6')?.value).toBe('INV-2026-000123')
    expect(String(at('G7')?.value)).toMatch(/^2026-07-03/)
    expect(at('H21')?.calculatedValue).toBeCloseTo(2500.01, 6)
    expect(at('H22')?.calculatedValue).toBeCloseTo(500.0, 6)
    expect(at('H34')?.calculatedValue).toBeCloseTo(3500.01, 6)
    expect(at('H37')?.formula).toBe('H34+H36')
    expect(at('H37')?.calculatedValue).toBeCloseTo(3500.01, 6)
    expect(sheet.images).toHaveLength(1)
    expect(book.worksheets.find((candidate) => candidate.name === 'Setup')?.visibility).toBe('veryHidden')
    // Canonical decimal totals use the declared rounding; the workbook reconciles to them.
    expect(invoice.subtotal).toBe('3500.010000')
    const pdf = await harness.runtime.readBoundOfficeFile({ userId: f.owner, workspaceId: f.workspaceId, fileId: invoice.pdf_file_id })
    expect(Buffer.from(pdf!.bytes.subarray(0, 5)).toString()).toBe('%PDF-')
    expect(createHash('sha256').update(pdf!.bytes).digest('hex')).toBe(invoice.pdf_sha256)
    expect(await renderedPdfPageCount(pdf!.bytes)).toBe(1)
    const text = await extractPdfText(Buffer.from(pdf!.bytes))
    expect(text).toContain('INV-2026-000123')
    expect(text).toContain('Example Buyer Limited')
    expect(text).toContain('Fictional service 3')
    expect(text).not.toContain('Fictional setup notes')
    expect(text).not.toMatch(/\[INVOICE/)
    expect(Buffer.from(pdf!.bytes).includes(Buffer.from('/Image'))).toBe(true)
    // Under the commercial assurance harness, keep the actual released bytes as evidence.
    const evidence = process.env.BRIAN_ASSURANCE_REPORT_DIR
    if (evidence) {
      mkdirSync(path.join(evidence, 'artifacts'), { recursive: true, mode: 0o700 })
      writeFileSync(path.join(evidence, 'artifacts', 'crm-invoice.xlsx'), xlsx!.bytes, { mode: 0o600 })
      writeFileSync(path.join(evidence, 'artifacts', 'crm-invoice.pdf'), pdf!.bytes, { mode: 0o600 })
    }
  })

  it('I6 keeps the invoice scope on the artifact and both released files', async () => {
    const { f, invoice } = await issued('confidential')
    expect(invoice).toMatchObject({ state: 'issued', sensitivity: 'confidential' })
    const artifact = await harness.artifacts.get(f.owner, invoice.office_artifact_id)
    expect(artifact?.sensitivity).toBe('confidential')
    for (const fileId of [invoice.xlsx_file_id, invoice.pdf_file_id]) {
      const row = (await pool.query('SELECT sensitivity,compartments FROM workspace_files WHERE id=$1', [fileId])).rows[0]
      expect(row).toEqual({ sensitivity: 'confidential', compartments: invoice.compartments })
      expect(await harness.runtime.readBoundOfficeFile({ userId: f.owner, workspaceId: f.workspaceId, fileId })).not.toBeNull()
      expect(await harness.runtime.readBoundOfficeFile({ userId: f.member, workspaceId: f.workspaceId, fileId })).toBeNull()
    }
    expect(await harness.artifacts.get(f.member, invoice.office_artifact_id)).toBeNull()
    expect(await harness.reads.getInvoice(f.workspaceId, { userId: f.member }, invoice.id)).toBeNull()
    expect((await harness.reads.listInvoices(f.workspaceId, { userId: f.member }, { limit: 50 })).invoices).toEqual([])
  })
})
