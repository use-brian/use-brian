/**
 * Research delivery: turn an actual research turn into a saved, inspected
 * canonical artifact (docs/architecture/features/research.md -> "Delivery").
 *
 * The observer reads only structured tool results. A page id the model merely
 * writes in prose, planning text, or narration riding beside a tool call is
 * never a receipt. When the turn made no canonical write, the server authors
 * the default Page through the canonical page writer; either way every
 * receipt is re-read as the actor before it is linked, and an activity is
 * `saved` only with at least one such link.
 *
 * [COMP:api/research-delivery]
 */
import {
  deriveResearchDeliveryStatus,
  extractResearchWriteReceipts,
  type QueryEvent,
  type ResearchArtifactKind,
  type ResearchSourceRef,
  type ResearchWriteReceipt,
} from '@use-brian/core'
import type { ResearchActivity, SettleResearchActivityInput } from '../db/research-store.js'

/** Read tools whose successful result means the source was actually read. */
const INSPECTING_READS: Readonly<Record<string, { kind: ResearchSourceRef['kind']; key: string }>> = {
  urlReader: { kind: 'web', key: 'url' },
  readPage: { kind: 'page', key: 'pageId' },
  fileRead: { kind: 'file', key: 'path' },
  getOfficeArtifact: { kind: 'document', key: 'artifactId' },
  browserRead: { kind: 'browser', key: 'url' },
}
/** Tools that only find links/snippets: a hit is a found source, not a read. */
const FINDING_TOOLS = new Set(['webSearch', 'xSearch', 'searchKnowledge', 'searchBrain'])

const URL_RE = /https?:\/\/[^\s)\]"'<>]+/g
const MAX_SOURCES = 50
const MAX_FOUND_PER_SEARCH = 5

export type ResearchTurnObservation = {
  receipts: ResearchWriteReceipt[]
  sources: ResearchSourceRef[]
  gaps: string[]
}

/**
 * Collects receipts, sources and gaps from the coordinator's own event stream
 * and (reads only) from its read-only workers. Gaps are structural - a read
 * that failed - never the coordinator's planning prose, which is narration
 * riding beside tool calls and must not reach a user.
 */
export function createResearchTurnObserver(now: () => Date = () => new Date()) {
  const inputs = new Map<string, { name: string; input: Record<string, unknown> }>()
  const receipts = new Map<string, ResearchWriteReceipt>()
  const sources = new Map<string, ResearchSourceRef>()
  const gaps = new Set<string>()

  function addSource(kind: ResearchSourceRef['kind'], ref: string, inspected: boolean) {
    const key = `${kind}\u0000${ref}`
    const prior = sources.get(key)
    if (prior) {
      if (inspected && !prior.inspected) sources.set(key, { ...prior, inspected: true })
      return
    }
    if (sources.size >= MAX_SOURCES) return
    sources.set(key, { kind, ref: ref.slice(0, 2048), title: null, readAt: now().toISOString(), inspected })
  }

  function onToolResults(results: readonly unknown[], allowWrites: boolean) {
    for (const block of results) {
      if (!block || typeof block !== 'object') continue
      const b = block as { type?: string; toolUseId?: string; name?: string; content?: unknown; isError?: boolean }
      if (b.type !== 'tool_result' || !b.toolUseId || !b.name) continue
      const call = inputs.get(b.toolUseId)
      if (allowWrites) {
        for (const r of extractResearchWriteReceipts({ toolName: b.name, toolUseId: b.toolUseId, isError: !!b.isError, result: b.content, input: call?.input })) {
          receipts.set(`${r.kind}\u0000${r.artifactId}\u0000${r.version ?? ''}`, r)
        }
      }
      const read = INSPECTING_READS[b.name]
      const target = read ? call?.input?.[read.key] : undefined
      if (b.isError) {
        // A read that failed is a limitation, never an inspected source.
        if (read && typeof target === 'string' && target.trim() && gaps.size < 20) gaps.add(`Not read: ${target.trim()}`.slice(0, 300))
        continue
      }
      if (read && typeof target === 'string' && target.trim()) addSource(read.kind, target.trim(), true)
      if (FINDING_TOOLS.has(b.name) && typeof b.content === 'string') {
        for (const url of (b.content.match(URL_RE) ?? []).slice(0, MAX_FOUND_PER_SEARCH)) addSource('web', url, false)
      }
    }
  }

  return {
    /** Coordinator events: writes and reads. */
    observe(event: QueryEvent) {
      if (event.type === 'tool_input') inputs.set(event.id, { name: event.name, input: event.input })
      else if (event.type === 'tool_result') onToolResults(event.results, true)
    },
    /** Worker events: workers are read-only, so only their reads count. */
    observeWorker(event: QueryEvent) {
      if (event.type === 'tool_input') inputs.set(event.id, { name: event.name, input: event.input })
      else if (event.type === 'tool_result') onToolResults(event.results, false)
    },
    snapshot(): ResearchTurnObservation {
      return { receipts: [...receipts.values()], sources: [...sources.values()], gaps: [...gaps] }
    },
  }
}

export type ResearchDeliveryDeps = {
  settle(input: SettleResearchActivityInput): Promise<ResearchActivity>
  /** Current viewer projection after a refused attempt; saved status is historical. */
  currentActivity?(userId: string, workspaceId: string, activityId: string): Promise<ResearchActivity | null>
  /** Re-read an artifact as the actor; `readable` false when it is gone or hidden. */
  inspect(userId: string, kind: ResearchArtifactKind, artifactId: string): Promise<{ readable: boolean; version: number | null }>
  /** Author the default Page through the canonical page writer. */
  writeDefaultPage(input: {
    activityId: string
    requestMessageId: string | null
    userId: string
    workspaceId: string
    pageId: string
    title: string
    markdown: string
    projectId: string | null
    originPrompt: string | null
    /** The activity's source floor; the writer must not place the page below it. */
    sensitivity: 'public' | 'internal' | 'confidential'
  }): Promise<{ pageId: string; version: number }>
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code
  if (typeof code === 'string' && /^[a-z0-9_]{1,80}$/i.test(code)) return code
  return 'page_write_failed'
}

export function researchTitleFor(request: string | null): string {
  const base = (request ?? '').replace(/\s+/g, ' ').trim()
  if (!base) return 'Research'
  return base.length > 80 ? `${base.slice(0, 77).trimEnd()}...` : base
}

/**
 * Settle one research activity from what the turn actually did. `finalText`
 * must already be the sanitized user-facing answer (no tool-use narration).
 */
export async function recordResearchDelivery(deps: ResearchDeliveryDeps, params: {
  activity: ResearchActivity
  observation: ResearchTurnObservation
  finalText: string
  outputMessageId: string | null
  requestText: string | null
  /** True when the turn ended without a usable answer (abort/error). */
  interrupted?: boolean
}): Promise<ResearchActivity> {
  const { activity, observation } = params
  const answer = params.finalText.trim()
  let receipts = observation.receipts
  let saveError: string | null = null

  // The default Page: only when the turn made no canonical write of its own,
  // only from a real answer, and only for a pre-minted id (replay-safe).
  if (receipts.length === 0 && answer && !params.interrupted && activity.plannedPageId) {
    try {
      const page = await deps.writeDefaultPage({
        activityId: activity.id,
        requestMessageId: activity.requestMessageId,
        userId: activity.actorUserId,
        workspaceId: activity.workspaceId,
        pageId: activity.plannedPageId,
        title: researchTitleFor(params.requestText),
        markdown: answer,
        projectId: activity.projectId,
        originPrompt: params.requestText,
        sensitivity: activity.sensitivity,
      })
      receipts = [{ kind: 'page', artifactId: page.pageId, version: page.version, toolName: 'research.default_page', toolUseId: activity.id, operation: 'create' }]
    } catch (error) {
      if (deps.currentActivity) {
        const current = await deps.currentActivity(activity.actorUserId,activity.workspaceId,activity.id)
        if (!current || current.status === 'saved') throw Object.assign(new Error('Research source is not currently available'), { code: 'research_source_unavailable' })
      }
      saveError = errorCode(error)
    }
  }

  const links: SettleResearchActivityInput['links'] = []
  for (const r of receipts) {
    const seen = await deps.inspect(activity.actorUserId, r.kind, r.artifactId).catch(() => ({ readable: false, version: null }))
    if (!seen.readable) continue
    links.push({
      kind: r.kind,
      artifactId: r.artifactId,
      version: r.version ?? seen.version,
      relation: r.operation === 'create' ? 'output' : 'revision',
      toolName: r.toolName,
      toolUseId: r.toolUseId,
    })
  }
  if (receipts.length > 0 && links.length === 0 && !saveError) saveError = 'artifact_not_readable'

  const inspected = observation.sources.filter((s) => s.inspected).length
  const status = deriveResearchDeliveryStatus({
    verifiedReceipts: links.length,
    findings: inspected + (answer ? 1 : 0),
    gaps: observation.gaps.length,
  })
  if (status !== 'saved' && !saveError) saveError = params.interrupted ? 'interrupted' : answer ? 'not_saved' : 'no_output'

  return deps.settle({
    activityId: activity.id,
    workspaceId: activity.workspaceId,
    status,
    outputMessageId: params.outputMessageId,
    sources: observation.sources,
    gaps: observation.gaps,
    findingsCount: inspected,
    summary: answer ? answer.slice(0, 1000) : null,
    saveError,
    links,
  })
}
