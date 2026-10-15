import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import type { SpreadsheetSnapshot } from '@use-brian/office-model'
import { getAppPool, getPool } from '../../db/client.js'
import { createCrmReferenceReadStore } from '../../db/crm-business-reference-store.js'
import { createCommercialDocumentHarness, lines, seedInvoiceWorkspace } from './commercial-document-fixture.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 })
const harness = await createCommercialDocumentHarness(pool)
afterAll(async () => { await pool.end(); await getAppPool().end(); await getPool().end() })

async function cell(userId: string, artifactId: string, address: string) {
  const live = await harness.live.get(userId, artifactId)
  const sheet = (live!.snapshot as SpreadsheetSnapshot).worksheets.find((candidate) => candidate.name === 'Invoice')!
  return sheet.cells.find((candidate) => candidate.address === address)
}
type Prepared = { preparation: { id: string; version: number; state: string; officeArtifactId: string | null }; version: { questions: Array<{ fieldKey: string }>; draftReady: boolean } }

describe('[COMP:crm/invoice-preparation] invoice preparation on PostgreSQL and Office', () => {
  it('issues saved client codes with one annual sequence, fails without consuming numbers, and preserves parent snapshots', async () => {
    const f = await seedInvoiceWorkspace(pool, harness, { clientCode: 'ACME' })
    const reads = createCrmReferenceReadStore((sql, values) => pool.query(sql, values as unknown[]) as never)
    async function prepare(accountId: string, dealId = f.deal) {
      const prepared = await f.exec(f.owner, { kind: 'prepare_commercial_document', operationKey: 'invoice', accountId, dealIds: [dealId], lines: lines(1) })
      const id = (prepared.record as Prepared).preparation.id
      await f.exec(f.owner, { kind: 'mark_preparation_ready', preparationId: id, expectedVersion: 1 })
      return id
    }
    async function issue(id: string, date: string) {
      await f.exec(f.owner, { kind: 'issue_invoice', preparationId: id, expectedVersion: 1, issueDate: date })
      const invoice = (await pool.query('SELECT id,number,state FROM crm_invoices WHERE workspace_id=$1 AND preparation_id=$2', [f.workspaceId, id])).rows[0]
      const attempts = await pool.query('SELECT state,error_code,error_detail FROM crm_issue_attempts WHERE invoice_id=$1', [invoice.id])
      expect(invoice.state, JSON.stringify(attempts.rows)).toBe('issued')
      return invoice
    }
    const firstId = await prepare(f.accountId)
    const first = await issue(firstId, '2026-01-02')
    expect(first).toMatchObject({ number: 'INV-ACME-2026-001', state: 'issued' })
    const firstDetail = await harness.reads.getPreparation(f.workspaceId, { userId: f.owner }, firstId) as { preparation: Prepared['preparation'] }
    expect(await cell(f.owner, firstDetail.preparation.officeArtifactId!, 'G6')).toMatchObject({ value: first.number })
    expect(await reads.preview(f.workspaceId, { userId: f.owner }, { definitionKey: 'invoice-number', targetId: first.id, businessDate: '2026-01-02' }))
      .toMatchObject({ explanation: { maskedExample: 'INV-ACME-2026-###' }, partitionKey: 'year=2026', reserves: false })
    expect(await reads.lookup(f.workspaceId, { userId: f.owner }, { q: first.number, match: 'exact', limit: 20, includeFormer: true }))
      .toMatchObject({ references: [{ targetKind: 'invoice', targetId: first.id, value: first.number }] })
    await pool.query("UPDATE crm_invoices SET sensitivity='confidential' WHERE id=$1", [first.id])
    expect(await reads.lookup(f.workspaceId, { userId: f.member }, { q: first.number, match: 'exact', limit: 20, includeFormer: true }))
      .toMatchObject({ references: [] })
    await expect(reads.preview(f.workspaceId, { userId: f.member }, { definitionKey: 'invoice-number', targetId: first.id }))
      .rejects.toMatchObject({ code: 'not_found' })

    const secondCompany = randomUUID()
    await pool.query(`INSERT INTO entities(id,workspace_id,kind,display_name,user_id,created_by_user_id,source,sensitivity)
      VALUES($1,$2,'company','Beacon Example Limited',$3,$3,'manual','internal')`, [secondCompany, f.workspaceId, f.owner])
    const secondDeal = randomUUID()
    await pool.query(`INSERT INTO entities(id,workspace_id,kind,display_name,user_id,created_by_user_id,source,attributes,sensitivity)
      VALUES($1,$2,'deal','Second fictional service',$3,$3,'manual',$4::jsonb,'internal')`,
      [secondDeal, f.workspaceId, f.owner, JSON.stringify({ company_id: secondCompany })])
    const secondAccount = (await f.exec(f.owner, { kind: 'save_customer_account', account: {
      sellerKey: 'studio', companyId: secondCompany, label: 'Second fictional account', billingAddress: '2 Example Road',
    } })).record.account as { id: string }
    const secondId = await prepare(secondAccount.id, secondDeal)
    const next = async () => (await pool.query(`SELECT p.next_value::int AS n FROM crm_number_partitions p
      JOIN crm_number_series s ON s.id=p.series_id JOIN crm_reference_definitions d ON d.id=s.definition_id
      WHERE p.workspace_id=$1 AND d.definition_key='invoice-number' AND p.partition_key='year=2026'`, [f.workspaceId])).rows[0].n
    expect(await next()).toBe(2)
    await expect(issue(secondId, '2026-01-03')).rejects.toMatchObject({ details: { reason: 'parent_reference_missing' } })
    expect(await next()).toBe(2)
    await expect(f.exec(f.owner, { kind: 'assign_business_reference', definitionKey: 'client_code', target: { kind: 'company', id: secondCompany }, value: 'acme' }))
      .rejects.toMatchObject({ details: { reason: 'reference_collision' } })
    await f.exec(f.owner, { kind: 'assign_business_reference', definitionKey: 'client_code', target: { kind: 'company', id: secondCompany }, value: 'BEACON' })
    expect(await issue(secondId, '2026-01-03')).toMatchObject({ number: 'INV-BEACON-2026-002', state: 'issued' })

    const client = (await pool.query("SELECT id,version FROM crm_business_references WHERE workspace_id=$1 AND target_id=$2 AND status='active'", [f.workspaceId, f.company])).rows[0]
    await f.exec(f.owner, { kind: 'replace_business_reference', referenceId: client.id, expectedVersion: client.version, reason: 'Accepted fictional code correction', value: 'ACME2' })
    expect((await pool.query('SELECT number FROM crm_invoices WHERE id=$1', [first.id])).rows[0].number).toBe('INV-ACME-2026-001')
    expect((await pool.query('SELECT parent_snapshot FROM crm_business_references WHERE workspace_id=$1 AND target_id=$2', [f.workspaceId, first.id])).rows[0].parent_snapshot)
      .toMatchObject({ value: 'ACME', referenceId: client.id, version: 1 })
    const thirdId = await prepare(f.accountId)
    expect(await issue(thirdId, '2027-01-02')).toMatchObject({ number: 'INV-ACME2-2027-001', state: 'issued' })

    await f.exec(f.owner, { kind: 'import_business_references', definitionKey: 'invoice-number', partitionCounters: [{ partitionKey: 'year=2026', nextValue: 1000 }] })
    const exhaustedId = await prepare(f.accountId)
    await expect(issue(exhaustedId, '2026-12-31')).rejects.toMatchObject({ details: { reason: 'counter_exhausted' } })
    expect(await next()).toBe(1000)
    expect((await pool.query('SELECT number FROM crm_invoices WHERE preparation_id=$1', [exhaustedId])).rows[0].number).toBeNull()
  }, 60_000)

  it('I1 renders an editable draft from the admitted fictional XLSX with no official number or issue date', async () => {
    const f = await seedInvoiceWorkspace(pool, harness)
    const prepared = await f.exec(f.owner, { kind: 'prepare_commercial_document', operationKey: 'invoice', accountId: f.accountId, dealIds: [f.deal],
      servicePeriodStart: '2026-03-01', servicePeriodEnd: '2026-03-31', lines: lines(2) })
    const id = (prepared.record as Prepared).preparation.id
    const detail = await harness.reads.getPreparation(f.workspaceId, { userId: f.owner }, id) as { preparation: Prepared['preparation'] & { draftRenderError: string | null }; invoice: { number: string | null; state: string; total: string } }
    expect(detail.preparation.draftRenderError).toBeNull()
    expect(detail.preparation.officeArtifactId).toBeTruthy()
    expect(detail.invoice).toMatchObject({ number: null, state: 'draft', total: '3000.01' })
    const artifactId = detail.preparation.officeArtifactId!
    expect(await cell(f.owner, artifactId, 'G6')).toMatchObject({ value: '[INVOICE NUMBER ASSIGNED AT ISSUE]' })
    expect(await cell(f.owner, artifactId, 'G7')).toMatchObject({ value: '[INVOICE ISSUE DATE SET AT ISSUE]' })
    expect(await cell(f.owner, artifactId, 'A14')).toMatchObject({ value: 'Example Buyer Limited' })
    expect(await cell(f.owner, artifactId, 'F21')).toMatchObject({ valueType: 'number', value: 2 })
    expect((await pool.query("SELECT count(*)::int AS n FROM crm_business_references WHERE workspace_id=$1 AND target_kind='invoice'", [f.workspaceId])).rows[0].n).toBe(0)
    // A draft cannot be released as a customer invoice: the canonical invoice PDF preflight refuses the markers.
    const live = await harness.live.get(f.owner, artifactId)
    const sheetId = (live!.snapshot as SpreadsheetSnapshot).worksheets.find((sheet) => sheet.name === 'Invoice')!.id
    const artifact = await harness.artifacts.get(f.owner, artifactId)
    const blocked = await harness.binding.release(f.owner, artifactId, { expectedVersion: artifact!.headVersion, action: 'export', destination: { sensitivity: 'internal', external: true },
      format: 'pdf', spreadsheetPdf: { sheetId, printArea: 'A1:H48', calculationMode: 'automatic', expectedPageCount: 1, preset: 'invoice' } })
    expect(blocked.status).toBe(409)
    expect(JSON.stringify(blocked.body)).toContain('invoice_placeholder')
    // Visual edits elsewhere survive a commercial revision; bound cells are rewritten.
    await harness.binding.writeCells({ userId: f.owner, workspaceId: f.workspaceId, artifactId, scope: { sensitivity: 'internal', compartments: [], projectIds: [] }, actorUserId: f.owner,
      summary: 'Human note', cells: [{ sheetId, cellId: randomUUID(), address: 'C3', value: { valueType: 'string', value: 'Thank you for your business' } }] })
    const revised = await f.exec(f.owner, { kind: 'revise_commercial_preparation', preparationId: id, expectedVersion: 1, dealIds: [f.deal],
      servicePeriodStart: '2026-03-01', servicePeriodEnd: '2026-03-31', lines: lines(3) })
    expect((revised.record as Prepared).preparation.version).toBe(2)
    expect(await cell(f.owner, artifactId, 'C3')).toMatchObject({ value: 'Thank you for your business' })
    expect(await cell(f.owner, artifactId, 'B23')).toMatchObject({ value: 'Fictional service 3' })
  })

  it('I2 gates readiness and issue on resolved facts, an exact reviewed version and the review policy', async () => {
    const f = await seedInvoiceWorkspace(pool, harness, { reviewPolicy: 'exact_version_review' })
    const empty = await f.exec(f.owner, { kind: 'prepare_commercial_document', operationKey: 'invoice', accountId: f.accountId, dealIds: [f.deal, f.secondDeal], lines: [] })
    const id = (empty.record as Prepared).preparation.id
    expect((empty.record as Prepared).version).toMatchObject({ draftReady: false })
    expect((empty.record as Prepared).version.questions.map((question) => question.fieldKey)).toContain('lines')
    expect((await harness.reads.getPreparation(f.workspaceId, { userId: f.owner }, id) as { preparation: { officeArtifactId: string | null } }).preparation.officeArtifactId).toBeNull()
    await expect(f.exec(f.owner, { kind: 'issue_invoice', preparationId: id, expectedVersion: 1, issueDate: '2026-04-01' })).rejects.toMatchObject({ details: { reason: 'not_ready' } })
    const two = await f.exec(f.owner, { kind: 'revise_commercial_preparation', preparationId: id, expectedVersion: 1, dealIds: [f.deal, f.secondDeal], lines: lines(2) })
    expect((two.record as Prepared).version.questions.map((question) => question.fieldKey)).toEqual(['allocations'])
    await expect(f.exec(f.admin, { kind: 'mark_preparation_ready', preparationId: id, expectedVersion: 2 })).rejects.toMatchObject({ details: { reason: 'questions_open' } })
    await f.exec(f.owner, { kind: 'revise_commercial_preparation', preparationId: id, expectedVersion: 2, dealIds: [f.deal, f.secondDeal], lines: lines(2),
      allocations: [{ dealId: f.deal, amount: '2000' }, { dealId: f.secondDeal, amount: '1000.01' }] })
    await expect(f.exec(f.owner, { kind: 'mark_preparation_ready', preparationId: id, expectedVersion: 3 })).rejects.toMatchObject({ details: { reason: 'self_review' } })
    await expect(f.exec(f.member, { kind: 'mark_preparation_ready', preparationId: id, expectedVersion: 3 })).rejects.toMatchObject({ code: 'not_authorized' })
    await f.exec(f.admin, { kind: 'mark_preparation_ready', preparationId: id, expectedVersion: 3 })
    // A commercial change after review returns the preparation to draft.
    await f.exec(f.owner, { kind: 'revise_commercial_preparation', preparationId: id, expectedVersion: 3, dealIds: [f.deal, f.secondDeal], lines: lines(2),
      allocations: [{ dealId: f.deal, amount: '1500' }, { dealId: f.secondDeal, amount: '1500.01' }] })
    await expect(f.exec(f.owner, { kind: 'issue_invoice', preparationId: id, expectedVersion: 4, issueDate: '2026-04-01' })).rejects.toMatchObject({ details: { reason: 'not_ready' } })
    await f.exec(f.admin, { kind: 'mark_preparation_ready', preparationId: id, expectedVersion: 4 })
    await expect(f.exec(f.owner, { kind: 'issue_invoice', preparationId: id, expectedVersion: 3, issueDate: '2026-04-01' })).rejects.toMatchObject({ details: { reason: 'stale_version' } })
    await expect(f.exec(f.member, { kind: 'issue_invoice', preparationId: id, expectedVersion: 4, issueDate: '2026-04-01' })).rejects.toMatchObject({ code: 'not_authorized' })
    // Accepted terms changing after review fails closed at issue.
    await f.exec(f.owner, { kind: 'accept_commercial_profile', owner: { kind: 'account', accountId: f.accountId }, expectedCurrentVersion: 0, evidence: { kind: 'manual' },
      fields: { payment_terms: { type: 'string', value: 'Net 14' } } })
    await expect(f.exec(f.owner, { kind: 'issue_invoice', preparationId: id, expectedVersion: 4, issueDate: '2026-04-01' })).rejects.toMatchObject({ details: { reason: 'stale_sources' } })
    expect((await pool.query("SELECT count(*)::int AS n FROM crm_business_references WHERE workspace_id=$1", [f.workspaceId])).rows[0].n).toBe(0)
  })

  it('I3 assigns exactly one number under concurrent and replayed issue, and issue does not send', async () => {
    const f = await seedInvoiceWorkspace(pool, harness)
    const prepared = await f.exec(f.owner, { kind: 'prepare_commercial_document', operationKey: 'invoice', accountId: f.accountId, dealIds: [f.deal], lines: lines(2) })
    const id = (prepared.record as Prepared).preparation.id
    await f.exec(f.owner, { kind: 'mark_preparation_ready', preparationId: id, expectedVersion: 1 })
    const operationId = randomUUID()
    const command = { kind: 'issue_invoice', preparationId: id, expectedVersion: 1, issueDate: '2026-03-31' }
    const results = await Promise.all([
      f.exec(f.owner, { ...command, operationId }), f.exec(f.admin, { ...command }), f.exec(f.owner, { ...command }),
    ])
    expect(results.filter((result) => result.created)).toHaveLength(1)
    const replay = await f.exec(f.owner, { ...command, operationId })
    expect(replay.duplicate).toBe(true)
    const references = await pool.query("SELECT printable_value FROM crm_business_references WHERE workspace_id=$1 AND target_kind='invoice'", [f.workspaceId])
    expect(references.rows).toEqual([{ printable_value: 'INV-2026-000123' }])
    const invoice = (await pool.query('SELECT id,number,state,issue_date::text AS issue_date FROM crm_invoices WHERE workspace_id=$1', [f.workspaceId])).rows[0]
    const attempts = await pool.query('SELECT state,error_code,error_detail FROM crm_issue_attempts WHERE invoice_id=$1', [invoice.id])
    expect(invoice, JSON.stringify(attempts.rows)).toMatchObject({ number: 'INV-2026-000123', state: 'issued', issue_date: '2026-03-31' })
    expect((await pool.query('SELECT count(*)::int AS n FROM crm_delivery_receipts WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(0)
    await expect(f.exec(f.owner, { kind: 'revise_commercial_preparation', preparationId: id, expectedVersion: 1, dealIds: [f.deal], lines: lines(1) }))
      .rejects.toMatchObject({ code: 'invalid_transition' })
    await expect(pool.query("UPDATE crm_invoices SET number='INV-2026-999999' WHERE id=$1", [invoice.id])).rejects.toThrow(/issued_immutable/)
  })

  it('I4 retries an injected rendering failure with the same number and frozen payload', async () => {
    const f = await seedInvoiceWorkspace(pool, harness)
    const prepared = await f.exec(f.owner, { kind: 'prepare_commercial_document', operationKey: 'invoice', accountId: f.accountId, dealIds: [f.deal], lines: lines(1) })
    const id = (prepared.record as Prepared).preparation.id
    await f.exec(f.owner, { kind: 'mark_preparation_ready', preparationId: id, expectedVersion: 1 })
    const canonical = harness.binding
    let failures = 1
    harness.documents.binding = { ...canonical, release: async (...args: Parameters<typeof canonical.release>) => {
      if (failures-- > 0) throw Object.assign(new Error('Injected renderer outage'), { code: 'renderer_unavailable' })
      return canonical.release(...args)
    } }
    try {
      await f.exec(f.owner, { kind: 'issue_invoice', preparationId: id, expectedVersion: 1, issueDate: '2026-05-02' })
      const failed = (await pool.query('SELECT id,number,state,frozen_hash,version FROM crm_invoices WHERE workspace_id=$1', [f.workspaceId])).rows[0]
      expect(failed).toMatchObject({ state: 'issue_failed', number: 'INV-2026-000123' })
      const attempt = (await pool.query('SELECT state,error_code FROM crm_issue_attempts WHERE invoice_id=$1', [failed.id])).rows
      expect(attempt).toEqual([{ state: 'failed', error_code: 'renderer_unavailable' }])
      await f.exec(f.owner, { kind: 'retry_invoice_issue', invoiceId: failed.id, expectedVersion: failed.version })
      const issued = (await pool.query('SELECT number,state,frozen_hash,pdf_file_id FROM crm_invoices WHERE id=$1', [failed.id])).rows[0]
      expect(issued).toMatchObject({ state: 'issued', number: 'INV-2026-000123', frozen_hash: failed.frozen_hash })
      expect(issued.pdf_file_id).toBeTruthy()
      expect((await pool.query("SELECT count(*)::int AS n FROM crm_business_references WHERE workspace_id=$1 AND target_kind='invoice'", [f.workspaceId])).rows[0].n).toBe(1)
      expect((await pool.query('SELECT attempt,state FROM crm_issue_attempts WHERE invoice_id=$1 ORDER BY attempt', [failed.id])).rows)
        .toEqual([{ attempt: 1, state: 'failed' }, { attempt: 2, state: 'succeeded' }])
      await f.exec(f.owner, { kind: 'void_invoice', invoiceId: failed.id, expectedVersion: (await pool.query('SELECT version FROM crm_invoices WHERE id=$1', [failed.id])).rows[0].version, reason: 'Fictional duplicate' })
      expect((await pool.query('SELECT state,number FROM crm_invoices WHERE id=$1', [failed.id])).rows[0]).toEqual({ state: 'voided', number: 'INV-2026-000123' })
    } finally { harness.documents.binding = canonical }
  })
})
