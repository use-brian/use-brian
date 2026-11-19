import { createHash, randomUUID } from 'node:crypto'
import type { AssistantResponse } from '../providers/types.js'
import type { QueryEvent } from './query-loop.js'

/** Private dispatcher metadata. Never provider content or a public wire field. */
export type OutputDisposition = 'reply' | 'question' | 'suspended' | 'partial' | 'error'
export type OutputRevision = Readonly<{
  origin: string
  revision: number
  digest: string
  sealed: boolean
  /** Present on first observation and changed revisions only. */
  response?: AssistantResponse
}>
export type QueryOutputProvenance = Readonly<{
  version: 1
  invocationId: string
  emission?: { origin: string; replay: boolean }
  updates: readonly OutputRevision[]
  disposition?: OutputDisposition
  qualified: boolean
}>
export type OutputRecord = {
  origin: string
  revision: number
  digest: string
  sealed: boolean
  response: AssistantResponse
}

/** Host JSON codec v1. Object order/absent optional keys do not change identity. */
export function outputContentDigest(value: unknown): string {
  const path = new WeakSet<object>()
  function normalize(item: unknown): unknown {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (!item || typeof item !== 'object' || path.has(item)) throw new Error('Unsupported output JSON')
    if (Object.getOwnPropertySymbols(item).length) throw new Error('Unsupported output keys')
    const prototype = Object.getPrototypeOf(item)
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) throw new Error('Unsupported output object')
    path.add(item)
    const result = Array.isArray(item) ? Array.from(item, value => normalize(value))
      : Object.fromEntries(Object.keys(item).sort().filter(key => (item as Record<string, unknown>)[key] !== undefined)
        .map(key => [key, normalize((item as Record<string, unknown>)[key])]))
    path.delete(item)
    return result
  }
  const json = JSON.stringify(normalize(value))
  return createHash('sha256').update(json).digest('hex')
}

const associated = new WeakMap<QueryEvent, QueryOutputProvenance>()
export function associateQueryOutput(event: QueryEvent, provenance: QueryOutputProvenance): void {
  associated.set(event, provenance)
}
export function queryOutputProvenance(event: QueryEvent): QueryOutputProvenance | undefined {
  return associated.get(event)
}

type ProducerRecord = {
  origin: string
  revision: number
  digest: string
  observed: boolean
  project: () => AssistantResponse
}

/** One actual query invocation; its caller cannot choose producer origins. */
export function createQueryOutputOwner(maxTurns: number) {
  const invocationId = randomUUID()
  const aliases = new WeakMap<AssistantResponse, ProducerRecord>()
  const records: ProducerRecord[] = []
  // Normal loop responses plus one isolated finalizer/static terminal notice.
  const originBudget = Number.isSafeInteger(maxTurns) && maxTurns >= 0 ? maxTurns + 1 : 0
  let qualified = originBudget > 0
  let disposition: OutputDisposition | undefined
  function register(response: AssistantResponse): ProducerRecord {
    const existing = aliases.get(response)
    if (existing) return existing
    const record: ProducerRecord = { origin: randomUUID(), revision: 0, digest: '', observed: false, project: () => response }
    records.push(record)
    aliases.set(response, record)
    if (records.length > originBudget) qualified = false
    return record
  }
  function revision(record: ProducerRecord, sealed: boolean): OutputRevision {
    const response = record.project()
    const digest = outputContentDigest(response)
    const changed = record.digest !== digest
    if (changed) { record.revision++; record.digest = digest }
    return { origin: record.origin, revision: record.revision, digest, sealed,
      ...(changed ? { response: structuredClone(response) } : {}) }
  }
  return {
    register,
    project(raw: AssistantResponse, projected: AssistantResponse, project: () => AssistantResponse) {
      const record = register(raw)
      aliases.set(projected, record)
      record.project = project
    },
    disposition(value: OutputDisposition) { disposition = value },
    prepare(event: QueryEvent): { event: QueryEvent; provenance: QueryOutputProvenance } {
      const updates: OutputRevision[] = []
      let emission: QueryOutputProvenance['emission']
      if (event.type === 'assistant_turn') {
        const record = aliases.get(event.response)
        if (!record) qualified = false
        else {
          emission = { origin: record.origin, replay: record.observed }
          const update = revision(record, false)
          updates.push(update)
          record.observed = true
          // Share only the owned initial snapshot inside this detached envelope.
          event = { ...event, response: update.response ?? structuredClone(record.project()) }
        }
      }
      if (event.type === 'error') disposition = 'error'
      if (event.type === 'question') disposition = 'question'
      const finish = event.type === 'turn_complete' || event.type === 'error'
        || event.type === 'awaiting_approval' && disposition === 'suspended'
      if (finish) {
        if (event.type === 'turn_complete' && !disposition) disposition = 'reply'
        if (event.type === 'turn_complete' && !aliases.has(event.response)) qualified = false
        for (const record of records) if (record.observed) updates.push(revision(record, true))
      }
      return { event, provenance: { version: 1, invocationId, ...(emission ? { emission } : {}), updates,
        ...(finish ? { disposition: disposition ?? 'partial' } : {}), qualified } }
    },
    dispose() { records.length = 0 },
  }
}

/** Same revision validator for collector and buffered transcript consumers. */
export function applyOutputRevisions(records: Map<string, OutputRecord>, provenance: QueryOutputProvenance): void {
  const next = new Map(records)
  const seen = new Set<string>()
  if (provenance.emission && records.has(provenance.emission.origin) !== provenance.emission.replay) throw new Error('Invalid output emission replay')
  for (const update of provenance.updates) {
    if (seen.has(update.origin) || !Number.isSafeInteger(update.revision) || update.revision < 1) throw new Error('Invalid output revision')
    seen.add(update.origin)
    const old = next.get(update.origin)
    if (!old) {
      if (!update.response || update.revision !== 1 || provenance.emission?.origin !== update.origin || provenance.emission.replay) throw new Error('Missing output origin')
    } else if (update.revision < old.revision || update.revision > old.revision + 1
      || update.revision === old.revision && update.digest !== old.digest
      || old.sealed && (update.revision !== old.revision || !update.sealed)) throw new Error('Stale output revision')
    const response = update.response ?? old?.response
    if (!response || outputContentDigest(response) !== update.digest || old && update.revision > old.revision && !update.response) throw new Error('Output snapshot mismatch')
    next.set(update.origin, { origin: update.origin, revision: update.revision, digest: update.digest,
      sealed: update.sealed, response: update.response ? structuredClone(response) : response })
  }
  if (provenance.emission && !next.has(provenance.emission.origin)) throw new Error('Missing output emission')
  for (const [origin, record] of next) records.set(origin, record)
}
