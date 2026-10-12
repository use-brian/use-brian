/**
 * Canonical business reference commands. Called only from
 * `CrmOperationsService.execute`, inside its single transaction: definitions,
 * native allocation, corrections, retirement and reviewed imports write the
 * reference rows, history, audit, operation receipt and outbox together.
 * Spec: docs/architecture/features/crm-commercial-operations.md
 *
 * [COMP:crm/business-references]
 */

import {
  CrmOperationsError,
  crmReferenceDefinitionIssues,
  crmReferenceNeedsBusinessDate,
  crmReferenceNeedsCategory,
  crmReferencePartitionKey,
  formatCrmBusinessReference,
  normalizeCrmBusinessReference,
  requireCrmIntegrationResources,
  resolveCrmBusinessDate,
  type CrmBusinessDate,
  type CrmBusinessReferenceCommand,
  type CrmOperationsContext,
} from '@use-brian/core'
import type { CrmOperationsTransaction } from '../db/crm-operations-store.js'
import { readCrmMutationSource, readCrmReference } from '../db/crm.js'
import { lockAccount } from '../db/crm-commercial-context-store.js'
import {
  allocateCounter,
  definitionUsage,
  insertDefinition,
  insertHistory,
  insertReference,
  lockReference,
  raisePartitionCounter,
  readActiveReference,
  readDefinitionById,
  readDefinitionByKey,
  readPartitionNext,
  referenceRecord,
  saveSeries,
  setReferenceStatus,
  updateDefinition,
  valueReserved,
  type CrmReferenceDefinitionRow,
  type CrmReferenceRow,
} from '../db/crm-business-reference-store.js'
import {
  actorColumns,
  commercialAudit,
  commercialEmit,
  commercialResult,
  refuse,
  unavailable,
  uniqueViolation,
  withOperationReceipt,
  type CommercialResult,
} from './commercial-transaction.js'

type Command<K extends CrmBusinessReferenceCommand['kind']> = Extract<CrmBusinessReferenceCommand, { kind: K }>

function requireReferenceGrant(context: CrmOperationsContext, operation: 'crm.references.write' | 'crm.references.configure', definitionKey: string): void {
  if (context.authority.integration) {
    requireCrmIntegrationResources(context.authority.integration, operation, { referenceDefinitionKeys: definitionKey })
  }
}

function counterSegmentWidth(definition: Pick<CrmReferenceDefinitionRow, 'format'>): number | null {
  const counter = definition.format?.find((segment) => segment.kind === 'counter')
  return counter?.kind === 'counter' ? counter.width : null
}

function definitionRecord(row: CrmReferenceDefinitionRow): Record<string, unknown> {
  return { ...row }
}

async function saveDefinition(tx: CrmOperationsTransaction, command: Command<'save_reference_definition'>): Promise<CommercialResult> {
  const { client, context } = tx.commercial()
  const input = command.definition
  requireReferenceGrant(context, 'crm.references.configure', input.definitionKey)
  const issues = crmReferenceDefinitionIssues(input)
  if (issues.length) refuse('invalid_input', 'Reference definition is not admissible.', { issues })
  const parent = input.format?.find((segment) => segment.kind === 'parent')
  if (parent?.kind === 'parent') {
    const parentDefinition = await readDefinitionByKey(client, context.workspaceId, parent.definitionKey)
    if (!parentDefinition || !parentDefinition.targetKinds.includes('company')) {
      refuse('catalog_key_invalid', 'The parent segment must name a company reference definition.', { definitionKey: parent.definitionKey })
    }
  }
  const actor = actorColumns(context)
  const width = counterSegmentWidth({ format: input.format })
  if (command.definitionId === undefined) {
    if (await readDefinitionByKey(client, context.workspaceId, input.definitionKey, null)) {
      refuse('conflict', 'A definition with this key already exists. Update it with its id and version.', { reason: 'definition_key_taken' })
    }
    let id: string
    try { id = await insertDefinition(client, context.workspaceId, input, actor) } catch (error) {
      if (uniqueViolation(error) !== null) refuse('conflict', 'The namespace is already bound to another definition.', { reason: 'namespace_taken' })
      throw error
    }
    if (input.assignmentMode === 'native' && width !== null) {
      await saveSeries(client, context.workspaceId, id, { counterStart: input.counterStart, counterWidth: width,
        partitionDimensions: input.partitionDimensions, configVersion: 1, active: input.status === 'active' })
    }
    const saved = (await readDefinitionById(client, context.workspaceId, id))!
    await commercialAudit(tx, context, { action: 'crm.reference_definition.created', subjectKind: 'reference_definition', subjectId: id,
      details: { definitionKey: input.definitionKey, version: saved.version } })
    return commercialResult(command.kind, definitionRecord(saved), { created: true })
  }
  const current = await readDefinitionById(client, context.workspaceId, command.definitionId)
  if (!current) unavailable()
  if (current.version !== command.expectedVersion) {
    refuse('conflict', 'The definition changed. Reread it and apply your change to the current version.', { reason: 'stale_version', currentVersion: current.version })
  }
  if (current.definitionKey !== input.definitionKey) refuse('invalid_input', 'A definition key is stable and cannot be renamed.')
  const usage = await definitionUsage(client, context.workspaceId, current.id)
  if (usage.values > 0) {
    const frozen: string[] = []
    if (input.namespaceKey !== current.namespaceKey) frozen.push('namespaceKey')
    if (input.assignmentMode !== current.assignmentMode) frozen.push('assignmentMode')
    if (current.targetKinds.some((kind) => !input.targetKinds.includes(kind))) frozen.push('targetKinds')
    if ([...input.partitionDimensions].sort().join() !== [...current.partitionDimensions].sort().join()) frozen.push('partitionDimensions')
    if (current.assignmentMode === 'native' && (width !== current.counterWidth || input.counterStart !== current.counterStart)) frozen.push('counter')
    if (input.timezone !== current.timezone && current.partitionDimensions.includes('business_year')) frozen.push('timezone')
    const removed = usage.categoryKeys.filter((key) => !input.categories.some((category) => category.key === key))
    if (removed.length) frozen.push('categories')
    if (frozen.length) {
      refuse('conflict', 'Values have been assigned under this definition. These settings would renumber, rebind or reinterpret them and are frozen.',
        { reason: 'definition_frozen', fields: frozen })
    }
  }
  const version = await updateDefinition(client, context.workspaceId, current.id, input, actor)
  if (input.assignmentMode === 'native' && width !== null) {
    await saveSeries(client, context.workspaceId, current.id, { counterStart: input.counterStart, counterWidth: width,
      partitionDimensions: input.partitionDimensions, configVersion: version, active: input.status === 'active' })
  }
  const saved = (await readDefinitionById(client, context.workspaceId, current.id))!
  await commercialAudit(tx, context, { action: 'crm.reference_definition.updated', subjectKind: 'reference_definition', subjectId: current.id,
    details: { definitionKey: input.definitionKey, version } })
  return commercialResult(command.kind, definitionRecord(saved))
}

type Allocation = {
  printable: string
  normalized: string
  origin: CrmReferenceRow['origin']
  seriesId: string | null
  partitionKey: string | null
  counterValue: number | null
  parentReferenceId: string | null
  parentSnapshot: Record<string, unknown> | null
  businessDate: string | null
  categoryKey: string | null
  externalEvidence: Record<string, unknown> | null
}

/** Resolve the value for one target: native allocation or a supplied manual/external value. */
async function resolveValue(tx: CrmOperationsTransaction, definition: CrmReferenceDefinitionRow, target: ReferenceTarget, input: {
  businessDate?: string; categoryKey?: string; value?: string; external?: { provider: string; remoteId: string }
}): Promise<Allocation> {
  const { client, context } = tx.commercial()
  if (definition.assignmentMode !== 'native') {
    if (!input.value) refuse('invalid_input', 'This definition takes a supplied value.', { reason: 'value_required', assignmentMode: definition.assignmentMode })
    if (definition.assignmentMode === 'external' && !input.external) {
      refuse('invalid_input', 'An externally assigned value needs its provider evidence.', { reason: 'external_evidence_required' })
    }
    if (definition.assignmentMode === 'manual' && input.external) refuse('invalid_input', 'A finance-entered value does not carry provider evidence.')
    return { printable: input.value, normalized: normalizeCrmBusinessReference(input.value), origin: definition.assignmentMode,
      seriesId: null, partitionKey: null, counterValue: null, parentReferenceId: null, parentSnapshot: null,
      businessDate: input.businessDate && /^\d{4}-\d{2}-\d{2}$/.test(input.businessDate) ? input.businessDate : null,
      categoryKey: input.categoryKey ?? null,
      externalEvidence: input.external ? { ...input.external } : null }
  }
  if (input.value || input.external) refuse('invalid_input', 'Native definitions allocate their own value; do not supply one.', { reason: 'value_not_allowed' })
  if (!definition.format || !definition.seriesId || definition.counterStart === null) refuse('conflict', 'The definition has no active number series.', { reason: 'series_unavailable' })
  let businessDate: CrmBusinessDate | null = null
  if (crmReferenceNeedsBusinessDate(definition.format, definition.partitionDimensions)) {
    if (!input.businessDate) refuse('invalid_input', 'This reference needs an explicit business date. It is never guessed.', { reason: 'business_date_required' })
    try { businessDate = resolveCrmBusinessDate(input.businessDate, definition.timezone) } catch (error) {
      refuse('invalid_input', error instanceof Error ? error.message : 'Invalid business date.', { reason: 'business_date_invalid' })
    }
  }
  let category: { key: string; code: string } | null = null
  if (crmReferenceNeedsCategory(definition.format, definition.partitionDimensions)) {
    const found = definition.categories.find((item) => item.key === input.categoryKey)
    if (!found) {
      refuse('catalog_key_invalid', 'Choose one of the declared categories.', { reason: 'category_required', validValues: definition.categories.map((item) => item.key) })
    }
    category = found
  }
  const parentSegment = definition.format.find((segment) => segment.kind === 'parent')
  const needsParent = Boolean(parentSegment) || definition.partitionDimensions.includes('parent_target')
  let parentTargetId: string | null = null
  let parentReference: CrmReferenceRow | null = null
  if (needsParent) {
    parentTargetId = target.parentCompanyId
    if (!parentTargetId) refuse('invalid_input', 'Link the record to its company before assigning this reference.', { reason: 'parent_record_required' })
    const access = await tx.commercial().actorAccess()
    // The parent is printed into this value, so the actor must be able to read it now.
    await readCrmReference(access.userId, context.workspaceId, parentTargetId, 'company', access, client).catch(() => unavailable())
    if (parentSegment?.kind === 'parent') {
      const parentDefinition = await readDefinitionByKey(client, context.workspaceId, parentSegment.definitionKey)
      parentReference = parentDefinition ? await readActiveReference(client, context.workspaceId, parentDefinition.id, parentTargetId) : null
      if (!parentReference) {
        refuse('conflict', 'The company needs its own reference before this one can be assigned.', { reason: 'parent_reference_missing', definitionKey: parentSegment.definitionKey })
      }
    }
  }
  let partitionKey: string
  try {
    partitionKey = crmReferencePartitionKey(definition.partitionDimensions, { businessDate, parentTargetId, categoryKey: category?.key ?? null })
  } catch (error) {
    refuse('invalid_input', error instanceof Error ? error.message : 'Partition inputs are missing.')
  }
  const counterValue = await allocateCounter(client, context.workspaceId, definition.seriesId, partitionKey, definition.counterStart)
  let printable: string
  try {
    printable = formatCrmBusinessReference(definition.format, { counter: counterValue, businessDate,
      parentValue: parentReference?.printableValue ?? null, categoryCode: category?.code ?? null })
  } catch (error) {
    refuse('conflict', error instanceof Error ? error.message : 'The value could not be formatted.', { reason: 'counter_exhausted' })
  }
  if (printable.length > 128) refuse('conflict', 'The formatted value exceeds 128 characters.', { reason: 'value_too_long' })
  return {
    printable, normalized: normalizeCrmBusinessReference(printable), origin: 'native',
    seriesId: definition.seriesId, partitionKey, counterValue,
    parentReferenceId: parentReference?.id ?? null,
    parentSnapshot: parentReference ? { referenceId: parentReference.id, value: parentReference.printableValue,
      version: parentReference.version, targetId: parentReference.targetId } : null,
    businessDate: businessDate?.date ?? null, categoryKey: category?.key ?? null, externalEvidence: null,
  }
}

/**
 * Company and deal references publish under their canonical entity, whose
 * scope floor the outbox and audit derive. An account may be stricter than its
 * company, and neither surface has an account scope source, so account
 * references audit without their value and publish no outbox event.
 */
function scopedPublication(kind: string): boolean {
  // Invoices and accounts may be stricter than any canonical entity they relate to.
  return kind === 'company' || kind === 'deal'
}

/** A reference target: a canonical company or deal, or a customer account. */
export type ReferenceTarget = { id: string; kind: string; displayName: string; updatedAt: string; parentCompanyId: string | null }

async function lockTarget(tx: CrmOperationsTransaction, kind: string, id: string): Promise<ReferenceTarget> {
  const { client, context } = tx.commercial()
  const access = await tx.commercial().actorAccess()
  if (kind === 'account') {
    const account = await lockAccount(client, context.workspaceId, id, access)
    if (!account) unavailable()
    return { id: account.id, kind, displayName: account.label, updatedAt: account.updatedAt, parentCompanyId: account.companyId }
  }
  const target = await readCrmMutationSource(access, id, [kind], client).catch((error: { code?: string }) => {
    if (error?.code === 'scope_operation_denied') return null
    throw error
  })
  if (!target) unavailable()
  return { id: target.id, kind, displayName: target.displayName, updatedAt: new Date(target.updatedAt).toISOString(),
    parentCompanyId: target.kind === 'deal' && typeof target.attributes.company_id === 'string' ? target.attributes.company_id : null }
}

async function persist(tx: CrmOperationsTransaction, definition: CrmReferenceDefinitionRow, target: { kind: string; id: string },
  allocation: Allocation, operationId: string, status: 'active' | 'retired' = 'active', statusReason: string | null = null): Promise<CrmReferenceRow> {
  const { client, context } = tx.commercial()
  if (await valueReserved(client, context.workspaceId, definition.id, allocation.normalized)) {
    refuse('conflict', 'This value is already reserved in the namespace.', { reason: 'reference_collision' })
  }
  try {
    return await insertReference(client, context.workspaceId, {
      definitionId: definition.id, definitionVersion: definition.version, targetKind: target.kind, targetId: target.id,
      printableValue: allocation.printable, normalizedValue: allocation.normalized, origin: allocation.origin, status,
      formatSnapshot: definition.format, seriesId: allocation.seriesId, partitionKey: allocation.partitionKey,
      counterValue: allocation.counterValue, parentReferenceId: allocation.parentReferenceId, parentSnapshot: allocation.parentSnapshot,
      businessDate: allocation.businessDate, categoryKey: allocation.categoryKey, externalEvidence: allocation.externalEvidence,
      operationId, actor: actorColumns(context), statusReason,
    })
  } catch (error) {
    if (uniqueViolation(error) !== null) refuse('conflict', 'This value is already reserved in the namespace.', { reason: 'reference_collision' })
    throw error
  }
}

async function assign(tx: CrmOperationsTransaction, command: Command<'assign_business_reference'>, occurredAt: string): Promise<CommercialResult> {
  const { client, context } = tx.commercial()
  requireReferenceGrant(context, 'crm.references.write', command.definitionKey)
  const definition = await readDefinitionByKey(client, context.workspaceId, command.definitionKey)
  if (!definition || definition.status === 'archived') refuse('not_found', 'Reference definition was not found.')
  if (definition.status !== 'active') refuse('invalid_transition', 'Activate the definition before assigning values.', { reason: 'definition_inactive' })
  if (!definition.targetKinds.includes(command.target.kind)) {
    refuse('invalid_input', 'This definition does not apply to that record kind.', { validValues: definition.targetKinds })
  }
  if (definition.assignmentEvent !== 'explicit') {
    refuse('invalid_transition', `This reference is assigned at ${definition.assignmentEvent}, not by a direct command.`, { reason: 'assignment_event', assignmentEvent: definition.assignmentEvent })
  }
  const target = await lockTarget(tx, command.target.kind, command.target.id)
  if (command.expectedTargetUpdatedAt && new Date(target.updatedAt).toISOString() !== new Date(command.expectedTargetUpdatedAt).toISOString()) {
    refuse('conflict', 'The record changed. Reread it before assigning.', { reason: 'stale_target' })
  }
  const existing = await readActiveReference(client, context.workspaceId, definition.id, target.id)
  if (existing) return commercialResult(command.kind, { reference: referenceRecord(existing, target.displayName) }, { duplicate: true })
  const allocation = await resolveValue(tx, definition, target, command)
  const saved = await persist(tx, definition, command.target, allocation, command.operationId)
  await insertHistory(client, context.workspaceId, { referenceId: saved.id, definitionId: definition.id, targetKind: saved.targetKind,
    targetId: saved.targetId, action: 'assigned', formerValue: null, newValue: saved.printableValue, reason: null,
    actor: actorColumns(context), operationId: command.operationId })
  const published = scopedPublication(command.target.kind)
  await commercialAudit(tx, context, { action: 'crm.reference.assigned', subjectKind: published ? command.target.kind : 'customer_account', subjectId: target.id,
    details: { referenceId: saved.id, definitionKey: definition.definitionKey, origin: saved.origin, ...(published ? { value: saved.printableValue } : {}) } })
  const emitted = published ? [await commercialEmit(tx, context, { eventType: 'crm.reference.assigned', eventKey: `crm.reference.assigned:${saved.id}`,
    subjectKind: command.target.kind, subjectId: target.id, occurredAt,
    payload: { referenceId: saved.id, definitionKey: definition.definitionKey, targetKind: command.target.kind, targetId: target.id,
      value: saved.printableValue, origin: saved.origin, actorKind: context.actor.kind, occurredAt } })] : []
  return commercialResult(command.kind, { reference: referenceRecord(saved, target.displayName) }, { created: true, emittedEventIds: emitted })
}

async function lockChangeableReference(tx: CrmOperationsTransaction, referenceId: string, expectedVersion: number) {
  const { client, context } = tx.commercial()
  const reference = await lockReference(client, context.workspaceId, referenceId)
  if (!reference) unavailable()
  const target = await lockTarget(tx, reference.targetKind, reference.targetId)
  if (reference.version !== expectedVersion) {
    refuse('conflict', 'The reference changed. Reread it first.', { reason: 'stale_version', currentVersion: reference.version })
  }
  if (reference.status !== 'active') refuse('invalid_transition', 'Only the current reference can be changed.', { status: reference.status })
  const definition = (await readDefinitionById(client, context.workspaceId, reference.definitionId, 'share'))!
  return { reference, target, definition }
}

async function replace(tx: CrmOperationsTransaction, command: Command<'replace_business_reference'>, occurredAt: string): Promise<CommercialResult> {
  const { client, context } = tx.commercial()
  const { reference, target, definition } = await lockChangeableReference(tx, command.referenceId, command.expectedVersion)
  requireReferenceGrant(context, 'crm.references.configure', definition.definitionKey)
  if (definition.changePolicy !== 'correctable') {
    refuse('invalid_transition', 'References under this definition are immutable.', { reason: 'reference_immutable' })
  }
  await setReferenceStatus(client, context.workspaceId, reference.id, 'replaced', command.reason)
  const allocation = await resolveValue(tx, definition, target, {
    businessDate: command.businessDate ?? reference.businessDate ?? undefined,
    categoryKey: command.categoryKey ?? reference.categoryKey ?? undefined,
    value: command.value, external: command.external,
  })
  const saved = await persist(tx, definition, { kind: reference.targetKind, id: reference.targetId }, allocation, command.operationId)
  await insertHistory(client, context.workspaceId, { referenceId: saved.id, definitionId: definition.id, targetKind: saved.targetKind,
    targetId: saved.targetId, action: 'replaced', formerValue: reference.printableValue, newValue: saved.printableValue,
    reason: command.reason, actor: actorColumns(context), operationId: command.operationId })
  const published = scopedPublication(reference.targetKind)
  await commercialAudit(tx, context, { action: 'crm.reference.replaced', subjectKind: published ? reference.targetKind : 'customer_account', subjectId: reference.targetId,
    details: { referenceId: saved.id, formerReferenceId: reference.id, definitionKey: definition.definitionKey,
      ...(published ? { formerValue: reference.printableValue, value: saved.printableValue, reason: command.reason } : {}) } })
  const emitted = !published ? [] : [await commercialEmit(tx, context, { eventType: 'crm.reference.replaced', eventKey: `crm.reference.replaced:${saved.id}`,
    subjectKind: reference.targetKind, subjectId: reference.targetId, occurredAt,
    payload: { referenceId: saved.id, formerReferenceId: reference.id, definitionKey: definition.definitionKey,
      targetKind: reference.targetKind, targetId: reference.targetId, value: saved.printableValue, formerValue: reference.printableValue,
      actorKind: context.actor.kind, occurredAt } })]
  return commercialResult(command.kind, { reference: referenceRecord(saved, target.displayName), replaced: referenceRecord({ ...reference, status: 'replaced', version: reference.version + 1 }, target.displayName) },
    { created: true, emittedEventIds: emitted })
}

async function retire(tx: CrmOperationsTransaction, command: Command<'retire_business_reference'>, occurredAt: string): Promise<CommercialResult> {
  const { client, context } = tx.commercial()
  const { reference, target, definition } = await lockChangeableReference(tx, command.referenceId, command.expectedVersion)
  requireReferenceGrant(context, 'crm.references.configure', definition.definitionKey)
  const saved = await setReferenceStatus(client, context.workspaceId, reference.id, 'retired', command.reason)
  await insertHistory(client, context.workspaceId, { referenceId: saved.id, definitionId: definition.id, targetKind: saved.targetKind,
    targetId: saved.targetId, action: 'retired', formerValue: saved.printableValue, newValue: null, reason: command.reason,
    actor: actorColumns(context), operationId: command.operationId })
  const published = scopedPublication(reference.targetKind)
  await commercialAudit(tx, context, { action: 'crm.reference.retired', subjectKind: published ? reference.targetKind : 'customer_account', subjectId: reference.targetId,
    details: { referenceId: saved.id, definitionKey: definition.definitionKey, ...(published ? { value: saved.printableValue, reason: command.reason } : {}) } })
  const emitted = !published ? [] : [await commercialEmit(tx, context, { eventType: 'crm.reference.retired', eventKey: `crm.reference.retired:${saved.id}`,
    subjectKind: reference.targetKind, subjectId: reference.targetId, occurredAt,
    payload: { referenceId: saved.id, definitionKey: definition.definitionKey, targetKind: reference.targetKind,
      targetId: reference.targetId, value: saved.printableValue, actorKind: context.actor.kind, occurredAt } })]
  return commercialResult(command.kind, { reference: referenceRecord(saved, target.displayName) }, { emittedEventIds: emitted })
}

const PARTITION_PART = /^(year=\d{4}|parent=[0-9a-f-]{36}|category=[a-z][a-z0-9_-]{0,62})$/

function validPartitionKey(definition: CrmReferenceDefinitionRow, key: string): boolean {
  if (!definition.partitionDimensions.length) return key === 'all'
  const parts = key.split('|')
  const expected = ['business_year', 'parent_target', 'service_category'].filter((dimension) =>
    definition.partitionDimensions.includes(dimension as CrmReferenceDefinitionRow['partitionDimensions'][number]))
  if (parts.length !== expected.length || parts.some((part) => !PARTITION_PART.test(part))) return false
  return parts.every((part, index) => part.startsWith(({ business_year: 'year=', parent_target: 'parent=', service_category: 'category=' } as Record<string, string>)[expected[index]!]!))
    && parts.filter((part) => part.startsWith('category=')).every((part) => definition.categories.some((item) => `category=${item.key}` === part))
}

/** Also composed by the ERP bridge import, inside its confirmed transaction. */
export async function importReferences(tx: CrmOperationsTransaction, command: Command<'import_business_references'>): Promise<CommercialResult> {
  const { client, context } = tx.commercial()
  requireReferenceGrant(context, 'crm.references.configure', command.definitionKey)
  const definition = await readDefinitionByKey(client, context.workspaceId, command.definitionKey, 'update')
  if (!definition || definition.status === 'archived') refuse('not_found', 'Reference definition was not found.')
  const conflicts: Array<{ index: number; reason: string; value?: string; partitionKey?: string }> = []
  const seen = new Map<string, number>()
  const targets: ReferenceTarget[] = []
  for (const [index, row] of command.rows.entries()) {
    if (!definition.targetKinds.includes(row.target.kind)) { conflicts.push({ index, reason: 'target_kind_not_allowed' }); continue }
    const normalized = normalizeCrmBusinessReference(row.value)
    if (seen.has(normalized)) conflicts.push({ index, reason: 'duplicate_in_import', value: row.value })
    seen.set(normalized, index)
    if (await valueReserved(client, context.workspaceId, definition.id, normalized)) conflicts.push({ index, reason: 'value_reserved', value: row.value })
    if (row.categoryKey && !definition.categories.some((item) => item.key === row.categoryKey)) conflicts.push({ index, reason: 'category_unknown' })
    const target = await lockTarget(tx, row.target.kind, row.target.id).catch(() => null)
    if (!target) { conflicts.push({ index, reason: 'target_unavailable' }); continue }
    targets[index] = target
    if (row.status === 'active' && (await readActiveReference(client, context.workspaceId, definition.id, target.id)
      || command.rows.some((other, otherIndex) => otherIndex < index && other.status === 'active' && other.target.id === row.target.id))) {
      conflicts.push({ index, reason: 'target_already_referenced' })
    }
  }
  for (const counter of command.partitionCounters) {
    if (definition.assignmentMode !== 'native' || !definition.seriesId) { conflicts.push({ index: -1, reason: 'not_a_native_series', partitionKey: counter.partitionKey }); continue }
    if (!validPartitionKey(definition, counter.partitionKey)) { conflicts.push({ index: -1, reason: 'partition_key_invalid', partitionKey: counter.partitionKey }); continue }
    const next = await readPartitionNext(client, context.workspaceId, definition.seriesId, counter.partitionKey)
    if (next !== null && counter.nextValue < next) conflicts.push({ index: -1, reason: 'counter_would_decrease', partitionKey: counter.partitionKey })
  }
  if (conflicts.length) {
    refuse('conflict', 'The import has conflicts that need review. Nothing was imported.', { reason: 'import_conflicts', conflicts: conflicts.slice(0, 100), conflictCount: conflicts.length })
  }
  const imported: Array<Record<string, unknown>> = []
  for (const [index, row] of command.rows.entries()) {
    const target = targets[index]!
    const saved = await persist(tx, definition, row.target, {
      printable: row.value, normalized: normalizeCrmBusinessReference(row.value), origin: 'import', seriesId: null, partitionKey: null,
      counterValue: null, parentReferenceId: null, parentSnapshot: null, businessDate: row.businessDate ?? null,
      categoryKey: row.categoryKey ?? null, externalEvidence: null,
    }, command.operationId, row.status, row.status === 'retired' ? 'Imported as retired' : null)
    await insertHistory(client, context.workspaceId, { referenceId: saved.id, definitionId: definition.id, targetKind: saved.targetKind,
      targetId: saved.targetId, action: 'imported', formerValue: null, newValue: saved.printableValue, reason: null,
      actor: actorColumns(context), operationId: command.operationId })
    const published = scopedPublication(row.target.kind)
    await commercialAudit(tx, context, { action: 'crm.reference.imported', subjectKind: published ? row.target.kind : 'customer_account', subjectId: target.id,
      details: { referenceId: saved.id, definitionKey: definition.definitionKey, status: saved.status, ...(published ? { value: saved.printableValue } : {}) } })
    imported.push({ index, referenceId: saved.id, value: saved.printableValue, status: saved.status })
  }
  for (const counter of command.partitionCounters) {
    await raisePartitionCounter(client, context.workspaceId, definition.seriesId!, counter.partitionKey, counter.nextValue)
  }
  if (command.partitionCounters.length) {
    await commercialAudit(tx, context, { action: 'crm.reference_counters.bootstrapped', subjectKind: 'reference_definition', subjectId: definition.id,
      details: { definitionKey: definition.definitionKey, partitions: command.partitionCounters } })
  }
  return commercialResult(command.kind, { definitionKey: definition.definitionKey, imported, counters: command.partitionCounters }, { created: true })
}

/**
 * Lifecycle-owned assignment for definitions whose event is `issue` or
 * `approval`. The caller holds the target lock and has already authorized
 * the lifecycle command; this reuses the same allocation, reservation,
 * history and audit as a direct assignment. Returns the existing value when
 * the target already has one.
 */
export async function assignCrmReferenceAtEvent(tx: CrmOperationsTransaction, params: {
  definitionKey: string
  event: 'issue' | 'approval'
  target: ReferenceTarget
  businessDate?: string
  categoryKey?: string
  value?: string
  external?: { provider: string; remoteId: string }
  operationId: string
}): Promise<CrmReferenceRow> {
  const { client, context } = tx.commercial()
  const definition = await readDefinitionByKey(client, context.workspaceId, params.definitionKey)
  if (!definition || definition.status !== 'active') refuse('conflict', 'The numbering definition is not active.', { reason: 'definition_inactive', definitionKey: params.definitionKey })
  if (definition.assignmentEvent !== params.event || !definition.targetKinds.includes(params.target.kind as never)) {
    refuse('conflict', `The numbering definition is not configured for ${params.event} on ${params.target.kind}.`, { reason: 'definition_mismatch', definitionKey: params.definitionKey })
  }
  const existing = await readActiveReference(client, context.workspaceId, definition.id, params.target.id)
  if (existing) return existing
  const allocation = await resolveValue(tx, definition, params.target, params)
  const saved = await persist(tx, definition, { kind: params.target.kind, id: params.target.id }, allocation, params.operationId)
  await insertHistory(client, context.workspaceId, { referenceId: saved.id, definitionId: definition.id, targetKind: saved.targetKind,
    targetId: saved.targetId, action: 'assigned', formerValue: null, newValue: saved.printableValue, reason: null,
    actor: actorColumns(context), operationId: params.operationId })
  const published = scopedPublication(params.target.kind)
  await commercialAudit(tx, context, { action: 'crm.reference.assigned', subjectKind: published ? params.target.kind : `crm_${params.target.kind}`, subjectId: params.target.id,
    details: { referenceId: saved.id, definitionKey: definition.definitionKey, origin: saved.origin, event: params.event, ...(published ? { value: saved.printableValue } : {}) } })
  return saved
}

export async function executeCrmBusinessReferenceCommand(
  tx: CrmOperationsTransaction,
  command: CrmBusinessReferenceCommand,
  now: Date,
): Promise<CommercialResult> {
  const occurredAt = now.toISOString()
  return withOperationReceipt(tx, command, async () => {
    switch (command.kind) {
      case 'save_reference_definition': return saveDefinition(tx, command)
      case 'assign_business_reference': return assign(tx, command, occurredAt)
      case 'replace_business_reference': return replace(tx, command, occurredAt)
      case 'retire_business_reference': return retire(tx, command, occurredAt)
      case 'import_business_references': return importReferences(tx, command)
    }
  })
}

