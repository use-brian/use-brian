import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { createCrmGovernedReadStore } from '../../db/crm-governed-store.js'
import { getAppPool, getPool } from '../../db/client.js'
import { createCommercialDocumentHarness, lines, seedInvoiceWorkspace } from './commercial-document-fixture.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 })
const harness = await createCommercialDocumentHarness(pool)
const reads = createCrmGovernedReadStore(((sql: string, values: unknown[]) => pool.query(sql, values)) as never)
afterAll(async () => { await pool.end(); await getAppPool().end(); await getPool().end() })

type Seeded = Awaited<ReturnType<typeof seedInvoiceWorkspace>>
type Billing = { id: string; state: string; reviewStep: string | null; version: number; invoiceId: string | null }
const billing = (result: { record: Record<string, unknown> }) => result.record.request as Billing

async function engagement(f: Seeded) {
  await f.exec(f.owner, { kind: 'save_engagement_catalog', catalog: 'service_category', expectedVersion: 0, entries: [{ key: 'advisory', label: 'Advisory' }] })
  const saved = (await f.exec(f.owner, { kind: 'save_change_request', target: { kind: 'deal', id: f.deal }, changes: { engagement: {
    serviceCategory: 'advisory', periodStart: '2026-01-01', periodEnd: '2026-12-31', financialPeriod: 'FY2026', ownerUserId: f.member, participantIds: [f.member, f.admin] } } })).record.request as Billing
  const applied = (await f.exec(f.owner, { kind: 'submit_change_request', requestId: saved.id, expectedVersion: saved.version })).record.request as Billing
  expect(applied.state).toBe('approved')
  await f.exec(f.owner, { kind: 'set_commercial_values', dealId: f.deal, evidence: { source: 'engagement letter', reason: 'Signed fee' },
    values: [{ valueKind: 'quoted', expectedVersion: 0, amount: '6000', currency: 'HKD' }, { valueKind: 'confirmed', expectedVersion: 0, amount: '5000', currency: 'HKD' }] })
}
async function ready(f: Seeded, dealId: string, amount: string) {
  const created = billing(await f.exec(f.member, { kind: 'create_billing_request', dealId, amount, currency: 'HKD', description: `Fictional milestone ${amount}` }))
  expect(created).toMatchObject({ state: 'review', reviewStep: 'reviewer' })
  const reviewed = billing(await f.exec(f.admin, { kind: 'decide_billing_request', requestId: created.id, expectedVersion: created.version, decision: 'approve' }))
  expect(reviewed).toMatchObject({ state: 'review', reviewStep: 'finance' })
  return billing(await f.exec(f.owner, { kind: 'decide_billing_request', requestId: created.id, expectedVersion: reviewed.version, decision: 'approve' }))
}
async function state(id: string) {
  return (await pool.query<{ state: string; invoice_id: string | null; version: number }>('SELECT state,invoice_id,version FROM crm_billing_requests WHERE id=$1', [id])).rows[0]!
}

describe('[COMP:crm/engagement-billing] recurrence and billing handoff on PostgreSQL', () => {
  it('G5 previews and commits one successor per source and period under replay and concurrency, carrying only declared fields', async () => {
    const f = await seedInvoiceWorkspace(pool, harness)
    await engagement(f)
    // A recorded invoice on the source must never carry forward.
    await f.exec(f.owner, { kind: 'record_external_invoice', accountId: f.accountId, provider: 'example-ledger', remoteId: 'R-1', number: 'EXT-1', issueDate: '2026-02-01',
      currency: 'HKD', total: '1000', allocations: [{ dealId: f.deal, amount: '1000' }] })
    const missing = randomUUID()
    const preview = await reads.previewRecurringSuccessors(f.workspaceId, { userId: f.owner }, { sourceDealIds: [f.deal, f.secondDeal, missing], periodKey: '2027' }) as {
      candidates: Array<Record<string, unknown>> }
    expect(preview.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceDealId: f.deal, outcome: 'create', proposedName: 'Example advisory retainer (2027)' }),
      { sourceDealId: f.secondDeal, outcome: 'stale', reason: 'source_not_an_engagement' },
      { sourceDealId: missing, outcome: 'stale', reason: 'source_unavailable' }]))
    const command = { kind: 'commit_recurring_successors', sourceDealIds: [f.deal, f.secondDeal],
      period: { key: '2027', periodStart: '2027-01-01', periodEnd: '2027-12-31', financialPeriod: 'FY2027', deadline: '2027-11-30' },
      carryForward: ['serviceCategory', 'owner', 'participants', 'quotedFee'] }
    const operationId = randomUUID()
    const runs = await Promise.all([f.exec(f.owner, { ...command, operationId }), f.exec(f.admin, command), f.exec(f.owner, command)])
    const outcomes = runs.flatMap((run) => (run.record.outcomes as Array<{ sourceDealId: string; outcome: string; dealId?: string }>).filter((row) => row.sourceDealId === f.deal))
    expect(outcomes.filter((row) => row.outcome === 'created')).toHaveLength(1)
    expect(outcomes.filter((row) => row.outcome === 'existing')).toHaveLength(2)
    expect(new Set(outcomes.map((row) => row.dealId)).size).toBe(1)
    expect(runs[0]!.record.outcomes).toEqual(expect.arrayContaining([{ sourceDealId: f.secondDeal, outcome: 'stale', reason: 'source_not_an_engagement' }]))
    expect((await f.exec(f.owner, { ...command, operationId })).duplicate).toBe(true)
    const successors = (await pool.query<{ deal_id: string }>('SELECT deal_id FROM crm_engagement_extensions WHERE recurrence_parent_deal_id=$1', [f.deal])).rows
    expect(successors).toHaveLength(1)
    const successor = successors[0]!.deal_id
    const detail = (await reads.listEngagements(f.workspaceId, { userId: f.owner }, { dealId: successor, includeCommercialValues: true, limit: 50 })).engagements[0] as Record<string, unknown>
    expect(detail).toMatchObject({ displayName: 'Example advisory retainer (2027)', companyId: f.company, serviceCategory: 'advisory', periodStart: '2027-01-01',
      periodEnd: '2027-12-31', financialPeriod: 'FY2027', deadline: '2027-11-30', ownerUserId: f.member, workStatus: null, recurrenceParentDealId: f.deal, recurrencePeriodKey: '2027' })
    expect(detail.participantIds).toEqual([f.member, f.admin])
    expect((detail.commercialValues as Array<{ valueKind: string; amount: string }>).map((value) => [value.valueKind, value.amount])).toEqual([['quoted', '6000']])
    for (const table of ['crm_invoice_allocations', 'crm_billing_requests', 'crm_business_references']) {
      const column = table === 'crm_business_references' ? 'target_id' : 'deal_id'
      expect((await pool.query(`SELECT 1 FROM ${table} WHERE ${column}=$1`, [successor])).rowCount).toBe(0)
    }
    const after = await reads.previewRecurringSuccessors(f.workspaceId, { userId: f.owner }, { sourceDealIds: [f.deal], periodKey: '2027' }) as { candidates: unknown[] }
    expect(after.candidates).toEqual([{ sourceDealId: f.deal, outcome: 'existing', dealId: successor }])
    // Without quotedFee in the carry list, no fee crosses into the next period.
    const next = await f.exec(f.owner, { kind: 'commit_recurring_successors', sourceDealIds: [f.deal], period: { key: '2028', periodStart: '2028-01-01', periodEnd: '2028-12-31' } })
    const plain = (next.record.outcomes as Array<{ dealId: string }>)[0]!.dealId
    expect((await pool.query('SELECT 1 FROM crm_commercial_values WHERE deal_id=$1', [plain])).rowCount).toBe(0)
  })

  it('G6 reviews billing in sequence, closes each request exactly once on native or external allocation, and corrects without deleting', async () => {
    const f = await seedInvoiceWorkspace(pool, harness)
    await engagement(f)
    const current = (await reads.listCatalogs(f.workspaceId)).policies.find((row) => row.subject === 'billing_request') as { version: number }
    await f.exec(f.owner, { kind: 'save_governance_policy', subject: 'billing_request', expectedVersion: current.version, policy: { mode: 'reviewer_then_finance', directRoles: [] } })
    // Sequential review: a member is not a reviewer and the finance step needs a different person.
    const created = billing(await f.exec(f.member, { kind: 'create_billing_request', dealId: f.deal, amount: '2000', currency: 'HKD', description: 'Fictional milestone 1' }))
    await expect(f.exec(f.member, { kind: 'decide_billing_request', requestId: created.id, expectedVersion: created.version, decision: 'approve' }))
      .rejects.toMatchObject({ code: 'not_authorized' })
    const first = billing(await f.exec(f.admin, { kind: 'decide_billing_request', requestId: created.id, expectedVersion: created.version, decision: 'approve' }))
    await expect(f.exec(f.admin, { kind: 'decide_billing_request', requestId: created.id, expectedVersion: first.version, decision: 'approve' }))
      .rejects.toMatchObject({ code: 'not_authorized', details: { reason: 'same_reviewer' } })
    const a = billing(await f.exec(f.owner, { kind: 'decide_billing_request', requestId: created.id, expectedVersion: first.version, decision: 'approve' }))
    expect(a.state).toBe('ready_to_bill')
    const b = await ready(f, f.secondDeal, '1000.01')
    // Recording fees or moving the sales stage never closes a request.
    await f.exec(f.owner, { kind: 'set_commercial_values', dealId: f.deal, evidence: { source: 'variation', reason: 'Scope' },
      values: [{ valueKind: 'confirmed', expectedVersion: 1, amount: '5000.00', currency: 'HKD' }] })
    expect((await state(a.id)).state).toBe('ready_to_bill')

    // Native issue: allocations naming the requests close both in the issue transaction.
    const prepared = await f.exec(f.owner, { kind: 'prepare_commercial_document', operationKey: 'invoice', accountId: f.accountId, dealIds: [f.deal, f.secondDeal], lines: lines(2),
      allocations: [{ dealId: f.deal, amount: '2000', billingRequestId: a.id }, { dealId: f.secondDeal, amount: '1000.01', billingRequestId: b.id }] })
    const preparationId = (prepared.record as { preparation: { id: string } }).preparation.id
    await f.exec(f.owner, { kind: 'mark_preparation_ready', preparationId, expectedVersion: 1 })
    const issued = await f.exec(f.owner, { kind: 'issue_invoice', preparationId, expectedVersion: 1, issueDate: '2026-05-01' })
    const nativeId = (issued.record.invoice as { id: string }).id
    expect(await state(a.id)).toMatchObject({ state: 'invoiced', invoice_id: nativeId })
    expect(await state(b.id)).toMatchObject({ state: 'invoiced', invoice_id: nativeId })
    const balance = await reads.billingBalance(f.workspaceId, { userId: f.owner }, { companyId: f.company }) as { deals: Array<Record<string, unknown>>; unbilledByCurrency: unknown[] }
    expect(balance.deals.find((row) => row.dealId === f.deal)).toMatchObject({ confirmedFee: { amount: '5000', currency: 'HKD' }, billed: [{ currency: 'HKD', amount: '2000' }], unbilled: { currency: 'HKD', amount: '3000' } })
    // No confirmed fee means no unbilled figure, never zero.
    expect(balance.deals.find((row) => row.dealId === f.secondDeal)).toMatchObject({ confirmedFee: null, billed: [{ currency: 'HKD', amount: '1000.01' }], unbilled: null })
    expect(balance.unbilledByCurrency).toEqual([{ currency: 'HKD', unbilled: '3000' }])
    // A second invoice cannot close an invoiced request.
    await expect(f.exec(f.owner, { kind: 'record_external_invoice', accountId: f.accountId, provider: 'example-ledger', remoteId: 'DUP', number: 'EXT-DUP', issueDate: '2026-05-02',
      currency: 'HKD', total: '2000', allocations: [{ dealId: f.deal, amount: '2000', billingRequestId: a.id }] })).rejects.toMatchObject({ details: { reason: 'billing_request_not_ready' } })
    // Voiding the native invoice reopens what it billed.
    const native = (await pool.query<{ version: number }>('SELECT version FROM crm_invoices WHERE id=$1', [nativeId])).rows[0]!
    await f.exec(f.owner, { kind: 'void_invoice', invoiceId: nativeId, expectedVersion: native.version, reason: 'Issued in error' })
    expect((await state(a.id)).state).toBe('ready_to_bill')
    expect((await state(b.id)).state).toBe('ready_to_bill')

    // External: one multi-deal invoice closes both; a replay of the provider identity returns the same record.
    const external = { kind: 'record_external_invoice', accountId: f.accountId, provider: 'example-ledger', remoteId: 'R-100', number: 'EXT-0100', issueDate: '2026-05-03',
      currency: 'HKD', total: '3000.01', allocations: [{ dealId: f.deal, amount: '2000', billingRequestId: a.id }, { dealId: f.secondDeal, amount: '1000.01', billingRequestId: b.id }] }
    const recorded = await f.exec(f.owner, external)
    const externalId = recorded.record.invoiceId as string
    const replayed = await f.exec(f.owner, external)
    expect(replayed).toMatchObject({ duplicate: true, record: { invoiceId: externalId } })
    expect(await state(a.id)).toMatchObject({ state: 'invoiced', invoice_id: externalId })
    expect(await state(b.id)).toMatchObject({ state: 'invoiced', invoice_id: externalId })
    // A mismatched amount for a ready request fails without recording anything.
    const c = await ready(f, f.deal, '500')
    const before = (await pool.query('SELECT count(*)::int AS n FROM crm_invoices WHERE workspace_id=$1', [f.workspaceId])).rows[0].n
    await expect(f.exec(f.owner, { kind: 'record_external_invoice', accountId: f.accountId, provider: 'example-ledger', remoteId: 'R-101', number: 'EXT-0101', issueDate: '2026-05-04',
      currency: 'HKD', total: '400', allocations: [{ dealId: f.deal, amount: '400', billingRequestId: c.id }] })).rejects.toMatchObject({ details: { reason: 'billing_amount_mismatch' } })
    expect((await pool.query('SELECT count(*)::int AS n FROM crm_invoices WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(before)
    expect((await state(c.id)).state).toBe('ready_to_bill')
    // Correcting a mistaken reference reopens the request and keeps the provider invoice.
    const externalRow = (await pool.query<{ version: number }>('SELECT version FROM crm_invoices WHERE id=$1', [externalId])).rows[0]!
    await f.exec(f.owner, { kind: 'correct_external_invoice_reference', invoiceId: externalId, expectedVersion: externalRow.version, number: 'EXT-0100-A',
      reopenBillingRequestIds: [a.id], reason: 'Milestone 1 was billed on a different provider invoice' })
    expect((await state(a.id)).state).toBe('ready_to_bill')
    expect((await state(b.id)).state).toBe('invoiced')
    expect((await pool.query('SELECT state,number FROM crm_invoices WHERE id=$1', [externalId])).rows[0]).toEqual({ state: 'issued', number: 'EXT-0100-A' })
    expect((await pool.query("SELECT metadata->>'formerNumber' AS former FROM association_audit_log WHERE subject_id=$1 AND action='crm.invoice.external_corrected'", [externalId])).rows)
      .toEqual([{ former: 'EXT-0100' }])
    await expect(f.exec(f.owner, { kind: 'void_invoice', invoiceId: externalId, expectedVersion: externalRow.version + 1, reason: 'Wrong' }))
      .rejects.toMatchObject({ details: { reason: 'provider_owned' } })
    // A returned request is revised and resubmitted; a cancelled one cannot be invoiced.
    const d = billing(await f.exec(f.member, { kind: 'create_billing_request', dealId: f.deal, amount: '300', currency: 'HKD', description: 'Fictional expenses' }))
    const returned = billing(await f.exec(f.admin, { kind: 'decide_billing_request', requestId: d.id, expectedVersion: d.version, decision: 'return', reason: 'Attach receipts' }))
    const revised = billing(await f.exec(f.member, { kind: 'create_billing_request', requestId: d.id, expectedVersion: returned.version, dealId: f.deal, amount: '320',
      currency: 'HKD', description: 'Fictional expenses with receipts' }))
    expect(revised).toMatchObject({ state: 'review', reviewStep: 'reviewer' })
    await f.exec(f.member, { kind: 'cancel_billing_request', requestId: d.id, expectedVersion: revised.version, reason: 'Absorbed' })
    await expect(f.exec(f.owner, { kind: 'record_external_invoice', accountId: f.accountId, provider: 'example-ledger', remoteId: 'R-102', number: 'EXT-0102', issueDate: '2026-05-05',
      currency: 'HKD', total: '320', allocations: [{ dealId: f.deal, amount: '320', billingRequestId: d.id }] }))
      .rejects.toMatchObject({ details: { reason: 'billing_request_not_ready' } })
  })
})
