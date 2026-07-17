// [COMP:api/research-synthesizer] — the RESEARCH fill: synthesize a blueprint
// from a web-research gather into an anchored page.
//
// Research is `extract` with a web-gather source. A workflow `assistant_call`
// research step runs the existing parallel fan-out as the GATHER (unchanged); the
// findings come back as a formatted string. This synthesizer is the AUTHORING
// half: it points the SAME `synthesizeFromSource` engine at those findings via a
// `kind:'research'` source whose source tool returns the gathered text
// (`createFindingsSourceTool`) — the findings ARE the source, no Episode needed.
//
// Parallel to `createRecordingSynthesizer` (recording) and `createGenerateSynthesizer`
// (brain): identical blueprint resolution (built-in skill / workspace skill /
// document page-template), identical doc-write + brain-write tool assembly,
// identical engine. Only the source tool changes. The target is the step's
// already-resolved page anchor (the engine fills THAT page; not found-or-created).
//
// Built once in boot from the shared stores and handed to the callee executor as
// a function reference (the recording-synthesizer pattern), so the executor's
// research path stays a single call. See
// docs/architecture/brain/structural-synthesis.md → "The three fill modes" (Research).

import {
  createCrmTools,
  createMemoryTools,
  createDocTools,
  createTaskTools,
  loadBuiltinSkills,
  type CrmStore,
  type DocPageStore,
  type LLMProvider,
  type MemoryStore,
  type SavedViewStore,
  type Sensitivity,
  type TaskStore,
  type TokenUsage,
  type Tool,
  type UsageStore,
  type WorkflowRunStore,
  type WorkspaceDirectoryStore,
} from '@sidanclaw/core'
import { createFindingsSourceTool } from './findings-source-tool.js'
import { synthesizeFromSource, type SynthesisBlueprint } from './synthesize.js'
import { extractionToBlueprintBody } from './blueprint-from-template.js'
import { createRecordPageProjector } from './synthesize.js'
import type { BlueprintRecordStore } from '../db/blueprint-records-store.js'
import type { PageTemplateStore } from '../db/page-templates-store.js'

export type ResearchSynthesizerDeps = {
  provider: LLMProvider
  model: string
  savedViewStore: SavedViewStore
  docPageStore: DocPageStore
  crmStore: CrmStore
  taskStore: TaskStore
  /** Enables the `saveMemory` brain-write tool (capture: ['memory']). Optional so partial deploys degrade to CRM + task tools. */
  memoryStore?: MemoryStore
  workflowRunStore: WorkflowRunStore
  workspaceDirectory: WorkspaceDirectoryStore
  computeCostUsd?: (model: string, usage: TokenUsage) => number
  usageStore?: UsageStore
  /**
   * Resolve a workspace-authored blueprint body by slug (POST /api/skills).
   * Omitted → built-in + page-template blueprints only.
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

export type ResearchSynthesisArgs = {
  /** The blueprint to fill (built-in id, workspace skill slug, or page-template id). */
  blueprintSlug: string
  /** The research findings the fan-out already gathered (a `runPreflight` string). */
  findings: string
  /** The already-resolved page anchor to fill (the step's `pageAnchorId`). */
  pageId: string
  workspaceId: string
  userId: string
  assistantId: string
  /** Write/read ceiling for this draft; every `save*` write inherits it. Default `internal`. */
  sensitivity?: string
  /** Stable correlation handle for the synthetic loop context (the workflow/step key). */
  sourceRef?: string
}

/** The callback the callee executor's research path invokes after the gather. */
export type ResearchSynthesizeFn = (
  args: ResearchSynthesisArgs,
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
 * Build the RESEARCH synthesizer. Returns `null` when the blueprint slug resolves
 * to nothing (logged, non-fatal — the executor falls back to free-form authoring).
 */
export function createResearchSynthesizer(deps: ResearchSynthesizerDeps): ResearchSynthesizeFn {
  return async (args: ResearchSynthesisArgs): Promise<{ pageId: string | null } | null> => {
    const sensitivity = args.sensitivity ?? 'internal'

    // 1. Resolve the blueprint body: built-in first, else workspace-authored,
    //    else a page-template `extraction` spec — IDENTICAL to the other modes.
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
      console.warn(`[research-synthesizer] blueprint not found: ${args.blueprintSlug}`)
      return null
    }

    // 2. The SOURCE is the gathered findings, handed back by the source tool.
    const sourceTool = createFindingsSourceTool({ findings: args.findings })

    // 3. Doc-write tools, pinned to the anchored page at build time. `renderPage`
    //    is excluded — it mints a NEW draft, orphaning the anchored page.
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

    // Brain-write tools — write `source='extracted'`, so they surface in Brain Reviews.
    const crm = createCrmTools(deps.crmStore, { writeSource: 'extracted' })
    const tasks = createTaskTools(deps.taskStore, { writeSource: 'extracted' })
    const brainWriteTools = new Map<string, Tool>([
      ['saveCompany', crm.saveCompany],
      ['saveContact', crm.saveContact],
      ['saveDeal', crm.saveDeal],
      ['saveTask', tasks.saveTask],
    ])
    // Blueprint-directed memories (capture: ['memory']). No provenance Episode
    // exists for a brain draft / research gather, so the write carries
    // source='extracted' with no episode anchor (it still lands in the brain
    // inbox via its source filter).
    if (deps.memoryStore) {
      const memory = createMemoryTools(deps.memoryStore, { writeSource: 'extracted' })
      brainWriteTools.set('saveMemory', memory.saveMemory)
    }

    // 4. Run. The target is the EXISTING anchored page (page-first already
    //    happened upstream — the executor resolved/created the anchor). The
    //    anchorKey is a stable per-(workflow page) handle for the engine's
    //    find-or-create guard; with an explicit pageId it is the converge key only.
    return synthesizeFromSource(
      {
        kind: 'research',
        sourceId: args.sourceRef ?? args.pageId,
        workspaceId: args.workspaceId,
        userId: args.userId,
        assistantId: args.assistantId,
        assistantKind: 'standard',
        sensitivity,
      },
      blueprint,
      {
        pageId: args.pageId,
        anchorKey: `research-synthesis:${args.pageId}`,
        // A research fill reaches here only page-anchored (the executor resolved
        // the anchor upstream), so the page projection renders.
        renderPage: true,
        recordSubject: args.sourceRef ?? `page ${args.pageId}`,
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

// Re-export the clearance helper for the actor projection so the read ceiling on
// any future direct caller stays consistent with the other synthesizers.
export { clearanceOf as researchClearanceOf }
