// Reference ERP compatibility adapter. A fictional professional-services ERP
// keeps its own legacy store (clients, engagements, timesheets) and becomes a
// client of the CRM through the supported HTTP API only: staged import with
// reconciliation, write freeze and cutover, enrolled-viewer commands for the
// retained journeys, and a fee-free projection cache for timesheets.
// Spec: docs/architecture/features/crm-commercial-operations.md -> ERP bridge
// [COMP:crm/reference-erp-adapter]
import { createHash, randomUUID } from 'node:crypto'

/** Same canonical form as the CRM's request hashing: object keys sorted, arrays in order. */
export function canonicalJson(value) {
  const canonical = (item) => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, inner]) => [key, canonical(inner)]))
      : item
  return JSON.stringify(canonical(value))
}
export const sha256 = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex')

const CLIENT_FIELDS = { domain: null, code: null, formerCodes: [] }
const ENGAGEMENT_FIELDS = { code: null, formerCodes: [], serviceCategory: null, workStatus: null, periodStart: null, periodEnd: null, financialPeriod: null, quotedFee: null, confirmedFee: null }

export class ErpBridgeError extends Error {
  constructor(status, body) {
    super(body?.message ?? body?.error ?? `HTTP ${status}`)
    this.name = 'ErpBridgeError'
    this.status = status
    this.code = body?.error ?? null
    this.details = body?.details ?? {}
  }
}
export class LegacyWriterRetired extends Error {
  constructor(state) { super(`Legacy writes are ${state === 'frozen' ? 'frozen for cutover' : 'retired; the CRM is the writer'}.`); this.name = 'LegacyWriterRetired'; this.state = state }
}

/** The ERP's own store. Time records stay here and keep pointing at legacy engagement ids. */
export function createLegacyStore(fixture) {
  const copy = structuredClone(fixture)
  return {
    clients: new Map(copy.clients.map((row) => [row.legacyId, { ...CLIENT_FIELDS, ...row }])),
    engagements: new Map(copy.engagements.map((row) => [row.legacyId, { ...ENGAGEMENT_FIELDS, ...row }])),
    timesheets: new Map(copy.timesheets.map((row) => [row.entryId, row])),
    users: copy.users,
  }
}

export class ReferenceErpAdapter {
  /**
   * @param {{ baseUrl: string, token: string, fixture: any, fetchImpl?: typeof fetch, store?: ReturnType<typeof createLegacyStore>, retries?: number }} options
   */
  constructor({ baseUrl, token, fixture, fetchImpl = fetch, store, retries = 3 }) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.token = token
    this.fixture = fixture
    this.bindingKey = fixture.binding.bindingKey
    this.fetch = fetchImpl
    this.store = store ?? createLegacyStore(fixture)
    this.retries = retries
    this.writerState = 'legacy'
    this.projections = new Map()
    this.projectionVersions = new Map()
    this.cursor = null
  }

  async request(method, path, { body, viewer, query } = {}) {
    const url = new URL(`${this.baseUrl}/api/crm/integration${path}`)
    for (const [key, value] of Object.entries(query ?? {})) {
      for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined && item !== null) url.searchParams.append(key, String(item))
    }
    const headers = { authorization: `Bearer ${this.token}`, ...(body ? { 'content-type': 'application/json' } : {}),
      ...(viewer ? { 'x-crm-viewer': viewer, 'x-crm-binding': this.bindingKey } : {}) }
    const response = await this.fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined })
    const text = await response.text()
    const parsed = text ? JSON.parse(text) : null
    if (!response.ok) throw new ErpBridgeError(response.status, parsed)
    return parsed
  }

  /**
   * One command with a stable operation id. A transport failure or 5xx is an
   * uncertain outcome: retry with the SAME id, so a create that already
   * committed returns its receipt instead of creating twice.
   */
  async command(body, { viewer, operationId = randomUUID() } = {}) {
    let lastError
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await this.request('POST', '/operations/commands', { body: { ...body, operationId }, viewer })
      } catch (error) {
        const uncertain = !(error instanceof ErpBridgeError) || error.status >= 500
        if (!uncertain) throw error
        lastError = error
      }
    }
    throw lastError
  }

  // ── Migration and cutover ─────────────────────────────────────────

  exportRecords() {
    const byId = (rows) => [...rows].sort((a, b) => a.legacyId.localeCompare(b.legacyId))
    const records = {
      clients: byId([...this.store.clients.values()].map((row) => ({ legacyId: row.legacyId, name: row.name, domain: row.domain, code: row.code, formerCodes: row.formerCodes }))),
      engagements: byId([...this.store.engagements.values()].map((row) => ({ legacyId: row.legacyId, clientLegacyId: row.clientLegacyId, name: row.name, code: row.code,
        formerCodes: row.formerCodes, serviceCategory: row.serviceCategory, workStatus: row.workStatus, periodStart: row.periodStart, periodEnd: row.periodEnd,
        financialPeriod: row.financialPeriod, quotedFee: row.quotedFee, confirmedFee: row.confirmedFee }))),
    }
    return { records, exportHash: sha256(records), counts: { client: records.clients.length, engagement: records.engagements.length } }
  }

  async refreshBinding() {
    const binding = await this.request('GET', `/operations/erp-bindings/${this.bindingKey}`)
    this.writerState = binding.binding.writerState
    return binding
  }

  async stage() {
    const { records } = this.exportRecords()
    const definitions = Object.fromEntries(this.fixture.referencePresets.map((preset) => [preset.targetKinds[0] === 'company' ? 'client' : 'engagement', preset.definitionKey]))
    const staged = await this.command({ kind: 'stage_erp_import', bindingKey: this.bindingKey, label: this.fixture.binding.label, referenceDefinitions: definitions, records })
    return staged.record
  }

  /** Dry run, then confirm the exact reviewed report. */
  async migrate() {
    const staged = await this.stage()
    if (staged.report.conflicts.length) return { staged, confirmed: null }
    const confirmed = await this.command({ kind: 'confirm_erp_import', importId: staged.importId, expectedReportHash: staged.reportHash })
    return { staged, confirmed: confirmed.record }
  }

  /** Legacy UI writes go through here; they stop once a cutover freezes or retires the writer. */
  async legacyWrite(kind, legacyId, patch) {
    await this.refreshBinding()
    if (this.writerState !== 'legacy') throw new LegacyWriterRetired(this.writerState)
    const table = kind === 'client' ? this.store.clients : this.store.engagements
    const current = table.get(legacyId)
    table.set(legacyId, { ...(kind === 'client' ? CLIENT_FIELDS : ENGAGEMENT_FIELDS), ...current, ...patch, legacyId })
  }

  async prepareCutover() {
    const { exportHash, counts } = this.exportRecords()
    const prepared = await this.command({ kind: 'prepare_erp_cutover', bindingKey: this.bindingKey, recordClasses: ['client', 'engagement'], source: { counts, exportHash } })
    this.writerState = prepared.record.writerState
    return prepared.record
  }

  /** Replay the final delta captured before the freeze, then commit against the final snapshot. */
  async commitCutover(cutover) {
    const delta = await this.migrate()
    if (!delta.confirmed) return { committed: null, delta }
    const { exportHash, counts } = this.exportRecords()
    const committed = await this.command({ kind: 'commit_erp_cutover', cutoverId: cutover.cutoverId, expectedVersion: cutover.version, finalSource: { counts, exportHash } })
    this.writerState = committed.record.writerState
    return { committed: committed.record, delta }
  }

  // ── Retained journeys through the CRM ─────────────────────────────

  async resolve(legacyType, legacyId) {
    return this.request('GET', '/operations/legacy-mappings', { query: { bindingKey: this.bindingKey, legacyType, legacyId } })
  }

  async requestEngagementChange(viewer, legacyId, changes) {
    const { mapping } = await this.resolve('engagement', legacyId)
    const saved = await this.command({ kind: 'save_change_request', target: { kind: 'deal', id: mapping.targetId }, changes }, { viewer })
    const request = saved.record.request
    return (await this.command({ kind: 'submit_change_request', requestId: request.id, expectedVersion: request.version }, { viewer })).record.request
  }

  async decide(viewer, request, decision, reason) {
    return (await this.command({ kind: 'decide_change_request', requestId: request.id, expectedRevision: request.revision, decision, ...(reason ? { reason } : {}) }, { viewer })).record.request
  }

  async engagement(viewer, legacyId) {
    const { mapping } = await this.resolve('engagement', legacyId)
    const page = await this.request('GET', '/operations/engagements', { viewer, query: { dealId: mapping.targetId } })
    return page.engagements[0]
  }

  async updateTracking(viewer, legacyId, tracking) {
    const current = await this.engagement(viewer, legacyId)
    return this.command({ kind: 'update_engagement_tracking', dealId: current.id, expectedVersion: current.trackingVersion, tracking }, { viewer })
  }

  async requestBilling(viewer, legacyId, amount, currency, description) {
    const { mapping } = await this.resolve('engagement', legacyId)
    return (await this.command({ kind: 'create_billing_request', dealId: mapping.targetId, amount, currency, description }, { viewer })).record.request
  }

  async decideBilling(viewer, request, decision, reason) {
    return (await this.command({ kind: 'decide_billing_request', requestId: request.id, expectedVersion: request.version, decision, ...(reason ? { reason } : {}) }, { viewer })).record.request
  }

  async recordExternalInvoice(viewer, { accountId, provider, remoteId, number, issueDate, currency, total, allocations }) {
    const resolved = []
    for (const allocation of allocations) {
      const { mapping } = await this.resolve('engagement', allocation.engagementLegacyId)
      resolved.push({ dealId: mapping.targetId, amount: allocation.amount, ...(allocation.billingRequestId ? { billingRequestId: allocation.billingRequestId } : {}) })
    }
    return this.command({ kind: 'record_external_invoice', accountId, provider, remoteId, number, issueDate, currency, total, allocations: resolved }, { viewer })
  }

  async billableBalance(viewer, legacyClientId) {
    const { mapping } = await this.resolve('client', legacyClientId)
    return this.request('GET', '/operations/billing-balance', { viewer, query: { companyId: mapping.targetId } })
  }

  async createNextPeriod(viewer, legacyIds, period) {
    const sourceDealIds = []
    for (const legacyId of legacyIds) sourceDealIds.push((await this.resolve('engagement', legacyId)).mapping.targetId)
    const preview = await this.request('GET', '/operations/recurring-successors/preview', { viewer, query: { sourceDealIds, periodKey: period.key } })
    const committed = await this.command({ kind: 'commit_recurring_successors', sourceDealIds, period, carryForward: ['serviceCategory', 'owner', 'participants'] }, { viewer })
    return { preview, outcomes: committed.record.outcomes }
  }

  // ── Projection cache for timesheets and exports ───────────────────

  /**
   * Poll the projection feed and apply versions in order. A gap (or a
   * receipt the CRM rejects as out of order) is repaired by a resync from
   * the current state; repeats are ignored. Receipts tell the CRM exactly
   * which version this consumer holds.
   */
  async syncProjections() {
    const applied = [], resynced = []
    for (;;) {
      const page = await this.request('GET', '/operations/projection-events', { query: { bindingKey: this.bindingKey, ...(this.cursor ? { cursor: this.cursor } : {}) } })
      const receipts = [], gaps = new Set()
      for (const event of page.events) {
        const last = this.projectionVersions.get(event.subjectId) ?? 0
        if (event.version <= last) continue
        if (event.version !== last + 1) { gaps.add(event.subjectId); continue }
        this.projectionVersions.set(event.subjectId, event.version)
        this.projections.set(event.subjectId, event.tombstone ? { ...(this.projections.get(event.subjectId) ?? {}), subjectId: event.subjectId, tombstone: true } : event.projection)
        receipts.push({ eventSeq: event.seq, subjectId: event.subjectId, version: event.version })
      }
      if (receipts.length) {
        const recorded = await this.command({ kind: 'record_projection_receipt', bindingKey: this.bindingKey, receipts })
        for (const outcome of recorded.record.outcomes) {
          if (outcome.outcome === 'applied') applied.push(outcome)
          if (outcome.outcome === 'resync_required') gaps.add(outcome.subjectId)
        }
      }
      for (const subjectId of gaps) resynced.push(await this.resync(subjectId))
      if (page.events.length) this.cursor = page.events[page.events.length - 1].seq
      if (!page.nextCursor) break
      this.cursor = page.nextCursor
    }
    return { applied, resynced: resynced.filter(Boolean) }
  }

  /** Replace the cached projection with the current state and record that version. */
  async resync(subjectId) {
    let found = null
    for (const legacyType of ['engagement', 'client']) {
      found = await this.request('GET', '/operations/legacy-mappings', { query: { bindingKey: this.bindingKey, legacyType, targetId: subjectId } }).catch(() => null)
      if (found) break
    }
    if (!found) return null
    await this.command({ kind: 'record_projection_receipt', bindingKey: this.bindingKey, resynced: [{ subjectId, version: found.version }] })
    this.projections.set(subjectId, found.projection)
    this.projectionVersions.set(subjectId, found.version)
    return { subjectId, version: found.version }
  }

  projectionForLegacy(legacyId) {
    for (const projection of this.projections.values()) if (projection?.legacyIds?.includes(legacyId)) return projection
    return null
  }

  /** A time entry keeps its legacy engagement id; its display comes from the current projection. */
  timesheetLookup(entryId) {
    const entry = this.store.timesheets.get(entryId)
    if (!entry) return null
    const projection = this.projectionForLegacy(entry.engagementLegacyId)
    const code = (projection, key) => projection?.codes?.current.find((item) => item.definitionKey === key)?.value ?? null
    return { entryId, hours: entry.hours, date: entry.date, engagementLegacyId: entry.engagementLegacyId,
      engagement: projection ? { id: projection.subjectId, code: code(projection, 'job-code'), formerCodes: projection.codes.former.map((item) => item.value),
        name: projection.name, workStatus: projection.workStatus, client: projection.client?.name ?? null, tombstone: Boolean(projection.tombstone) } : null }
  }

  /** Workbook export through a configured preset; only projection fields exist, so fees cannot appear. */
  exportEngagements(presetKey = 'engagement-list') {
    const columns = this.fixture.exportPresets[presetKey]
    const rows = [...this.projections.values()].filter((projection) => projection?.subjectKind === 'deal' && !projection.tombstone)
    const read = (projection, source) => {
      if (source.startsWith('code:')) return projection.codes.current.find((item) => item.definitionKey === source.slice(5))?.value ?? ''
      if (source.startsWith('client.code:')) return projection.client?.codes.current.find((item) => item.definitionKey === source.slice(12))?.value ?? ''
      if (source === 'client.name') return projection.client?.name ?? ''
      return projection[source] ?? ''
    }
    return { header: columns.map((column) => column.header), rows: rows.map((projection) => columns.map((column) => read(projection, column.source)))
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))) }
  }
}
