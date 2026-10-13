/**
 * Resumable task execution: the pure decision core.
 *
 * The api layer persists execution state, pools and receipts
 * (`packages/api/src/db/task-execution-store.ts`); this module owns the
 * judgments that must stay identical everywhere and testable without a
 * database: readiness against the selected assistant's actual runtime
 * manifest, the per-iteration classification that replaces
 * "the workflow completed, so it progressed", the continuation limits, and the
 * allowance arithmetic of one shared pool segment.
 *
 * Spec: docs/architecture/features/goals.md -> "Resumable task execution".
 * [COMP:goals/execution-qualification] [COMP:goals/execution-checkpoint]
 * [COMP:goals/allowance-tree]
 */

export const EXECUTION_PHASES = ['planning', 'ready', 'running', 'waiting', 'paused', 'blocked', 'done', 'retired'] as const
export type ExecutionPhase = (typeof EXECUTION_PHASES)[number]
export type ExecutionLane = 'native' | 'external'

/** Consecutive iterations without new checked evidence before blocking. An
 *  engineering default, not a user business budget. */
export const EXECUTION_NO_PROGRESS_LIMIT = 3
/** Consecutive classified transient faults before blocking (matches the
 *  driver's existing `MAX_CONSECUTIVE_TICK_ERRORS`). */
export const EXECUTION_TRANSIENT_LIMIT = 5
/** Spend reserved for an iteration when the pool has no observed history. A
 *  bounded estimate, reconciled against the real ledger after the iteration. */
export const DEFAULT_ITERATION_SPEND_ESTIMATE = 0.05

// --- readiness ---------------------------------------------------------------

export const READINESS_REASON_KINDS = [
  'missing_operation',
  'missing_account',
  'missing_input',
  'insufficient_context',
  'inaccessible_source',
  'dependency_open',
  'executor_unavailable',
  'authority_unproven',
] as const
export type ReadinessReasonKind = (typeof READINESS_REASON_KINDS)[number]

export type ReadinessReason = {
  kind: ReadinessReasonKind
  /** The operation, account, input, source or dependency it concerns. */
  subject: string
  /** Human-readable next action ("connect the calendar account"). */
  detail?: string
}

export type ExecutionReadinessState = 'ready' | 'waiting' | 'uncertain' | 'unavailable'
export type ExecutionReadiness = { state: ExecutionReadinessState; reasons: ReadinessReason[] }

/** A source the plan is grounded in, with the version actually read. */
export type ExecutionSourceRef = {
  kind: 'task' | 'parent_task' | 'brief' | 'session' | 'page' | 'file' | 'memory' | 'entity'
  id: string
  version?: string | null
  label?: string
}

export type ExecutionDependency = {
  taskId: string
  /** Live status as read at planning time. `missing` = unreadable or gone. */
  status: 'open' | 'done' | 'cancelled' | 'missing'
  /** A human-owned prerequisite is tracked and waited on, never pursued. */
  owner: 'assistant' | 'person' | 'unassigned'
}

/** What the planner proposes; never trusted as proof of feasibility. */
export type ExecutionPlanDraft = {
  outcome: string
  constraints: string[]
  steps: { title: string; contribution: string; child?: boolean }[]
  /** Task-specific completion evidence ("a sent confirmation email id"). */
  completionEvidence: string[]
  requiredOperations: string[]
  requiredAccounts: string[]
  requiredInputs: { name: string; provided: boolean }[]
  /** Consequential questions the planner could not answer from sources. */
  questions: string[]
}

export type ExecutionPlan = ExecutionPlanDraft & {
  sourceBasis: ExecutionSourceRef[]
  dependencies: ExecutionDependency[]
  nextStep: string | null
  readiness: ExecutionReadiness
}

/** The selected assistant's ACTUAL runtime capability: the tool names that
 *  would be injected for it and the accounts connected for it. */
export type ExecutorManifest = {
  tools: ReadonlySet<string>
  accounts: ReadonlySet<string>
}

export type ReadinessInput = {
  plan: ExecutionPlanDraft
  manifest: ExecutorManifest | null
  /** Sources the planner wanted but the actor/assistant could not read. */
  inaccessibleSources: string[]
  dependencies: ExecutionDependency[]
  /** True when the original request had no substantive content to plan from. */
  contextSparse: boolean
}

/**
 * Readiness is computed, never asserted: each required operation must be a
 * tool name in the manifest and each account a connected account. A static
 * connector label or a confident plan cannot pass this check. Reasons stay
 * distinct so the surface can name the smallest missing thing.
 */
export function assessExecutionReadiness(input: ReadinessInput): ExecutionReadiness {
  const reasons: ReadinessReason[] = []
  if (!input.manifest) {
    return { state: 'unavailable', reasons: [{ kind: 'executor_unavailable', subject: 'executor' }] }
  }
  for (const op of unique(input.plan.requiredOperations)) {
    if (!input.manifest.tools.has(op)) reasons.push({ kind: 'missing_operation', subject: op })
  }
  for (const account of unique(input.plan.requiredAccounts)) {
    if (!input.manifest.accounts.has(account)) reasons.push({ kind: 'missing_account', subject: account })
  }
  for (const req of input.plan.requiredInputs) {
    if (!req.provided) reasons.push({ kind: 'missing_input', subject: req.name })
  }
  for (const q of input.plan.questions) reasons.push({ kind: 'missing_input', subject: q })
  for (const src of unique(input.inaccessibleSources)) reasons.push({ kind: 'inaccessible_source', subject: src })
  if (input.contextSparse && input.plan.questions.length === 0 && input.plan.requiredInputs.every(r => r.provided)) {
    // A name-only request must not become invented scope.
    reasons.push({ kind: 'insufficient_context', subject: 'request' })
  }
  if (input.plan.completionEvidence.length === 0) {
    reasons.push({ kind: 'insufficient_context', subject: 'completion_evidence' })
  }
  const blocking = reasons.length > 0
  const openDeps = input.dependencies.filter(d => d.status !== 'done')
  for (const dep of openDeps) reasons.push({ kind: 'dependency_open', subject: dep.taskId, detail: dep.status })
  if (blocking) {
    const unavailable = reasons.some(r => r.kind === 'missing_operation' || r.kind === 'missing_account')
    return { state: unavailable ? 'unavailable' : 'uncertain', reasons }
  }
  // A missing/cancelled prerequisite is never a satisfied one, but it is a
  // wait (or a question), not a missing capability.
  if (openDeps.length > 0) return { state: 'waiting', reasons }
  return { state: 'ready', reasons: [] }
}

// --- provenance ----------------------------------------------------------------

/** Trusted assignment provenance captured at an authenticated command boundary.
 *  Never derived from a task row's historical author. */
export type ExecutionProvenance = {
  kind: 'human_assignment'
  actorUserId: string
  origin: 'ui' | 'chat'
  at: string
}

export function isTrustedProvenance(value: unknown): value is ExecutionProvenance {
  if (!value || typeof value !== 'object') return false
  const p = value as Partial<ExecutionProvenance>
  return p.kind === 'human_assignment' && typeof p.actorUserId === 'string' && p.actorUserId.length > 0
    && (p.origin === 'ui' || p.origin === 'chat') && typeof p.at === 'string'
}

// --- checkpoint + classification ------------------------------------------------

export type ExecutionArtifact = { kind: string; ref: string; version?: string | null }
export type ExecutionEffect = { operation: string; ref: string; attemptId: string }

export type ExecutionCheckpoint = {
  /** Factual, attributable working summary. Never hidden reasoning. */
  summary: string
  sourceRefs: ExecutionSourceRef[]
  artifacts: ExecutionArtifact[]
  completedEffects: ExecutionEffect[]
  uncertainEffects: ExecutionEffect[]
  /** Results Brian checked itself (not claims). */
  checkedResults: string[]
  nextStep: string | null
  questions: string[]
  segment: number
  evidenceFingerprint: string
  /** Metered spend already settled for the in-flight workflow run, so a run
   *  advanced across several ticks is reconciled by delta, never twice. */
  runLedger?: { runId: string; accounted: number } | null
}

/** Stable fingerprint of the checked evidence a checkpoint carries. Cosmetic
 *  changes (summary wording, reordered lists) do not change it. */
export function evidenceFingerprint(cp: Pick<ExecutionCheckpoint, 'artifacts' | 'completedEffects' | 'checkedResults'>): string {
  const parts = [
    ...cp.artifacts.map(a => `a:${a.kind}:${a.ref}:${a.version ?? ''}`),
    ...cp.completedEffects.map(e => `e:${e.operation}:${e.ref}`),
    ...cp.checkedResults.map(r => `c:${r.trim().toLowerCase()}`),
  ]
  return unique(parts).sort().join('|')
}

export type IterationClassification = 'progress' | 'waiting' | 'blocker' | 'transient' | 'no_progress'

export type IterationSignals = {
  /** A known blocker the iteration reported (missing op/account/input, ...). */
  blocker?: ReadinessReason | null
  /** A real dependency or event park. */
  waiting?: boolean
  /** A classified retryable fault (provider 5xx, timeout). */
  transientFault?: boolean
  previousFingerprint: string
  fingerprint: string
}

/**
 * One iteration's honest classification. Progress requires NEW checked
 * evidence; a completed workflow run that produced nothing new is
 * `no_progress`, so a finished run cannot clear stall history.
 */
export function classifyIteration(s: IterationSignals): IterationClassification {
  if (s.blocker) return 'blocker'
  if (s.transientFault) return 'transient'
  if (s.fingerprint !== s.previousFingerprint && isSuperset(s.fingerprint, s.previousFingerprint)) return 'progress'
  if (s.waiting) return 'waiting'
  return 'no_progress'
}

export type ExecutionStreaks = { noProgress: number; transient: number }

export type ExecutionDecision =
  | { decision: 'continue'; resume: 'now' | 'backoff' | 'wait'; streaks: ExecutionStreaks }
  | { decision: 'blocked'; reason: string; streaks: ExecutionStreaks }

/** Map a classification onto streaks and a stop/continue verdict. Known
 *  blockers stop immediately rather than after futile retries. */
export function decideExecution(
  classification: IterationClassification,
  prior: ExecutionStreaks,
  limits: { noProgress?: number; transient?: number } = {},
  blocker?: ReadinessReason | null,
): ExecutionDecision {
  const noProgressLimit = limits.noProgress ?? EXECUTION_NO_PROGRESS_LIMIT
  const transientLimit = limits.transient ?? EXECUTION_TRANSIENT_LIMIT
  switch (classification) {
    case 'blocker':
      return { decision: 'blocked', reason: blocker ? `${blocker.kind}: ${blocker.subject}` : 'blocker', streaks: prior }
    case 'progress':
      return { decision: 'continue', resume: 'now', streaks: { noProgress: 0, transient: 0 } }
    case 'waiting':
      // A real wait neither burns a turn polling nor counts as a stall.
      return { decision: 'continue', resume: 'wait', streaks: { noProgress: prior.noProgress, transient: 0 } }
    case 'transient': {
      const streaks = { noProgress: prior.noProgress, transient: prior.transient + 1 }
      return streaks.transient >= transientLimit
        ? { decision: 'blocked', reason: 'transient_retries_exhausted', streaks }
        : { decision: 'continue', resume: 'backoff', streaks }
    }
    case 'no_progress': {
      const streaks = { noProgress: prior.noProgress + 1, transient: 0 }
      return streaks.noProgress >= noProgressLimit
        ? { decision: 'blocked', reason: 'no_progress', streaks }
        : { decision: 'continue', resume: 'backoff', streaks }
    }
  }
}

// --- allowance -------------------------------------------------------------------

export type PoolBounds = { maxSpend: number | null; maxIterations: number | null }
export type SegmentUsage = { spent: number; iterations: number; reservedSpend: number; reservedIterations: number }

export type ReservationVerdict =
  | { ok: true; spend: number; iterations: 1 }
  | { ok: false; reason: 'max_spend' | 'max_iterations' }

/**
 * Reserve one iteration against the ACTIVE segment. Outstanding reservations
 * count against headroom, so concurrent branches cannot each spend the full
 * remainder. The spend reserved is a bounded estimate capped by what is left.
 */
export function reserveIteration(bounds: PoolBounds, usage: SegmentUsage, estimate: number): ReservationVerdict {
  if (bounds.maxIterations !== null && usage.iterations + usage.reservedIterations + 1 > bounds.maxIterations) {
    return { ok: false, reason: 'max_iterations' }
  }
  if (bounds.maxSpend !== null) {
    const left = bounds.maxSpend - usage.spent - usage.reservedSpend
    if (left <= 0) return { ok: false, reason: 'max_spend' }
    return { ok: true, spend: round6(Math.min(Math.max(estimate, 0), left)), iterations: 1 }
  }
  return { ok: true, spend: round6(Math.max(estimate, 0)), iterations: 1 }
}

/** Mean observed spend per iteration across a pool's history, else the default. */
export function iterationSpendEstimate(lifetimeSpend: number, lifetimeIterations: number): number {
  if (lifetimeIterations <= 0 || lifetimeSpend <= 0) return DEFAULT_ITERATION_SPEND_ESTIMATE
  return round6(lifetimeSpend / lifetimeIterations)
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}

/** `next` adds evidence to `prev` without dropping any (a fingerprint shrinking
 *  is a replan that lost facts, not progress). */
function isSuperset(next: string, prev: string): boolean {
  if (!prev) return next.length > 0
  const have = new Set(next.split('|'))
  return prev.split('|').every(p => have.has(p))
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6
}
