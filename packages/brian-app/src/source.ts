/** Node-only trusted source wire contract. Business ACL decisions belong to the source. */
import { createHash } from 'node:crypto'
import { authorizeConnectorRequest, type ConnectorActorClaims, type ConnectorRequestBytes, type createConnectorActorVerifier } from './connector.js'

export const SOURCE_PROTOCOL_VERSION = 'ub.source.v1'
export const SOURCE_MAXIMUM_BATCH = 100
export const SOURCE_TIMEOUT_MS = 5_000
export const SOURCE_ACTIONS = ['read','context','derive','retain','deliver','export','mutate'] as const
export type SourceAction = typeof SOURCE_ACTIONS[number]
export type SourceRetentionMode = 'governed' | 'released_snapshot' | 'ephemeral'
export type SourceSubject = { kind: 'human' | 'service'; id: string; executingAssistantId: string }
export type SourceResourceRef = { type: string; id: string; contentVersion: string; policyVersion: string }
export type SourceRetention = { mode: 'governed' | 'ephemeral' }
  | { mode: 'released_snapshot'; releaseId: string; expiresAt: number }
export type SourceObservation = {
  resource: SourceResourceRef
  fields: string[]
  labels: { sensitivity: 'public' | 'internal' | 'confidential'; compartments: string[]; projectIds: string[] }
  subjects: SourceSubject[]
  actions: SourceAction[]
  retention: SourceRetention
  export: { model: boolean; destinations: string[] }
}
export type SourceEnvelope = { version: typeof SOURCE_PROTOCOL_VERSION; tenant: string; resources: SourceObservation[] }
export type SourceCapabilities = { version: typeof SOURCE_PROTOCOL_VERSION; tenant: string;
  retentionModes: SourceRetentionMode[]; fieldEvidence: true; reconciliation: boolean }
export type SourceAuthorizationRequest = { version: typeof SOURCE_PROTOCOL_VERSION; operationId: string;
  items: Array<{ itemId: string; resource: SourceResourceRef; fields: string[]; action: SourceAction; retentionMode: SourceRetentionMode }>;
  recipients: Array<{ recipientId: string; subject: SourceSubject }> }
export type SourceAuthorizationResponse = { version: typeof SOURCE_PROTOCOL_VERSION; tenant: string; operationId: string;
  decisions: Array<{ itemId: string; recipientId: string; allowed: false }
    | { itemId: string; recipientId: string; allowed: true; receipt: { id: string; issuedAt: number; expiresAt: number } }> }
export type SourceReconcileRequest = { version: typeof SOURCE_PROTOCOL_VERSION; idempotencyKey: string; receipt?: string }
export type SourceReconcileResponse = { version: typeof SOURCE_PROTOCOL_VERSION; tenant: string;
  state: 'not_applied' | 'uncertain' | 'applied'; receipt?: string; evidence?: SourceEnvelope }
export class SourceProtocolError extends Error {
  readonly retrySafe = false
  constructor(readonly code: 'source_protocol_invalid' | 'source_access_denied' | 'source_unavailable' | 'source_effect_uncertain') {
    super(code); this.name = 'SourceProtocolError'
  }
}
function invalid(): never { throw new SourceProtocolError('source_protocol_invalid') }
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const record = value as Record<string, unknown>
  if (required.some(key => !Object.hasOwn(record, key)) || Object.keys(record).some(key => !required.includes(key) && !optional.includes(key))) return invalid()
  return record
}
function text(value: unknown, maximum = 256): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) invalid()
}
function uuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) invalid()
}
function strings(value: unknown, maximum = 256, nonempty = false): asserts value is string[] {
  if (!Array.isArray(value) || value.length > maximum || nonempty && value.length === 0) invalid()
  value.forEach(item => text(item)); if (new Set(value).size !== value.length) invalid()
}
function list(value: unknown, maximum = SOURCE_MAXIMUM_BATCH): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) invalid()
}
function enumeration(value: unknown, valid: readonly string[]): void { if (!valid.includes(String(value)) || typeof value !== 'string') invalid() }
function timestamp(value: unknown): asserts value is number { if (!Number.isSafeInteger(value) || Number(value) < 0) invalid() }
function version(record: Record<string, unknown>) { if (record.version !== SOURCE_PROTOCOL_VERSION) invalid() }
function resource(value: unknown) {
  const record = object(value, ['type','id','contentVersion','policyVersion'])
  text(record.type, 128); text(record.id, 1024); text(record.contentVersion); text(record.policyVersion)
}
function subject(value: unknown) {
  const record = object(value, ['kind','id','executingAssistantId'])
  enumeration(record.kind, ['human','service']); uuid(record.id); uuid(record.executingAssistantId)
}
function unique(items: unknown[], key: (item: unknown) => unknown) {
  const keys = items.map(item => JSON.stringify(key(item))); if (new Set(keys).size !== keys.length) invalid()
}
function detached<T>(value: unknown): T { return structuredClone(value) as T }
function bounded(value: unknown, maximumBytes = 512 * 1024) {
  let serialized: string | undefined
  try { serialized = JSON.stringify(value) } catch { return invalid() }
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > maximumBytes) invalid()
}
export function sourceSubjectFromActor(actor: Readonly<ConnectorActorClaims>): SourceSubject {
  return { kind: actor.actor.kind, id: actor.actor.kind === 'human' ? actor.actor.userId : actor.actor.serviceUserId,
    executingAssistantId: actor.executingAssistantId }
}
export function sourceSubjectKey(value: SourceSubject): string { subject(value); return JSON.stringify([value.kind,value.id,value.executingAssistantId]) }
export function sourceResourceKey(value: SourceResourceRef): string {
  resource(value); return JSON.stringify([value.type,value.id,value.contentVersion,value.policyVersion])
}
export function parseSourceEnvelope(value: unknown): SourceEnvelope {
  bounded(value)
  const record = object(value, ['version','tenant','resources']); version(record); text(record.tenant); list(record.resources)
  for (const item of record.resources) {
    const entry = object(item, ['resource','fields','labels','subjects','actions','retention','export'])
    resource(entry.resource); strings(entry.fields, 256, true)
    const labels = object(entry.labels, ['sensitivity','compartments','projectIds'])
    enumeration(labels.sensitivity, ['public','internal','confidential']); strings(labels.compartments); strings(labels.projectIds)
    for (const label of labels.compartments) {
      const match = /^(team|project):(.+)$/.exec(label)
      if (!match) invalid()
      uuid(match[2])
    }
    labels.projectIds.forEach(uuid)
    list(entry.subjects); entry.subjects.forEach(subject); unique(entry.subjects, item => sourceSubjectKey(item as SourceSubject))
    strings(entry.actions, SOURCE_ACTIONS.length, true); entry.actions.forEach(action => enumeration(action, SOURCE_ACTIONS))
    const retention = object(entry.retention, ['mode'], ['releaseId','expiresAt'])
    enumeration(retention.mode, ['governed','released_snapshot','ephemeral'])
    if (retention.mode === 'released_snapshot') { object(retention, ['mode','releaseId','expiresAt']); text(retention.releaseId); timestamp(retention.expiresAt) }
    else object(retention, ['mode'])
    const exporting = object(entry.export, ['model','destinations'])
    if (typeof exporting.model !== 'boolean') invalid()
    strings(exporting.destinations, SOURCE_MAXIMUM_BATCH)
  }
  // Multiple observations of one resource cannot silently choose a broader field/retention set.
  unique(record.resources, item => { const ref = (item as SourceObservation).resource; return [ref.type,ref.id] })
  return detached(value)
}
export function parseSourceCapabilities(value: unknown): SourceCapabilities {
  bounded(value)
  const record = object(value, ['version','tenant','retentionModes','fieldEvidence','reconciliation']); version(record); text(record.tenant)
  strings(record.retentionModes, 3, true); record.retentionModes.forEach(mode => enumeration(mode, ['governed','released_snapshot','ephemeral']))
  if (record.fieldEvidence !== true || typeof record.reconciliation !== 'boolean') invalid()
  return detached(value)
}
export function parseSourceAuthorizationRequest(value: unknown): SourceAuthorizationRequest {
  bounded(value)
  const record = object(value, ['version','operationId','items','recipients']); version(record); uuid(record.operationId)
  list(record.items); list(record.recipients)
  for (const item of record.items) {
    const entry = object(item, ['itemId','resource','fields','action','retentionMode'])
    uuid(entry.itemId); resource(entry.resource); strings(entry.fields, 256, true); enumeration(entry.action, SOURCE_ACTIONS)
    enumeration(entry.retentionMode, ['governed','released_snapshot','ephemeral'])
  }
  for (const item of record.recipients) { const entry = object(item, ['recipientId','subject']); uuid(entry.recipientId); subject(entry.subject) }
  unique(record.items, item => (item as { itemId: string }).itemId)
  unique(record.recipients, item => (item as { recipientId: string }).recipientId)
  unique(record.recipients, item => sourceSubjectKey((item as { subject: SourceSubject }).subject))
  return detached(value)
}
/** A missing pair is denial; duplicates/unknown pairs or stale receipts invalidate the whole response. */
export function parseSourceAuthorizationResponse(value: unknown, request: SourceAuthorizationRequest, tenant: string, now = Date.now()): SourceAuthorizationResponse {
  request = parseSourceAuthorizationRequest(request); bounded(value, 8 * 1024 * 1024); text(tenant); timestamp(now)
  const record = object(value, ['version','tenant','operationId','decisions']); version(record)
  if (record.tenant !== tenant || record.operationId !== request.operationId || !Array.isArray(record.decisions)
    || record.decisions.length > request.items.length * request.recipients.length) invalid()
  for (const item of record.decisions) {
    const entry = object(item, ['itemId','recipientId','allowed'], ['receipt'])
    if (!request.items.some(item => item.itemId === entry.itemId) || !request.recipients.some(item => item.recipientId === entry.recipientId)) invalid()
    if (entry.allowed === false) object(entry, ['itemId','recipientId','allowed'])
    else if (entry.allowed === true) {
      const receipt = object(entry.receipt, ['id','issuedAt','expiresAt']); text(receipt.id, 1024); timestamp(receipt.issuedAt); timestamp(receipt.expiresAt)
      if (receipt.issuedAt > now || receipt.expiresAt <= now || receipt.expiresAt - receipt.issuedAt > SOURCE_TIMEOUT_MS) invalid()
    } else invalid()
  }
  unique(record.decisions, item => { const entry = item as { itemId: string; recipientId: string }; return [entry.itemId,entry.recipientId] })
  return detached(value)
}
export function requireSourceAuthorization(response: SourceAuthorizationResponse, request: SourceAuthorizationRequest, tenant: string, now = Date.now()): SourceAuthorizationResponse {
  const result = parseSourceAuthorizationResponse(response, request, tenant, now)
  if (result.decisions.length !== request.items.length * request.recipients.length || result.decisions.some(item => !item.allowed)) throw new SourceProtocolError('source_access_denied')
  return result
}
/** Store this digest with an authenticated response/local lease; an opaque receipt alone grants nothing. */
export function sourceAuthorizationDigest(request: SourceAuthorizationRequest): string {
  const parsed = parseSourceAuthorizationRequest(request)
  const canonical = { version: parsed.version, operationId: parsed.operationId,
    items: parsed.items.map(item => [item.itemId,sourceResourceKey(item.resource),[...item.fields].sort(),item.action,item.retentionMode]).sort((a,b) => String(a[0]).localeCompare(String(b[0]))),
    recipients: parsed.recipients.map(item => [item.recipientId,sourceSubjectKey(item.subject)]).sort((a,b) => a[0].localeCompare(b[0])) }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('base64url')
}
export function parseSourceReconcileRequest(value: unknown): SourceReconcileRequest {
  const record = object(value, ['version','idempotencyKey'], ['receipt']); version(record); text(record.idempotencyKey, 256)
  if (record.receipt !== undefined) text(record.receipt, 1024)
  return detached(value)
}
export function parseSourceReconcileResponse(value: unknown, tenant: string): SourceReconcileResponse {
  bounded(value)
  const record = object(value, ['version','tenant','state'], ['receipt','evidence']); version(record)
  if (record.tenant !== tenant) invalid()
  enumeration(record.state, ['not_applied','uncertain','applied'])
  if (record.state === 'applied') text(record.receipt, 1024)
  else if (record.receipt !== undefined || record.evidence !== undefined) invalid()
  if (record.evidence !== undefined && parseSourceEnvelope(record.evidence).tenant !== tenant) invalid()
  return detached(value)
}

export type SourceSidecarPorts = {
  capabilities: (actor: Readonly<ConnectorActorClaims>) => Promise<SourceCapabilities | null>
  authorize: (actor: Readonly<ConnectorActorClaims>, request: SourceAuthorizationRequest) => Promise<SourceAuthorizationResponse>
  reconcile: (actor: Readonly<ConnectorActorClaims>, request: SourceReconcileRequest) => Promise<SourceReconcileResponse>
  now?: () => number
}
/** Caller routes only its configured /usebrian/source endpoint; the source callbacks enforce its own current ACL. */
export async function handleSourceSidecar(input: {
  endpoint: 'capabilities' | 'authorize' | 'reconcile'; request: ConnectorRequestBytes; assertion: string
  authenticateTransport: () => Promise<boolean>; verifyActor: ReturnType<typeof createConnectorActorVerifier>
}, ports: SourceSidecarPorts): Promise<SourceCapabilities | SourceAuthorizationResponse | SourceReconcileResponse> {
  if (input.request.method !== 'POST' || input.request.body.byteLength > 512 * 1024) invalid()
  const { actor } = await authorizeConnectorRequest({ ...input, authorize: async actor => ({ allowed: true, value: actor }) })
  let body: unknown
  try { body = JSON.parse(Buffer.from(input.request.body).toString('utf8')) } catch { return invalid() }
  let capabilities: SourceCapabilities
  try {
    const result = await ports.capabilities(actor)
    if (!result) throw new SourceProtocolError('source_access_denied')
    capabilities = parseSourceCapabilities(result)
  } catch (error) { if (error instanceof SourceProtocolError) throw error; throw new SourceProtocolError('source_unavailable') }
  if (input.endpoint === 'capabilities') { const record = object(body, ['version']); version(record); return capabilities }
  if (input.endpoint === 'authorize') {
    const request = parseSourceAuthorizationRequest(body)
    let response: SourceAuthorizationResponse
    try { response = await ports.authorize(actor, request) } catch { throw new SourceProtocolError('source_unavailable') }
    const validated = parseSourceAuthorizationResponse(response, request, capabilities.tenant, ports.now?.() ?? Date.now())
    const pairs = new Set(validated.decisions.map(item => JSON.stringify([item.itemId,item.recipientId])))
    for (const item of request.items) for (const recipient of request.recipients) {
      if (!pairs.has(JSON.stringify([item.itemId,recipient.recipientId]))) validated.decisions.push({ itemId: item.itemId, recipientId: recipient.recipientId, allowed: false })
    }
    return validated
  }
  if (input.endpoint !== 'reconcile' || !capabilities.reconciliation) throw new SourceProtocolError('source_unavailable')
  const request = parseSourceReconcileRequest(body)
  let response: SourceReconcileResponse
  try { response = await ports.reconcile(actor, request) } catch { throw new SourceProtocolError('source_effect_uncertain') }
  return parseSourceReconcileResponse(response, capabilities.tenant)
}
