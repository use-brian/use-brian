// [COMP:api/generate-synthesizer] — the GENERATE fill mode: draft a blueprint
// from what the company brain already holds.
//
// Parallel to `createRecordingSynthesizer` (the EXTRACT mode), but the source is
// the brain (`SynthesisSource.kind:'brain'`) instead of a recording transcript:
// the model gathers context with the `searchSource` brain tool and fills the same
// blueprint into a page. "Generate is the outbound half: turn structure into a
// document" — a proposal / SOW / brief drafted from the account the brain already
// knows. The blueprint is resolved IDENTICALLY (built-in skill, else
// workspace-authored skill, else a `document` page-template extraction spec), and
// the SAME `synthesizeFromSource` engine runs it — only the source tool changes.
//
// Idempotent by a stable per-subject anchor key, so re-generating the same
// (blueprint, subject) pair patches one page instead of minting duplicates — the
// substrate the MAINTAIN mode reuses (this synthesizer on a recurring schedule +
// `anchor_key` page reuse keeps one document current; no new code needed).
//
// See docs/architecture/brain/structural-synthesis.md → "The three fill modes".

import {
  createCrmTools,
  createMemoryTools,
  createDocTools,
  createTaskTools,
  loadBuiltinSkills,
  type CrmStore,
  type DocPageStore,
  type Embedder,
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
import { createBrainSourceTool } from './brain-source-tool.js'
import {
  createRecordPageProjector,
  synthesizeFromSource,
  type SynthesisBlueprint,
} from './synthesize.js'
import { extractionToBlueprintBody } from './blueprint-from-template.js'
import { blueprintSubjectAnchorKey } from './blueprint-record-tools.js'
import type { PageTemplateStore } from '../db/page-templates-store.js'
import type { BlueprintRecordStore } from '../db/blueprint-records-store.js'

export type GenerateSynthesizerDeps = {
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
  embedder?: Pick<Embedder, 'embed'>
  computeCostUsd?: (model: string, usage: TokenUsage) => number
  usageStore?: UsageStore
  /**
   * Resolve a workspace-authored blueprint body by slug (user-authored
   * blueprints via POST /api/skills). Omitted → built-in blueprints only.
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

export type GenerateSynthesisArgs = {
  /** The blueprint to fill (built-in id, workspace skill slug, or page-template id). */
  blueprintSlug: string
  /**
   * What this draft is ABOUT — an entity id/name or a free subject string. Used
   * only to scope the idempotent anchor key (so re-generating the same
   * (blueprint, subject) pair patches one page) and to seed the brief title; the
   * model gathers the actual facts via the brain source tool.
   */
  subject: string
  workspaceId: string
  userId: string
  assistantId: string
  /**
   * Write/read ceiling for this draft. The brain source tool reads under this
   * clearance and every `save*` write inherits it. Defaults to `internal`.
   */
  sensitivity?: string
  /**
   * Optional explicit target page (e.g. a workflow-anchored page). When set, the
   * draft fills THAT page; otherwise found-or-created by the subject anchor key.
   */
  pageId?: string | null
  /**
   * Whether this surface renders the page projection. Default true (the
   * Generate UI and recording paths keep their pages). Record-only callers
   * (in-chat fill, workflow output bindings) pass false.
   */
  renderPage?: boolean
}

/** The callback a chat "generate" tool / route invokes to draft from the brain. */
export type GenerateSynthesizeFn = (args: GenerateSynthesisArgs) => Promise<{
  pageId: string | null
  recordId?: string | null
  recordStatus?: 'complete' | 'incomplete' | null
  missing?: string[]
} | null>

/** Episode sensitivity is 4-value (`private` exists); the actor clearance ladder is 3-value. */
function clearanceOf(sensitivity: string): Sensitivity {
  if (sensitivity === 'private' || sensitivity === 'confidential') return 'confidential'
  if (sensitivity === 'public') return 'public'
  return 'internal'
}

function titleFor(slug: string, subject: string, name?: string): string {
  const blueprintName = name ?? slug.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  return `${blueprintName} - ${subject}`.slice(0, 200)
}

/**
 * Stable, collision-resistant anchor key for a (workspace, blueprint, subject)
 * draft — shared with the direct-save tool so a generate fill and a
 * `saveBlueprintRecord` for the same subject converge on one record + page.
 */
const anchorKeyFor = blueprintSubjectAnchorKey

/**
 * Build the GENERATE synthesizer. Returns `null` when the blueprint slug resolves
 * to nothing (logged, non-fatal — the caller decides how to surface it).
 */
export function createGenerateSynthesizer(deps: GenerateSynthesizerDeps): GenerateSynthesizeFn {
  return async (args: GenerateSynthesisArgs): Promise<{ pageId: string | null } | null> => {
    const sensitivity = args.sensitivity ?? 'internal'

    // 1. Resolve the blueprint body: built-in first, else workspace-authored,
    //    else a page-template `extraction` spec — IDENTICAL to the recording path.
    let blueprint: SynthesisBlueprint | null = null
    const builtin = loadBuiltinSkills().find((s) => s.id === args.blueprintSlug)
    if (builtin) {
      blueprint = {
        kind: 'skill',
        slug: builtin.id,
        body: builtin.content,
        title: titleFor(builtin.id, args.subject, builtin.name),
      }
    }
    if (!blueprint && deps.resolveWorkspaceBlueprint) {
      const ws = await deps.resolveWorkspaceBlueprint(args.workspaceId, args.blueprintSlug)
      if (ws) {
        blueprint = {
          kind: 'skill',
          slug: args.blueprintSlug,
          body: ws.body,
          title: titleFor(args.blueprintSlug, args.subject, ws.title),
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
          title: titleFor(tmpl.id, args.subject, tmpl.name),
          spec: tmpl.extraction,
        }
      }
    }
    if (!blueprint) {
      console.warn(`[generate-synthesizer] blueprint not found: ${args.blueprintSlug}`)
      return null
    }

    // 2. The SOURCE is the brain: a `searchSource` tool pinned to this actor +
    //    clearance (the read ceiling cannot be widened by the loop context).
    const sourceTool = createBrainSourceTool({
      actor: {
        workspaceId: args.workspaceId,
        userId: args.userId,
        assistantId: args.assistantId,
        assistantKind: 'standard',
        clearance: clearanceOf(sensitivity),
        compartments: null,
      },
      storeDeps: deps.embedder ? { embedder: deps.embedder } : undefined,
    })

    // 3. Doc-write tools, pinned to the brief page at build time. `renderPage`
    //    is excluded — it mints a NEW draft, orphaning the page-first brief.
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

    // 4. Run. Page-first + idempotent on the (workspace, blueprint, subject)
    //    anchor — the same key a MAINTAIN schedule reuses to keep ONE page current.
    return synthesizeFromSource(
      {
        kind: 'brain',
        // No single provenance Episode for a brain draft; the subject is the
        // in-process correlation handle (channelId on the synthetic context).
        sourceId: args.subject,
        workspaceId: args.workspaceId,
        userId: args.userId,
        assistantId: args.assistantId,
        assistantKind: 'standard',
        sensitivity,
      },
      blueprint,
      {
        pageId: args.pageId ?? null,
        anchorKey: anchorKeyFor(args.workspaceId, blueprint.slug, args.subject),
        renderPage: args.renderPage ?? true,
        recordSubject: args.subject,
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
