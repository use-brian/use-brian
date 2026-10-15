import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import type { CrmOperationsCommand, CrmOperationsContext } from '@use-brian/core'
import { createCrmOperationsService } from '../service.js'
import { createDbCrmOperationsStore } from '../../db/crm-operations-store.js'
import { createCrmCommercialContextReadStore } from '../../db/crm-commercial-context-store.js'
import { createCrmReferenceReadStore } from '../../db/crm-business-reference-store.js'
import { getAppPool, getPool } from '../../db/client.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
const service = createCrmOperationsService(createDbCrmOperationsStore(pool))
const run = (sql: string, values: unknown[]) => pool.query(sql, values)
const reads = createCrmCommercialContextReadStore(run as never)
const references = createCrmReferenceReadStore(run as never)
afterAll(async () => { await pool.end(); await getAppPool().end(); await getPool().end() })

async function fixture() {
  const workspaceId = randomUUID(), owner = randomUUID(), member = randomUUID()
  for (const user of [owner, member]) await pool.query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'test',$1::text)", [user])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional commercial fixture',$2)", [workspaceId, owner])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential'),($1,$3,'member','internal')", [workspaceId, owner, member])
  const entity = async (kind: 'company' | 'deal' | 'person', name: string, attributes: Record<string, unknown> = {}) => {
    const id = randomUUID()
    await pool.query(`INSERT INTO entities(id,workspace_id,kind,display_name,created_by_user_id,source,attributes,sensitivity)
      VALUES($1,$2,$3,$4,$5,'manual',$6::jsonb,'internal')`, [id, workspaceId, kind, name, owner, JSON.stringify(attributes)])
    return id
  }
  const ctx = (userId: string, patch: Partial<CrmOperationsContext> = {}): CrmOperationsContext => ({
    workspaceId, actor: { kind: 'user', userId },
    authority: { role: userId === owner ? 'owner' : 'member', canWrite: true, canConfigure: userId === owner, trustedIdentitySources: [] }, ...patch,
  })
  const exec = (userId: string, command: Record<string, unknown>, patch: Partial<CrmOperationsContext> = {}) =>
    service.execute(ctx(userId, patch), { operationId: randomUUID(), ...command } as CrmOperationsCommand)
  const company = await entity('company', 'Example Buyer Limited')
  const deal = await entity('deal', 'Example retainer', { company_id: company })
  const contactA = await entity('person', 'Fictional Billing A')
  const contactB = await entity('person', 'Fictional Billing B')
  await exec(owner, { kind: 'save_seller_profile', seller: { sellerKey: 'studio', legalName: 'Example Studio Limited', displayName: 'Example Studio', timezone: 'Asia/Hong_Kong' } })
  await exec(owner, { kind: 'save_seller_profile', seller: { sellerKey: 'labs', legalName: 'Example Labs Limited', displayName: 'Example Labs' } })
  await exec(owner, { kind: 'accept_commercial_profile', owner: { kind: 'seller', sellerKey: 'studio' }, expectedCurrentVersion: 0,
    evidence: { kind: 'manual', note: 'Fixture seller defaults' },
    fields: { currency: { type: 'currency', value: 'HKD' }, payment_terms: { type: 'string', value: 'Net 30' }, tax_rate: { type: 'percent', value: '0' } } })
  return { workspaceId, owner, member, entity, exec, company, deal, contactA, contactB }
}
type Fixture = Awaited<ReturnType<typeof fixture>>

const bindings = [
  { fieldKey: 'currency', label: 'Currency', type: 'currency', requiredFor: 'draft', sources: ['agreement', 'account', 'seller'] },
  { fieldKey: 'payment_terms', label: 'Payment terms', type: 'string', requiredFor: 'issue', protected: true, overridable: true },
  { fieldKey: 'day_rate', label: 'Day rate', type: 'decimal', requiredFor: 'draft', protected: true, overridable: true },
  { fieldKey: 'po_number', label: 'Purchase order', type: 'string', requiredFor: 'issue', overridable: true },
  { fieldKey: 'tax_rate', label: 'Tax rate', type: 'percent', requiredFor: 'issue', sources: ['account', 'seller'] },
]

async function operation(f: Fixture) {
  const proposed = await f.exec(f.owner, { kind: 'save_operation_definition', operationKey: 'invoice', operationKind: 'invoice', label: 'Prepare invoice',
    expectedVersion: 0, version: { instructions: 'Use the accepted account and agreement terms. Ask for the purchase order before issue.', fieldBindings: bindings } })
  const version = proposed.record.version as { id: string }
  await f.exec(f.owner, { kind: 'accept_operation_version', operationKey: 'invoice', versionId: version.id, expectedVersion: 1 })
  return version.id
}

describe('[COMP:crm/commercial-context] commercial context on PostgreSQL', () => {
  it('C1 keeps separately configured accounts for one company and enforces each child scope', async () => {
    const f = await fixture()
    const a = await f.exec(f.owner, { kind: 'save_customer_account', account: { sellerKey: 'studio', companyId: f.company, label: 'Studio retainer', billingContactId: f.contactA, billingAddress: '1 Example Road' } })
    const b = await f.exec(f.owner, { kind: 'save_customer_account', account: { sellerKey: 'labs', companyId: f.company, label: 'Labs research', billingContactId: f.contactB },
      classification: { sensitivity: 'confidential' } })
    const accountA = a.record.account as { id: string; version: number; sensitivity: string }
    const accountB = b.record.account as { id: string; sensitivity: string }
    expect(accountA.sensitivity).toBe('internal')
    expect(accountB.sensitivity).toBe('confidential')
    const ownerView = await reads.listAccounts(f.workspaceId, { userId: f.owner }, { companyId: f.company, includeArchived: false, limit: 50 })
    expect(ownerView.accounts.map((row) => row.label).sort()).toEqual(['Labs research', 'Studio retainer'])
    // The member sees the company but not the stricter account, and cannot distinguish it from a missing one.
    const memberView = await reads.listAccounts(f.workspaceId, { userId: f.member }, { companyId: f.company, includeArchived: false, limit: 50 })
    expect(memberView.accounts.map((row) => row.label)).toEqual(['Studio retainer'])
    await expect(reads.listProfiles(f.workspaceId, { userId: f.member }, { accountId: accountB.id, includeSuperseded: false })).rejects.toMatchObject({ code: 'not_found' })
    await expect(f.exec(f.member, { kind: 'save_customer_account', accountId: accountB.id, expectedVersion: 1,
      account: { sellerKey: 'labs', companyId: f.company, label: 'Hijack', billingContactId: null } })).rejects.toMatchObject({ code: 'not_found' })
    await expect(f.exec(f.owner, { kind: 'save_customer_account', accountId: accountA.id, expectedVersion: accountA.version,
      account: { sellerKey: 'labs', companyId: f.company, label: 'Moved' } })).rejects.toMatchObject({ details: { reason: 'account_binding_immutable' } })
    await expect(f.exec(f.owner, { kind: 'save_customer_account', account: { sellerKey: 'studio', companyId: f.company, label: 'Too broad' },
      classification: { sensitivity: 'public' } })).rejects.toMatchObject({ details: { reason: 'classification_broader_than_source' } })
    // Accounts are reference targets under their own scope.
    await f.exec(f.owner, { kind: 'save_reference_definition', definition: { definitionKey: 'account-code', label: 'Account code', targetKinds: ['account'],
      assignmentMode: 'native', namespaceKey: 'account-codes', format: [{ kind: 'literal', text: 'AC-' }, { kind: 'counter', width: 4 }] } })
    const code = await f.exec(f.owner, { kind: 'assign_business_reference', definitionKey: 'account-code', target: { kind: 'account', id: accountB.id } })
    expect((code.record.reference as { value: string }).value).toBe('AC-0001')
    expect((await references.lookup(f.workspaceId, { userId: f.owner }, { q: 'AC-0001', match: 'exact', includeFormer: true, limit: 50 })).references[0])
      .toMatchObject({ targetKind: 'account', targetId: accountB.id, targetName: 'Labs research' })
    expect((await references.lookup(f.workspaceId, { userId: f.member }, { q: 'AC-0001', match: 'exact', includeFormer: true, limit: 50 })).references).toEqual([])
  })

  it('C2 resolves accepted terms by precedence, traces overrides and asks precise questions on conflicts', async () => {
    const f = await fixture()
    const operationVersionId = await operation(f)
    const account = (await f.exec(f.owner, { kind: 'save_customer_account', account: { sellerKey: 'studio', companyId: f.company, label: 'Studio retainer' } })).record.account as { id: string }
    await f.exec(f.owner, { kind: 'accept_commercial_profile', owner: { kind: 'account', accountId: account.id }, expectedCurrentVersion: 0,
      evidence: { kind: 'manual' }, fields: { payment_terms: { type: 'string', value: 'Net 14' } } })
    const agreement = await f.exec(f.owner, { kind: 'accept_commercial_profile', owner: { kind: 'agreement', accountId: account.id, agreementKey: 'retainer-2026', dealIds: [f.deal] },
      expectedCurrentVersion: 0, effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31', evidence: { kind: 'page', id: randomUUID(), revision: '3' },
      fields: { day_rate: { type: 'decimal', value: '1250.00' }, payment_terms: { type: 'string', value: 'Net 7' } } })
    const receipt = await reads.resolve(f.workspaceId, { userId: f.owner }, { operationKey: 'invoice', accountId: account.id, dealId: f.deal, businessDate: '2026-03-01',
      transaction: { po_number: { type: 'string', value: 'PO-777' } } })
    expect(receipt.operationVersionId).toBe(operationVersionId)
    expect(receipt.fields.currency).toMatchObject({ value: 'HKD', source: { kind: 'seller' } })
    expect(receipt.fields.payment_terms).toMatchObject({ value: 'Net 7', source: { kind: 'agreement', recordId: (agreement.record.profile as { id: string }).id, version: 1 } })
    expect(receipt.fields.day_rate).toMatchObject({ value: '1250.00', source: { kind: 'agreement' } })
    expect(receipt.fields.po_number).toMatchObject({ value: 'PO-777', overridden: true, source: { kind: 'transaction' } })
    expect(receipt).toMatchObject({ draftReady: true, issueReady: true, questions: [] })
    // Outside the agreement period the account default applies and the rate is missing.
    const later = await reads.resolve(f.workspaceId, { userId: f.owner }, { operationKey: 'invoice', accountId: account.id, dealId: f.deal, businessDate: '2027-01-15' })
    expect(later.fields.payment_terms).toMatchObject({ value: 'Net 14', source: { kind: 'account' } })
    expect(later.questions.map((question) => [question.fieldKey, question.kind])).toEqual([['day_rate', 'missing'], ['po_number', 'missing']])
    expect(later.draftReady).toBe(false)
    // A contradictory transaction value for a protected term is a review question, never silently accepted.
    const contradicted = await reads.resolve(f.workspaceId, { userId: f.owner }, { operationKey: 'invoice', accountId: account.id, dealId: f.deal, businessDate: '2026-03-01',
      transaction: { day_rate: { type: 'decimal', value: '900.00' }, po_number: { type: 'string', value: 'PO-1' } } })
    expect(contradicted.fields.day_rate).toMatchObject({ value: '1250.00', overridden: false })
    expect(contradicted.questions).toMatchObject([{ fieldKey: 'day_rate', kind: 'review_required' }])
    expect(contradicted.issueReady).toBe(false)
    await expect(reads.resolve(f.workspaceId, { userId: f.owner }, { operationKey: 'invoice', accountId: account.id, transaction: { tax_rate: { type: 'percent', value: '0.1' } } }))
      .rejects.toMatchObject({ details: { reason: 'override_not_permitted', fields: ['tax_rate'] } })
    // A second applicable agreement disagreeing on the rate is a conflict question naming both sources.
    await f.exec(f.owner, { kind: 'accept_commercial_profile', owner: { kind: 'agreement', accountId: account.id, agreementKey: 'side-letter', dealIds: [] },
      expectedCurrentVersion: 0, evidence: { kind: 'manual' }, fields: { day_rate: { type: 'decimal', value: '1100.00' } } })
    const conflicted = await reads.resolve(f.workspaceId, { userId: f.owner }, { operationKey: 'invoice', accountId: account.id, dealId: f.deal, businessDate: '2026-03-01' })
    expect(conflicted.questions.find((question) => question.fieldKey === 'day_rate')).toMatchObject({ kind: 'conflict', candidates: [{ source: 'agreement' }, { source: 'agreement' }] })
    expect(conflicted.fields.day_rate.value).toBeUndefined()
  })

  it('C3 follows source access and version changes, keeps explicit nulls, and lets only a human accept the procedure', async () => {
    const f = await fixture()
    await operation(f)
    const account = (await f.exec(f.owner, { kind: 'save_customer_account', account: { sellerKey: 'studio', companyId: f.company, label: 'Studio retainer' } })).record.account as { id: string }
    await f.exec(f.owner, { kind: 'accept_commercial_profile', owner: { kind: 'account', accountId: account.id }, expectedCurrentVersion: 0,
      evidence: { kind: 'manual' }, fields: { po_number: { type: 'string', value: null }, day_rate: { type: 'decimal', value: '800.00' } } })
    const first = await reads.resolve(f.workspaceId, { userId: f.member }, { operationKey: 'invoice', accountId: account.id })
    expect(first.fields.po_number).toMatchObject({ value: null, source: { kind: 'account' } })
    expect(first.questions.some((question) => question.fieldKey === 'po_number')).toBe(false)
    expect(first.fields.day_rate.value).toBe('800.00')
    // Resolving again (a resumed preparation) yields the same complete answer.
    expect(await reads.resolve(f.workspaceId, { userId: f.member }, { operationKey: 'invoice', accountId: account.id })).toEqual(first)
    // A stale acceptance is refused; a new version raised to confidential drops out of the member's snapshot without leaking.
    await expect(f.exec(f.owner, { kind: 'accept_commercial_profile', owner: { kind: 'account', accountId: account.id }, expectedCurrentVersion: 0,
      evidence: { kind: 'manual' }, fields: {} })).rejects.toMatchObject({ details: { reason: 'stale_version', currentVersion: 1 } })
    await f.exec(f.owner, { kind: 'accept_commercial_profile', owner: { kind: 'account', accountId: account.id }, expectedCurrentVersion: 1,
      evidence: { kind: 'manual' }, fields: { day_rate: { type: 'decimal', value: '850.00' } }, classification: { sensitivity: 'confidential' } })
    const memberAfter = await reads.resolve(f.workspaceId, { userId: f.member }, { operationKey: 'invoice', accountId: account.id })
    expect(memberAfter.fields.day_rate.value).toBeUndefined()
    expect(JSON.stringify(memberAfter)).not.toContain('850.00')
    expect(memberAfter.profileVersions.every((profile) => profile.ownerKind === 'seller')).toBe(true)
    const ownerAfter = await reads.resolve(f.workspaceId, { userId: f.owner }, { operationKey: 'invoice', accountId: account.id })
    expect(ownerAfter.fields.day_rate).toMatchObject({ value: '850.00', source: { kind: 'account', version: 2 } })
    // Operation versions: a proposal is not in force, an assistant cannot accept, and accepted snapshots are immutable.
    const proposal = await f.exec(f.owner, { kind: 'save_operation_definition', operationKey: 'invoice', operationKind: 'invoice', label: 'Prepare invoice',
      expectedVersion: 2, version: { instructions: 'Revised procedure.', fieldBindings: bindings } })
    const proposedId = (proposal.record.version as { id: string }).id
    expect((await reads.resolve(f.workspaceId, { userId: f.owner }, { operationKey: 'invoice', accountId: account.id })).operationVersionId).not.toBe(proposedId)
    await expect(f.exec(f.owner, { kind: 'accept_operation_version', operationKey: 'invoice', versionId: proposedId, expectedVersion: 3 },
      { actor: { kind: 'assistant', assistantId: randomUUID(), userId: f.owner, sessionId: randomUUID() } })).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(f.exec(f.member, { kind: 'save_operation_definition', operationKey: 'invoice', operationKind: 'invoice', label: 'X', expectedVersion: 3,
      version: { instructions: 'Member edit.', fieldBindings: bindings } })).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(pool.query("UPDATE crm_operation_versions SET instructions='tampered' WHERE workspace_id=$1", [f.workspaceId])).rejects.toThrow(/snapshot/)
  })
})
