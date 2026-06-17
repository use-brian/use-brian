/**
 * Classification framework — type surface.
 *
 * Generic over the target enum (`T`) so the same shape covers entity-kind,
 * edge-type, sensitivity, memory-scope, and any future locked-vocabulary
 * classification problem.
 *
 * Spec: docs/architecture/brain/classification/README.md
 */

import type { EntityKind, EdgeType } from '../entities/types.js'
import type { SourceKind } from '../ingest/types.js'

// ── Boundary keys ────────────────────────────────────────────────────

export const CLASSIFIER_BOUNDARIES = [
  'connector',   // B1 — connector adapter at envelope time
  'tool',        // B2 — chat / CRM tool
  'inbox',       // B3 — brain inbox / web UI
  'extraction',  // B4 — Pipeline B extraction
  'self_heal',   // B5 — background reclassification worker
] as const
export type ClassifierBoundary = typeof CLASSIFIER_BOUNDARIES[number]

// ── Tier model ───────────────────────────────────────────────────────

export type ClassifierTier = 'deterministic' | 'probabilistic'

// ── Candidate input ──────────────────────────────────────────────────

/**
 * Inputs every classifier rule sees. Constructed by the caller at each
 * boundary; fields are optional because no single boundary populates
 * everything.
 *
 * - `primary` — the principal string the classifier reasons over.
 *   For entity-kind: the display_name or canonical_id.
 *   For edge-type: a description / phrasing.
 *   For sensitivity: empty (sensitivity reasons over episode content via
 *   `context`).
 *
 * - `canonical_id` — strong identity hint when present (URL, email, ID).
 * - `attributes` — already-known attribute bag.
 * - `source` — provenance signal: which connector / channel, who the actor was.
 * - `context` — surrounding text (episode content, chat snippet).
 * - `proposed` — what the caller is about to write before the classifier runs.
 *   Lets the classifier compare to the LLM's suggestion / UI form value.
 */
export type ClassifierCandidate = {
  primary: string
  canonical_id?: string | null
  attributes?: Record<string, unknown>
  source?: {
    kind: SourceKind | 'chat' | 'web_ui'
    connector_id?: string | null
    channel_id?: string | null
    actor_external_id?: string | null
  }
  context?: string
  proposed?: string
}

// ── Composition (derived writes) ─────────────────────────────────────

/**
 * Derived entity to write alongside the primary classification.
 * `ref` is a local name used by sibling edges to resolve the freshly-
 * written ID before the row exists.
 */
export type DerivedEntity = {
  ref: string
  kind: EntityKind
  display_name: string
  canonical_id?: string | null
  attributes?: Record<string, unknown>
}

export type DerivedEdge = {
  source_ref: string  // 'primary' OR a DerivedEntity.ref
  target_ref: string  // 'primary' OR a DerivedEntity.ref
  edge_type: EdgeType
  attributes?: Record<string, unknown>
}

// ── Match output ─────────────────────────────────────────────────────

export type ClassifierMatch<T extends string> = {
  rule_id: string
  value: T
  confidence: number
  tier: ClassifierTier
  derived?: {
    attributes?: Record<string, unknown>
    entities?: DerivedEntity[]
    edges?: DerivedEdge[]
  }
}

// ── Negative match ───────────────────────────────────────────────────

/**
 * Negative rules don't produce a value — they declare that one or more
 * values cannot result from this candidate, suppressing other rules
 * that would have produced them.
 */
export type ClassifierBlock<T extends string> = {
  rule_id: string
  blocked: T[]
  reason: string
}

// ── Rule shape ───────────────────────────────────────────────────────

export type ClassifierRule<T extends string> = {
  id: string
  produces: T
  tier: ClassifierTier
  confidence: number
  boundaries: ReadonlyArray<ClassifierBoundary>
  /** Tiebreaker on equal-confidence conflicts. Higher = more specific. Default 1. */
  specificity?: number
  /** Per-source restriction; if set, rule only fires when candidate.source.kind matches. */
  applicableSources?: ReadonlyArray<SourceKind | 'chat' | 'web_ui'>
  /** Cheap pre-check. Called for every candidate. Should be O(1). */
  applies(c: ClassifierCandidate): boolean
  /** Heavier evaluation; called only when `applies()` returns true. */
  evaluate(c: ClassifierCandidate): ClassifierMatch<T> | null
}

/**
 * Negative rule — declares "if I fire, suppress these values regardless
 * of other rules producing them." Wins over positive rules at the same
 * tier (deterministic negative suppresses both deterministic and
 * probabilistic positives; probabilistic negative suppresses only
 * probabilistic positives).
 */
export type ClassifierNegativeRule<T extends string> = {
  id: string
  blocks: T[]
  tier: ClassifierTier
  boundaries: ReadonlyArray<ClassifierBoundary>
  applicableSources?: ReadonlyArray<SourceKind | 'chat' | 'web_ui'>
  applies(c: ClassifierCandidate): boolean
  /** Reason string surfaced in `classifier_blocked` analytics. */
  reason: string
}

// ── Decision output ──────────────────────────────────────────────────

export type ClassifierDecision<T extends string> =
  | { kind: 'override'; match: ClassifierMatch<T>; suppressedBy?: never }
  | { kind: 'hint'; matches: ClassifierMatch<T>[]; suppressedBy?: ClassifierBlock<T>[] }
  | { kind: 'blocked'; suppressedBy: ClassifierBlock<T>[] }
  | { kind: 'no_signal' }

// ── Classifier surface ───────────────────────────────────────────────

export interface Classifier<T extends string> {
  /** Returns every match above the soft-cutoff threshold, sorted desc by confidence. */
  classify(c: ClassifierCandidate, boundary: ClassifierBoundary): ClassifierMatch<T>[]
  /** Resolves matches + negatives into a single decision per the escalation ladder. */
  decide(c: ClassifierCandidate, boundary: ClassifierBoundary): ClassifierDecision<T>
}

// ── Registry interface (impl in registry.ts) ─────────────────────────

export interface ClassifierRegistry<T extends string> extends Classifier<T> {
  /** Returns rule ids for diagnostics; not for runtime dispatch. */
  ruleIds(): string[]
}

// ── Tool-result protocol (B2 chat tool boundary, Decision 2) ─────────

/**
 * The contract chat/CRM tools return when a classifier rule blocks or
 * suggests at the tool boundary. Consumers (the LLM via the tool result
 * channel) react to `ok: false` per the system-prompt addendum.
 */
export type ClassifierToolResult<T extends string, TData> =
  | {
      ok: true
      data: TData
      suggestions?: ClassifierSuggestion<T>[]
    }
  | {
      ok: false
      reason: 'reclassified'
      blocking_rule_id: string
      explanation: string
      suggested_tool?: string
      suggested_kind?: T
    }

export type ClassifierSuggestion<T extends string> = {
  rule_id: string
  suggested_value: T
  confidence: number
  hint: string
}

// ── Soft thresholds ──────────────────────────────────────────────────

/**
 * Below this confidence, probabilistic matches are dropped from hint
 * inclusion. Not a hard rule; the framework defaults applied at decide
 * time. Per-classifier overrides supported via registry options.
 */
export const DEFAULT_HINT_FLOOR = 0.4
