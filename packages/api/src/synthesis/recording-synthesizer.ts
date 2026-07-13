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
import { createSearchRecordingTool } from '../recordings/recording-search-tool.js'
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

    // 2. The source-retrieval tool (searchRecording), pinned to this recording + actor.
    const sourceTool = createSearchRecordingTool({
      recordingId: args.recordingId,
      actor: {
        workspaceId: args.workspaceId,
        userId: args.userId,
        assistantId: args.assistantId,
        assistantKind: 'standard',
        clearance: clearanceOf(args.sensitivity),
        compartments: null,
      },
      embedder: deps.embedder,
    })

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
        projectRecordPage: createRecordPageProjector(deps.docPageStore),
        usageStore: deps.usageStore,
        computeCostUsd: deps.computeCostUsd,
      },
    )
  }
}
