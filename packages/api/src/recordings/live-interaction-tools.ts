import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { formatStamp } from '@use-brian/shared'
import { buildTool, type Embedder, type Tool } from '@use-brian/core'

export type LiveInteractionUtterance = {
  id: string
  text: string
  startMs: number
  endMs: number
  source: string
  revision?: number | string
}
export type LiveInteractionToolsDeps = {
  /** Both ports MUST already be bound to the authorized actor/capture/chat. */
  read(): Promise<readonly LiveInteractionUtterance[]>
  assertAccess(): Promise<void>
  /** Stable capture identifier, used only to namespace citations; never model supplied. */
  scopeId: string
  /** Server-built recording page URL, never supplied by the model. */
  pagePath?: string
  embedder?: Pick<Embedder, 'embed'>
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const limit = z.number().int().min(1).max(30).default(10)
const query = z.string().trim().min(1).max(2000)
const searchSchema = z.object({ query, limit, source: z.string().max(100).optional() }).strict()
const rangeSchema = z.object({
  startMs: z.number().nonnegative().optional(),
  endMs: z.number().nonnegative().optional(),
  afterCursor: z.string().max(100).optional(),
  references: z.array(z.string().max(300)).max(30).optional(),
  surroundingContext: z.number().int().min(0).max(5).default(0),
  limit,
}).strict()
const similarSchema = z.object({ query: query.optional(), segmentId: z.string().max(300).optional(), limit })
  .strict()

function lexical(text: string, q: string): number {
  const terms = [...new Set(q.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
  const haystack = text.toLocaleLowerCase()
  return terms.reduce((score, term) => score + Number(haystack.includes(term)), 0)
}
function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length || [...a, ...b].some(n => !Number.isFinite(n))) throw new Error('Invalid embedding')
  const norm = Math.hypot(...a) * Math.hypot(...b)
  if (!norm) throw new Error('Empty embedding')
  return a.reduce((sum, n, i) => sum + n * b[i]!, 0) / norm
}

/** Cursors are factory-lifetime change cursors, NOT timestamps or question-time cutoffs.
 * Recreate the factory only when the capture ends. An expired/foreign cursor fails closed.
 * Citations remain stable across factory restarts; revised evidence gets a new citation.
 */
export function createLiveInteractionTools(deps: LiveInteractionToolsDeps): Map<string, Tool> {
  const epoch = randomUUID()
  let revision = 0
  let state = new Map<string, { fingerprint: string; changed: number }>()
  const embeddings = new Map<string, number[]>() // bounded, text-version-keyed insertion cache
  // Serialize reads/state updates, not embedding requests; concurrent callers cannot roll cursors back.
  let reading: Promise<unknown> = Promise.resolve()
  const snapshot = () => {
    const result = reading.then(async () => {
      await deps.assertAccess()
      const rows = (await deps.read()).map(row => ({ ...row }))
        .sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id))
      await deps.assertAccess()
      const next = new Map<string, { fingerprint: string; changed: number }>()
      const hits = rows.map(row => {
        const fingerprint = digest([deps.scopeId, row.id, row.text, row.startMs, row.endMs, row.source, row.revision ?? null])
        const old = state.get(row.id)
        const changed = old?.fingerprint === fingerprint ? old.changed : ++revision
        next.set(row.id, { fingerprint, changed })
        return { ...row, citation: `live:${fingerprint}`,
          ...(deps.pagePath ? { citationLink: `[${formatStamp(row.startMs)}](${deps.pagePath}#${encodeURIComponent(`stream:${deps.scopeId}:${row.id}`)})` } : {}),
          provisional: true, timing: 'utterance' as const, changed }
      })
      if ([...state.keys()].some(id => !next.has(id))) revision++
      state = next
      return { hits, cursor: `${epoch}:${revision}`, revision }
    })
    reading = result.catch(() => {})
    return result
  }
  const metadata = { isReadOnly: true, isConcurrencySafe: true, requiresConfirmation: false,
    allowsRepeatCalls: true, timeoutMs: 10_000, maxResultSizeChars: 65_000 }
  type Snapshot = Awaited<ReturnType<typeof snapshot>>
  async function output(s: Snapshot, hits: Snapshot['hits'], method: string, degraded = false, extra = {}) {
    await deps.assertAccess()
    // Preserve exact text rather than silently truncating cited evidence.
    let chars = 0
    const bounded = hits.filter(hit => { chars += hit.text.length; return chars <= 48_000 })
    return { data: { cursor: s.cursor, revision: s.revision, method, degraded,
      hits: bounded.map(({ changed: _, ...hit }) => hit), truncated: bounded.length !== hits.length, omittedReferences: hits.filter(h => !bounded.includes(h)).map(h => h.citation), ...extra } }
  }
  const search = buildTool({ ...metadata, name: 'searchLiveTranscript', inputSchema: searchSchema,
    description: 'Lexical search of the latest persisted live speech in this capture. Returns exact provisional evidence, stable citations and the current read cursor.',
    async execute(raw) {
      const input = searchSchema.parse(raw)
      const s = await snapshot()
      const ranked = s.hits.filter(h => !input.source || h.source === input.source)
        .map(h => ({ h, score: lexical(h.text, input.query) })).filter(h => h.score > 0)
        .sort((a, b) => b.score - a.score || b.h.startMs - a.h.startMs)
      return output(s, ranked.slice(0, input.limit).map(r => r.h), 'lexical')
    },
  })
  const range = buildTool({ ...metadata, name: 'readLiveTranscriptRange', inputSchema: rangeSchema,
    description: 'Read latest live speech by inclusive time overlap, afterCursor, or exact citation/segment references. Omit filters for the latest tail. Cursors are change cursors scoped to this tool instance; use returned nextCursor to page. Unknown/revised citations are explicitly reported.',
    async execute(raw) {
      const input = rangeSchema.parse(raw)
      if (input.afterCursor && input.surroundingContext) throw new Error('Use surroundingContext with time or references, not afterCursor')
      if (input.startMs !== undefined && input.endMs !== undefined && input.endMs < input.startMs) throw new Error('endMs must follow startMs')
      const s = await snapshot()
      let after = -1
      if (input.afterCursor) {
        const [id, value] = input.afterCursor.split(':')
        after = Number(value)
        if (id !== epoch || !/^\d+$/.test(value ?? '') || after > s.revision) throw new Error('Foreign or expired live transcript cursor; read latest again')
      }
      const refs = new Set(input.references)
      const selected = new Set<number>()
      s.hits.forEach((h, i) => {
        if (h.changed <= after || (input.startMs !== undefined && h.endMs < input.startMs)
          || (input.endMs !== undefined && h.startMs > input.endMs)
          || (input.references && !refs.has(h.id) && !refs.has(h.citation))) return
        for (let j = Math.max(0, i - input.surroundingContext); j <= Math.min(s.hits.length - 1, i + input.surroundingContext); j++) selected.add(j)
      })
      let hits = [...selected].sort((a, b) => a - b).map(i => s.hits[i]!)
      const unfiltered = !input.afterCursor && !input.references && input.startMs === undefined && input.endMs === undefined
      if (input.afterCursor) hits.sort((a, b) => a.changed - b.changed)
      const more = hits.length > input.limit
      hits = unfiltered ? hits.slice(-input.limit) : hits.slice(0, input.limit)
      return output(s, hits, 'range', false, {
        hasMore: more,
        nextCursor: input.afterCursor && more ? `${epoch}:${Math.max(after, ...hits.map(h => h.changed))}` : s.cursor,
        missingReferences: [...refs].filter(ref => !s.hits.some(h => h.id === ref || h.citation === ref)),
      })
    },
  })
  const similar = buildTool({ ...metadata, name: 'findSimilarLiveTranscript', inputSchema: similarSchema,
    description: 'Similarity over current live speech. Embeds up to 128 recent utterances on demand with a bounded cache; older speech remains lexically searchable. Reports semantic coverage and honest lexical fallback on unavailable embeddings.',
    async execute(raw) {
      const input = similarSchema.parse(raw)
      if (Boolean(input.query) === Boolean(input.segmentId)) throw new Error('Supply query OR segmentId')
      const s = await snapshot()
      const seed = input.segmentId ? s.hits.find(h => h.id === input.segmentId) : undefined
      if (input.segmentId && !seed) throw new Error('Segment is not in this capture')
      const q = input.query ?? seed!.text
      const candidates = s.hits.filter(h => h.id !== input.segmentId)
      let ranked = candidates.map(h => ({ h, score: lexical(h.text, q) })).filter(r => r.score > 0)
      let method = 'lexical-fallback'
      let embedded = 0
      if (deps.embedder) {
        try {
          const tail = candidates.slice(-128)
          const missing = tail.filter(h => !embeddings.has(h.citation))
          const vectors = await deps.embedder.embed([q, ...missing.map(h => h.text)])
          if (vectors.length !== missing.length + 1) throw new Error('Incomplete embeddings')
          vectors.forEach(v => cosine(vectors[0]!, v))
          missing.forEach((h, i) => embeddings.set(h.citation, vectors[i + 1]!))
          ranked = tail.map(h => ({ h, score: cosine(vectors[0]!, embeddings.get(h.citation)!) }))
          embedded = tail.length
          method = 'semantic-recent-tail'
        } catch { /* all current speech remains available in lexical fallback */ }
        while (embeddings.size > 256) embeddings.delete(embeddings.keys().next().value!)
      }
      ranked.sort((a, b) => b.score - a.score)
      return output(s, ranked.slice(0, input.limit).map(r => r.h), method,
        method === 'lexical-fallback' || embedded < candidates.length,
        { embeddedUtterances: embedded, totalUtterances: candidates.length })
    },
  })
  return new Map<string, Tool>([search, range, similar].map(tool => [tool.name, tool]))
}
