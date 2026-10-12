/**
 * Canonical commercial document commands: preparation, revision, version-bound
 * readiness, invoice issue with issue-time numbering, retry and void. Draft
 * rendering and the issue attempt run after commit against canonical Office
 * paths and record their outcome back through the same transaction port.
 * Spec: docs/architecture/features/crm-commercial-operations.md -> Invoice preparation
 *
 * [COMP:crm/invoice-preparation]
 */

import { randomUUID } from 'node:crypto'
import {
  CRM_INVOICE_ISSUE_PATHS,
  CrmDecimalError,
  CrmInvoiceTemplateMapSchema,
  computeCrmInvoiceTotals,
  crmDecimalAdd,
  crmDecimalCompare,
  crmDecimalRound,
  crmOperationsSha256,
  maxSensitivity,
  requireCrmIntegrationResources,
  unionScopeRequirements,
  type CrmCommercialDocumentCommand,
  type CrmCommercialFields,
  type CrmInvoiceTemplateMap,
  type CrmInvoiceTotals,
  type CrmOperationsContext,
  type CrmResolutionReceipt,
} from '@use-brian/core'
import type { CrmOperationsStore, CrmOperationsTransaction } from '../db/crm-operations-store.js'
import { getPool } from '../db/client.js'
import { readCrmReference } from '../db/crm.js'
import {
  lockAccount,
  readAcceptedOperation,
  readOperationVersion,
  readSellerById,
  readVisibleProfiles,
  resolveForAccount,
  commercialVisibility,
  type CrmAccountRow,
  type CrmOperationVersionRow,
  type CrmScopeEnvelope,
} from '../db/crm-commercial-context-store.js'
import {
  enqueueIssueAttempt,
  finishIssueAttempt,
  freezeInvoice,
  insertInvoice,
  insertPreparation,
  insertPreparationVersion,
  invoiceForPreparation,
  leaseIssueAttempt,
  lockInvoice,
  lockPreparation,
  readPreparationVersion,
  recordDraftRender,
  setInvoiceState,
  updateInvoiceDraft,
  updatePreparation,
  type CrmInvoiceRow,
  type CrmPreparationRow,
  type CrmPreparationVersionRow,
} from '../db/crm-commercial-document-store.js'
import { assignCrmReferenceAtEvent } from './business-references.js'
import { closeBillingRequest, reopenBillingRequestsForInvoice } from './governed-records.js'
import { actorColumns, commercialAudit, commercialResult, refuse, unavailable, withOperationReceipt, type CommercialResult } from './commercial-transaction.js'
import type { CrmOfficeBindingPort } from './office-binding.js'

type Command<K extends CrmCommercialDocumentCommand['kind']> = Extract<CrmCommercialDocumentCommand, { kind: K }>
type Content = { dealIds: string[]; servicePeriodStart: string | null; servicePeriodEnd: string | null; lines: Array<{ description: string; quantity: string; unitPrice: string; dealId: string | null }>
  values: CrmCommercialFields; allocations: Array<{ dealId: string; amount: string; billingRequestId?: string }> }
type CellValue = { valueType: 'blank'; value: null } | { valueType: 'string'; value: string } | { valueType: 'number'; value: number } | { valueType: 'boolean'; value: boolean } | { valueType: 'date'; value: string }
type Question = CrmResolutionReceipt['questions'][number]

export type CrmDocumentFollowUp =
  | { kind: 'render_draft'; workspaceId: string; preparationId: string; version: number; userId: string }
  | { kind: 'process_attempt'; workspaceId: string; attemptId: string }

export type CrmCommercialDocumentRuntime = { binding: CrmOfficeBindingPort | null; now?: () => Date }

const NUMBER_MARKER = '[INVOICE NUMBER ASSIGNED AT ISSUE]'
const DATE_MARKER = '[INVOICE ISSUE DATE SET AT ISSUE]'

function grant(context: CrmOperationsContext, operation: 'crm.commercial.write' | 'crm.commercial.issue', operationKey: string, sellerKey: string) {
  if (context.authority.integration) requireCrmIntegrationResources(context.authority.integration, operation, { operationKeys: operationKey, sellerKeys: sellerKey })
}

function officeNumber(decimal: string): number {
  const value = Number(decimal)
  if (!Number.isFinite(value) || decimal.replace(/[-.]/g, '').replace(/^0+/, '').length > 15) {
    refuse('invalid_input', 'The amount exceeds the precision a workbook cell can hold exactly.', { reason: 'unsupported_monetary_value' })
  }
  return Object.is(value, -0) ? 0 : value
}

function templateMap(version: CrmOperationVersionRow): { map: CrmInvoiceTemplateMap; templateVersionId: string; pdfPreset: 'invoice' | 'worksheet' } {
  const binding = version.templateBinding as (CrmOperationVersionRow['templateBinding'] & { map?: unknown }) | null
  if (!binding?.templateVersionId || !binding.map) {
    refuse('conflict', 'The accepted operation needs a pinned admitted template version and template map before preparing a document.', { reason: 'template_binding_incomplete' })
  }
  return { map: CrmInvoiceTemplateMapSchema.parse(binding.map), templateVersionId: binding.templateVersionId, pdfPreset: binding.pdfPreset }
}

function entryCell(entry: { type: string; value: unknown } | undefined): CellValue {
  if (!entry || entry.value === null || entry.value === undefined) return { valueType: 'blank', value: null }
  switch (entry.type) {
    case 'decimal': case 'percent': return { valueType: 'number', value: officeNumber(String(entry.value)) }
    case 'date': return { valueType: 'date', value: `${entry.value}T00:00:00.000Z` }
    case 'boolean': return { valueType: 'boolean', value: Boolean(entry.value) }
    case 'reference': return { valueType: 'string', value: (entry.value as { id: string }).id }
    default: return { valueType: 'string', value: String(entry.value) }
  }
}

/** Resolve every mapped token to an explicit cell value. Issue tokens hold markers until issue. */
function tokenValues(map: CrmInvoiceTemplateMap, data: {
  number: string | null; issueDate: string | null; totals: CrmInvoiceTotals | null; resolution: CrmResolutionReceipt
  sellerLegalName: string; sellerDisplayName: string; companyName: string; account: CrmAccountRow; content: Content
}): Record<string, CellValue> {
  const text = (value: string | null | undefined): CellValue => value ? { valueType: 'string', value } : { valueType: 'blank', value: null }
  const date = (value: string | null | undefined): CellValue => value ? { valueType: 'date', value: `${value}T00:00:00.000Z` } : { valueType: 'blank', value: null }
  const amount = (value: string | null | undefined): CellValue => value ? { valueType: 'number', value: officeNumber(value) } : { valueType: 'blank', value: null }
  const out: Record<string, CellValue> = {}
  for (const [token, path] of Object.entries(map.tokens)) {
    const line = /^line\.(\d+)\.(description|quantity|unit_price|amount)$/.exec(path)
    if (line) {
      const index = Number(line[1]) - 1
      const source = data.content.lines[index]
      const computed = data.totals?.lines[index]
      out[token] = !source ? { valueType: 'blank', value: null }
        : line[2] === 'description' ? text(source.description)
          : line[2] === 'quantity' ? amount(source.quantity)
            : line[2] === 'unit_price' ? amount(source.unitPrice) : amount(computed?.amount)
      continue
    }
    if (path.startsWith('field.')) { out[token] = entryCell(data.resolution.fields[path.slice(6)] as never); continue }
    switch (path) {
      case 'invoice.number': out[token] = data.number ? text(data.number) : text(NUMBER_MARKER); break
      case 'invoice.issue_date': out[token] = data.issueDate ? date(data.issueDate) : text(DATE_MARKER); break
      case 'invoice.currency': out[token] = text(data.totals?.currency); break
      case 'invoice.service_period_start': out[token] = date(data.content.servicePeriodStart); break
      case 'invoice.service_period_end': out[token] = date(data.content.servicePeriodEnd); break
      case 'invoice.subtotal': out[token] = amount(data.totals?.subtotal); break
      case 'invoice.tax_rate': out[token] = data.totals ? { valueType: 'number', value: officeNumber(data.totals.taxRate) } : { valueType: 'blank', value: null }; break
      case 'invoice.tax_amount': out[token] = amount(data.totals?.taxAmount); break
      case 'invoice.total': out[token] = amount(data.totals?.total); break
      case 'seller.legal_name': out[token] = text(data.sellerLegalName); break
      case 'seller.display_name': out[token] = text(data.sellerDisplayName); break
      case 'buyer.name': out[token] = text(data.companyName); break
      case 'buyer.account_label': out[token] = text(data.account.label); break
      case 'buyer.billing_address': out[token] = text(data.account.billingAddress); break
      default: refuse('invalid_input', `Unsupported template path ${path}.`)
    }
  }
  return out
}

type Computed = {
  resolution: CrmResolutionReceipt; totals: CrmInvoiceTotals | null; allocations: Array<{ dealId: string; amount: string; billingRequestId?: string }>
  questions: Question[]; draftReady: boolean; issueReady: boolean; sourceHash: string; contentHash: string
  envelope: CrmScopeEnvelope; tokens: Record<string, CellValue>
}

async function compute(tx: CrmOperationsTransaction, params: {
  operationKey: string; version: CrmOperationVersionRow; account: CrmAccountRow; content: Content; current?: CrmScopeEnvelope
}): Promise<Computed> {
  const { client, context } = tx.commercial()
  const access = await tx.commercial().actorAccess()
  const { map, templateVersionId } = templateMap(params.version)
  const keys = new Set(params.version.fieldBindings.map((binding) => binding.fieldKey))
  if (!keys.has('currency') || !keys.has('tax_rate')) {
    refuse('conflict', 'An invoice operation binds the currency and tax_rate fields.', { reason: 'invoice_binding_incomplete' })
  }
  let envelope: CrmScopeEnvelope = {
    sensitivity: maxSensitivity(params.account.sensitivity, params.current?.sensitivity ?? 'public'),
    compartments: unionScopeRequirements(params.account.compartments, params.current?.compartments) ?? [],
    projectIds: unionScopeRequirements(params.account.projectIds, params.current?.projectIds) ?? [],
  }
  for (const dealId of params.content.dealIds) {
    const deal = await readCrmReference(access.userId, context.workspaceId, dealId, ['deal'], access, client).catch(() => null)
    if (!deal) unavailable()
    if (deal.attributes.company_id !== params.account.companyId) refuse('invalid_input', 'Every deal must belong to the account company.', { reason: 'deal_outside_account' })
    envelope = { sensitivity: maxSensitivity(envelope.sensitivity, deal.sensitivity),
      compartments: unionScopeRequirements(envelope.compartments, deal.compartments ?? []) ?? [],
      projectIds: unionScopeRequirements(envelope.projectIds, deal.projectIds ?? []) ?? [] }
  }
  if (params.content.lines.some((line) => line.dealId && !params.content.dealIds.includes(line.dealId))) {
    refuse('invalid_input', 'A line can only reference one of the preparation deals.', { reason: 'line_deal_outside_preparation' })
  }
  const run = (sql: string, values: unknown[]) => client.query(sql, values)
  const profiles = await readVisibleProfiles(run as never, context.workspaceId, { userId: access.userId, access }, params.account)
  const resolution = resolveForAccount({ operationKey: params.operationKey, version: params.version, businessDate: params.content.servicePeriodStart,
    dealId: params.content.dealIds.length === 1 ? params.content.dealIds[0]! : null, profiles, transaction: params.content.values })
  const questions: Question[] = [...resolution.questions]
  if (!params.content.lines.length) questions.push({ fieldKey: 'lines', label: 'Line items', kind: 'missing', requiredFor: 'draft', question: 'Add at least one line item with description, quantity and unit price.' })
  if (params.content.lines.length > Object.values(map.tokens).filter((path) => /^line\.\d+\.description$/.test(path)).length) {
    refuse('invalid_input', 'The template has fewer line rows than the preparation.', { reason: 'template_line_capacity' })
  }
  const currency = resolution.fields.currency?.value, taxRate = resolution.fields.tax_rate?.value
  let totals: CrmInvoiceTotals | null = null
  if (typeof currency === 'string' && typeof taxRate === 'string' && params.content.lines.length) {
    try { totals = computeCrmInvoiceTotals({ currency, minorUnits: map.minorUnits, lines: params.content.lines, taxRate }) } catch (error) {
      if (error instanceof CrmDecimalError) refuse('invalid_input', error.message, { reason: 'unsupported_monetary_value' })
      throw error
    }
  }
  let allocations: Array<{ dealId: string; amount: string; billingRequestId?: string }> = []
  if (!params.content.dealIds.length) {
    questions.push({ fieldKey: 'deals', label: 'Deals', kind: 'missing', requiredFor: 'issue', question: 'Which deal does this invoice bill?' })
  } else if (totals) {
    if (params.content.dealIds.length === 1 && !params.content.allocations.length) {
      allocations = [{ dealId: params.content.dealIds[0]!, amount: totals.total }]
    } else {
      allocations = params.content.allocations.map((allocation) => ({ dealId: allocation.dealId, amount: crmDecimalRound(allocation.amount, totals!.minorUnits),
        ...(allocation.billingRequestId ? { billingRequestId: allocation.billingRequestId } : {}) }))
      const covered = new Set(allocations.map((allocation) => allocation.dealId))
      const sum = allocations.reduce((total, allocation) => crmDecimalAdd(total, allocation.amount, totals!.minorUnits), crmDecimalRound('0', totals.minorUnits))
      if (covered.size !== params.content.dealIds.length || params.content.dealIds.some((dealId) => !covered.has(dealId)) || crmDecimalCompare(sum, totals.total) !== 0) {
        questions.push({ fieldKey: 'allocations', label: 'Deal allocations', kind: 'missing', requiredFor: 'issue',
          question: `Allocate the total of ${totals.total} ${totals.currency} across every deal on this invoice.` })
      }
    }
  }
  const blocking = (stage: 'draft' | 'issue') => questions.some((question) => question.requiredFor === 'draft' || (stage === 'issue' && (question.requiredFor === 'issue' || question.kind !== 'missing')))
  const draftReady = !blocking('draft') && totals !== null
  const issueReady = draftReady && !blocking('issue')
  const account = params.account
  const seller = (await readSellerById(client, context.workspaceId, account.sellerId))!
  const company = await readCrmReference(access.userId, context.workspaceId, account.companyId, 'company', access, client).catch(() => null)
  if (!company) unavailable()
  const tokens = tokenValues(map, { number: null, issueDate: null, totals, resolution, sellerLegalName: seller.legalName, sellerDisplayName: seller.displayName,
    companyName: company.displayName, account, content: params.content })
  return {
    resolution, totals, allocations, questions, draftReady, issueReady, envelope, tokens,
    sourceHash: crmOperationsSha256({ operationVersionId: params.version.id, configHash: params.version.configHash, templateVersionId, profiles: resolution.profileVersions }),
    contentHash: crmOperationsSha256(params.content),
  }
}

function contentOf(command: Command<'prepare_commercial_document'> | Command<'revise_commercial_preparation'>): Content {
  return { dealIds: [...new Set(command.dealIds)].sort(), servicePeriodStart: command.servicePeriodStart, servicePeriodEnd: command.servicePeriodEnd,
    lines: command.lines, values: command.values, allocations: command.allocations }
}

async function persistVersion(tx: CrmOperationsTransaction, preparation: { id: string; invoiceId: string }, version: number, content: Content, computed: Computed, operationId: string) {
  const { client, context } = tx.commercial()
  const saved = await insertPreparationVersion(client, context.workspaceId, {
    preparationId: preparation.id, version, content, resolution: computed.resolution,
    totals: { invoice: computed.totals, allocations: computed.allocations, tokens: computed.tokens }, questions: computed.questions,
    draftReady: computed.draftReady, issueReady: computed.issueReady, sourceHash: computed.sourceHash, contentHash: computed.contentHash,
    operationId, actor: actorColumns(context),
  })
  await updateInvoiceDraft(client, context.workspaceId, preparation.invoiceId, {
    state: 'draft', currency: computed.totals?.currency ?? null, minorUnits: computed.totals?.minorUnits ?? null, subtotal: computed.totals?.subtotal ?? null,
    taxRate: computed.totals?.taxRate ?? null, taxAmount: computed.totals?.taxAmount ?? null, total: computed.totals?.total ?? null, envelope: computed.envelope,
  })
  return saved
}

function summary(preparation: CrmPreparationRow, version: CrmPreparationVersionRow, invoice: CrmInvoiceRow | null) {
  return { preparation, version: { version: version.version, questions: version.questions, draftReady: version.draftReady, issueReady: version.issueReady,
    totals: (version.totals as { invoice: unknown } | null)?.invoice ?? null }, invoice: invoice ? { id: invoice.id, state: invoice.state, number: invoice.number, version: invoice.version } : null }
}

async function prepare(tx: CrmOperationsTransaction, command: Command<'prepare_commercial_document'>): Promise<[CommercialResult, CrmDocumentFollowUp | null]> {
  const { client, context } = tx.commercial()
  const access = await tx.commercial().actorAccess()
  const operation = await readAcceptedOperation(client, context.workspaceId, command.operationKey)
  if (!operation || operation.definition.operationKind !== 'invoice') refuse('not_found', 'The invoice operation has no accepted version.')
  const account = await lockAccount(client, context.workspaceId, command.accountId, access)
  if (!account || account.status !== 'active') unavailable()
  grant(context, 'crm.commercial.write', command.operationKey, account.sellerKey)
  const content = contentOf(command)
  const computed = await compute(tx, { operationKey: command.operationKey, version: operation.version, account, content })
  const actor = actorColumns(context)
  const id = await insertPreparation(client, context.workspaceId, { operationDefinitionId: operation.definition.id, operationVersionId: operation.version.id,
    operationKind: 'invoice', accountId: account.id, sellerId: account.sellerId, title: command.title ?? `Invoice for ${account.label}`, envelope: computed.envelope, actor })
  const invoiceId = await insertInvoice(client, context.workspaceId, { preparationId: id, sellerId: account.sellerId, accountId: account.id, envelope: computed.envelope })
  const version = await persistVersion(tx, { id, invoiceId }, 1, content, computed, command.operationId)
  await commercialAudit(tx, context, { action: 'crm.preparation.created', subjectKind: 'crm_preparation', subjectId: id, details: { operationKey: command.operationKey, version: 1 } })
  const preparation = (await lockPreparation(client, context.workspaceId, id, null))!
  return [commercialResult(command.kind, summary(preparation, version, await invoiceForPreparation(client, context.workspaceId, id)), { created: true }),
    version.draftReady ? { kind: 'render_draft', workspaceId: context.workspaceId, preparationId: id, version: 1, userId: access.userId } : null]
}

async function lockForChange(tx: CrmOperationsTransaction, preparationId: string, expectedVersion: number) {
  const { client, context } = tx.commercial()
  const access = await tx.commercial().actorAccess()
  const preparation = await lockPreparation(client, context.workspaceId, preparationId, access)
  if (!preparation) unavailable()
  if (preparation.version !== expectedVersion) refuse('conflict', 'The preparation changed. Reread it first.', { reason: 'stale_version', currentVersion: preparation.version })
  const definition = await client.query<{ key: string }>('SELECT operation_key AS key FROM crm_operation_definitions WHERE workspace_id=$1 AND id=$2', [context.workspaceId, preparation.operationDefinitionId])
  const account = await lockAccount(client, context.workspaceId, preparation.accountId, access)
  if (!account) unavailable()
  return { preparation, access, account, operationKey: definition.rows[0]!.key }
}

async function revise(tx: CrmOperationsTransaction, command: Command<'revise_commercial_preparation'>): Promise<[CommercialResult, CrmDocumentFollowUp | null]> {
  const { client, context } = tx.commercial()
  const { preparation, access, account, operationKey } = await lockForChange(tx, command.preparationId, command.expectedVersion)
  grant(context, 'crm.commercial.write', operationKey, account.sellerKey)
  if (!['draft', 'ready'].includes(preparation.state)) refuse('invalid_transition', 'An issued or issuing preparation cannot be revised.', { state: preparation.state })
  const operation = await readAcceptedOperation(client, context.workspaceId, operationKey)
  if (!operation) refuse('not_found', 'The invoice operation has no accepted version.')
  const content = contentOf(command)
  const computed = await compute(tx, { operationKey, version: operation.version, account, content, current: preparation })
  const invoice = (await invoiceForPreparation(client, context.workspaceId, preparation.id))!
  const next = preparation.version + 1
  const version = await persistVersion(tx, { id: preparation.id, invoiceId: invoice.id }, next, content, computed, command.operationId)
  // A commercial change invalidates any prior review.
  await updatePreparation(client, context.workspaceId, preparation.id, { version: next, state: 'draft', readyVersion: null, ready: null,
    envelope: computed.envelope, operationVersionId: operation.version.id, actor: actorColumns(context) })
  await commercialAudit(tx, context, { action: 'crm.preparation.revised', subjectKind: 'crm_preparation', subjectId: preparation.id, details: { version: next, reviewCleared: preparation.state === 'ready' } })
  const saved = (await lockPreparation(client, context.workspaceId, preparation.id, null))!
  return [commercialResult(command.kind, summary(saved, version, await invoiceForPreparation(client, context.workspaceId, preparation.id))),
    version.draftReady ? { kind: 'render_draft', workspaceId: context.workspaceId, preparationId: preparation.id, version: next, userId: access.userId } : null]
}

async function markReady(tx: CrmOperationsTransaction, command: Command<'mark_preparation_ready'>): Promise<[CommercialResult, null]> {
  const { client, context } = tx.commercial()
  const { preparation, account, operationKey } = await lockForChange(tx, command.preparationId, command.expectedVersion)
  grant(context, 'crm.commercial.write', operationKey, account.sellerKey)
  if (preparation.state === 'ready' && preparation.readyVersion === preparation.version) {
    return [commercialResult(command.kind, { preparation }, { duplicate: true }), null]
  }
  if (preparation.state !== 'draft') refuse('invalid_transition', 'Only a draft preparation can be marked ready.', { state: preparation.state })
  const version = (await readPreparationVersion(client, context.workspaceId, preparation.id, preparation.version))!
  if (!version.issueReady) refuse('invalid_transition', 'Resolve every question before marking ready.', { reason: 'questions_open', questions: version.questions })
  if (preparation.officeBinding?.version !== preparation.version || preparation.draftRenderError) {
    refuse('invalid_transition', 'Review the rendered Office draft of this exact version first.', { reason: 'draft_not_rendered' })
  }
  const opVersion = (await readOperationVersion(client, context.workspaceId, preparation.operationVersionId))!
  if (opVersion.reviewPolicy === 'exact_version_review') {
    const reviewer = context.actor.kind === 'user' ? context.actor.userId : null
    if (!reviewer || !['owner', 'admin'].includes(context.authority.role)) refuse('not_authorized', 'This operation requires review by a workspace owner or admin.')
    if (version.actorUserId === reviewer) refuse('not_authorized', 'The author of a version cannot review it.', { reason: 'self_review' })
  }
  await updatePreparation(client, context.workspaceId, preparation.id, { state: 'ready', readyVersion: preparation.version, ready: actorColumns(context), actor: actorColumns(context) })
  const invoice = (await invoiceForPreparation(client, context.workspaceId, preparation.id))!
  await setInvoiceState(client, context.workspaceId, invoice.id, 'ready')
  await commercialAudit(tx, context, { action: 'crm.preparation.ready', subjectKind: 'crm_preparation', subjectId: preparation.id, details: { version: preparation.version, policy: opVersion.reviewPolicy } })
  return [commercialResult(command.kind, { preparation: (await lockPreparation(client, context.workspaceId, preparation.id, null))! }), null]
}

async function issue(tx: CrmOperationsTransaction, command: Command<'issue_invoice'>): Promise<[CommercialResult, CrmDocumentFollowUp | null]> {
  const { client, context } = tx.commercial()
  const { preparation, access, account, operationKey } = await lockForChange(tx, command.preparationId, command.expectedVersion)
  grant(context, 'crm.commercial.issue', operationKey, account.sellerKey)
  const invoice = (await invoiceForPreparation(client, context.workspaceId, preparation.id))!
  if (invoice.frozenHash) return [commercialResult(command.kind, { invoice }, { duplicate: true }), null]
  if (preparation.state !== 'ready' || preparation.readyVersion !== preparation.version) {
    refuse('invalid_transition', 'Issue requires the reviewed, ready version.', { reason: 'not_ready', state: preparation.state })
  }
  const operation = await readAcceptedOperation(client, context.workspaceId, operationKey)
  if (!operation || operation.version.id !== preparation.operationVersionId) {
    refuse('conflict', 'The operation procedure changed after review. Revise the preparation.', { reason: 'operation_version_changed' })
  }
  const version = (await readPreparationVersion(client, context.workspaceId, preparation.id, preparation.version))!
  const content = version.content as unknown as Content
  // Recheck sources and current access at issue: drift or a lost source fails closed.
  const recomputed = await compute(tx, { operationKey, version: operation.version, account, content, current: preparation })
  if (recomputed.sourceHash !== version.sourceHash || recomputed.contentHash !== version.contentHash || !recomputed.issueReady) {
    refuse('conflict', 'Accepted terms or access changed since review. Revise and review again.', { reason: 'stale_sources' })
  }
  const referenceKey = operation.version.referenceDefinitionKey
  if (!referenceKey) refuse('conflict', 'The operation names no invoice numbering definition.', { reason: 'numbering_unconfigured' })
  const target = { id: invoice.id, kind: 'invoice', displayName: preparation.title, updatedAt: invoice.updatedAt, parentCompanyId: account.companyId }
  const reference = await assignCrmReferenceAtEvent(tx, { definitionKey: referenceKey, event: 'issue', target, businessDate: command.issueDate,
    value: command.value, external: command.external, operationId: command.operationId })
  const totals = recomputed.totals!
  const { map, templateVersionId, pdfPreset } = templateMap(operation.version)
  const seller = (await readSellerById(client, context.workspaceId, account.sellerId))!
  const company = (await readCrmReference(access.userId, context.workspaceId, account.companyId, 'company', access, client))!
  const tokens = tokenValues(map, { number: reference.printableValue, issueDate: command.issueDate, totals, resolution: recomputed.resolution,
    sellerLegalName: seller.legalName, sellerDisplayName: seller.displayName, companyName: company.displayName, account, content })
  const payload = { schemaVersion: 1, number: reference.printableValue, issueDate: command.issueDate, currency: totals.currency, minorUnits: totals.minorUnits,
    lines: totals.lines, subtotal: totals.subtotal, taxRate: totals.taxRate, taxAmount: totals.taxAmount, total: totals.total, allocations: recomputed.allocations,
    tokens, map, templateVersionId, pdfPreset, preparationVersion: version.version, operationVersionId: operation.version.id, sourceHash: version.sourceHash,
    seller: { id: seller.id, legalName: seller.legalName }, buyer: { companyId: account.companyId, name: company.displayName, accountId: account.id } }
  await freezeInvoice(client, context.workspaceId, invoice.id, { number: reference.printableValue, referenceId: reference.id, issueDate: command.issueDate,
    payload, hash: crmOperationsSha256(payload), lines: totals.lines.map((line) => ({ ...line, dealId: line.dealId ?? null })), allocations: recomputed.allocations, currency: totals.currency })
  // Allocations naming a billing request close it in this transaction, once, for exactly its reviewed amount.
  for (const allocation of recomputed.allocations) {
    if (allocation.billingRequestId) await closeBillingRequest(client, context.workspaceId, allocation.billingRequestId, invoice.id, allocation.dealId, allocation.amount, totals.currency)
  }
  await updatePreparation(client, context.workspaceId, preparation.id, { state: 'issue_pending', actor: actorColumns(context) })
  const attempt = await enqueueIssueAttempt(client, context.workspaceId, invoice.id, command.operationId, access.userId)
  await commercialAudit(tx, context, { action: 'crm.invoice.issue_requested', subjectKind: 'crm_invoice', subjectId: invoice.id, details: { preparationVersion: version.version } })
  return [commercialResult(command.kind, { invoice: (await lockInvoice(client, context.workspaceId, invoice.id, null))!, attemptId: attempt.id }, { created: true }),
    { kind: 'process_attempt', workspaceId: context.workspaceId, attemptId: attempt.id }]
}

async function retry(tx: CrmOperationsTransaction, command: Command<'retry_invoice_issue'>): Promise<[CommercialResult, CrmDocumentFollowUp | null]> {
  const { client, context } = tx.commercial()
  const access = await tx.commercial().actorAccess()
  const invoice = await lockInvoice(client, context.workspaceId, command.invoiceId, access)
  if (!invoice || !invoice.preparationId) unavailable()
  if (invoice.version !== command.expectedVersion) refuse('conflict', 'The invoice changed. Reread it first.', { reason: 'stale_version', currentVersion: invoice.version })
  if (invoice.state !== 'issue_failed') refuse('invalid_transition', 'Only a failed issue can be retried.', { state: invoice.state })
  const account = await lockAccount(client, context.workspaceId, invoice.accountId, access)
  if (!account) unavailable()
  const op = await client.query<{ key: string }>(`SELECT d.operation_key AS key FROM crm_commercial_preparations p JOIN crm_operation_definitions d
    ON d.workspace_id=p.workspace_id AND d.id=p.operation_definition_id WHERE p.workspace_id=$1 AND p.id=$2`, [context.workspaceId, invoice.preparationId])
  grant(context, 'crm.commercial.issue', op.rows[0]!.key, account.sellerKey)
  await setInvoiceState(client, context.workspaceId, invoice.id, 'issue_pending')
  await updatePreparation(client, context.workspaceId, invoice.preparationId, { state: 'issue_pending', actor: actorColumns(context) })
  const attempt = await enqueueIssueAttempt(client, context.workspaceId, invoice.id, command.operationId, access.userId)
  await commercialAudit(tx, context, { action: 'crm.invoice.issue_retried', subjectKind: 'crm_invoice', subjectId: invoice.id, details: { attempt: attempt.attempt } })
  return [commercialResult(command.kind, { invoice: (await lockInvoice(client, context.workspaceId, invoice.id, null))!, attemptId: attempt.id }, { created: true }),
    { kind: 'process_attempt', workspaceId: context.workspaceId, attemptId: attempt.id }]
}

async function voidInvoice(tx: CrmOperationsTransaction, command: Command<'void_invoice'>): Promise<[CommercialResult, null]> {
  const { client, context } = tx.commercial()
  const access = await tx.commercial().actorAccess()
  const invoice = await lockInvoice(client, context.workspaceId, command.invoiceId, access)
  if (!invoice) unavailable()
  if (invoice.version !== command.expectedVersion) refuse('conflict', 'The invoice changed. Reread it first.', { reason: 'stale_version', currentVersion: invoice.version })
  if (!['issued', 'issue_failed'].includes(invoice.state)) refuse('invalid_transition', 'Only an issued or failed invoice can be voided.', { state: invoice.state })
  if (invoice.origin === 'external') refuse('invalid_transition', 'An externally issued invoice belongs to its provider; correct its reference instead of voiding it.', { reason: 'provider_owned' })
  const account = await lockAccount(client, context.workspaceId, invoice.accountId, access)
  if (!account) unavailable()
  if (context.authority.integration) requireCrmIntegrationResources(context.authority.integration, 'crm.commercial.issue', { sellerKeys: account.sellerKey })
  await setInvoiceState(client, context.workspaceId, invoice.id, 'voided', { voidReason: command.reason })
  const reopened = await reopenBillingRequestsForInvoice(client, context.workspaceId, invoice.id)
  if (invoice.preparationId) await updatePreparation(client, context.workspaceId, invoice.preparationId, { state: 'voided', actor: actorColumns(context) })
  await commercialAudit(tx, context, { action: 'crm.invoice.voided', subjectKind: 'crm_invoice', subjectId: invoice.id, details: { reason: command.reason, reopenedBillingRequests: reopened } })
  return [commercialResult(command.kind, { invoice: (await lockInvoice(client, context.workspaceId, invoice.id, null))! }), null]
}

export async function executeCrmCommercialDocumentCommand(tx: CrmOperationsTransaction, command: CrmCommercialDocumentCommand): Promise<{ result: CommercialResult; followUp: CrmDocumentFollowUp | null }> {
  let followUp: CrmDocumentFollowUp | null = null
  const result = await withOperationReceipt(tx, command, async () => {
    const [outcome, next] = await (command.kind === 'prepare_commercial_document' ? prepare(tx, command)
      : command.kind === 'revise_commercial_preparation' ? revise(tx, command)
        : command.kind === 'mark_preparation_ready' ? markReady(tx, command)
          : command.kind === 'issue_invoice' ? issue(tx, command)
            : command.kind === 'retry_invoice_issue' ? retry(tx, command) : voidInvoice(tx, command))
    followUp = next
    return outcome
  })
  return { result, followUp: result.duplicate ? null : followUp }
}

// ── After-commit work ───────────────────────────────────────────────

function systemContext(workspaceId: string, runId: string): CrmOperationsContext {
  return { workspaceId, actor: { kind: 'system_job', job: 'commercial_documents', runId }, authority: { role: 'system', canWrite: true, canConfigure: false, trustedIdentitySources: [] } }
}

function errorText(error: unknown): string {
  const fields = (error as { fields?: string[] } | null)?.fields
  if (Array.isArray(fields)) return `Template fields need values: ${fields.join(', ')}`
  return error instanceof Error ? error.message : 'Rendering failed'
}

/** Render or refresh the Office draft for one preparation version as the acting user. */
export async function renderCrmPreparationDraft(store: CrmOperationsStore, runtime: CrmCommercialDocumentRuntime, followUp: Extract<CrmDocumentFollowUp, { kind: 'render_draft' }>): Promise<void> {
  const context = systemContext(followUp.workspaceId, randomUUID())
  const loaded = await store.transaction(context, async (tx) => {
    const { client } = tx.commercial()
    const preparation = await lockPreparation(client, followUp.workspaceId, followUp.preparationId, null)
    if (!preparation || preparation.version !== followUp.version) return null
    const version = await readPreparationVersion(client, followUp.workspaceId, preparation.id, preparation.version)
    const opVersion = await readOperationVersion(client, followUp.workspaceId, preparation.operationVersionId)
    return preparation && version && opVersion ? { preparation, version, opVersion } : null
  })
  if (!loaded) return
  const record = (outcome: Parameters<typeof recordDraftRender>[4]) => store.transaction(context, (tx) =>
    recordDraftRender(tx.commercial().client, followUp.workspaceId, followUp.preparationId, followUp.version, outcome))
  if (!runtime.binding) { await record({ error: 'Office rendering is unavailable on this deployment.' }); return }
  try {
    const { map, templateVersionId } = templateMap(loaded.opVersion)
    const tokens = (loaded.version.totals as { tokens: Record<string, CellValue> }).tokens
    const deferred = new Set(Object.entries(map.tokens).filter(([, path]) => (CRM_INVOICE_ISSUE_PATHS as readonly string[]).includes(path)).map(([token]) => token))
    const scope = { sensitivity: loaded.preparation.sensitivity, compartments: loaded.preparation.compartments, projectIds: loaded.preparation.projectIds }
    if (!loaded.preparation.officeArtifactId) {
      const created = await runtime.binding.createDraft({ userId: followUp.userId, workspaceId: followUp.workspaceId, templateVersionId, title: loaded.preparation.title,
        scope, values: tokens, deferred })
      await record({ artifactId: created.artifactId, officeVersion: created.version, cells: created.cells.filter((cell) => Object.hasOwn(map.tokens, cell.token)) })
      return
    }
    const cells = loaded.preparation.officeBinding?.cells ?? []
    const written = await runtime.binding.writeCells({ userId: followUp.userId, workspaceId: followUp.workspaceId, artifactId: loaded.preparation.officeArtifactId, scope,
      actorUserId: followUp.userId, summary: `Commercial preparation version ${followUp.version}`,
      cells: cells.map((cell) => ({ sheetId: cell.sheetId, cellId: cell.cellId, address: cell.address, value: tokens[cell.token]! })) })
    await record({ artifactId: loaded.preparation.officeArtifactId, officeVersion: written.version, cells })
  } catch (error) {
    await record({ error: errorText(error) })
  }
}

function sameAmount(value: unknown, expected: string, minorUnits: number): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false
  return crmDecimalCompare(crmDecimalRound(value.toFixed(Math.min(12, minorUnits + 6)), minorUnits), crmDecimalRound(expected, minorUnits)) === 0
}

/** Lease and run issue attempts: rewrite bound cells from the frozen payload, reconcile, release XLSX and PDF, mark issued. */
export async function processCrmIssueAttempts(store: CrmOperationsStore, runtime: CrmCommercialDocumentRuntime, options: { attemptId?: string; limit?: number; leaseMs?: number } = {}): Promise<number> {
  let processed = 0
  for (let index = 0; index < (options.limit ?? 10); index++) {
    const leaseToken = randomUUID()
    const lease = await (async () => {
      const client = await getPool().connect()
      try {
        await client.query('BEGIN'); await client.query(`SELECT set_config('app.system_bypass','true',true)`)
        const leased = await leaseIssueAttempt(client, options.attemptId ?? null, leaseToken, options.leaseMs ?? 10 * 60_000)
        await client.query('COMMIT'); return leased
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error } finally { client.release() }
    })()
    if (!lease) break
    processed++
    const context = systemContext(lease.workspaceId, lease.id)
    const finish = (outcome: { ok: true; patch: Record<string, unknown>; officeVersion: number } | { ok: false; code: string; detail: string }) =>
      store.transaction(context, async (tx) => {
        const { client } = tx.commercial()
        const invoice = (await lockInvoice(client, lease.workspaceId, lease.invoiceId, null))!
        if (!await finishIssueAttempt(client, lease.workspaceId, lease.id, leaseToken, outcome.ok ? { state: 'succeeded', officeVersion: outcome.officeVersion }
          : { state: 'failed', errorCode: outcome.code, errorDetail: outcome.detail })) return
        if (invoice.state !== 'issue_pending') return
        await setInvoiceState(client, lease.workspaceId, invoice.id, outcome.ok ? 'issued' : 'issue_failed', outcome.ok ? outcome.patch : {})
        if (invoice.preparationId) await updatePreparation(client, lease.workspaceId, invoice.preparationId, { state: outcome.ok ? 'issued' : 'issue_failed',
          actor: { kind: 'system_job', id: `commercial_documents:${lease.id}`, userId: null } })
        await commercialAudit(tx, context, { action: outcome.ok ? 'crm.invoice.issued' : 'crm.invoice.issue_failed', subjectKind: 'crm_invoice', subjectId: invoice.id,
          details: outcome.ok ? { attempt: lease.attempt } : { attempt: lease.attempt, code: outcome.code } })
      })
    try {
      const loaded = await store.transaction(context, async (tx) => {
        const { client } = tx.commercial()
        const invoice = (await lockInvoice(client, lease.workspaceId, lease.invoiceId, null))!
        const preparation = (await lockPreparation(client, lease.workspaceId, invoice.preparationId!, null))!
        // Current access of the issuing user is rechecked before anything is released.
        const scope = commercialVisibility(lease.renderUserId, lease.workspaceId, 'i', 3)
        const visible = await client.query(`SELECT 1 FROM crm_invoices i WHERE i.workspace_id=$1 AND i.id=$2 AND ${scope.sql}`, [lease.workspaceId, invoice.id, ...scope.params])
        return { invoice, preparation, visible: Boolean(visible.rowCount) }
      })
      if (!loaded.visible) throw Object.assign(new Error('The issuing user can no longer read this invoice.'), { code: 'access_revoked' })
      if (!runtime.binding) throw Object.assign(new Error('Office rendering is unavailable on this deployment.'), { code: 'office_unavailable' })
      const payload = loaded.invoice.frozenPayload as { tokens: Record<string, CellValue>; map: CrmInvoiceTemplateMap; pdfPreset: 'invoice' | 'worksheet'
        lines: Array<{ amount: string }>; subtotal: string; taxAmount: string; total: string; minorUnits: number }
      const artifactId = loaded.preparation.officeArtifactId
      const cells = loaded.preparation.officeBinding?.cells ?? []
      if (!artifactId || !cells.length) throw Object.assign(new Error('The preparation has no rendered Office draft.'), { code: 'draft_missing' })
      const scope = { sensitivity: loaded.invoice.sensitivity, compartments: loaded.invoice.compartments, projectIds: loaded.invoice.projectIds }
      const written = await runtime.binding.writeCells({ userId: lease.renderUserId, workspaceId: lease.workspaceId, artifactId, scope, actorUserId: lease.renderUserId,
        summary: `Issued invoice ${loaded.invoice.number}`, cells: cells.map((cell) => ({ sheetId: cell.sheetId, cellId: cell.cellId, address: cell.address, value: payload.tokens[cell.token]! })) })
      const expected: Record<string, string> = { 'invoice.subtotal': payload.subtotal, 'invoice.tax_amount': payload.taxAmount, 'invoice.total': payload.total }
      payload.lines.forEach((line, lineIndex) => { expected[`line.${lineIndex + 1}.amount`] = line.amount })
      const refs = payload.map.reconcile.map((item) => item.cell)
      const values = refs.length ? await runtime.binding.readCells({ userId: lease.renderUserId, artifactId, refs }) : {}
      for (const item of payload.map.reconcile) {
        const want = expected[item.path]
        if (want === undefined) continue
        if (!sameAmount(values[item.cell]?.value, want, payload.minorUnits)) {
          throw Object.assign(new Error(`Workbook ${item.cell} does not reconcile with ${item.path} ${want}.`), { code: 'formula_reconciliation_failed' })
        }
      }
      const destination = { sensitivity: scope.sensitivity, external: true }
      const xlsx = await runtime.binding.release(lease.renderUserId, artifactId, { expectedVersion: written.version, action: 'export', destination, format: 'native' })
      if (xlsx.status !== 201) throw Object.assign(new Error(`Workbook release was refused: ${JSON.stringify(xlsx.body).slice(0, 300)}`), { code: 'release_blocked' })
      const sheetId = await runtime.binding.sheetId({ userId: lease.renderUserId, artifactId, sheetName: payload.map.sheetName })
      if (!sheetId) throw Object.assign(new Error(`The template has no ${payload.map.sheetName} worksheet.`), { code: 'release_blocked' })
      const pdf = await runtime.binding.release(lease.renderUserId, artifactId, { expectedVersion: written.version, action: 'export', destination, format: 'pdf',
        spreadsheetPdf: { sheetId, printArea: payload.map.printArea, calculationMode: 'automatic', expectedPageCount: 1, preset: payload.pdfPreset } })
      if (pdf.status !== 201) throw Object.assign(new Error(`Invoice PDF release was refused: ${JSON.stringify(pdf.body).slice(0, 300)}`), { code: 'release_blocked' })
      const receipt = pdf.body.receipt as { spreadsheetPdf?: { actualPageCount?: number } }
      await finish({ ok: true, officeVersion: written.version, patch: {
        officeArtifactId: artifactId, officeVersion: written.version, xlsxReleaseId: xlsx.body.releaseId, xlsxFileId: xlsx.body.fileId, xlsxSha256: xlsx.body.sha256,
        pdfReleaseId: pdf.body.releaseId, pdfFileId: pdf.body.fileId, pdfSha256: pdf.body.sha256, pdfPageCount: receipt.spreadsheetPdf?.actualPageCount ?? 1,
      } })
    } catch (error) {
      const code = typeof (error as { code?: unknown }).code === 'string' && /^[a-z][a-z0-9_.]{0,80}$/.test((error as { code: string }).code) ? (error as { code: string }).code : 'render_failed'
      await finish({ ok: false, code, detail: errorText(error) }).catch(() => undefined)
    }
    if (options.attemptId) break
  }
  return processed
}

export function crmDocumentWorker(store: CrmOperationsStore, runtime: CrmCommercialDocumentRuntime, options: { intervalMs?: number; onError?: (error: unknown) => void } = {}) {
  let timer: NodeJS.Timeout | null = null
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try { await processCrmIssueAttempts(store, runtime) } catch (error) { options.onError?.(error) } finally { running = false }
  }
  return {
    start() { if (!timer) timer = setInterval(() => { void tick() }, options.intervalMs ?? 30_000) },
    stop() { if (timer) clearInterval(timer); timer = null },
    tick,
  }
}

