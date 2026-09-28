/** Pure manifest diff and projected-catalog validation. [COMP:crm/manifest] */
import { CrmOperationsCommandSchema, CrmOperationsUuidSchema } from '../../packages/core/dist/crm/operations-types.js'
import { buildCrmSegmentCatalog } from '../../packages/core/dist/crm/segment-catalog.js'
import { validateCrmSegmentCatalog } from '../../packages/core/dist/crm/segments.js'
import { ManifestError, parseManifest } from './manifest-client.mjs'

const fail = (code, details = {}) => { throw new ManifestError(code, details) }
const own = (value, key) => Object.hasOwn(value, key)
const instants = new Set(['startsAt', 'endsAt', 'activeFrom', 'activeTo', 'registrationOpensAt', 'registrationClosesAt'])
function normal(value, key) {
  if (value === undefined || value === null) return null
  if (instants.has(key) && typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString()
  if (Array.isArray(value)) return value.map((item) => normal(item))
  if (typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((name) => [name, normal(value[name], name)]))
  return value
}
const equal = (left, right, key) => JSON.stringify(normal(left, key)) === JSON.stringify(normal(right, key))
const pick = (row, keys) => Object.fromEntries(keys.filter((key) => own(row, key)).map((key) => [key, row[key]]))
const fields = {
  recordFields: ['entityKind', 'fieldKey', 'label', 'fieldType', 'options', 'isRequired'],
  pipelines: ['name', 'isDefault'], pipelineStages: ['name', 'category', 'probability', 'requiredFields'],
  consentPurposes: ['purposeKey', 'label', 'description', 'requiresConsent', 'applicableChannels', 'wordingVersion', 'wording', 'defaultLocale', 'localeWordings'],
  entitlementPlans: ['name', 'currency', 'billingPeriod', 'benefits', 'eligibilityNote', 'activeFrom', 'activeTo', 'published', 'provider', 'providerPlanId'],
  events: ['slug', 'programmeKey', 'title', 'description', 'startsAt', 'endsAt', 'timezone', 'mode', 'venue', 'onlineUrl', 'registrationOpensAt', 'registrationClosesAt', 'capacity', 'status', 'canonicalUrl', 'metadata'],
  intakeDefinitions: ['definitionKey', 'label', 'active'],
  segments: ['segmentKey', 'name', 'description', 'entityKind', 'predicate'],
}
const definitionFields = ['fields', 'attachments', 'identityPolicy', 'identityVerification', 'allowedIdentityProvider', 'consentMappings', 'queueKey', 'ownerUserId', 'followUpTaskTemplate', 'followUpDueMinutes', 'maxPayloadBytes', 'workflowHint']
const stable = { recordFields: 'fieldKey', consentPurposes: 'purposeKey', entitlementPlans: 'key', events: 'slug', intakeDefinitions: 'definitionKey', segments: 'segmentKey' }

function business(resource, row) {
  if (!row) return {}
  const result = pick(row, fields[resource])
  if (resource === 'consentPurposes') result.archived = Boolean(row.archivedAt)
  if (resource === 'entitlementPlans') {
    result.key = row.planKey; result.feeMinor = Number(row.feeMinor)
    if (result.provider === null) delete result.provider
    if (result.providerPlanId === null) delete result.providerPlanId
  }
  if (resource === 'intakeDefinitions') {
    result.definition = pick(row, definitionFields)
    if (result.definition.identityVerification === null) delete result.definition.identityVerification
  }
  return result
}
function differences(before, wanted, path = '') {
  return Object.entries(wanted).flatMap(([key, value]) => {
    const at = path ? `${path}.${key}` : key
    if (key === 'definition') return differences(before?.definition ?? {}, value, at)
    return equal(before?.[key], value, key) ? [] : [{ path: at, before: normal(before?.[key], key), after: normal(value, key) }]
  })
}
function merged(before, wanted) {
  return { ...before, ...wanted, ...(wanted.definition ? { definition: { ...before.definition, ...wanted.definition } } : {}) }
}
function locate(resource, item, rows) {
  const identity = (row) => {
    const data = business(resource, row)
    const key = stable[resource] ?? 'name'
    return data[key] === item.value[key] && (resource !== 'recordFields' || data.entityKind === item.value.entityKind)
  }
  if (item.id) {
    const found = rows.find((row) => row.id === item.id)
    if (!found) fail('configuration_id_unavailable', { ref: item.ref, availableIds: rows.map((row) => row.id).filter(Boolean).slice(0, 100) })
    if (stable[resource] && !identity(found)) fail('immutable_configuration_identity', { ref: item.ref })
    return found
  }
  const candidates = rows.filter(identity)
  const live = candidates.filter((row) => !row.archivedAt)
  if (live.length > 1) fail('ambiguous_configuration', { ref: item.ref, availableIds: live.map((row) => row.id).slice(0, 100) })
  if (live.length) return live[0]
  if (candidates.length) fail('archived_configuration', { ref: item.ref, availableIds: candidates.map((row) => row.id).slice(0, 100) })
  return null
}

/** The returned steps contain business data only; unresolved pipeline refs
 * remain refs until a later discovery returns their actual ids. */
export function planManifest(manifestInput, catalogs) {
  const manifest = parseManifest(manifestInput), projected = structuredClone(catalogs)
  const steps = [], bindings = new Map(), boundIds = new Set()
  const order = ['recordFields', 'pipelines', 'pipelineStages', 'consentPurposes', 'entitlementPlans', 'events', 'intakeDefinitions', 'segments']
  for (const resource of order) {
    let entries = manifest[resource]
    if (resource === 'pipelines') entries = [...entries].sort((a, b) => Number(b.value.isDefault) - Number(a.value.isDefault))
    for (const item of entries) {
      const parent = resource === 'pipelineStages' ? bindings.get(item.pipelineRef) : null
      if (resource === 'pipelineStages' && !parent) fail('pipeline_reference_unavailable', { ref: item.ref })
      const rows = resource === 'pipelineStages' ? parent.stages : projected[resource]
      if (!Array.isArray(rows)) fail('missing_required_catalog', { resource })
      const row = locate(resource, item, rows), before = business(resource, row)
      if (row?.archivedAt) fail('archived_configuration', { ref: item.ref, id: row.id })
      if (row && resource === 'recordFields' && before.fieldType !== item.value.fieldType) fail('immutable_field_type', { ref: item.ref, currentType: before.fieldType })
      // Only the unverified policies are manifest-owned; a trusted one stays with its owner.
      if (row && resource === 'intakeDefinitions' && !['new_or_review', 'existing_or_new'].includes(before.definition.identityPolicy)) fail('trusted_definition_requires_owner', { ref: item.ref })
      if (row && resource === 'segments' && before.entityKind !== item.value.entityKind) fail('immutable_segment_entity_kind', { ref: item.ref })
      if (row?.id) {
        const bound = `${resource}:${row.id}`
        if (boundIds.has(bound)) fail('duplicate_id_binding', { ref: item.ref, id: row.id })
        boundIds.add(bound)
      }
      if (['pipelines', 'pipelineStages'].includes(resource)) {
        const occupied = rows.filter((other) => other.id !== row?.id && !other.archivedAt && other.name === item.value.name)
        if (occupied.length) fail('configuration_name_conflict', { ref: item.ref, availableIds: occupied.map((other) => other.id) })
      }
      if (resource === 'pipelines' && row?.isDefault && !item.value.isDefault) fail('choose_default_pipeline', { ref: item.ref })
      const wanted = item.value, changes = differences(before, wanted)
      const step = { resource, ref: item.ref, id: row?.id ?? null, action: row ? (changes.length ? 'update' : 'none') : 'create',
        before, wanted, changes, currentVersion: row?.currentVersion ?? row?.version, pipelineId: parent?.id ?? null }
      steps.push(step)
      const next = { ...row, ...merged(before, wanted), ...(resource === 'entitlementPlans' ? { planKey: wanted.key } : {}),
        ...(resource === 'intakeDefinitions' ? merged(before, wanted).definition : {}) }
      if (resource === 'pipelines') {
        next.stages = row?.stages ?? []
        if (wanted.isDefault) for (const pipeline of rows) pipeline.isDefault = false
        bindings.set(item.ref, next)
      }
      if (row) rows[rows.indexOf(row)] = next
      else rows.push(next)
    }
  }
  validateProjected(manifest, projected)
  return { steps, changes: steps.filter((step) => step.action !== 'none').map(({ resource, ref, id, action, changes }) => ({ resource, ref, id, action, changes })) }
}

function validateProjected(manifest, projected) {
  const liveFields = projected.recordFields.filter((row) => !row.archivedAt)
  for (const kind of ['person', 'company', 'deal']) if (liveFields.filter((row) => row.entityKind === kind).length > 50) fail('field_limit', { entityKind: kind, limit: 50 })
  for (const item of manifest.consentPurposes) {
    const purpose = projected.consentPurposes.find((row) => row.purposeKey === item.value.purposeKey)
    if (purpose.defaultLocale && purpose.localeWordings?.[purpose.defaultLocale] !== undefined && purpose.localeWordings[purpose.defaultLocale] !== purpose.wording) fail('default_wording_mismatch', { ref: item.ref })
  }
  for (const item of manifest.intakeDefinitions) {
    const definition = projected.intakeDefinitions.find((row) => row.definitionKey === item.value.definitionKey)
    const availableFields = liveFields.filter((row) => row.entityKind === 'person')
    for (const field of definition.fields) {
      if (field.mapping.kind === 'base_field') {
        const types = { name: 'text', email: 'email', phone: 'phone', tags: 'string_array' }
        if (field.type !== types[field.mapping.field]) fail('incompatible_base_mapping', { ref: item.ref, field: field.key, validValues: [types[field.mapping.field]] })
      }
      if (field.mapping.kind !== 'custom_field') continue
      const target = availableFields.find((row) => row.fieldKey === field.mapping.fieldKey)
      if (!target) fail('unknown_custom_field', { ref: item.ref, field: field.key, validValues: availableFields.map((row) => row.fieldKey).slice(0, 150) })
      const acceptedTypes = target.fieldType === 'text' ? ['text', 'email', 'phone']
        : target.fieldType === 'single_select' ? ['text'] : target.fieldType === 'multi_select' ? ['string_array']
          : target.fieldType === 'entity_reference' ? [] : [target.fieldType]
      if (!acceptedTypes.includes(field.type)) fail('incompatible_custom_mapping', { ref: item.ref, field: field.key, targetType: target.fieldType, validValues: acceptedTypes })
      if (['single_select', 'multi_select'].includes(target.fieldType)
        && (!field.options?.length || field.options.some((option) => !target.options.includes(option)))) fail('invalid_mapping_options', { ref: item.ref, field: field.key, validValues: target.options })
    }
    for (const mapping of definition.consentMappings) {
      const answer = definition.fields.find((field) => field.key === mapping.fieldKey)
      const expectedType = answer.type === 'boolean' ? 'boolean' : answer.type === 'number' ? 'number' : 'string'
      if (answer.type === 'string_array' || typeof mapping.grantedValue !== expectedType
        || (answer.options && !answer.options.includes(String(mapping.grantedValue)))
        || (typeof mapping.grantedValue === 'string' && answer.maxLength !== undefined && mapping.grantedValue.length > answer.maxLength)) {
        fail('invalid_consent_answer_mapping', { ref: item.ref, field: answer.key, expectedType, validValues: answer.options ?? [] })
      }
      const purpose = projected.consentPurposes.find((row) => row.purposeKey === mapping.purposeKey && !row.archivedAt)
      if (!purpose) fail('unknown_consent_purpose', { ref: item.ref, validValues: projected.consentPurposes.filter((row) => !row.archivedAt).map((row) => row.purposeKey).slice(0, 100) })
      const locales = mapping.locale ? [mapping.locale] : mapping.localeFieldKey
        ? definition.fields.find((field) => field.key === mapping.localeFieldKey).options : []
      for (const locale of locales) if (locale !== purpose.defaultLocale && !purpose.localeWordings?.[locale]) fail('wording_locale_unavailable', {
        ref: item.ref, purposeKey: purpose.purposeKey, locale, validValues: [...new Set([purpose.defaultLocale, ...Object.keys(purpose.localeWordings ?? {})].filter(Boolean))],
      })
    }
  }
  for (const item of manifest.segments) {
    const { entityKind, predicate } = item.value
    const loaded = projected.segmentCatalogs[entityKind]
    if (!Array.isArray(loaded)) fail('missing_segment_catalog', { ref: item.ref })
    const built = buildCrmSegmentCatalog({ entityKind, customFields: liveFields.filter((row) => row.entityKind === entityKind),
      relationships: loaded.filter((entry) => entry.family === 'relationship').map((entry) => ({ edgeType: entry.field, description: entry.label })),
      purposes: projected.consentPurposes.filter((row) => !row.archivedAt), plans: projected.entitlementPlans, events: projected.events })
    const issues = validateCrmSegmentCatalog(predicate, built.catalog)
    if (issues.length) fail('invalid_segment_catalog', { ref: item.ref, issues: issues.slice(0, 100) })
    const visit = (group) => {
      for (const rule of group.items) {
        if (rule.type === 'group') { visit(rule); continue }
        if (rule.family !== 'pipeline' || rule.value === undefined) continue
        const valid = projected.pipelines.filter((row) => !row.archivedAt)
          .flatMap((row) => rule.field === 'pipeline' ? [row.id] : (row.stages ?? []).filter((stage) => !stage.archivedAt).map((stage) => stage.id)).filter(Boolean)
        if ((Array.isArray(rule.value) ? rule.value : [rule.value]).some((value) => !valid.includes(value))) fail('unknown_pipeline_filter', { ref: item.ref, validValues: valid.slice(0, 100) })
      }
    }
    visit(predicate)
  }
}

export function manifestCommand(step) {
  const value = merged(step.before, step.wanted)
  let command
  if (step.resource === 'recordFields') command = step.id ? { kind: 'update_record_field', fieldId: step.id, ...pick(value, ['label', 'options', 'isRequired']) } : { kind: 'create_record_field', ...value }
  if (step.resource === 'pipelines') command = { kind: step.id ? 'update_pipeline' : 'create_pipeline', ...(step.id ? { pipelineId: step.id } : {}), ...value }
  if (step.resource === 'pipelineStages') {
    if (!step.id && !CrmOperationsUuidSchema.safeParse(step.pipelineId).success) fail('unresolved_pipeline_reference', { ref: step.ref })
    command = { kind: step.id ? 'update_pipeline_stage' : 'create_pipeline_stage', ...(step.id ? { stageId: step.id } : { pipelineId: step.pipelineId }), ...value }
  }
  if (step.resource === 'consentPurposes') command = { kind: 'save_consent_purpose', ...(step.id ? { purposeId: step.id } : {}), ...value }
  if (step.resource === 'entitlementPlans') command = { kind: 'save_entitlement_plan', ...value }
  if (step.resource === 'events') command = { kind: 'save_event', ...value }
  if (step.resource === 'intakeDefinitions') command = { kind: 'save_intake_definition', ...(step.id ? { definitionId: step.id, expectedVersion: step.currentVersion } : {}), ...value }
  if (step.resource === 'segments') command = { kind: 'save_segment', ...(step.id ? { segmentId: step.id, expectedVersion: step.currentVersion } : {}), ...value }
  const parsed = CrmOperationsCommandSchema.safeParse(command)
  if (!parsed.success) fail('invalid_merged_command', { ref: step.ref, issues: parsed.error.issues.slice(0, 100).map((issue) => ({ path: issue.path.join('.'), message: issue.message })) })
  return parsed.data
}

export function sameManifestBefore(left, right) {
  const controlled = (value, wanted) => Object.fromEntries(Object.entries(wanted).map(([key, item]) => [key,
    key === 'definition' ? controlled(value?.[key] ?? {}, item) : value?.[key]]))
  return left.id === right.id && differences(right.before, controlled(left.before, left.wanted)).length === 0
}
