// [COMP:api/synthesize] — the structural-synthesis engine runner.
//
// Takes a SOURCE (a recording transcript today; a research gather or the brain
// later) and a BLUEPRINT (the runnable spec — a skill body in v1, a fillable
// document in v2; a plain doc "template" is just a skeleton, a blueprint is a
// template that knows how to fill itself), runs a bounded server-side model
// loop, and produces a readable brief PAGE plus extracted brain rows, all with
// provenance. It is a thin SIBLING of the inter-assistant `queryLoop` driver
// (packages/api/src/inter-assistant/executor.ts), NOT an extension of it — the
// A2A executor's caller/callee identity, leaf invariant, deferred confirmations
// and fan-out do not apply to a source-driven run, and threading them through
// would fork every branch.
//
// Reuse, not reinvention: entity writes go through the core save* tools
// (`source='extracted'`), so they surface in Brain Reviews for free; the page is
// authored through the core doc tools, pinned via `context.docViewId`.
//
// Spec + locked invariants (page-first, additive-to-Pipeline-B, failure
// isolation, idempotent-by-anchorKey, sensitivity-inherited, COGS-as-overhead):
// docs/architecture/brain/structural-synthesis.md.

import { randomUUID } from 'node:crypto'
import {
  queryLoop,
  resolveResearchBudget,
  type AssistantKind,
  type LLMProvider,
  type Message,
  type ResearchDepthConfig,
  type SavedViewStore,
  type TokenUsage,
  type Tool,
  type UsageStore,
} from '@sidanclaw/core'

export type SynthesisSourceKind = 'recording' | 'brain' | 'research'

export type SynthesisSource = {
  kind: SynthesisSourceKind
  /**
   * The provenance handle: the recording id for `recording`; the draft subject
   * for `brain`; the originating workflow/step key for `research` (the gathered
   * findings are the source, surfaced by the source tool — there is no Episode).
   */
  sourceId: string
  workspaceId: string
  userId: string
  assistantId: string
  assistantKind: AssistantKind
  /** Sensitivity inherited from the source Episode; stamped on the page + every write. */
  sensitivity: string
}

export type SynthesisBlueprint = {
  /** v1 = a skill body. v2 adds 'document' (a blueprint authored in the editor);
   *  the engine consumes `body` + `title` either way. */
  kind: 'skill' | 'document'
  slug: string
  /** The resolved blueprint recipe — becomes the system prompt of the loop. */
  body: string
  /** Seed title for the brief page. */
  title?: string
}

export type SynthesisTarget = {
  /** An existing page to fill; else found-or-created by `anchorKey`. */
  pageId?: string | null
  /** Stable cross-run identity for idempotent find-or-create (saved_views.anchor_key). */
  anchorKey: string
}

export type SynthesisResult = {
  /** The brief page (null only if page creation itself failed). */
  pageId: string | null
  /** The model's closing plain-text receipt. */
  summary: string
  toolCallCount: number
  /** The loop hit its turn / wall-clock budget before finishing. */
  truncated: boolean
}

export type SynthesizeDeps = {
  provider: LLMProvider
  model: string
  /** The source-retrieval tool (searchRecording), pre-bound to the source + actor. */
  sourceTool: Tool
  /**
   * Build the page-write tools (patchPage / getCurrentPage / ...) PINNED to the
   * brief page. Called with the page id AFTER it's found-or-created (page-first),
   * because patchPage/getCurrentPage target the page via `DocToolDeps.anchorPageId`
   * (construction-time), not the call-time context.
   */
  buildDocTools: (anchorPageId: string) => Map<string, Tool>
  /** Brain-write tools (saveCompany / saveContact / saveDeal / saveTask). */
  brainWriteTools: Map<string, Tool>
  savedViewStore: Pick<SavedViewStore, 'createDraft' | 'findIdByAnchorKey'>
  /** COGS metering (fire-and-forget); omit to skip. Only `recordUsage` is used. */
  usageStore?: Pick<UsageStore, 'recordUsage'>
  /** Cost-of-the-extra-pass calculator; omit → COGS rows record 0. */
  computeCostUsd?: (model: string, usage: TokenUsage) => number
  /** Loop budget; defaults to the synthesis fallback below. */
  budget?: ResearchDepthConfig
}

/** Enough turns/tool-calls for a multi-section brief over a long transcript. */
const SYNTHESIS_BUDGET_FALLBACK = { maxTurns: 30, maxToolCalls: 40, timeoutMs: 180_000 }

function titleFromSlug(slug: string): string {
  return slug.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Strip confirmation from a tool for an unattended server run (non-mutating). */
function unattended(tool: Tool): Tool {
  return { ...tool, requiresConfirmation: false, resolveConfirmation: undefined }
}

function buildSystemPrompt(
  blueprint: SynthesisBlueprint,
  source: SynthesisSource,
  sourceToolName: string,
): string {
  // Three sources, three gather + citation disciplines. The PROVENANCE handle
  // differs per kind, so the "where to cite" instruction tracks the source: a
  // recording cites `start_ms`, the brain cites the row it returned, a research
  // gather cites the source/URL the finding came from. A `start_ms` demand on a
  // brain draft (or a "brain row" demand on web findings) is nonsense.
  let gatherLine: string
  let citeLine: string
  if (source.kind === 'recording') {
    gatherLine = `- Pull facts with \`${sourceToolName}\` (this recording only); never paste the whole transcript into the page.`
    citeLine = `- Cite the moment for every claim (the segment \`start_ms\`).`
  } else if (source.kind === 'brain') {
    gatherLine = `- Pull facts with \`${sourceToolName}\` — draft ONLY from what the brain returns; do not invent facts it does not hold.`
    citeLine = `- Ground every claim in a brain row \`${sourceToolName}\` returned; if the brain has nothing for a section, say so rather than guessing.`
  } else {
    // research — the gathered findings ARE the source, returned by the tool.
    gatherLine = `- Read the gathered research with \`${sourceToolName}\` — draft ONLY from those findings; do not add facts they do not contain.`
    citeLine = `- Cite the source each claim came from (the URL / source named in the findings); if the findings do not cover a section, say so rather than guessing.`
  }
  return [
    blueprint.body,
    '',
    '---',
    '## How to run this synthesis',
    `A brief page has already been created for you and is currently empty. Author it IN PLACE:`,
    `- Call \`getCurrentPage\` to see it, then \`patchPage\` to add the sections your instructions describe. Do NOT call \`renderPage\` — that mints a duplicate page.`,
    gatherLine,
    `- Write durable records with the save tools (company / contacts / deal / tasks) and inherit sensitivity \`${source.sensitivity}\` on every write.`,
    citeLine,
    `- Do not ask the user questions — this runs unattended. When the page is authored and the records are written, reply with a one-line receipt and stop.`,
  ].join('\n')
}

function kickoff(source: SynthesisSource, sourceToolName: string): string {
  const noun =
    source.kind === 'recording'
      ? 'this recording'
      : source.kind === 'brain'
        ? 'this account'
        : 'the research findings'
  return `Synthesize the brief for ${noun} into the page prepared for you. Use \`${sourceToolName}\` to pull what you need.`
}

function recordCogs(
  deps: SynthesizeDeps,
  source: SynthesisSource,
  usage: TokenUsage | null | undefined,
  model: string,
): void {
  if (!deps.usageStore || !usage) return
  deps.usageStore
    .recordUsage({
      userId: source.userId,
      assistantId: source.assistantId,
      // No real chat session — overhead COGS rows take NULL (migration 067). The
      // loop's synthetic context sessionId is for in-process correlation only.
      sessionId: null,
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      actualCostUsd: deps.computeCostUsd ? deps.computeCostUsd(model, usage) : 0,
      // `overhead:*` keeps this OUT of the user credit derivation; synthesis COGS
      // folds into the recording surcharge. See structural-synthesis.md.
      source: 'overhead:synthesis',
      triggerKey: 'structural_synthesis',
    })
    .catch((err) => console.error('[synthesis] usage tracking failed:', err))
}

/**
 * Fill a blueprint from a source into a brief page + brain rows.
 *
 * Page-first: the brief page is found-or-created on `target.anchorKey` BEFORE the
 * model runs, so even a no-op or timed-out run leaves a real artifact and a
 * re-run patches the same page (idempotent). A wall-clock timeout returns
 * `truncated: true` with the page so far. Callers (the recording ingest seam)
 * wrap this so a synthesis failure never blocks segments / entities / billing.
 */
export async function synthesizeFromSource(
  source: SynthesisSource,
  blueprint: SynthesisBlueprint,
  target: SynthesisTarget,
  deps: SynthesizeDeps,
): Promise<SynthesisResult> {
  // 1. Page-first + idempotent: reuse an explicit pageId, else the anchor's
  //    existing page, else create one. The (workspace_id, anchor_key) partial
  //    unique index converges a concurrent race on 23505 → re-read the winner.
  let pageId = target.pageId ?? null
  if (!pageId) {
    pageId = await deps.savedViewStore.findIdByAnchorKey(source.userId, source.workspaceId, target.anchorKey)
  }
  if (!pageId) {
    try {
      const draft = await deps.savedViewStore.createDraft({
        userId: source.userId,
        workspaceId: source.workspaceId,
        name: blueprint.title ?? titleFromSlug(blueprint.slug),
        nameOrigin: 'placeholder', // auto-title can refine from content later
        // `saved_views.entity` is a closed enum; a document page defaults the
        // legacy column to 'tasks' (the block content is authoritative).
        entity: 'tasks',
        viewType: 'table',
        binding: { entity: 'tasks', viewType: 'table' },
        page: { blocks: [] },
        anchorKey: target.anchorKey,
        originPrompt: `synthesis: ${blueprint.slug}`,
      })
      pageId = draft.id
    } catch (err) {
      pageId = await deps.savedViewStore.findIdByAnchorKey(source.userId, source.workspaceId, target.anchorKey)
      if (!pageId) throw err
    }
  }

  // 2. Tool map: page-write (pinned to the just-created brief page) ∪ brain-write
  //    ∪ the source tool. Confirmations stripped — this is an unattended run.
  const tools = new Map<string, Tool>()
  for (const [name, t] of deps.buildDocTools(pageId)) tools.set(name, unattended(t))
  for (const [name, t] of deps.brainWriteTools) tools.set(name, unattended(t))
  tools.set(deps.sourceTool.name, deps.sourceTool)

  // 3. Bounded server-side loop. The blueprint recipe IS the system prompt
  //    (executed, not nudged); the page is pinned via context.docViewId.
  const budget = resolveResearchBudget(deps.budget, SYNTHESIS_BUDGET_FALLBACK)
  const sessionId = randomUUID()
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), budget.timeoutMs)
  let truncated = false
  let summary = ''
  let toolCallCount = 0

  try {
    for await (const event of queryLoop({
      provider: deps.provider,
      model: deps.model,
      systemPrompt: buildSystemPrompt(blueprint, source, deps.sourceTool.name),
      messages: [{ role: 'user', content: kickoff(source, deps.sourceTool.name) }] as Message[],
      tools,
      context: {
        userId: source.userId,
        assistantId: source.assistantId,
        sessionId,
        appId: 'sidanclaw',
        channelType: 'synthesis',
        channelId: source.sourceId,
        workspaceId: source.workspaceId,
        assistantKind: source.assistantKind,
        docViewId: pageId, // pins patchPage / getCurrentPage / renderView to the brief page
        abortSignal: abort.signal,
        activeCapabilities: new Set(['crm', 'tasks']),
      },
      maxTurns: budget.maxTurns,
      maxToolCalls: budget.maxToolCalls,
    })) {
      if (event.type === 'text_delta') {
        summary += event.text
      } else if (event.type === 'tool_start') {
        toolCallCount += 1
      } else if (event.type === 'turn_complete') {
        recordCogs(deps, source, event.totalUsage, event.response.model)
      } else if (event.type === 'error') {
        throw event.error
      }
    }
  } catch (err) {
    // A wall-clock timeout surfaces as an AbortError; the page-first artifact
    // survives, so return it as a partial rather than throwing.
    if (abort.signal.aborted) {
      truncated = true
    } else {
      throw err
    }
  } finally {
    clearTimeout(timer)
  }

  return { pageId, summary: summary.trim(), toolCallCount, truncated }
}
