/**
 * Pipeline B — Episode → derived rows (entities, edges, memories, summary)
 * + async sensitivity classification.
 *
 * Given an Episode envelope plus the resolved text content, runs a single
 * LLM extraction call that emits a typed JSON payload, writes the
 * resulting rows through injected store ports, updates the Episode's
 * summary text + status, and finally calls the Flash-class sensitivity
 * classifier as a non-blocking drift check.
 *
 * Key wirings (per ingest.md §"Engine and Pipeline B layering"):
 *   - Q24 (CRM routing) — person/company entities go through CrmStore
 *     (`createContact` / `createCompany`), NOT raw EntityStore.create.
 *     Post CRM→entity unification those wrappers write a single `entities`
 *     row (kind + typed fields in `attributes`) — there is no separate
 *     specialization row.
 *   - Tag stamping — model-emitted `tags` merge with engine-pre-stamped
 *     `episode.preStampedTags` and propagate to every written memory.
 *   - Q3 async sensitivity classifier — final step; flag-not-bump.
 *
 * Non-blocking discipline: any LLM error / parse failure logs to console
 * and short-circuits — the Episode is still archived (with empty summary)
 * and the function returns `extracted: false`. Pipeline B never throws on
 * provider issues.
 *
 * Pattern references:
 *   - ./sensitivity-classifier.ts (Flash-class JSON-only prompt, collectStream, fallback)
 *   - ../distribution/defense/classifier.ts (Zod safeParse + fence-strip)
 *
 * Spec: docs/plans/company-brain/ingest.md:321-345 (Pipeline B contract);
 *       docs/plans/company-brain/data-model.md §Entities, §Entity Links,
 *       "CRM as specialization of entities".
 *
 * [COMP:brain/pipeline-b]
 */

import { z } from 'zod'

import { sanitize, type AnalyticsLogger } from '../analytics/logger.js'
import { calculateCost, type UsageStore } from '../billing/cost-tracker.js'
import { estimateStringTokens } from '../compaction/index.js'
import { createClassificationAnalytics, type ClassificationAnalytics } from '../classification/analytics.js'
import type { CircuitBreaker } from '../classification/circuit-breaker.js'
import { validateEdgeKindTriple } from '../classification/rules/edge-type/index.js'
import { applySensitivityRules } from '../classification/rules/sensitivity/index.js'
import type { Classifier } from '../classification/types.js'
import type { CrmStore } from '../crm/types.js'
import {
  EDGE_TYPES,
  type EdgeType,
  type EntityKind,
  type EntityLinkRecord,
  type EntityLinksStore,
  type EntityRecord,
  type EntityStore,
} from '../entities/types.js'
import { resolveEntity } from '../entities/resolver.js'
import type { MemoryRecord, MemoryStore } from '../memory/types.js'
import type { TaskStore } from '../tasks/types.js'
import { collectStream } from '../providers/accumulator.js'
import type { LLMProvider, Message, TokenUsage } from '../providers/types.js'
import { RANK, type Sensitivity } from '../security/sensitivity.js'

import { scrubCredentials } from './credential-scrubber.js'
import {
  classifySensitivity,
  type SensitivityClassification,
} from './sensitivity-classifier.js'
import { SPOTLIGHT_RULE, spotlightContent } from './spotlight.js'
import type { PlatformEngagementMetrics, SourceKind } from './types.js'

// ── Public types ─────────────────────────────────────────────────────

/**
 * Episode shape Pipeline B reads. Structurally compatible with the
 * `EpisodeRecord` returned by `packages/api/src/db/episodes-store.ts` but
 * defined locally so core does not depend on the api package.
 *
 * `sensitivity` here is the 3-value core `Sensitivity` union. The
 * api-side store uses a 4-value `EpisodeSensitivity`
 * (`public`/`internal`/`private`/`secret`) — the coordinator that wires
 * Pipeline B normalises at the boundary.
 */
export type PipelineBEpisode = {
  id: string
  sourceKind: SourceKind
  occurredAt: Date
  sensitivity: Sensitivity
  workspaceId: string
  userId: string | null
  assistantId: string | null
  createdByUserId: string
  createdByAssistantId: string | null
  /** Tags pre-stamped by the ingest engine from rule metadata (e.g.
   *  `channel_match { #engineering }` → `'domain:engineering'`). Merged
   *  alongside model-emitted tags. */
  preStampedTags?: string[]
  /**
   * Structured metrics for a `platform_engagement_digest` Episode. When
   * `sourceKind === 'platform_engagement_digest'` and this is present,
   * Pipeline B takes the digest branch: it writes engagement-metric
   * memories + `platform_engagement_for` edges directly from the
   * structured payload and **skips the generic extraction LLM call**
   * (the digest is pre-structured — there is no prose to extract).
   * The api-side processor lifts it off the Episode's `content_ref`.
   * See data-model.md §"Notes on the platform_engagement_digest variant".
   */
  digest?: PlatformEngagementMetrics
  /**
   * Platform identities for people referenced in this episode, keyed by the
   * resolved display name the content uses. Source adapters that know the
   * platform user-id behind a mention (e.g. Slack — `<@U…>` resolved to a
   * name) populate this so the freshly-created `person` carries the id as a
   * contact `external_ref` (metadata) instead of surfacing it as the name.
   *
   * Matched case-insensitively against each extracted person's
   * `display_name`. Only stamped on FRESH contact creation — the dedup
   * paths in `writeEntity` return before `createContact`, so an already-known
   * person is never re-stamped (forward-only by construction).
   *
   * See docs/architecture/brain/ingest-pipeline.md → Source adapters →
   * Slack → "Mention resolution".
   */
  personExternalRefs?: Array<{ name: string; externalRef: Record<string, unknown> }>
}

/**
 * Narrow port over the episodes-store update surface. The coordinator
 * passes `createDbEpisodesStore()` from packages/api, which already
 * satisfies this shape.
 */
export type EpisodeUpdaterPort = {
  updateCheckpoint(
    actorUserId: string,
    id: string,
    patch: { at?: Date; summaryText?: string | null },
  ): Promise<unknown>
  updateStatus(
    actorUserId: string,
    id: string,
    next: 'open' | 'extracting' | 'archived',
    opts?: { stampCheckpoint?: boolean },
  ): Promise<unknown>
}

export type PipelineBDeps = {
  provider: LLMProvider
  /** Extraction model id (Standard tier per model-routing.md Trigger #11). */
  model: string
  crm: CrmStore
  entities: EntityStore
  entityLinks: EntityLinksStore
  memories: MemoryStore
  /**
   * v2 (brain_extraction_v2_enabled) — extraction emits `tasks[]` items
   * via this store. Optional so legacy v1 callers (and tests that don't
   * exercise tasks) keep working; when absent, task items in the LLM
   * output are silently dropped with a `console.warn`. New callers
   * should always wire it.
   */
  tasks?: TaskStore
  episodes: EpisodeUpdaterPort
  /** Optional Flash-class classifier model. Defaults to `deps.model` when
   *  omitted; pass `null` to disable the classifier step. */
  classifierModel?: string | null
  /** Wired into the sensitivity classifier for `sensitivity_drift_flagged`
   *  emission, and the entity-kind classifier for `classifier_applied`. */
  analytics?: AnalyticsLogger
  /**
   * Entity-kind classifier. When provided, the post-LLM hook runs
   * the classifier over each emitted entity:
   *   - deterministic rule fires → OVERRIDE the LLM's `kind` (PR 5+)
   *     (circuit-breaker-gated; suspended rules skip)
   *   - probabilistic rule fires → log `classifier_applied` hint, LLM stands
   *   - negative rule fires → log `classifier_blocked`, LLM stands
   *
   * See docs/architecture/brain/classification/README.md
   *   §Decision semantics per boundary
   */
  entityKindClassifier?: Classifier<EntityKind>
  /**
   * Circuit breaker for classifier deterministic overrides. When
   * provided, deterministic-tier overrides consult the breaker before
   * applying; suspended rules skip override (logged but not enforced).
   *
   * See docs/architecture/brain/classification/operational.md §O2
   */
  classifierCircuitBreaker?: CircuitBreaker
  /**
   * Q20 observation-side blocklist port (WU-4.4). When provided, returns
   * `true` if the given user is blocked for the given assistant. Episodes
   * whose `(assistantId, userId)` pair resolves to `true` are archived
   * without extraction — no entities, edges, or memories are written for
   * that assistant. Mirrors the invocation-side check in `chat.ts`.
   *
   * Optional for backwards compatibility — when absent, no observation
   * block applies (legacy behaviour). The api-side wiring should always
   * provide it.
   */
  isUserBlockedForAssistant?: (assistantId: string, userId: string) => Promise<boolean>
  /**
   * Optional 4-tier resolver tunables. When provided, `writeEntity`
   * falls through to a fuzzy/LLM pass against existing workspace
   * entities before creating a new row — catches alias variants that
   * exact + canonical_id + alias-index lookups miss.
   *
   *   - `fuzzyThreshold` (0–1, default 0.92): Jaro-Winkler cutoff.
   *     Tight by default to minimise false-positive merges.
   *   - `candidateLimit` (default 100): cap on candidates loaded per
   *     write — keeps the per-write cost bounded at workspace scale.
   *   - `llm`: when set, ambiguous fuzzy matches escalate to an LLM
   *     disambiguation call. Omit to disable write-time LLM cost
   *     (the heal-time alias clusterer covers semantic aliases at
   *     a controlled cadence).
   */
  entityResolver?: {
    fuzzyThreshold?: number
    candidateLimit?: number
    llm?: { provider: LLMProvider; model: string }
  }
  /**
   * Optional usage recorder for the extraction LLM call. When present,
   * the call is attributed as an `overhead:extraction` row (`triggerKey:
   * 'pipeline_b_extraction'`) — excluded from billing math but visible on
   * cost dashboards (cost-and-pricing.md → "Overhead accounting"). The
   * recording lives INSIDE `processEpisode`, next to the only place
   * extraction usage is produced, so no caller can ship an unmetered
   * ingest path. Best-effort: absent store / missing usage skip silently;
   * failures log and never break ingestion. OSS builds without a usage
   * store simply omit it.
   */
  usage?: UsageStore
  /**
   * Optional user-billed charge hook, invoked once per episode after a
   * SUCCESSFUL extraction (post summary+archive, step 7) — never on the
   * empty-summary failure paths. All charging policy lives behind the
   * hook: the platform's implementation classifies `episode.sourceKind`
   * (file/manual/bulk billable; conversational, connector-drip, and
   * recording-surcharge-covered kinds exempt) and debits the 0.5-credit
   * bulk-ingest item into its per-episode-idempotent ledger, so a
   * reprocessed episode can never double-charge (cost-and-pricing.md →
   * "Credit operation menu"). Same inside-processEpisode placement
   * rationale as `usage`: no caller can ship an uncharged ingest path.
   * Best-effort: failures log and never break ingestion. Absent in OSS.
   */
  ingestCharge?: (episode: PipelineBEpisode) => Promise<void>
}

export type PipelineBResult = {
  episodeId: string
  summaryText: string
  entitiesWritten: EntityRecord[]
  edgesWritten: EntityLinkRecord[]
  memoriesWritten: MemoryRecord[]
  /**
   * v2 — newly created task ids (one per `payload.tasks[]` item that
   * survived the write). Empty array when `deps.tasks` is not wired or
   * the LLM emitted no tasks.
   */
  tasksWritten: { id: string }[]
  /**
   * v2 — count of items the LLM routed into the `ephemeral` slot. Not
   * persisted (ephemeral is a "drop with reason" signal); surfaced here
   * for analytics / golden-set assertions.
   */
  ephemeralCount: number
  tags: string[]
  sensitivity: SensitivityClassification | null
  extractionUsage: TokenUsage | null
  /** True iff extraction LLM returned a parseable payload (even if all arrays were empty). */
  extracted: boolean
}

// ── Extraction-output schema (Zod safeParse target) ──────────────────

// Post-migration 162: `connection` retired; the extraction LLM emits
// only the three model-facing types. REM's own output (formerly
// `connection`) is a `context` memory carrying the `consolidation:rem`
// provenance tag, written by REM directly — not by extraction.
//
// Post-Phase-4 (retire-memory-type): MEMORY_TYPES retired; extraction
// schema doesn't carry a type field anymore.
// Model-facing scope vocabulary. Mirrors `packages/core/src/memory/tools.ts`
// chat-tool API (`'user' | 'team'`). Translated to DB vocabulary
// (`'shared' | 'workspace'`) at write time via `toDbScope` below — the
// DB's valid_scope CHECK accepts only `('shared', 'app', 'workspace')`
// per migration 110.
const MEMORY_SCOPES = ['user', 'team'] as const
type ModelMemoryScope = typeof MEMORY_SCOPES[number]

function toDbScope(modelScope: ModelMemoryScope): 'shared' | 'workspace' {
  return modelScope === 'team' ? 'workspace' : 'shared'
}
const EXTRACT_ENTITY_KINDS = ['person', 'company', 'project', 'product', 'repository'] as const

const EPHEMERAL_REASONS = [
  'operational-state',
  'relative-time-marker',
  'per-cycle-counter',
  'ack-or-confirmation',
  'duplicate',
  'other',
] as const

// JSON-mode null tolerance: with `responseFormat: 'json'` the model emits
// explicit `null` for empty optional slots (idiomatic JSON — and the prompt
// itself documents nullable fields like `canonical_id` / `due_iso`). Every
// optional below accepts `null` and canonicalizes it to `undefined` (or the
// slot's default), so ONE nulled optional can no longer fail the whole
// payload and archive the Episode empty. Caught by the golden set's first
// live run: `schema mismatch: Expected string, received null` ×6/18.
const emptyToUndef = <T>(v: T | null | undefined): T | undefined => v ?? undefined

const extractedEntitySchema = z.object({
  kind: z.enum(EXTRACT_ENTITY_KINDS),
  display_name: z.string().min(1).max(200),
  canonical_id: z.string().min(1).max(200).nullable().optional(),
  attributes: z.record(z.unknown()).nullish().transform(emptyToUndef),
})

const extractedEdgeSchema = z.object({
  source_ref: z.string().min(1),
  target_ref: z.string().min(1),
  edge_type: z.enum(EDGE_TYPES),
  attributes: z.record(z.unknown()).nullish().transform(emptyToUndef),
})

// v2 (brain_extraction_v2_enabled) — actionable items get their own slot
// so the LLM stops smuggling tasks into `memories`. Pipeline B writes
// extracted tasks via `TaskStore.create`.
const extractedTaskSchema = z.object({
  text: z.string().min(1).max(500),
  due_iso: z.string().nullable().optional(),
  // Reference to an entity display_name from this same extraction; the
  // emission loop resolves to a workspace_members.id where possible.
  assignee_ref: z.string().nullish().transform(emptyToUndef),
})

// ── Task-creation lane policy ─────────────────────────────────────────
//
// Some source kinds are RETROSPECTIVE records of work already completed
// (code history), not sources of new action items. Pipeline B still mines
// them for entities / edges / memories (knowledge), but must NOT mint tasks:
// a merged/pushed commit narrates work that is already DONE, so reifying its
// imperative-sounding text ("Fix X", "Add @Y", "Review PR #Z") into `todo`s
// is slop. On 2026-07-23 this produced 314 open todos in one workspace, 98%
// never closed, from push-to-`main` batches alone.
//
// `github_sync` = push-to-default-branch batches (ingest/adapters/github/
// envelope.ts `pickSourceKind`). Reconciling EXISTING tasks against a merge
// (`Closes #N` → done) and CREATING tasks from prospective events
// (`issue.opened`) are separate, forward-looking paths — see
// docs/plans/github-task-extraction-fix.md.
//
// Denylist, not allowlist: every other source (chat, slack, recording,
// whatsapp, connector_action, …) legitimately creates tasks, so the default
// is "creates tasks" and only retrospective kinds are gated out. Graded by
// `pnpm check` (`invariants/no-task-extraction-from-code-history`).
// Spec: docs/architecture/brain/ingest-pipeline.md → "Retrospective sources".
const RETROSPECTIVE_SOURCE_KINDS: ReadonlySet<SourceKind> = new Set<SourceKind>([
  'github_sync',
])

/** False for retrospective code-history sources that must not mint tasks. */
export function sourceKindCreatesTasks(sourceKind: SourceKind): boolean {
  return !RETROSPECTIVE_SOURCE_KINDS.has(sourceKind)
}

// v2 — explicit drop-with-reason slot. Persisted to analytics only
// (NOT written to `memories`), so the LLM has a non-empty target for
// status updates / ack noise / per-cycle counters that otherwise rot
// in the memory pile.
const extractedEphemeralSchema = z.object({
  text: z.string().min(1).max(500),
  reason: z.enum(EPHEMERAL_REASONS),
})

const extractedMemorySchema = z.object({
  // Post-Phase-4 (retire-memory-type): `type` removed from the
  // extraction schema. The LLM extraction prompt should encode any
  // categorical signal via `tags` instead.
  scope: z.enum(MEMORY_SCOPES).nullish().transform(emptyToUndef),
  summary: z.string().min(1).max(500),
  detail: z.string().max(2000).nullish().transform(emptyToUndef),
  tags: z.array(z.string().min(1).max(64)).max(20).nullish().transform(emptyToUndef),
  // v2 — REQUIRED justification fields. Every memory must explain why
  // it's not better expressed as an entity attribute or a task. Forces
  // the model to confront the alternative explicitly rather than
  // defaulting to memory when uncertain. Free text in v1; may be
  // constrained to an enum in v2 once we see what reasons the model
  // produces against the golden set.
  why_not_entity: z.string().min(1).max(200),
  why_not_task: z.string().min(1).max(200),
})

const extractionOutputSchema = z.object({
  summary: z.string().max(2000).nullish().transform((v) => v ?? ''),
  entities: z.array(extractedEntitySchema).max(50).nullish().transform((v) => v ?? []),
  edges: z.array(extractedEdgeSchema).max(100).nullish().transform((v) => v ?? []),
  tasks: z.array(extractedTaskSchema).max(30).nullish().transform((v) => v ?? []),
  memories: z.array(extractedMemorySchema).max(30).nullish().transform((v) => v ?? []),
  ephemeral: z.array(extractedEphemeralSchema).max(30).nullish().transform((v) => v ?? []),
  tags: z.array(z.string().min(1).max(64)).max(20).nullish().transform((v) => v ?? []),
})

type ExtractionOutput = z.infer<typeof extractionOutputSchema>

/**
 * The same contract as `extractionOutputSchema` above, expressed in Gemini's
 * OpenAPI-subset JSON Schema so the decoder is actually CONSTRAINED to it.
 *
 * `responseMimeType: 'application/json'` alone is only a hint — the decoder can
 * still emit unparseable output, and did: 56 failed extractions in three days,
 * each one an episode that stored nothing. A `responseSchema` is what engages
 * constrained decoding, which attacks that class at the source instead of
 * repairing it in `parseExtraction` afterwards.
 *
 * **Kept by hand, deliberately.** `zod` here is v3, which has no
 * `toJSONSchema()`, and a generic converter would emit constructs Gemini's
 * subset rejects (`$ref`, `oneOf`, `additionalProperties: false`) — turning a
 * quality optimisation into a 400 on every call. Hand-authoring keeps the
 * emitted shape exactly what the API accepts.
 *
 * **The cost is drift**: this must be updated whenever the Zod schema changes.
 * Drift is bounded rather than silent, because the Zod gate still runs on the
 * parsed result and remains authoritative — a schema that falls behind loosens
 * the decoder constraint, it cannot let a bad payload through. `[COMP:brain/pipeline-b]`
 * covers the shape agreement.
 *
 * Only the two justification fields are `required`: everything else is
 * nullish-with-default on the Zod side, and forcing the model to emit an empty
 * array for every unused slot wastes tokens on the common single-topic window.
 */
const EXTRACTION_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    entities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: [...EXTRACT_ENTITY_KINDS] },
          display_name: { type: 'string' },
          canonical_id: { type: 'string', nullable: true },
          // Open-ended bag: `z.record(z.unknown())`. Gemini's subset has no way
          // to say "any keys, any values", so it is declared as a plain object
          // and left unconstrained rather than forced into a false shape.
          attributes: { type: 'object' },
        },
        required: ['kind', 'display_name'],
      },
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          source_ref: { type: 'string' },
          target_ref: { type: 'string' },
          edge_type: { type: 'string', enum: [...EDGE_TYPES] },
          attributes: { type: 'object' },
        },
        required: ['source_ref', 'target_ref', 'edge_type'],
      },
    },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          due_iso: { type: 'string', nullable: true },
          assignee_ref: { type: 'string', nullable: true },
        },
        required: ['text'],
      },
    },
    memories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: [...MEMORY_SCOPES], nullable: true },
          summary: { type: 'string' },
          detail: { type: 'string', nullable: true },
          tags: { type: 'array', items: { type: 'string' } },
          why_not_entity: { type: 'string' },
          why_not_task: { type: 'string' },
        },
        required: ['summary', 'why_not_entity', 'why_not_task'],
      },
    },
    ephemeral: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          reason: { type: 'string', enum: [...EPHEMERAL_REASONS] },
        },
        required: ['text', 'reason'],
      },
    },
    tags: { type: 'array', items: { type: 'string' } },
  },
}
type ExtractedEntity = z.infer<typeof extractedEntitySchema>
type ExtractedEdge = z.infer<typeof extractedEdgeSchema>
type ExtractedMemory = z.infer<typeof extractedMemorySchema>
type ExtractedTask = z.infer<typeof extractedTaskSchema>

// Extraction content bound per CALL, in TOKENS — coupled to the 32k-token
// early flush in `appendBatchEvent` (the cap must stay ≥ the flush bound or a
// bounded window is silently truncated again at extraction). Denominated in
// tokens via the CJK-aware `estimateStringTokens`, NOT chars: the previous
// 128 KB char cap assumed ~4 chars/token, which CJK content breaks at ~1
// char/token — a 95-min Cantonese transcript sailed in at 62k tokens, double
// the design point (2026-07-15). Content over the bound is not clipped but
// WINDOWED (`splitContentByTokenLimit`): each window extracts independently
// and the merged payload flows through the unchanged write path, so long
// single-source content (a recording transcript) is still extracted whole.
// See docs/architecture/brain/ingest-pipeline.md → "Batch flush — cron
// backstop + size trigger" + "The batch processor".
export const EXTRACTION_TOKEN_LIMIT = 32_000

// Per-window char ceiling for the prompt builder — belt-and-braces only. A
// window at the token bound can reach this only in the all-ASCII worst case
// (4 chars/token), so the truncate inside `buildExtractionPrompt` no-ops on
// windowed content.
const CONTENT_CHAR_LIMIT = 128 * 1024

// Output cap per extraction call. gemini-3 thinks on every turn and thought
// tokens count against `maxOutputTokens` (providers/gemini.ts), so the old
// 4000 left the JSON payload competing with reasoning on dense windows —
// attempt outputs hit exactly the cap on 2026-07-15. 8192 covers a LOW-
// thinking pass plus a full payload at the 32k-token input design point;
// output tokens are billed as used, so the headroom costs nothing.
const EXTRACTION_MAX_OUTPUT_TOKENS = 8192

/**
 * Split content into windows of ≤ `limitTokens` (CJK-aware estimator),
 * breaking on line boundaries — ingest content (transcripts, chat windows,
 * digests) is line-oriented. A single line exceeding the whole bound (no
 * newlines) is hard-split by code points; a `limitTokens`-codepoint slice can
 * never exceed `limitTokens` tokens (worst case 1 token/char). Content under
 * the bound returns as a single window — the pre-windowing fast path.
 */
export function splitContentByTokenLimit(content: string, limitTokens: number): string[] {
  if (estimateStringTokens(content) <= limitTokens) return [content]
  const windows: string[] = []
  let current: string[] = []
  let currentTokens = 0
  const flush = () => {
    if (current.length > 0) {
      windows.push(current.join('\n'))
      current = []
      currentTokens = 0
    }
  }
  for (const rawLine of content.split('\n')) {
    let line = rawLine
    let lineTokens = estimateStringTokens(line)
    while (lineTokens > limitTokens) {
      flush()
      const points = [...line]
      windows.push(points.slice(0, limitTokens).join(''))
      line = points.slice(limitTokens).join('')
      lineTokens = estimateStringTokens(line)
    }
    if (currentTokens + lineTokens > limitTokens) flush()
    current.push(line)
    currentTokens += lineTokens + 1 // +1: the joining newline
  }
  flush()
  return windows
}

/**
 * Merge per-window extraction payloads into one payload for the write path.
 * Entities dedupe on (kind, display_name) first-wins — `writeEntity` resolves
 * against the store anyway, this only avoids double writes when the same
 * person spans windows. Edges dedupe on the full (source, type, target)
 * triple. Everything else concatenates (windows cover disjoint content);
 * tags union. Single-window input returns unchanged — the fast path is
 * byte-identical to the pre-windowing behavior.
 */
export function mergeExtractionOutputs(payloads: ExtractionOutput[]): ExtractionOutput {
  if (payloads.length === 1) return payloads[0]
  const entities: ExtractedEntity[] = []
  const seenEntities = new Set<string>()
  for (const p of payloads) {
    for (const e of p.entities) {
      const key = `${e.kind} ${e.display_name}`
      if (seenEntities.has(key)) continue
      seenEntities.add(key)
      entities.push(e)
    }
  }
  const edges: ExtractedEdge[] = []
  const seenEdges = new Set<string>()
  for (const p of payloads) {
    for (const e of p.edges) {
      const key = `${e.source_ref} ${e.edge_type} ${e.target_ref}`
      if (seenEdges.has(key)) continue
      seenEdges.add(key)
      edges.push(e)
    }
  }
  return {
    summary: payloads.map((p) => p.summary).filter((s) => s.length > 0).join('\n\n'),
    entities,
    edges,
    tasks: payloads.flatMap((p) => p.tasks),
    memories: payloads.flatMap((p) => p.memories),
    ephemeral: payloads.flatMap((p) => p.ephemeral),
    tags: [...new Set(payloads.flatMap((p) => p.tags))],
  }
}

const SYSTEM_PROMPT =
  'You are the extraction step of a knowledge-management pipeline. ' +
  'Output ONE JSON object and nothing else. No markdown fences. No commentary. ' +
  SPOTLIGHT_RULE

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n) + '…'
}

function buildExtractionPrompt(
  episode: PipelineBEpisode,
  content: string,
): string {
  const allowedEdges = EDGE_TYPES.join(' | ')
  const allowedEphemeralReasons = EPHEMERAL_REASONS.join(' | ')
  // The content is untrusted third-party text — spotlight it so an embedded
  // "ignore previous instructions" string lands as DATA, not a command. The
  // markers pair with SPOTLIGHT_RULE in SYSTEM_PROMPT. Spotlight the truncated
  // text (what actually reaches the model) so the collision-free nonce is
  // derived over the exact bytes present in the prompt.
  return `Source: ${episode.sourceKind}
Occurred at: ${episode.occurredAt.toISOString()}
Channel sensitivity: ${episode.sensitivity}

Content:
${spotlightContent(truncate(content, CONTENT_CHAR_LIMIT))}

You are extracting structured knowledge from this content. Memory is the LAST resort, not the default. Run every observation through the precedence ladder below and emit it at the FIRST tier that fits.

Precedence ladder (first-fit wins):
  1. Task — anything the user (or someone in their workspace) must DO. Examples: "Schedule X", "Reply to Y", "Follow up on Z by Friday". Emit into "tasks".
  2. Entity — a person, company, project, or product mentioned. Names a thing that may recur. Emit into "entities". If a relationship between two entities is asserted (e.g. "Alice works at Notion"), also emit into "edges".
  3. Memory — a durable fact about the user or their world that doesn't fit as an entity attribute or a task. Examples: "User prefers async over meetings", "Team uses Linear for tracking". Emit into "memories" WITH justification fields (see below).
  4. Ephemeral — content that has no durable value: status updates, relative-time markers, per-cycle counters, ack-only replies, duplicates of existing content. Emit into "ephemeral" with a reason. These are NOT persisted as memories.

Output JSON only, matching this exact shape:
{
  "summary": "<one-paragraph abstract of what happened; ≤500 chars>",
  "entities": [
    { "kind": "person" | "company" | "project" | "product" | "repository",
      "display_name": "...",
      "canonical_id": "<email | domain | url | null>",
      "attributes": {} }
  ],
  "edges": [
    { "source_ref": "<display_name from entities>",
      "target_ref": "<display_name from entities>",
      "edge_type": "<one of: ${allowedEdges}>",
      "attributes": {} }
  ],
  "tasks": [
    { "text": "<imperative action, e.g. 'Schedule Q3 sync with Alice'>",
      "due_iso": "<ISO date or null>",
      "assignee_ref": "<display_name from entities, or omit>" }
  ],
  "memories": [
    { "scope": "user" | "team",
      "summary": "...",
      "detail": "...",
      "tags": ["..."],
      "why_not_entity": "<one sentence: why this fact isn't better recorded as an attribute on an entity (e.g. 'no recurring subject', 'is about the user themself', 'subject already covered elsewhere')>",
      "why_not_task": "<one sentence: why this isn't an actionable item (e.g. 'descriptive only, no action', 'completed past action', 'is a preference, not a TODO')>" }
  ],
  "ephemeral": [
    { "text": "<verbatim content>",
      "reason": "<one of: ${allowedEphemeralReasons}>" }
  ],
  "tags": ["..."]
}

Negative examples — DO NOT emit these as memories:
  - "Waiting on Q2 feedback" → ephemeral (operational-state). Goes stale within days.
  - "2nd attempt to reach Alice" → ephemeral (per-cycle-counter). Increments next attempt.
  - "Meeting scheduled for tomorrow" → ephemeral (relative-time-marker) AND a task ("Attend meeting <date>") if it's actionable.
  - "Got it, thanks!" → ephemeral (ack-or-confirmation). No content.
  - "Alice is the CEO of Hinson HQ" → entities (Alice, Hinson HQ) + edge (works_at). Memory's why_not_entity test fails — this IS an entity attribute.
  - "Follow up with Bob next week" → tasks (text="Follow up with Bob", due_iso=<next week>). Memory's why_not_task test fails — this IS a TODO.

Rules:
- Persons: prefer email as canonical_id; else null.
- Companies: prefer registrable domain as canonical_id; else null.
- Repositories: use for code repositories (GitHub, GitLab, Bitbucket, internal git). display_name is the repo name (e.g. "belvedere" or "acme/widget"); prefer the canonical URL (e.g. "https://github.com/acme/widget") as canonical_id when available. Distinct from "project" — a repository is a versioned codebase, a project is a piece of work.
- Edge endpoints (source_ref / target_ref) MUST match an entity's display_name from this same payload.
- Tasks may reference an entity by display_name in assignee_ref; the writer will resolve it to a workspace member.
- Every memory MUST include both why_not_entity and why_not_task. If you cannot articulate why the content isn't an entity or a task, do not emit it as a memory — re-classify it.
- Empty result IS acceptable when there is nothing useful: {"summary":"","entities":[],"edges":[],"tasks":[],"memories":[],"ephemeral":[],"tags":[]}.`
}

// ── Parser ───────────────────────────────────────────────────────────

type ParseResult =
  | { ok: true; payload: ExtractionOutput }
  | { ok: false; reason: string }

/** JSON's named short escapes for the control characters that have one. */
const JSON_SHORT_ESCAPES: Record<string, string> = {
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
}

type BalancedScan = { ok: true; json: string } | { ok: false; reason: string }

/**
 * Walk from the first `{` to its MATCHING `}`, escaping raw ASCII control
 * characters found inside string literals along the way. One string-aware pass
 * doing two jobs the previous pair of regexes got wrong:
 *
 *  1. **Escape, don't exempt.** RFC 8259 forbids every unescaped U+0000-U+001F
 *     inside a string, and tab / newline / carriage-return are in that range —
 *     but the old `[\x00-\x08\x0B\x0C\x0E-\x1F]` strip skipped exactly those
 *     three, because they are legal *between* tokens. So the one sanitizer
 *     written to kill "Bad control character in string literal" could not kill
 *     its three most common causes: 41% of production extraction failures.
 *     Escaping rather than stripping is also non-lossy — the old strip welded
 *     words together ("hello\nworld" -> "helloworld"), and a newline inside a
 *     summary is content. Outside a string, whitespace is left untouched.
 *  2. **Balance, don't glob.** The old `/\{[\s\S]*\}/` was greedy: on output
 *     that stopped mid-object it clipped to the LAST `}` — an inner object's —
 *     producing a structurally impossible fragment and a misleading
 *     `Expected ',' or ']' after array element` when the truth was "the model
 *     stopped early". 19 of 20 such production errors reported the identical
 *     column, the fingerprint of end-of-input rather than of content. Scanning
 *     to the matching brace reports incompleteness honestly, and drops any
 *     trailing prose after the object as a bonus.
 *
 * Every window failing means the episode extracts NOTHING, so each of these is
 * silent data loss into the brain, not a degraded result.
 *
 * NOT caused by the 8192-token cap: failing calls used 194-2646 output tokens
 * and the `max_tokens` truncation branch has never fired. Raising the cap again
 * (the 2026-07-16 change took it 4000 -> 8192) would fix nothing.
 */
function scanBalancedJsonObject(text: string): BalancedScan {
  const start = text.indexOf('{')
  if (start === -1) return { ok: false, reason: 'no JSON object in model output' }

  let out = ''
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escaped) {
      out += ch
      escaped = false
      continue
    }
    if (inString) {
      if (ch === '\\') {
        out += ch
        escaped = true
        continue
      }
      if (ch === '"') {
        inString = false
        out += ch
        continue
      }
      const code = ch.charCodeAt(0)
      if (code < 0x20) {
        out += JSON_SHORT_ESCAPES[ch] ?? `\\u${code.toString(16).padStart(4, '0')}`
        continue
      }
      out += ch
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      out += ch
      if (depth === 0) return { ok: true, json: out }
      continue
    }
    out += ch
  }

  return {
    ok: false,
    reason: `incomplete JSON: model output ended mid-object with ${depth} unclosed brace${depth === 1 ? '' : 's'}${inString ? ' inside an unterminated string' : ''}`,
  }
}

function parseExtraction(rawText: string): ParseResult {
  const cleaned = rawText.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
  const scan = scanBalancedJsonObject(cleaned)
  if (!scan.ok) return { ok: false, reason: scan.reason }

  // Drop trailing commas (`,]` / `,}`) — a common LLM output tic that
  // `JSON.parse` rejects and that carries no semantics.
  const sanitized = scan.json.replace(/,(\s*[\]}])/g, '$1')

  let parsed: unknown
  try {
    parsed = JSON.parse(sanitized)
  } catch (err) {
    return { ok: false, reason: `JSON.parse failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  const result = extractionOutputSchema.safeParse(parsed)
  if (!result.success) {
    return { ok: false, reason: `schema mismatch: ${result.error.issues[0]?.message ?? 'unknown'}` }
  }
  return { ok: true, payload: result.data }
}

function emailShape(canonical: string | null | undefined): canonical is string {
  if (typeof canonical !== 'string') return false
  // Cheap shape check; the CRM layer does the strict validation.
  return canonical.includes('@') && canonical.includes('.')
}

/**
 * Merge freshly-extracted attributes onto an entity's existing
 * attribute map. Returns the merged object when it differs from
 * `existing` (so the caller should supersede), or `null` when the
 * extraction adds nothing — same keys, same values — so re-extraction
 * is a no-op.
 *
 * Merge semantics: shallow. A key present in `extracted` overwrites the
 * same key in `existing` (re-extraction reflects the latest state per
 * the bi-temporal "supersede prior fact" rule); keys only in `existing`
 * carry forward. Value equality is by `JSON.stringify` — adequate for
 * the JSON-scalar / array / nested-object shapes extraction emits.
 */
function mergeAttributes(
  existing: Record<string, unknown>,
  extracted: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!extracted || Object.keys(extracted).length === 0) return null

  const merged: Record<string, unknown> = { ...existing }
  let changed = false
  for (const [key, value] of Object.entries(extracted)) {
    const prev = merged[key]
    if (!(key in merged) || JSON.stringify(prev) !== JSON.stringify(value)) {
      merged[key] = value
      changed = true
    }
  }
  return changed ? merged : null
}

function dedupTags(...lists: (string[] | undefined)[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const list of lists) {
    if (!list) continue
    for (const t of list) {
      if (!seen.has(t)) {
        seen.add(t)
        out.push(t)
      }
    }
  }
  return out
}

/**
 * Attribute one extraction LLM call as an `overhead:extraction` usage row
 * (billing-math-excluded, dashboard-visible; `sessionId` null — ingest has
 * no chat session). Billing party is the episode's creating user; a blank
 * assistant rides the store's workspace-fallback attribution (the episode's
 * `workspaceId` resolves a representative assistant — connector-drip
 * episodes carry no assistant of their own). Best-effort by design: no
 * store / no usage / no resolvable user → skip; a store failure logs and
 * never breaks ingestion.
 */
async function recordExtractionUsage(
  deps: PipelineBDeps,
  episode: PipelineBEpisode,
  usage: TokenUsage | null,
  /**
   * Overrides for the non-extraction calls this ingest also makes. The
   * sensitivity classifier fires once per episode and was computing its usage,
   * returning it on `PipelineBResult.sensitivity.usage`, and finding no
   * consumer anywhere in the repo — 2,827 unrecorded LLM calls over 90 days,
   * roughly 59x the entire transcription bucket's row count. Cheap in dollars,
   * but an unmetered call path is how a ledger starts drifting from reality.
   *
   * `overhead:classifier` is deliberate: it is already in `OVERHEAD_SOURCES`
   * and the `valid_source` CHECK, so metering this needs no migration, and the
   * `trigger_key` keeps it separable from the routing classifiers.
   */
  over: { model?: string; source?: string; triggerKey?: string } = {},
): Promise<void> {
  if (!deps.usage || !usage) return
  const userId = episode.createdByUserId || episode.userId
  if (!userId) return
  try {
    await deps.usage.recordUsage({
      userId,
      assistantId: episode.assistantId ?? '',
      workspaceId: episode.workspaceId,
      sessionId: null,
      model: over.model ?? deps.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      actualCostUsd: calculateCost(over.model ?? deps.model, usage),
      source: over.source ?? 'overhead:extraction',
      triggerKey: over.triggerKey ?? 'pipeline_b_extraction',
      // The episode itself, NOT its parent. Rolling up to the originating
      // recording is `COALESCE(parent_episode_id, id)` at query time — cheap
      // at the current depth of 1, and it keeps which child drove the spend,
      // which a denormalized root would discard permanently.
      sourceEpisodeId: episode.id,
    })
  } catch (err) {
    console.warn(
      `[pipeline-b] extraction usage recording failed for episode ${episode.id}:`,
      err instanceof Error ? err.message : err,
    )
  }
}

/**
 * Attribute the 4-tier resolver's LLM disambiguation call (`writeEntity`
 * third pass, `resolver.ts` → `disambiguateWithLLM`) as ingest overhead.
 * This is a SECOND LLM call in the same Pipeline B flow as extraction —
 * same episode, same billing party — but a distinct purpose (entity
 * disambiguation), so it carries its own `triggerKey`
 * (`pipeline_b_entity_resolution`) for per-trigger rollups while sharing
 * the `overhead:extraction` billing bucket. It rides the extraction
 * source deliberately: `overhead:entity-resolution` is not yet in the
 * `usage_tracking.source` CHECK constraint (latest is migration 309), and
 * emitting an undeclared source would 23514-fail every LLM-tier resolve
 * silently — the exact failure class migration 305 closed. See
 * docs/architecture/brain/ingest-pipeline.md → "Resolver LLM metering"
 * for the punchlisted migration that would give it a dedicated source.
 *
 * Only the `llm` tier produces usage; exact/canonical/fuzzy tiers resolve
 * locally and carry none. Best-effort like `recordExtractionUsage`:
 * absent store / missing usage skip; a store failure logs and never
 * breaks ingestion.
 */
async function recordResolverUsage(
  deps: PipelineBDeps,
  episode: PipelineBEpisode,
  usage: TokenUsage | null | undefined,
  model: string | undefined,
): Promise<void> {
  if (!deps.usage || !usage) return
  const userId = episode.createdByUserId || episode.userId
  if (!userId) return
  const usageModel = model ?? deps.entityResolver?.llm?.model ?? deps.model
  try {
    await deps.usage.recordUsage({
      userId,
      assistantId: episode.assistantId ?? '',
      workspaceId: episode.workspaceId,
      sessionId: null,
      model: usageModel,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      actualCostUsd: calculateCost(usageModel, usage),
      source: 'overhead:extraction',
      triggerKey: 'pipeline_b_entity_resolution',
    })
  } catch (err) {
    console.warn(
      `[pipeline-b] resolver usage recording failed for episode ${episode.id}:`,
      err instanceof Error ? err.message : err,
    )
  }
}

// ── Main entrypoint ──────────────────────────────────────────────────

/**
 * Run extraction on an Episode, write derived rows, classify sensitivity.
 *
 * Caller responsibilities:
 *  - The Episode row already exists (engine adapter / chat compaction /
 *    active capture created it).
 *  - `resolvedContent` is the text the LLM extracts from. For inline
 *    `manual_paste` that's the inline body; for pointer-based refs the
 *    caller resolved the pointer (session messages, file text, etc.).
 *
 * On success: writes derived rows, sets Episode summaryText, transitions
 * Episode to `archived`.
 *
 * On LLM / parse failure: writes empty summary, still archives the
 * Episode, returns `extracted: false`. Does not throw.
 */
export async function processEpisode(
  episode: PipelineBEpisode,
  resolvedContent: string,
  deps: PipelineBDeps,
): Promise<PipelineBResult> {
  const actorUserId = episode.createdByUserId

  // 0. Q20 observation block (WU-4.4). When the episode is tied to both
  // an assistant and a user, and that user is in the assistant's
  // blocklist, archive without extraction. Mirrors the invocation block
  // in `chat.ts`. The episode itself is preserved (audit / replay), but
  // no entities/edges/memories are derived from it for this assistant.
  if (
    deps.isUserBlockedForAssistant &&
    episode.assistantId &&
    episode.userId
  ) {
    const blocked = await deps.isUserBlockedForAssistant(
      episode.assistantId,
      episode.userId,
    )
    if (blocked) {
      await archiveWithEmptySummary(episode, deps, actorUserId)
      return emptyResult(episode, null, false)
    }
  }

  // 0a. Source-kind branch — `platform_engagement_digest` is
  // pre-structured (data-model.md §"Notes on the
  // platform_engagement_digest variant"). The generic extraction LLM is
  // bypassed; engagement-metric memories + `platform_engagement_for`
  // edges are written directly from the structured payload.
  if (episode.sourceKind === 'platform_engagement_digest' && episode.digest) {
    return processEngagementDigest(episode, episode.digest, deps, actorUserId)
  }

  // 0b. Universal credential scrubbing (ingest.md §"Universal credential
  // scrubbing"). Operational secrets — private keys, prefixed API
  // tokens, JWT-shaped strings — are stripped from the content before it
  // reaches the extraction LLM. The unscrubbed text is discarded here:
  // downstream extraction never sees the original. Business PII is NOT
  // touched (P1-9 lock). Runs before sensitivity is assigned; it never
  // bumps a tier.
  const scrubbed = scrubCredentials(resolvedContent)
  const extractableContent = scrubbed.text

  // 1+2. Call extraction LLM and parse — windowed input, up to two attempts
  // per window.
  //
  // Input is bounded per CALL at EXTRACTION_TOKEN_LIMIT (CJK-aware);
  // oversized single-source content (a long recording transcript) is split
  // into windows, each extracted independently, and the merged payload flows
  // through the unchanged write path below.
  //
  // The stream call carries the decoder-level JSON constraint (Gemini
  // responseMimeType via `responseFormat: 'json'`), but the live golden-set
  // run (2026-07-07) showed the preview-tier model still intermittently
  // emits malformed or schema-mismatching output even with the hint. A parse
  // failure archives the Episode EMPTY — silent knowledge loss — so one
  // bounded retry with the validation error fed back recovers that tail. A
  // `max_tokens` finish is TRUNCATION, not malformed JSON: it gets its own
  // reason + a concision retry instead of the misleading validation message
  // (2026-07-15: a 62k-token transcript's output hit the cap twice and
  // archived empty). LLM *throws* (network/provider errors) keep single-shot
  // semantics: they have their own retry layers upstream. Every attempt's
  // spend is metered the moment usage is known; `extractionUsage` in the
  // result is the final attempt's usage (per-attempt metering is
  // authoritative for billing).
  let extractionUsage: TokenUsage | null = null
  const windows = splitContentByTokenLimit(extractableContent, EXTRACTION_TOKEN_LIMIT)
  const windowPayloads: ExtractionOutput[] = []
  for (let wi = 0; wi < windows.length; wi++) {
    const extractionMessages: Message[] = [
      { role: 'user', content: buildExtractionPrompt(episode, windows[wi]) },
    ]
    let windowPayload: ExtractionOutput | null = null
    for (let attempt = 1; attempt <= 2 && !windowPayload; attempt++) {
      let rawText = ''
      let truncated = false
      try {
        const response = await collectStream(
          deps.provider.stream({
            model: deps.model,
            systemPrompt: SYSTEM_PROMPT,
            messages: extractionMessages,
            maxTokens: EXTRACTION_MAX_OUTPUT_TOKENS,
            temperature: 0.1,
            responseFormat: 'json',
            // The actual decoder constraint (the mime type alone is only a
            // hint). Fail-open: a provider whose schema is rejected retries
            // without it, so this can degrade output quality but never fail
            // the call. See EXTRACTION_RESPONSE_SCHEMA.
            responseSchema: EXTRACTION_RESPONSE_SCHEMA,
            // Decoder-constrained JSON needs no reasoning summary; on
            // gemini-3 (which thinks on every turn) LOW keeps thought tokens
            // from eating the output cap. Models without an explicit
            // thinking level ignore it (resolveGeminiThinkingLevel).
            thinkingLevel: 'low',
          }),
        )
        extractionUsage = response.usage
        // Attribute the spend the moment usage is known — failed-parse
        // attempts still consumed these tokens.
        await recordExtractionUsage(deps, episode, response.usage)
        // `'incomplete'` counts as truncation: the stream ended without the
        // provider ever saying why, so the JSON may simply stop mid-object —
        // the same failure the cap produces, just unannounced. Classifying it
        // as truncation gets the concision retry instead of the misleading
        // "failed validation" message, which re-runs the same doomed shape.
        truncated = response.stopReason === 'max_tokens' || response.stopReason === 'incomplete'
        rawText = response.content
          .filter((b) => b.type === 'text')
          .map((b) => (b.type === 'text' ? b.text : ''))
          .join('')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[pipeline-b] extraction LLM failed for episode ${episode.id}: ${msg}`)
        emitExtractionLoss(deps, episode, {
          phase: 'llm_error',
          reason: msg,
          window: wi + 1,
          windowCount: windows.length,
        })
        await archiveWithEmptySummary(episode, deps, actorUserId)
        return emptyResult(episode, extractionUsage, false)
      }

      let reason: string
      if (truncated) {
        reason = `output truncated at the ${EXTRACTION_MAX_OUTPUT_TOKENS}-token cap`
      } else {
        const parseRes = parseExtraction(rawText)
        if (parseRes.ok) {
          windowPayload = parseRes.payload
          break
        }
        reason = parseRes.reason
      }
      console.warn(
        `[pipeline-b] extraction ${truncated ? 'truncated' : 'parse failed'} for episode ${episode.id} (window ${wi + 1}/${windows.length}, attempt ${attempt}/2): ${reason}`,
      )
      if (attempt === 1) {
        // No echo of the bad output — re-anchoring on garbage hurts more than
        // the reason string helps. Fresh sampling + the failure-specific
        // instruction is what recovers the intermittent failures.
        extractionMessages.push({
          role: 'user',
          content: truncated
            ? 'Your previous response was cut off at the output token limit. ' +
              'Respond again with ONLY the JSON object — include only the highest-salience items and keep every summary brief.'
            : `Your previous response failed validation: ${reason}. ` +
              'Respond again with ONLY the JSON object, exactly matching the requested shape. No commentary.',
        })
      } else {
        emitExtractionLoss(deps, episode, {
          phase: 'window_failed',
          reason,
          window: wi + 1,
          windowCount: windows.length,
        })
      }
    }
    if (windowPayload) windowPayloads.push(windowPayload)
  }
  if (windowPayloads.length === 0) {
    emitExtractionLoss(deps, episode, {
      phase: 'all_windows_failed',
      reason: `all ${windows.length} extraction window(s) failed`,
      window: 0,
      windowCount: windows.length,
    })
    await archiveWithEmptySummary(episode, deps, actorUserId)
    return emptyResult(episode, extractionUsage, false)
  }
  const payload = mergeExtractionOutputs(windowPayloads)

  // 3. Merge tags.
  const tags = dedupTags(episode.preStampedTags, payload.tags)

  // 4. Write entities (CRM-routed for person/company; EntityStore for others).
  //
  // Entity-kind classifier runs as post-LLM validation:
  //   - deterministic rule fires → OVERRIDE the LLM's `kind` (PR 5+)
  //   - probabilistic rule fires → log `classifier_applied` hint, LLM choice stands
  //   - negative rule fires → log `classifier_blocked`, LLM choice stands
  // Circuit breaker checked before deterministic override; suspended
  // rules skip override (logged as if probabilistic).
  // See classification/README.md §Decision semantics per boundary.
  const entitiesByRef = new Map<string, EntityRecord>()
  const entitiesWritten: EntityRecord[] = []
  const classificationAnalytics = createClassificationAnalytics(deps.analytics)
  for (const exRaw of payload.entities) {
    const ex = deps.entityKindClassifier
      ? await applyEntityKindClassification(
          deps.entityKindClassifier,
          deps.classifierCircuitBreaker,
          classificationAnalytics,
          exRaw,
          episode,
          actorUserId,
        )
      : exRaw
    try {
      const entity = await writeEntity(ex, episode, deps, actorUserId)
      if (entity) {
        entitiesByRef.set(ex.display_name, entity)
        entitiesWritten.push(entity)
      }
    } catch (err) {
      console.warn(
        `[pipeline-b] entity write failed for episode ${episode.id} (${ex.kind} "${ex.display_name}"): ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }

  // 5. Write edges — skip dangling refs (one endpoint missing in the entity map).
  // Edge-type classifier validates source.kind/target.kind/edge_type triple
  // before write — rejects incompatible combinations (e.g. works_at(company,company)).
  const edgesWritten: EntityLinkRecord[] = []
  for (const ex of payload.edges) {
    const source = entitiesByRef.get(ex.source_ref)
    const target = entitiesByRef.get(ex.target_ref)
    if (!source || !target) {
      console.warn(
        `[pipeline-b] skipping dangling edge for episode ${episode.id}: "${ex.source_ref}" -[${ex.edge_type}]-> "${ex.target_ref}"`,
      )
      continue
    }
    const validation = validateEdgeKindTriple(ex.edge_type as EdgeType, source.kind, target.kind)
    if (!validation.ok) {
      console.warn(
        `[pipeline-b] edge rejected by ${validation.rule_id} for episode ${episode.id}: ${source.kind} -[${ex.edge_type}]-> ${target.kind} (${validation.reason})`,
      )
      continue
    }
    try {
      const link = await deps.entityLinks.create({
        sourceKind: 'entity',
        sourceId: source.id,
        targetKind: 'entity',
        targetId: target.id,
        edgeType: ex.edge_type as EdgeType,
        attributes: ex.attributes ?? {},
        source: 'extracted',
        sensitivity: episode.sensitivity,
        workspaceId: episode.workspaceId,
        userId: episode.userId,
        assistantId: episode.assistantId,
        sourceEpisodeId: episode.id,
      })
      edgesWritten.push(link)
    } catch (err) {
      console.warn(
        `[pipeline-b] edge write failed for episode ${episode.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }

  // 5b. Write tasks — v2 precedence ladder emits actionable items here
  //     rather than smuggling them into `memories`. TaskStore.create
  //     uses `userId` as both the RLS actor and the authorship stamp,
  //     so we pass `episode.createdByUserId` (the resolved workspace
  //     actor). Assignee resolution (assignee_ref → workspace_members.id)
  //     is deferred to a follow-up; v1 lands tasks unassigned.
  const tasksWritten: { id: string }[] = []
  // Retrospective sources (code history) extract knowledge but never mint
  // tasks — see RETROSPECTIVE_SOURCE_KINDS. This is the enforcement point
  // graded by `invariants/no-task-extraction-from-code-history`.
  const createsTasks = sourceKindCreatesTasks(episode.sourceKind)
  if (deps.tasks && createsTasks) {
    for (const ex of payload.tasks) {
      try {
        let due: Date | null = null
        if (ex.due_iso) {
          const parsed = new Date(ex.due_iso)
          due = Number.isNaN(parsed.getTime()) ? null : parsed
        }
        const task = await deps.tasks.create({
          userId: episode.createdByUserId,
          workspaceId: episode.workspaceId,
          title: ex.text,
          due,
          // Extraction provenance — without these the task landed as
          // source='user' with no back-edge, indistinguishable from a
          // human-created row (2026-07-10 source audit).
          source: 'extracted',
          sourceEpisodeId: episode.id,
          createdByAssistantId: episode.createdByAssistantId,
        })
        tasksWritten.push({ id: task.id })
      } catch (err) {
        console.warn(
          `[pipeline-b] task write failed for episode ${episode.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }
  } else if (payload.tasks.length > 0) {
    console.warn(
      `[pipeline-b] ${payload.tasks.length} extracted task(s) dropped for episode ${episode.id} — ${
        !createsTasks
          ? `source_kind '${episode.sourceKind}' is retrospective (no task creation)`
          : 'deps.tasks not wired'
      }`,
    )
  }

  // 6. Write memories. MemoryStore.create requires both userId + assistantId;
  //    skip rows we cannot place.
  const memoriesWritten: MemoryRecord[] = []
  if (episode.userId && episode.assistantId) {
    for (const ex of payload.memories) {
      try {
        // Post-Phase-4 (retire-memory-type): no `type` field. The
        // extracted memory's classification (if any) rides on tags
        // — Pipeline B's extraction prompt should emit categorical
        // tags directly (e.g. 'commitment:open', 'note'). The legacy
        // `ex.type` field is dropped from MEMORY_TYPES on a separate
        // pass; for now we still receive it from the LLM but route
        // it into tags as a single-value bucket.
        const memory = await deps.memories.create({
          assistantId: episode.assistantId,
          userId: episode.userId,
          scope: toDbScope(ex.scope ?? 'user'),
          tags: dedupTags(tags, ex.tags),
          summary: ex.summary,
          detail: ex.detail,
          source: 'extracted',
          workspaceId: episode.workspaceId,
          sensitivity: episode.sensitivity,
          createdByUserId: episode.createdByUserId,
          createdByAssistantId: episode.createdByAssistantId,
          sourceEpisodeId: episode.id,
        })
        memoriesWritten.push(memory)
      } catch (err) {
        console.warn(
          `[pipeline-b] memory write failed for episode ${episode.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }
  }

  // 7. Update Episode: summary + archive.
  try {
    await deps.episodes.updateCheckpoint(actorUserId, episode.id, {
      summaryText: payload.summary,
    })
    await deps.episodes.updateStatus(actorUserId, episode.id, 'archived')
  } catch (err) {
    console.warn(
      `[pipeline-b] episode update failed for ${episode.id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }

  // 7b. Bulk-ingest surcharge — extraction succeeded, so the billable unit
  // exists. The hook's ledger is idempotent on episode id, so charging
  // after a (possibly retried) archive write cannot double-debit. The
  // empty-summary failure paths above never reach here: a failed run
  // charges nothing (the recording-surcharge precedent).
  if (deps.ingestCharge) {
    try {
      await deps.ingestCharge(episode)
    } catch (err) {
      console.warn(
        `[pipeline-b] ingest charge failed for episode ${episode.id}:`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  // 8. Final step — async sensitivity classifier (non-blocking, flag-not-bump).
  //    Skip when there is nothing to classify (empty summary + no memories).
  // PR 11 — deterministic rule pre-pass: if credential/secret patterns
  // are detected in the content, force `confidential` without an LLM call.
  let sensitivity: SensitivityClassification | null = null
  const classifierModel = deps.classifierModel === undefined ? deps.model : deps.classifierModel
  const hasContent = payload.summary.length > 0 || memoriesWritten.length > 0
  if (hasContent) {
    const ruleForced = applySensitivityRules(
      [payload.summary, ...memoriesWritten.map((m) => m.summary)].join('\n'),
    )
    if (ruleForced) {
      sensitivity = {
        inferredSensitivity: ruleForced,
        briefReason: 'classifier rule: credential / secret pattern detected',
        drifted: RANK[ruleForced] > RANK[episode.sensitivity],
        usage: null,
      }
    } else if (classifierModel) {
      sensitivity = await classifySensitivity({
        provider: deps.provider,
        model: classifierModel,
        analytics: deps.analytics,
        input: {
          episodeId: episode.id,
          workspaceId: episode.workspaceId,
          userId: actorUserId,
          assistantId: episode.assistantId,
          channelSensitivity: episode.sensitivity,
          summary: payload.summary,
          memories: memoriesWritten.map((m) => ({ summary: m.summary })),
        },
      })
      // Meter it. This call was invisible to the ledger until migration 365's
      // audit; it fires once per ingested episode, so it is the highest-count
      // LLM call in the system. Best-effort, exactly like extraction — a
      // metering failure must never break ingestion.
      // `classifySensitivity` returns NULL when it throws internally, so this
      // must be null-safe: metering is instrumentation and may never be the
      // thing that breaks an ingest. `recordExtractionUsage` already no-ops on
      // a null usage, so the guard only has to survive the property read.
      await recordExtractionUsage(deps, episode, sensitivity?.usage ?? null, {
        model: sensitivity?.model ?? classifierModel,
        source: 'overhead:classifier',
        triggerKey: 'sensitivity_classifier',
      })
    }
  }

  return {
    episodeId: episode.id,
    summaryText: payload.summary,
    entitiesWritten,
    edgesWritten,
    memoriesWritten,
    tasksWritten,
    ephemeralCount: payload.ephemeral.length,
    tags,
    sensitivity,
    extractionUsage,
    extracted: true,
  }
}

// ── platform_engagement_digest branch (WU-3.6) ───────────────────────

/**
 * One-line human-readable summary of a single post's engagement.
 * Used as the engagement-metric memory's `summary`.
 */
function describePostEngagement(
  platform: string,
  post: PlatformEngagementMetrics['per_post'][number],
): string {
  const parts: string[] = []
  if (post.likes !== undefined) parts.push(`${post.likes} likes`)
  if (post.replies !== undefined) parts.push(`${post.replies} replies`)
  if (post.views !== undefined) parts.push(`${post.views} views`)
  if (post.reposts !== undefined) parts.push(`${post.reposts} reposts`)
  if (post.follower_delta_attributed !== undefined) {
    parts.push(`${post.follower_delta_attributed >= 0 ? '+' : ''}${post.follower_delta_attributed} followers`)
  }
  const metrics = parts.length > 0 ? parts.join(', ') : 'no engagement recorded'
  return `${platform} post engagement: ${metrics}.`
}

/**
 * Digest-Episode processor. A `platform_engagement_digest` Episode
 * carries a pre-structured `metrics` payload — there is no prose, so the
 * generic extraction LLM is bypassed entirely.
 *
 * For each post in `metrics.per_post`, this writes one `connection`-type
 * engagement memory and a `platform_engagement_for` edge from that
 * memory to the post's Episode (`memory → episode`; the post Episode is
 * the link target per data-model.md §"Notes on the
 * platform_engagement_digest variant"). The digest Episode's own summary
 * captures the period aggregate.
 *
 * Non-blocking discipline matches the rest of Pipeline B: per-row write
 * failures log and skip; the Episode is still archived.
 */
async function processEngagementDigest(
  episode: PipelineBEpisode,
  metrics: PlatformEngagementMetrics,
  deps: PipelineBDeps,
  actorUserId: string,
): Promise<PipelineBResult> {
  // Platform label is informational only; the digest Episode's
  // `source_ref` carries the authoritative platform. Default keeps the
  // memory summary readable when the api-side caller omits it.
  const platformRaw = (episode as { platform?: unknown }).platform
  const platform = typeof platformRaw === 'string' ? platformRaw : 'platform'

  const tags = dedupTags(episode.preStampedTags, ['engagement', 'platform-digest'])

  const memoriesWritten: MemoryRecord[] = []
  const edgesWritten: EntityLinkRecord[] = []

  // Engagement memories require the visibility double — same constraint
  // as the generic memory-write path.
  if (episode.userId && episode.assistantId) {
    for (const post of metrics.per_post) {
      let memory: MemoryRecord
      try {
        memory = await deps.memories.create({
          assistantId: episode.assistantId,
          userId: episode.userId,
          // Per-post engagement observations are raw contextual data —
          // they enter REM's input set as legitimate signal. Post-
          // Phase-4 (retire-memory-type): no `type` field; the
          // engagement marker rides on tags ('platform-engagement'
          // included via the caller's `tags` param).
          scope: toDbScope('team'),
          tags,
          summary: describePostEngagement(platform, post),
          detail: JSON.stringify(post),
          source: 'extracted',
          workspaceId: episode.workspaceId,
          sensitivity: episode.sensitivity,
          createdByUserId: episode.createdByUserId,
          createdByAssistantId: episode.createdByAssistantId,
          sourceEpisodeId: episode.id,
        })
      } catch (err) {
        console.warn(
          `[pipeline-b] digest memory write failed for episode ${episode.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
        continue
      }
      memoriesWritten.push(memory)

      // Link the engagement memory to the post Episode it describes.
      try {
        const link = await deps.entityLinks.create({
          sourceKind: 'memory',
          sourceId: memory.id,
          targetKind: 'episode',
          targetId: post.post_episode_id,
          edgeType: 'platform_engagement_for',
          attributes: { ...post },
          source: 'extracted',
          sensitivity: episode.sensitivity,
          workspaceId: episode.workspaceId,
          userId: episode.userId,
          assistantId: episode.assistantId,
          sourceEpisodeId: episode.id,
        })
        edgesWritten.push(link)
      } catch (err) {
        console.warn(
          `[pipeline-b] digest edge write failed for episode ${episode.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }
  }

  // Digest Episode summary — the period aggregate, human-readable.
  const agg = metrics.aggregate
  const aggParts: string[] = []
  if (agg.total_engagement !== undefined) aggParts.push(`${agg.total_engagement} total engagement`)
  if (agg.follower_delta !== undefined) {
    aggParts.push(`${agg.follower_delta >= 0 ? '+' : ''}${agg.follower_delta} followers`)
  }
  const summaryText =
    `${platform} engagement digest — ${metrics.per_post.length} post(s)` +
    (aggParts.length > 0 ? `; ${aggParts.join(', ')}.` : '.')

  try {
    await deps.episodes.updateCheckpoint(actorUserId, episode.id, { summaryText })
    await deps.episodes.updateStatus(actorUserId, episode.id, 'archived')
  } catch (err) {
    console.warn(
      `[pipeline-b] digest episode update failed for ${episode.id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }

  return {
    episodeId: episode.id,
    summaryText,
    entitiesWritten: [],
    edgesWritten,
    memoriesWritten,
    tasksWritten: [],
    ephemeralCount: 0,
    tags,
    sensitivity: null,
    extractionUsage: null,
    extracted: true,
  }
}

// ── Alias learning helper ────────────────────────────────────────────

/**
 * Self-improving alias loop. When Pipeline B resolves an extracted
 * mention to an existing entity (canonical_id or name-pass), the
 * surface form the LLM emitted might differ from the entity's
 * `displayName` and from its known `aliases`. Record the new variant
 * so future extractions of the same form hit the cheap alias index
 * instead of paying another LLM round-trip / canonical_id lookup.
 *
 * Best-effort: any conflict (the variant is already bound to a
 * different entity) is logged but does not block the extraction —
 * heal-time `dedupeEntities` resolves cross-entity conflicts later.
 */
/**
 * Post-LLM entity-kind classification. Two tiers of behavior:
 *
 *   - deterministic rule fires → OVERRIDE the LLM's `kind` (and merge
 *     rule-derived attributes), gated by circuit breaker
 *   - probabilistic rule fires → log analytics hint; LLM choice stands
 *   - negative rule fires → log `classifier_blocked`; LLM stands
 *
 * Returns the (possibly overridden) `ExtractedEntity`. Fire-and-forget
 * on analytics — classifier failures must never break extraction.
 */
async function applyEntityKindClassification(
  classifier: Classifier<EntityKind>,
  breaker: CircuitBreaker | undefined,
  analytics: ClassificationAnalytics,
  ex: ExtractedEntity,
  episode: PipelineBEpisode,
  actorUserId: string,
): Promise<ExtractedEntity> {
  try {
    const candidate = {
      primary: ex.display_name,
      canonical_id: ex.canonical_id ?? null,
      attributes: ex.attributes,
      proposed: ex.kind,
    }
    const decision = classifier.decide(candidate, 'extraction')
    if (decision.kind === 'override') {
      // Deterministic override — check circuit breaker first.
      if (breaker && (await breaker.isTripped(episode.workspaceId, decision.match.rule_id))) {
        // Suspended rule — log as hint, do not override.
        analytics.applied(actorUserId, {
          primitive_kind: 'entity',
          rule_id: decision.match.rule_id,
          tier: 'probabilistic',  // forced hint due to suspension
          confidence: decision.match.confidence,
          before_value: ex.kind,
          after_value: decision.match.value,
          boundary: 'extraction',
        })
        return ex
      }
      if (decision.match.value !== ex.kind) {
        analytics.applied(actorUserId, {
          primitive_kind: 'entity',
          rule_id: decision.match.rule_id,
          tier: 'deterministic',
          confidence: decision.match.confidence,
          before_value: ex.kind,
          after_value: decision.match.value,
          boundary: 'extraction',
        })
      }
      // Record toward circuit-breaker count (does the override even if it trips —
      // this override is the last one before suspension).
      if (breaker) {
        await breaker.record(episode.workspaceId, decision.match.rule_id, 'extraction')
      }
      const mergedAttrs = decision.match.derived?.attributes
        ? { ...(ex.attributes ?? {}), ...decision.match.derived.attributes }
        : ex.attributes
      // Narrow to EXTRACT_ENTITY_KINDS — Zod accepts only this subset.
      // Deterministic rules currently produce kinds inside this subset;
      // unknown values fall through and don't override.
      const narrowed = EXTRACT_ENTITY_KINDS.includes(
        decision.match.value as typeof EXTRACT_ENTITY_KINDS[number],
      )
        ? (decision.match.value as typeof EXTRACT_ENTITY_KINDS[number])
        : ex.kind
      return {
        ...ex,
        kind: narrowed,
        attributes: mergedAttrs,
      }
    } else if (decision.kind === 'hint') {
      const top = decision.matches[0]
      if (top && top.value !== ex.kind) {
        analytics.applied(actorUserId, {
          primitive_kind: 'entity',
          rule_id: top.rule_id,
          tier: top.tier,
          confidence: top.confidence,
          before_value: ex.kind,
          after_value: top.value,
          boundary: 'extraction',
        })
      }
    } else if (decision.kind === 'blocked') {
      for (const block of decision.suppressedBy) {
        analytics.blocked(actorUserId, {
          rule_id: block.rule_id,
          primitive_kind: 'entity',
          blocked_value: ex.kind,
          source_kind: episode.sourceKind,
          boundary: 'extraction',
          reason: block.reason,
        })
      }
    }
  } catch (err) {
    // Classifier errors must never break extraction
    console.warn(
      `[pipeline-b] entity-kind classifier failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  return ex
}

async function learnAlias(
  deps: PipelineBDeps,
  actorUserId: string,
  entity: EntityRecord,
  emittedDisplayName: string,
): Promise<void> {
  const normalized = emittedDisplayName.trim().toLowerCase()
  if (normalized.length === 0) return
  if (normalized === entity.displayName.toLowerCase()) return
  if (entity.aliases.includes(normalized)) return
  try {
    await deps.entities.addAlias(actorUserId, entity.id, normalized)
  } catch (err) {
    console.warn(
      `[pipeline-b] alias learn failed for entity=${entity.id} alias='${normalized}': ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
}

// ── Entity write helper ──────────────────────────────────────────────

/**
 * Case-insensitive lookup of the platform external_ref a source adapter
 * resolved for an extracted person's display name. Returns `null` when the
 * episode carries no directory or no name matches — the person is then
 * written without an external_ref (name still correct).
 */
function matchPersonExternalRef(
  refs: PipelineBEpisode['personExternalRefs'],
  displayName: string,
): Record<string, unknown> | null {
  if (!refs || refs.length === 0) return null
  const target = displayName.trim().toLowerCase()
  for (const r of refs) {
    if (r.name.trim().toLowerCase() === target) return r.externalRef
  }
  return null
}

async function writeEntity(
  ex: ExtractedEntity,
  episode: PipelineBEpisode,
  deps: PipelineBDeps,
  actorUserId: string,
): Promise<EntityRecord | null> {
  // Dedup by canonical_id when present — skip recreating an existing entity.
  // Pipeline-B is a system worker (Privileged-service exception): it
  // must see entities across every viewer in the workspace so the
  // dedup is comprehensive. Use the `*System` variants instead of the
  // viewer-projected reads.
  if (ex.canonical_id) {
    const existing = await deps.entities.findByCanonicalIdSystem(
      actorUserId,
      episode.workspaceId,
      ex.canonical_id,
    )
    if (existing.length > 0) {
      // First match wins for identity. WU-3.6: when re-extraction
      // surfaces new/changed attributes, bi-temporally supersede the
      // prior row so the audit chain records the update
      // (ingest.md §"Re-checkpoint behavior" → "Fact updated → Bi-temporal
      // supersede"). When attributes are unchanged, return the live row
      // untouched — re-extraction of the same content is a no-op.
      const current = existing[0]
      // Alias learning: extraction emitted a display_name that resolves
      // to this entity by canonical_id, but the surface form differs
      // from `current.displayName` and isn't already a known alias.
      // Record it so future mentions hit the cheap name/alias index
      // instead of paying a canonical_id lookup. Best-effort — log
      // conflicts (the alias is claimed by a different entity) and
      // continue without blocking the extraction.
      await learnAlias(deps, actorUserId, current, ex.display_name)
      const merged = mergeAttributes(current.attributes, ex.attributes)
      if (merged === null) return current
      const superseded = await deps.entities.supersedeAttributes(
        actorUserId,
        current.id,
        {
          attributes: merged,
          // The new row points at the Episode that triggered the change.
          sourceEpisodeId: episode.id,
        },
      )
      // `supersedeAttributes` returns null only when the row is no longer
      // live (raced). Fall back to the row we already have.
      return superseded ?? current
    }
  }

  // Second-pass dedup by (kind, display_name) when canonical_id is
  // absent or didn't match. Without this, every re-extraction of an
  // entity that has no strong identity (project / product / repository,
  // or person/company that the model couldn't pin to an email/domain)
  // creates a fresh row — accumulating into the workspace as hundreds of
  // copies per logical entity. Same supersede-on-attribute-change path
  // as the canonical_id branch above; same `*System` lookup to bypass
  // per-viewer projection.
  const existingByName = await deps.entities.findByNameSystem(
    actorUserId,
    episode.workspaceId,
    ex.display_name,
    { kind: ex.kind },
  )
  if (existingByName) {
    // Alias learning (alias-path variant) — when findByNameSystem
    // resolved via an alias hit rather than a display_name match, the
    // extracted form is already a registered alias and there's nothing
    // new to learn. But if the extracted name matches a case variant
    // not yet captured, record it.
    await learnAlias(deps, actorUserId, existingByName, ex.display_name)
    const merged = mergeAttributes(existingByName.attributes, ex.attributes)
    if (merged === null) return existingByName
    const superseded = await deps.entities.supersedeAttributes(
      actorUserId,
      existingByName.id,
      {
        attributes: merged,
        sourceEpisodeId: episode.id,
      },
    )
    return superseded ?? existingByName
  }

  // Third-pass resolver — fuzzy (Jaro-Winkler) + optional LLM. Skipped
  // unless deps.entityResolver is wired; same-kind workspace candidates
  // are loaded under a cap so per-write cost stays bounded. Catches
  // alias variants that exact + canonical_id + alias-index lookups
  // miss (typos, casing+punctuation drift).
  if (deps.entityResolver) {
    const candidates = await deps.entities.listLiveEntitiesSystem(
      actorUserId,
      episode.workspaceId,
      { kind: ex.kind, limit: deps.entityResolver.candidateLimit ?? 100 },
    )
    if (candidates.length > 0) {
      const resolved = await resolveEntity({
        mention: {
          kind: ex.kind,
          display_name: ex.display_name,
          canonical_id: ex.canonical_id ?? null,
        },
        candidates: candidates.map((c) => ({
          id: c.id,
          kind: c.kind,
          display_name: c.displayName,
          canonical_id: c.canonicalId,
          attributes: c.attributes,
        })),
        fuzzyThreshold: deps.entityResolver.fuzzyThreshold ?? 0.92,
        llm: deps.entityResolver.llm,
      })
      // Meter the resolver's LLM disambiguation spend the moment it's
      // known — `usage`/`model` are only present on the `llm` tier (both
      // `resolved` and `ambiguous` variants carry them). Record before
      // branching so an ambiguous/no-match outcome is billed too.
      if ('usage' in resolved) {
        await recordResolverUsage(deps, episode, resolved.usage, resolved.model)
      }
      if (resolved.status === 'resolved'
        && (resolved.tier === 'fuzzy' || resolved.tier === 'llm')) {
        const match = candidates.find((c) => c.id === resolved.entityId)
        if (match) {
          await learnAlias(deps, actorUserId, match, ex.display_name)
          const merged = mergeAttributes(match.attributes, ex.attributes)
          if (merged === null) return match
          const superseded = await deps.entities.supersedeAttributes(
            actorUserId,
            match.id,
            { attributes: merged, sourceEpisodeId: episode.id },
          )
          return superseded ?? match
        }
      }
      // 'ambiguous' / 'no_match' / non-fuzzy-tier fall through to create.
    }
  }

  if (ex.kind === 'person') {
    const email = emailShape(ex.canonical_id) ? ex.canonical_id : null
    // Stamp the platform id (e.g. Slack user id) the source adapter resolved
    // for this name as the contact's external_ref — metadata, not the name.
    const externalRef = matchPersonExternalRef(episode.personExternalRefs, ex.display_name)
    await deps.crm.createContact({
      userId: actorUserId,
      workspaceId: episode.workspaceId,
      name: ex.display_name,
      email,
      ...(externalRef ? { externalRef } : {}),
      // Extraction provenance — previously omitted, so extracted contacts
      // landed source='user' with no back-edge (2026-07-10 source audit).
      // Fresh inserts only; the upsert/merge path keeps the existing row's.
      source: 'extracted',
      sourceEpisodeId: episode.id,
      createdByAssistantId: episode.createdByAssistantId,
    })
    // CRM wrapper writes a single `entities` row (kind='person', typed
    // fields in `attributes`; entity.canonical_id = email when present).
    // It returns the ContactRecord projection, so look up the entity row
    // here to give the edge loop an entity id.
    return resolveCrmEntity(deps, actorUserId, episode.workspaceId, ex.display_name, email, 'person')
  }

  if (ex.kind === 'company') {
    const domain = typeof ex.canonical_id === 'string' && !ex.canonical_id.includes('@')
      ? ex.canonical_id
      : null
    await deps.crm.createCompany({
      userId: actorUserId,
      workspaceId: episode.workspaceId,
      name: ex.display_name,
      domain,
      // Extraction provenance — see createContact above.
      source: 'extracted',
      sourceEpisodeId: episode.id,
      createdByAssistantId: episode.createdByAssistantId,
    })
    return resolveCrmEntity(deps, actorUserId, episode.workspaceId, ex.display_name, domain, 'company')
  }

  // kind === 'project' | 'product' | 'repository' — direct EntityStore write.
  return deps.entities.create({
    kind: ex.kind,
    displayName: ex.display_name,
    canonicalId: ex.canonical_id ?? null,
    attributes: ex.attributes ?? {},
    workspaceId: episode.workspaceId,
    userId: episode.userId,
    assistantId: episode.assistantId,
    createdByUserId: actorUserId,
    createdByAssistantId: episode.createdByAssistantId,
    sourceEpisodeId: episode.id,
    sensitivity: episode.sensitivity,
    source: 'extracted',
  })
}

/**
 * After a CRM `createContact` / `createCompany` call commits, it has
 * written a single `entities` row with `kind='person'|'company'`, typed
 * fields in `attributes`, and (when supplied) `canonical_id` = email |
 * domain. Pipeline B needs the resulting entity-row id for edge
 * construction, but the core `CrmStore` ports return the CRM record
 * projection (`ContactRecord` / `CompanyRecord`), not the `EntityRecord`.
 * Look it up here.
 *
 * Resolution order: by canonical id when present → by display name. Both
 * lookups are workspace-scoped; the entities store filters on RLS so
 * results are the just-created row in the common case.
 */
async function resolveCrmEntity(
  deps: PipelineBDeps,
  actorUserId: string,
  workspaceId: string,
  displayName: string,
  canonicalId: string | null,
  kind: 'person' | 'company',
): Promise<EntityRecord | null> {
  if (canonicalId) {
    const found = await deps.entities.findByCanonicalIdSystem(actorUserId, workspaceId, canonicalId)
    const match = found.find((e) => e.kind === kind)
    if (match) return match
  }
  return deps.entities.findByNameSystem(actorUserId, workspaceId, displayName, { kind })
}

// ── Failure-path helpers ─────────────────────────────────────────────

/**
 * Extraction ended in knowledge loss — surface it in `analytics_events`
 * (`ingest_extraction_error`). A console.warn on a worker instance nobody
 * tails is silent loss; analytics is the primary log (analytics.md). The
 * reason string is machine-generated (parse/validation/stop reasons), never
 * user content. Fire-and-forget: absent analytics dep → no-op.
 */
function emitExtractionLoss(
  deps: PipelineBDeps,
  episode: PipelineBEpisode,
  args: {
    phase: 'window_failed' | 'llm_error' | 'all_windows_failed'
    reason: string
    window: number
    windowCount: number
  },
): void {
  if (!deps.analytics) return
  const userId = episode.createdByUserId || episode.userId
  if (!userId) return
  deps.analytics.logEvent({
    userId,
    ...(episode.assistantId ? { assistantId: episode.assistantId } : {}),
    eventName: 'ingest_extraction_error',
    metadata: {
      episodeId: sanitize(episode.id),
      sourceKind: sanitize(episode.sourceKind),
      phase: sanitize(args.phase),
      reason: sanitize(args.reason.slice(0, 300)),
      window: args.window,
      windowCount: args.windowCount,
    },
  })
}

async function archiveWithEmptySummary(
  episode: PipelineBEpisode,
  deps: PipelineBDeps,
  actorUserId: string,
): Promise<void> {
  try {
    await deps.episodes.updateCheckpoint(actorUserId, episode.id, { summaryText: '' })
    await deps.episodes.updateStatus(actorUserId, episode.id, 'archived')
  } catch (err) {
    console.warn(
      `[pipeline-b] failed to archive episode ${episode.id} after extraction failure: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
}

function emptyResult(
  episode: PipelineBEpisode,
  extractionUsage: TokenUsage | null,
  extracted: boolean,
): PipelineBResult {
  return {
    episodeId: episode.id,
    summaryText: '',
    entitiesWritten: [],
    edgesWritten: [],
    memoriesWritten: [],
    tasksWritten: [],
    ephemeralCount: 0,
    tags: episode.preStampedTags ? [...episode.preStampedTags] : [],
    sensitivity: null,
    extractionUsage,
    extracted,
  }
}

// Re-exported so callers can reference the parsed-output shape (e.g. in
// fixture builders for tests).
export type { ExtractionOutput, ExtractedEntity, ExtractedEdge, ExtractedMemory }
