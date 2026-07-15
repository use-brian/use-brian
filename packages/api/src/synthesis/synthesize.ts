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
import { z } from 'zod'
import {
  buildTool,
  buildUndoEntry,
  blueprintRecordToBlocks,
  queryLoop,
  recordCompleteness,
  resolveResearchBudget,
  validateFieldValue,
  type AssistantKind,
  type Block,
  type BlueprintRecordFields,
  type DocPageStore,
  type ExtractionSpec,
  type LLMProvider,
  type Message,
  type Ops,
  type ResearchDepthConfig,
  type SavedViewStore,
  type TokenUsage,
  type Tool,
  type UsageStore,
} from '@sidanclaw/core'
import type { BlueprintRecord, BlueprintRecordStore } from '../db/blueprint-records-store.js'

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
  /**
   * The complete source text, injected into the prompt so the model drafts from
   * ALL of it rather than paging a search tool. For a `recording` this is the
   * whole `[H:MM:SS] Speaker: text` transcript. Set only when it fits the inject
   * budget (`recording-synthesizer` caps it); absent → fall back to the
   * search-tool sweep. A model told to "read end to end with a tool" SATISFICES —
   * it reads a few windows and drafts (2026-07-15: a 96-min meeting's brief
   * covered only the first ~23 min despite the sweep instruction). Handing it
   * the full text removes the discretion.
   */
  fullText?: string
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
  /**
   * The typed contract (document blueprints). Present + a record store wired ⇒
   * the fill runs RECORD-FIRST: `writeField` is the loop's sink, the record is
   * the artifact, and the page (when this surface renders one) is projected
   * from the record afterwards. Absent (skill-body blueprints) ⇒ the legacy
   * page-authoring flow, unchanged.
   */
  spec?: ExtractionSpec | null
}

export type SynthesisTarget = {
  /** An existing page to fill; else found-or-created by `anchorKey`. */
  pageId?: string | null
  /** Stable cross-run identity for idempotent find-or-create (saved_views.anchor_key). */
  anchorKey: string
  /**
   * Whether this surface renders the page projection (default true — recording
   * fills and the Generate UI keep their pages). False ⇒ record-only: no page
   * is created or written. Ignored on the legacy (spec-less) path, which is
   * page-authoring by definition.
   */
  renderPage?: boolean
  /** What the record is ABOUT (seeds `blueprint_records.subject`). Defaults to the blueprint title. */
  recordSubject?: string
}

export type SynthesisResult = {
  /** The brief page (null when this surface renders no page, or page creation failed). */
  pageId: string | null
  /** The blueprint record (null on the legacy spec-less path). */
  recordId: string | null
  /** Required-coverage outcome of the record (null on the legacy path). */
  recordStatus: 'complete' | 'incomplete' | null
  /** Required field keys the fill could not ground (empty on the legacy path). */
  missing: string[]
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
  /**
   * The record persistence (migration 307). Wired + a typed `spec` on the
   * blueprint ⇒ record-first fill. Absent ⇒ legacy page-authoring (kept so
   * tests / partial deploys degrade to the old behavior instead of failing).
   */
  blueprintRecordStore?: Pick<BlueprintRecordStore, 'ensure' | 'mergeFields' | 'finalize'>
  /**
   * Write the record's page projection (full-replace under CAS + undo).
   * Build with `createRecordPageProjector(docPageStore)`. Required for the
   * record path to render; absent ⇒ record-only even when `renderPage`.
   */
  projectRecordPage?: (params: { userId: string; pageId: string; blocks: Block[] }) => Promise<boolean>
  /** COGS metering (fire-and-forget); omit to skip. Only `recordUsage` is used. */
  usageStore?: Pick<UsageStore, 'recordUsage'>
  /** Cost-of-the-extra-pass calculator; omit → COGS rows record 0. */
  computeCostUsd?: (model: string, usage: TokenUsage) => number
  /** Loop budget; defaults to the synthesis fallback below. */
  budget?: ResearchDepthConfig
}

/** Enough turns/tool-calls for a multi-section brief over a long transcript. */
const SYNTHESIS_BUDGET_FALLBACK = { maxTurns: 30, maxToolCalls: 40, timeoutMs: 180_000 }
// A recording sweep is the expensive source: reading an hour-plus transcript
// end to end (the coverage discipline in `buildSystemPrompt`) costs one tool
// call per window plus the drafting turns, and the 3-minute default wall clock
// aborted mid-sweep — the brief then reflected only the opening minutes
// (2026-07-13, a 96-min meeting). Sized for ~500 segments at 40/window.
const RECORDING_SYNTHESIS_BUDGET = { maxTurns: 60, maxToolCalls: 80, timeoutMs: 900_000 }

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
  mode: { recordPath: boolean; renderPage: boolean },
): string {
  // Three sources, three gather + citation disciplines. The PROVENANCE handle
  // differs per kind, so the "where to cite" instruction tracks the source: a
  // recording cites `start_ms`, the brain cites the row it returned, a research
  // gather cites the source/URL the finding came from. A `start_ms` demand on a
  // brain draft (or a "brain row" demand on web findings) is nonsense.
  let gatherLine: string
  let citeLine: string
  if (source.kind === 'recording' && source.fullText) {
    // The COMPLETE transcript is in the prompt (see below) — no sweep needed,
    // and no satisficing possible. A model told to "read end to end with a
    // tool" reads a few windows and drafts (2026-07-15: a 96-min brief covered
    // only the first ~23 min despite the sweep instruction). Handing it the
    // whole text is what makes the brief cover the whole meeting.
    gatherLine = [
      `- The COMPLETE transcript of the recording is included above under "FULL TRANSCRIPT". Draft from ALL of it, start to finish.`,
      `- Cover the WHOLE recording proportionally: the final third as thoroughly as the opening. Before you finish, confirm your brief reflects content from near the LAST timestamp in the transcript — a brief that stops partway through the recording is a failed brief. Never paste the whole transcript into the page.`,
      `- Use \`${sourceToolName}\` only to re-check an exact quote or timestamp; you do not need it to discover content.`,
    ].join('\n')
    citeLine = [
      `- Cite the moment for every claim as the transcript's \`[H:MM:SS]\` timestamp (copy it from the line you drew the claim from). Minutes and seconds are always 00-59 — a citation like \`[00:85]\` is impossible and means you invented it.`,
      `- Never cite a moment not in the transcript; if a claim is not grounded in a line, leave it out.`,
    ].join('\n')
  } else if (source.kind === 'recording') {
    // No injected transcript (too large, or read failed) — fall back to the
    // search-tool sweep. Weaker: the model tends to stop paging early.
    gatherLine = [
      `- FIRST read the recording END TO END with \`${sourceToolName}\`, before drafting anything: page sequential windows (\`fromIndex\`/\`toIndex\`, e.g. 0-39, then 40-79, and so on) until a window comes back empty — that is how you learn the transcript's true length. Do NOT rely on \`query\` top-K search for coverage; use it only to re-find a specific moment afterwards.`,
      `- Draft from the WHOLE conversation, in the order it happened. Cover the later parts of the recording as thoroughly as the opening — a brief that only reflects the first few minutes is a failed brief. Never paste the whole transcript into the page.`,
    ].join('\n')
    citeLine = [
      `- Cite the moment for every claim, as a timestamp in \`[H:MM:SS]\` form converted from that segment's \`start_ms\` (e.g. \`start_ms: 2841000\` → \`[0:47:21]\`). Minutes and seconds are always 00-59 — a citation like \`[00:85]\` is impossible and means you invented it.`,
      `- Never cite a moment you did not read; if you cannot ground a claim in a segment, leave it out.`,
    ].join('\n')
  } else if (source.kind === 'brain') {
    gatherLine = `- Pull facts with \`${sourceToolName}\` — draft ONLY from what the brain returns; do not invent facts it does not hold.`
    citeLine = `- Ground every claim in a brain row \`${sourceToolName}\` returned; if the brain has nothing for a section, say so rather than guessing.`
  } else {
    // research — the gathered findings ARE the source, returned by the tool.
    gatherLine = `- Read the gathered research with \`${sourceToolName}\` — draft ONLY from those findings; do not add facts they do not contain.`
    citeLine = `- Cite the source each claim came from (the URL / source named in the findings); if the findings do not cover a section, say so rather than guessing.`
  }
  // When the full source text is injected, it leads the prompt so the model
  // sees the whole thing before the instructions (and blueprint) that act on it.
  const transcriptBlock =
    source.kind === 'recording' && source.fullText
      ? ['## FULL TRANSCRIPT', '', source.fullText, '', '---', '']
      : []

  if (mode.recordPath) {
    // Record-first: the typed record is the deliverable; the page (when this
    // surface renders one) is projected FROM the record after the loop, so the
    // model never authors a page here.
    return [
      ...transcriptBlock,
      blueprint.body,
      '',
      '---',
      '## How to run this synthesis',
      `The deliverable is the blueprint RECORD — its typed fields. Save each field with \`writeField\` (one call per field, exactly the keys the blueprint lists). A field the source cannot ground stays unwritten; never invent a value.`,
      mode.renderPage
        ? `- A readable page is generated from your saved fields automatically afterwards — do not try to author a page.`
        : `- No page is rendered for this run; the saved fields ARE the output.`,
      gatherLine,
      `- Write durable records with the save tools (company / contacts / deal / tasks) and inherit sensitivity \`${source.sensitivity}\` on every write.`,
      citeLine,
      `- Do not ask the user questions — this runs unattended. When the fields are saved and the records are written, reply with a one-line receipt and stop.`,
    ].join('\n')
  }
  return [
    ...transcriptBlock,
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

function kickoff(source: SynthesisSource, sourceToolName: string, recordPath: boolean): string {
  const noun =
    source.kind === 'recording'
      ? 'this recording'
      : source.kind === 'brain'
        ? 'this account'
        : 'the research findings'
  if (recordPath) {
    return `Fill the blueprint fields for ${noun} with \`writeField\`. Use \`${sourceToolName}\` to pull what you need.`
  }
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
  // The RECORD path: a typed contract + a record store ⇒ the record is the
  // artifact and `writeField` the sink; the page (when rendered) is projected
  // from the record after the loop. Without either, the legacy page-authoring
  // flow runs untouched (skill-body blueprints, older deploys, engine tests).
  const spec = blueprint.kind === 'document' ? (blueprint.spec ?? null) : null
  const recordStore = spec ? deps.blueprintRecordStore : undefined
  const recordPath = Boolean(spec && recordStore)
  const renderPage = !recordPath || target.renderPage !== false

  // 0. Record-first (record path): find-or-create the record on the SAME
  //    anchor the page uses, so even a no-op or timed-out run leaves a typed
  //    artifact and a re-fill converges on one row (fresh fills reset fields).
  let record: BlueprintRecord | null = null
  if (recordPath && spec && recordStore) {
    record = await recordStore.ensure(source.userId, {
      workspaceId: source.workspaceId,
      blueprintId: blueprint.kind === 'document' ? blueprint.slug : null,
      specSnapshot: spec.fields,
      subject: target.recordSubject ?? blueprint.title ?? titleFromSlug(blueprint.slug),
      anchorKey: target.anchorKey,
      sourceKind: source.kind,
      sourceId: source.sourceId,
      sensitivity: source.sensitivity,
      resetFields: true,
    })
  }

  // 1. Page-first + idempotent (skipped entirely on a record-only run): reuse
  //    an explicit pageId, else the anchor's existing page, else create one.
  //    The (workspace_id, anchor_key) partial unique index converges a
  //    concurrent race on 23505 → re-read the winner.
  let pageId = target.pageId ?? null
  if (renderPage) {
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
  } else {
    pageId = null
  }

  // 2. Tool map. Record path: `writeField` (the typed sink) ∪ brain-write ∪
  //    the source tool — NO free-form page writes. Legacy path: page-write
  //    (pinned to the brief page) ∪ brain-write ∪ source. Confirmations
  //    stripped — this is an unattended run.
  const written: Map<string, unknown> = new Map()
  const tools = new Map<string, Tool>()
  if (recordPath && spec && recordStore && record) {
    const writeField = buildWriteFieldTool(spec, record, recordStore, source.userId, written)
    tools.set(writeField.name, writeField)
  } else if (pageId) {
    for (const [name, t] of deps.buildDocTools(pageId)) tools.set(name, unattended(t))
  }
  for (const [name, t] of deps.brainWriteTools) tools.set(name, unattended(t))
  tools.set(deps.sourceTool.name, deps.sourceTool)

  // 3. Bounded server-side loop. The blueprint recipe IS the system prompt
  //    (executed, not nudged); on the legacy path the page is pinned via
  //    context.docViewId.
  const budget = resolveResearchBudget(
    deps.budget,
    source.kind === 'recording' ? RECORDING_SYNTHESIS_BUDGET : SYNTHESIS_BUDGET_FALLBACK,
  )
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
      systemPrompt: buildSystemPrompt(blueprint, source, deps.sourceTool.name, {
        recordPath,
        renderPage,
      }),
      messages: [
        { role: 'user', content: kickoff(source, deps.sourceTool.name, recordPath) },
      ] as Message[],
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
        docViewId: pageId ?? undefined, // pins patchPage / getCurrentPage / renderView (legacy path)
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
    // A wall-clock timeout surfaces as an AbortError; the record/page-first
    // artifact survives, so return it as a partial rather than throwing.
    if (abort.signal.aborted) {
      truncated = true
    } else {
      throw err
    }
  } finally {
    clearTimeout(timer)
  }

  // 4. Record path: finalize completeness, then project the page from the
  //    record (full-replace) when this surface renders. Projection failures
  //    degrade — the record is the artifact; the page is only its view.
  let recordStatus: 'complete' | 'incomplete' | null = null
  let missing: string[] = []
  if (recordPath && spec && recordStore && record) {
    const values: BlueprintRecordFields = Object.fromEntries(written)
    const completeness = recordCompleteness(spec.fields, values)
    recordStatus = completeness.status
    missing = completeness.missing
    if (renderPage && pageId && deps.projectRecordPage) {
      try {
        const blocks = blueprintRecordToBlocks(spec.fields, values, () => randomUUID())
        if (truncated) {
          blocks.push({
            kind: 'text',
            id: randomUUID(),
            variant: 'muted',
            text: 'This fill hit its budget before finishing; the record may be partial.',
          })
        }
        await deps.projectRecordPage({ userId: source.userId, pageId, blocks })
      } catch (err) {
        console.warn('[synthesis] page projection failed (record kept):', err)
      }
    }
    await recordStore.finalize(source.userId, record.id, {
      status: completeness.status,
      missing: completeness.missing,
      pageId,
    })
  }

  return {
    pageId,
    recordId: record?.id ?? null,
    recordStatus,
    missing,
    summary: summary.trim(),
    toolCallCount,
    truncated,
  }
}

/**
 * The typed sink of a record-first fill: validate one value against its
 * contract field, flush it onto the record (incremental — a timed-out run
 * keeps everything already written), and tell the model what required keys
 * remain. Keys outside the contract are rejected; the model physically cannot
 * widen the record.
 */
function buildWriteFieldTool(
  spec: ExtractionSpec,
  record: BlueprintRecord,
  store: Pick<BlueprintRecordStore, 'mergeFields'>,
  userId: string,
  written: Map<string, unknown>,
): Tool {
  const keyList = spec.fields
    .map((f) => `"${f.key}" (${f.type}${f.required ? ', required' : ''})`)
    .join(', ')
  return buildTool({
    name: 'writeField',
    description:
      `Save one blueprint field onto the record. Fields: ${keyList}. ` +
      'One call per field; re-calling a key overwrites it. Value shapes: markdown/string → text; number → number; date → "YYYY-MM-DD"; boolean → true/false; enum → one of the allowed options; entityRef → { "name": "...", "entityId"?: "..." }.',
    inputSchema: z.object({
      key: z.string().min(1).max(64).describe('The field key, exactly as the blueprint lists it.'),
      value: z.any().describe('The field value, shaped per the field type.'),
    }),
    isConcurrencySafe: false,
    async execute(input) {
      const needle = input.key.trim()
      const field =
        spec.fields.find((f) => f.key === needle) ??
        spec.fields.find((f) => f.key === needle.toLowerCase())
      if (!field) {
        return {
          data: { error: `No field "${input.key}". Valid keys: ${spec.fields.map((f) => f.key).join(', ')}` },
          isError: true,
        }
      }
      const validated = validateFieldValue(field, input.value)
      if (!validated.ok) {
        return { data: { error: validated.error }, isError: true }
      }
      written.set(field.key, validated.value)
      await store.mergeFields(userId, record.id, { [field.key]: validated.value })
      const remainingRequired = spec.fields
        .filter((f) => f.required && !written.has(f.key))
        .map((f) => f.key)
      return { data: { saved: field.key, remainingRequired } }
    },
  })
}

/**
 * Build the page projector a record-first fill uses: full-replace the page's
 * blocks with the record projection under the store's version CAS, storing a
 * real undo (the inverse ops restore the prior blocks). One retry on a version
 * race; a second conflict skips the projection — the record already holds the
 * data, and the next fill re-projects.
 */
export function createRecordPageProjector(
  docPageStore: Pick<DocPageStore, 'getVersionedPage' | 'applyPatch'>,
): (params: { userId: string; pageId: string; blocks: Block[] }) => Promise<boolean> {
  return async ({ userId, pageId, blocks }) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = await docPageStore.getVersionedPage(userId, pageId)
      if (!current) return false
      const forwardOps: Ops = [
        ...current.page.blocks.map((b) => ({ op: 'delete' as const, blockId: b.id })),
        // Anchor-less adds append in order — builds the projection top-to-bottom.
        ...blocks.map((b) => ({ op: 'add' as const, block: b })),
      ]
      const undo = buildUndoEntry(current.page, forwardOps, {}, current.version + 1)
      const applied = await docPageStore.applyPatch({
        userId,
        pageId,
        expectedVersion: current.version,
        nextPage: { blocks },
        undo,
      })
      if (applied) return true
    }
    console.warn('[synthesis] page projection skipped after version conflicts:', pageId)
    return false
  }
}
