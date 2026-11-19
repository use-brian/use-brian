import {
  applyOutputRevisions,
  outputContentDigest,
  type OutputRecord,
  type QueryOutputProvenance
} from '@use-brian/agent-runtime/engine/output-provenance.js'
import type { QueryEvent } from '@use-brian/agent-runtime/engine/query-loop.js'
import type { FinalizedOutputSelection } from '@use-brian/agent-runtime/engine/turn-output.js'
import type { ContentBlock } from '@use-brian/agent-runtime/providers/types.js'

export type PendingAssistantTurn = {
  content: ContentBlock[]
  toolResults: ContentBlock[]
  stopReason: string
  origin?: string
  revision?: number
}
/** The existing web buffer, with exact in-place revisions. No lifecycle or authority. */
export function createBufferedTurnOutput() {
  const turns: PendingAssistantTurn[] = []
  const records = new Map<string, OutputRecord>()
  const positions = new Map<string, PendingAssistantTurn>()
  let invocationId: string | undefined
  let qualified = true
  return {
    turns,
    observe(event: QueryEvent, provenance?: QueryOutputProvenance): boolean {
      // Stage the entire packet before ANY buffer mutation: catch flush sees only accepted rows.
      const assertProviderContent = (content: readonly ContentBlock[]) => {
        if (content.some(block => (block as { type: string }).type === 'host_observation')) throw new Error('Provider output cannot author host observations')
      }
      if (event.type === 'assistant_turn') assertProviderContent(event.response.content)
      for (const update of provenance?.updates ?? []) if (update.response) assertProviderContent(update.response.content)
      let nextRecords = records
      if (provenance) {
        if (provenance.version !== 1 || !provenance.invocationId || invocationId && invocationId !== provenance.invocationId) throw new Error('Buffered output invocation changed')
        if (provenance.emission && positions.has(provenance.emission.origin) !== provenance.emission.replay) throw new Error('Duplicate or missing buffered output origin')
        if (provenance.updates.length || provenance.emission) {
          nextRecords = new Map(records)
          applyOutputRevisions(nextRecords, provenance)
        }
      }
      const replacements: Array<{ pending: PendingAssistantTurn; record: OutputRecord; content: ContentBlock[] }> = []
      for (const update of provenance?.updates ?? []) {
        const pending = positions.get(update.origin), record = nextRecords.get(update.origin)!
        if (pending && pending.revision !== record.revision) replacements.push({ pending, record, content: structuredClone(record.response.content) })
      }
      const emission = provenance?.emission
      let pending: PendingAssistantTurn | undefined
      if (event.type === 'assistant_turn' && !emission?.replay) {
        const response = emission ? nextRecords.get(emission.origin)!.response : event.response
        pending = { content: structuredClone(response.content), toolResults: structuredClone(event.toolResults),
          stopReason: response.stopReason ?? 'unknown', ...(emission ? { origin: emission.origin, revision: nextRecords.get(emission.origin)!.revision } : {}) }
      }
      // Commit only after content, packet, replay and every owned copy passed validation.
      if (nextRecords !== records) for (const [origin, record] of nextRecords) records.set(origin, record)
      if (provenance) { invocationId = provenance.invocationId; qualified &&= provenance.qualified }
      else if (event.type === 'assistant_turn' || event.type === 'turn_complete') qualified = false
      for (const replacement of replacements) {
        replacement.pending.content = replacement.content
        replacement.pending.stopReason = replacement.record.response.stopReason
        replacement.pending.revision = replacement.record.revision
      }
      if (pending) {
        turns.push(pending)
        if (emission) positions.set(emission.origin, pending)
      }
      return event.type === 'assistant_turn'
    },
    /** Identity projection only; exact actual row ordinals are supplied by the row-building loop. */
    selectedOrdinals(selection: FinalizedOutputSelection | null, ordinals: ReadonlyMap<string, number>,
      rows: readonly { role: string; content: unknown }[]): readonly number[] | null {
      if (!selection || !qualified || selection.invocationId !== invocationId || selection.members.length > 512 || rows.length > 512) return null
      const seenOrigins = new Set<string>(), seenOrdinals = new Set<number>()
      return selection.members.map(member => {
        const record = records.get(member.origin), pending = positions.get(member.origin), ordinal = ordinals.get(member.origin)
        if (seenOrigins.has(member.origin) || ordinal !== undefined && seenOrdinals.has(ordinal)) throw new Error('Duplicate selected publication member')
        seenOrigins.add(member.origin)
        if (ordinal !== undefined) seenOrdinals.add(ordinal)
        if (!record?.sealed || record.revision !== member.revision || record.digest !== member.digest || pending?.revision !== member.revision
          || ordinal === undefined || rows[ordinal]?.role !== 'assistant'
          || outputContentDigest(rows[ordinal].content) !== member.contentDigest) throw new Error('Selected output does not match publication command')
        return ordinal
      })
    },
  }
}
