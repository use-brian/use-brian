// [COMP:api/recording-synthesizer] — the recording → blueprint synthesis callback.
//
// This is the `synthesize` infra the recording ingestor factory takes. Per call
// it resolves the blueprint body (a built-in skill, else a workspace-authored
// one), assembles the searchRecording + doc-write + brain-write tools, and runs
// `synthesizeFromSource`. It lives in the OPEN package and is constructed at boot
// from the shared stores; the closed recording factory only holds the reference.
//
// See docs/architecture/brain/structural-synthesis.md → "The first source".

import {
  createCrmTools,
  createDocTools,
  createTaskTools,
  loadBuiltinSkills,
  type CrmStore,
  type DocPageStore,
  type Embedder,
  type LLMProvider,
  type SavedViewStore,
  type Sensitivity,
  type TaskStore,
  type TokenUsage,
  type Tool,
  type UsageStore,
  type WorkflowRunStore,
  type WorkspaceDirectoryStore,
} from '@sidanclaw/core'
import { buildCitationIndex, formatTranscript } from '@sidanclaw/shared'
import { createSearchRecordingTool } from '../recordings/recording-search-tool.js'
import { readRecordingRange, type RecordingSegmentHit } from '../db/retrieval-store.js'
import type { RetrievalActor } from '@sidanclaw/core'
import {
  createRecordPageProjector,
  synthesizeFromSource,
  type SynthesisBlueprint,
} from './synthesize.js'
import { extractionToBlueprintBody } from './blueprint-from-template.js'
import type { BlueprintRecordStore } from '../db/blueprint-records-store.js'
import type { PageTemplateStore } from '../db/page-templates-store.js'

export type RecordingSynthesizerDeps = {
  provider: LLMProvider
  model: string
  savedViewStore: SavedViewStore
  docPageStore: DocPageStore
  crmStore: CrmStore
  taskStore: TaskStore
  workflowRunStore: WorkflowRunStore
  workspaceDirectory: WorkspaceDirectoryStore
  embedder?: Pick<Embedder, 'embed'>
  computeCostUsd?: (model: string, usage: TokenUsage) => number
  usageStore?: UsageStore
  /**
   * Resolve a workspace-authored blueprint body by slug (user-authored blueprints
   * via POST /api/skills). Omitted → built-in blueprints only.
   */
  resolveWorkspaceBlueprint?: (
    workspaceId: string,
    slug: string,
  ) => Promise<{ body: string; title?: string } | null>
  /** Resolve a "document" blueprint — a page template carrying an extraction spec. */
  pageTemplateStore?: PageTemplateStore
  /** Record persistence (migration 307) — document fills run record-first when wired. */
  blueprintRecordStore?: BlueprintRecordStore
}

export type RecordingSynthesisArgs = {
  recordingId: string
  workspaceId: string
  userId: string
  assistantId: string
  sensitivity: string
  blueprintSlug: string
}

/** The callback the recording ingestor's `synthesize` infra field holds. */
export type RecordingSynthesizeFn = (
  args: RecordingSynthesisArgs,
) => Promise<{ pageId: string | null } | null>

/** Episode sensitivity is 4-value (`private` exists); the actor clearance ladder is 3-value. */
function clearanceOf(sensitivity: string): Sensitivity {
  if (sensitivity === 'private' || sensitivity === 'confidential') return 'confidential'
  if (sensitivity === 'public') return 'public'
  return 'internal'
}

function titleFor(slug: string, name?: string): string {
  return name ?? slug.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Above this the full transcript is NOT injected (a >~10 h recording would
 *  bloat the prompt) and synthesis falls back to the search-tool sweep. The
 *  3 h recording ceiling is ~70k chars, so this only guards pathological input. */
const MAX_INJECT_CHARS = 500_000

/**
 * Hard ceiling on segments held in memory. Only a pathological recording gets
 * near it (a 3 h meeting is ~2k segments); it exists so an absurd input degrades
 * to a partial citation index instead of an OOM.
 */
const MAX_INDEX_SEGMENTS = 50_000

/**
 * Read the recording's segments once, and serve BOTH consumers from that one
 * read: the `## FULL TRANSCRIPT` prompt injection, and the citation index the
 * fill resolves `[H:MM:SS]` against.
 *
 * `text` is undefined when the transcript exceeds `MAX_INJECT_CHARS` (the caller
 * falls back to the search-tool sweep) — but `segments` is still returned, so a
 * recording too large to inject still gets citations resolved. Pages the store in
 * blocks so one query never loads a pathological recording whole.
 */
async function loadRecordingTranscript(
  recordingId: string,
  actor: RetrievalActor,
): Promise<{ text?: string; segments: RecordingSegmentHit[] }> {
  const BLOCK = 500
  const segments: RecordingSegmentHit[] = []
  try {
    for (let from = 0; ; from += BLOCK) {
      const hits: RecordingSegmentHit[] = await readRecordingRange(actor, {
        recordingId,
        fromIndex: from,
        toIndex: from + BLOCK - 1,
      })
      if (hits.length === 0) break
      segments.push(...hits)
      if (hits.length < BLOCK || segments.length >= MAX_INDEX_SEGMENTS) break
    }
  } catch {
    return { segments: [] } // read failed — fall back to the sweep, no citations
  }
  if (segments.length === 0) return { segments: [] }
  // The ONE transcript rendering (`@sidanclaw/shared`) — the same function that
  // writes the transcript file, so the text the model cites from and the text we
  // later parse citations out of cannot drift.
  const text = formatTranscript(
    segments.map((s) => ({ startMs: s.start_ms, speaker: s.speaker, text: s.segment_text })),
  )
  return { ...(text.length <= MAX_INJECT_CHARS ? { text } : {}), segments }
}

/**
 * Build the structural-synthesis callback the recording ingestor invokes. Returns
 * `null` when the blueprint slug resolves to nothing (logged, non-fatal — the
 * caller's try/catch keeps segments/entities/billing intact regardless).
 */
export function createRecordingSynthesizer(deps: RecordingSynthesizerDeps): RecordingSynthesizeFn {
  return async (args: RecordingSynthesisArgs): Promise<{ pageId: string | null } | null> => {
    // 1. Resolve the blueprint body: built-in first, else workspace-authored.
    let blueprint: SynthesisBlueprint | null = null
    const builtin = loadBuiltinSkills().find((s) => s.id === args.blueprintSlug)
    if (builtin) {
      blueprint = {
        kind: 'skill',
        slug: builtin.id,
        body: builtin.content,
        title: titleFor(builtin.id, builtin.name),
      }
    }
    if (!blueprint && deps.resolveWorkspaceBlueprint) {
      const ws = await deps.resolveWorkspaceBlueprint(args.workspaceId, args.blueprintSlug)
      if (ws) {
        blueprint = {
          kind: 'skill',
          slug: args.blueprintSlug,
          body: ws.body,
          title: titleFor(args.blueprintSlug, ws.title),
        }
      }
    }
    // A page template carrying an `extraction` spec is a "document" blueprint:
    // rendered to a recipe body and run by the SAME engine. The slug is its id.
    if (!blueprint && deps.pageTemplateStore) {
      const tmpl = await deps.pageTemplateStore.getById(args.userId, args.blueprintSlug)
      if (tmpl?.extraction) {
        blueprint = {
          kind: 'document',
          slug: tmpl.id,
          body: extractionToBlueprintBody(tmpl.name, tmpl.extraction),
          title: tmpl.name,
          spec: tmpl.extraction,
        }
      }
    }
    if (!blueprint) {
      console.warn(`[recording-synthesizer] blueprint not found: ${args.blueprintSlug}`)
      return null
    }

    const actor = {
      workspaceId: args.workspaceId,
      userId: args.userId,
      assistantId: args.assistantId,
      assistantKind: 'standard' as const,
      clearance: clearanceOf(args.sensitivity),
      compartments: null,
    }

    // 2. The source-retrieval tool (searchRecording), pinned to this recording + actor.
    const sourceTool = createSearchRecordingTool({ recordingId: args.recordingId, actor, embedder: deps.embedder })

    // 2b. Inject the COMPLETE transcript into the prompt (when it fits): a model
    //     told to sweep it with a tool satisfices and drafts from the first
    //     quarter (2026-07-15). Handing it the whole text removes the discretion.
    //     Capped so a pathological >10 h recording can't blow the context; above
    //     the cap we fall back to the tool sweep.
    const { text: fullText, segments } = await loadRecordingTranscript(args.recordingId, actor)

    // 2c. The citation index: every `[H:MM:SS]` the model writes is resolved
    //     against the transcript it was shown and persisted as a typed pointer.
    //     The ceiling is the LAST SEGMENT'S END, not `recordings.duration_ms` —
    //     the model can only ground a claim in what it read, so a moment past the
    //     transcript is invented even when the audio runs longer (trailing
    //     silence, or a truncated transcription).
    const citationIndex =
      segments.length > 0
        ? buildCitationIndex(
            segments.map((s) => ({
              segmentIndex: s.segment_index,
              startMs: s.start_ms,
              endMs: s.end_ms,
              speaker: s.speaker,
            })),
            Math.max(...segments.map((s) => s.end_ms)),
          )
        : undefined

    // 3. Doc-write tools, pinned to the brief page at build time (patchPage targets
    //    `anchorPageId`). `renderPage` is excluded — it mints a NEW draft, which
    //    would orphan the page-first brief; the model authors via patchPage.
    const buildDocTools = (anchorPageId: string): Map<string, Tool> => {
      const docToolset = createDocTools({
        savedViewStore: deps.savedViewStore,
        docPageStore: deps.docPageStore,
        taskStore: deps.taskStore,
        crmStore: deps.crmStore,
        workflowRunStore: deps.workflowRunStore,
        workspaceDirectory: deps.workspaceDirectory,
        anchorPageId,
      })
      return new Map<string, Tool>(
        Object.entries(docToolset).filter(([name]) => name !== 'renderPage'),
      )
    }

    // Brain-write tools — write `source='extracted'`, so they surface in
    // Brain Reviews, back-edged to the recording's Episode (recordingId IS
    // the episode id — `routes/recordings.ts` returns `recordingId: episode.id`).
    const crm = createCrmTools(deps.crmStore, { writeSource: 'extracted', writeSourceEpisodeId: args.recordingId })
    const tasks = createTaskTools(deps.taskStore, { writeSource: 'extracted', writeSourceEpisodeId: args.recordingId })
    const brainWriteTools = new Map<string, Tool>([
      ['saveCompany', crm.saveCompany],
      ['saveContact', crm.saveContact],
      ['saveDeal', crm.saveDeal],
      ['saveTask', tasks.saveTask],
    ])

    // 4. Run. Page-first + idempotent on the recording's stable anchor key.
    return synthesizeFromSource(
      {
        kind: 'recording',
        sourceId: args.recordingId,
        workspaceId: args.workspaceId,
        userId: args.userId,
        assistantId: args.assistantId,
        assistantKind: 'standard',
        sensitivity: args.sensitivity,
        ...(fullText ? { fullText } : {}),
      },
      blueprint,
      {
        anchorKey: `recording-synthesis:${args.recordingId}`,
        // Recording fills always render the brief page (per-surface default);
        // the record rides underneath as the typed artifact.
        renderPage: true,
        recordSubject: `${blueprint.title ?? titleFor(args.blueprintSlug)} recording ${args.recordingId.slice(0, 8)}`,
      },
      {
        provider: deps.provider,
        model: deps.model,
        sourceTool,
        buildDocTools,
        brainWriteTools,
        savedViewStore: deps.savedViewStore,
        blueprintRecordStore: deps.blueprintRecordStore,
        ...(citationIndex ? { citationIndex } : {}),
        projectRecordPage: createRecordPageProjector(deps.docPageStore),
        usageStore: deps.usageStore,
        computeCostUsd: deps.computeCostUsd,
      },
    )
  }
}
