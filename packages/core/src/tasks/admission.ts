/**
 * Task admission gate — the one place a conversational task write can be
 * refused.
 *
 * Spec: docs/architecture/features/task-guardrails.md
 *
 * Task extraction over-produces. The Pipeline B precedence ladder puts Task at
 * tier 1 with first-fit-wins, so any imperative-sounding line becomes a `todo`.
 * That is right for a genuine commitment and wrong for an aside, an instruction
 * aimed at the assistant, or the same request restated three messages later. On
 * 2026-07-27 one Slack conversation minted 20 tasks in five minutes, including
 * three near-copies of "revise the daily standup workflow".
 *
 * TWO CALL SITES, NO THIRD:
 *   - `saveTask` (tools.ts)      — lane 'assistant': chat, workflow steps,
 *                                  synthesis fills, brain-MCP
 *   - `processEpisode` (pipeline-b.ts) — lane 'extracted': every ingest source
 *
 * The GitHub deterministic lifecycle is deliberately exempt: it is already
 * idempotent on `external_ref` and creates only from structured `issue.opened`
 * events, so it has no slop channel to gate. `pnpm check`
 * (`invariants/task-admission-gate`) fails if either real site loses its call.
 *
 * PURE / IMPURE SPLIT. `evaluateTaskAdmission` is a pure function over
 * (candidate, rules, tombstone match, task match). Similarity search runs in
 * Postgres via pg_trgm because that is where the rows are — the port
 * (`TaskAdmissionPort`) hands the pure layer pre-scored matches. Core stays
 * DB-free and the decision table is unit-testable without a database.
 *
 * [COMP:tasks/admission]
 */

// ── Thresholds ───────────────────────────────────────────────────────────────

/**
 * Similarity thresholds, calibrated against the actual production duplicates in
 * workspace 3ccdb5fe rather than guessed:
 *
 *   'Integrate Shopify'             / 'integrate shopify'                 1.00  dup
 *   'Revise daily standup workflow' / 'Revise the daily standup workflow' 0.88  dup
 *   'Fix GitHub integration 401…'   / 'Resolve GitHub connector 401…'     0.67  dup
 *   'Start trial with Erwin (…)'    / 'Start trial with Ashley (…)'       0.59  NOT
 *
 * The 0.59/0.67 gap is too thin to separate with one threshold, which is why
 * everything between HOLD and DROP is held for review instead of dropped.
 *
 * TOMBSTONE_MATCH sits BELOW DUPLICATE_DROP on purpose: a tombstone is an
 * explicit human "no", so it earns a wider blast radius than an inferred
 * duplicate.
 */
export const TASK_ADMISSION_THRESHOLDS = {
  /** A live open task this similar is the same task restated. */
  DUPLICATE_DROP: 0.88,
  /** Similar enough to be worth a human glance, not enough to act on. */
  NEAR_DUPLICATE_HOLD: 0.65,
  /** A previously rejected title this similar is the same rejection. */
  TOMBSTONE_MATCH: 0.72,
} as const

/** Held suggestions expire; otherwise the tray becomes the new task list. */
export const HELD_CANDIDATE_TTL_DAYS = 14
/** Dropped rows are kept only long enough to answer "why wasn't this a task?". */
export const DROPPED_CANDIDATE_TTL_DAYS = 90
/** Tombstones needed before a standing rule is even proposed. */
export const PROPOSAL_THRESHOLD = 3
/** Tombstones this similar to each other are the same rejection class. */
export const PROPOSAL_CLUSTER_MATCH = 0.5

// ── Types ────────────────────────────────────────────────────────────────────

/** Which write path produced the candidate. */
export type TaskLane = 'extracted' | 'assistant'

export type TaskRuleEffect = 'deny' | 'require'
export type TaskRuleStatus = 'active' | 'proposed' | 'disabled'
export type TaskRuleRequirement = 'assignee' | 'due'

/**
 * What a rule can test. Conditions AND together; a list within one condition
 * ORs. An absent condition means "don't care".
 *
 * Anything NOT expressible here ("only things I actually committed to") is
 * enforced upstream by injecting the rule's `nl_clause` into the extraction
 * prompt, where an LLM call is already being paid for. That split is
 * deliberate: this shape covers the rules people actually write, and pretending
 * a predicate can capture intent would make the guarantee dishonest.
 */
export type TaskRulePredicate = {
  source_kinds?: string[]
  lanes?: TaskLane[]
  /** Case-insensitive substring, tested against the NORMALIZED title. */
  title_matches?: string[]
  channel_refs?: string[]
  /** `effect: 'require'` only. */
  require?: TaskRuleRequirement[]
}

export type TaskRuleRecord = {
  id: string
  workspaceId: string
  status: TaskRuleStatus
  effect: TaskRuleEffect
  predicate: TaskRulePredicate
  nlClause: string | null
  reason: string | null
  origin: 'user' | 'proposed'
  createdAt: Date
}

export type TaskTombstoneRecord = {
  id: string
  workspaceId: string
  title: string
  titleNorm: string
  reason: string
  sourceKind: string | null
  lane: TaskLane | null
  createdAt: Date
}

/** A tombstone paired with its measured similarity to the candidate. */
export type ScoredTombstone = { tombstone: TaskTombstoneRecord; similarity: number }

/** A live open task paired with its measured similarity to the candidate. */
export type ScoredTask = { id: string; title: string; similarity: number }

export type TaskAdmissionCandidate = {
  workspaceId: string
  title: string
  due?: Date | null
  assigneeId?: string | null
  lane: TaskLane
  /** Episode source kind (`slack_thread`, `web_chat`, …); null on the chat lane. */
  sourceKind?: string | null
  /** Slack channel id / connector ref, for `channel_refs` predicates. */
  channelRef?: string | null
  sourceEpisodeId?: string | null
  createdByAssistantId?: string | null
}

export type TaskAdmissionReasonCode =
  | 'tombstoned'
  | 'rule'
  | 'rule_requires'
  | 'duplicate'
  | 'near_duplicate'

export type TaskAdmissionDecision =
  | { outcome: 'allow'; warning?: TaskAdmissionWarning }
  | {
      outcome: 'hold' | 'drop'
      reasonCode: TaskAdmissionReasonCode
      /** Human-readable, written for relay to the user by the model. */
      explanation: string
      matchedTaskId?: string
      matchedRuleId?: string
      matchedTombstoneId?: string
      similarity?: number
    }

/**
 * A `hold` that the assistant lane converts to an allow — the user asked
 * directly, so a review tray would be a non-answer, but they should still be
 * told a similar task exists.
 */
export type TaskAdmissionWarning = {
  reasonCode: TaskAdmissionReasonCode
  explanation: string
  matchedTaskId?: string
  similarity?: number
}

/** DB-backed lookups the pure decision needs. Implemented by the API layer. */
export type TaskAdmissionPort = {
  listActiveRules(workspaceId: string): Promise<TaskRuleRecord[]>
  /** Tombstones scored against `titleNorm`, above `minSimilarity`, best first. */
  findSimilarTombstones(
    workspaceId: string,
    titleNorm: string,
    minSimilarity: number,
  ): Promise<ScoredTombstone[]>
  /**
   * Live OPEN tasks scored against `titleNorm`, above `minSimilarity`, best
   * first. "Open" excludes `done` / `archived`: re-raising work that finished
   * last month is legitimate, and blocking it would be the guardrail inventing
   * policy the user never stated.
   */
  findSimilarTasks(
    workspaceId: string,
    titleNorm: string,
    minSimilarity: number,
  ): Promise<ScoredTask[]>
  /** Persist a held suggestion / dropped audit row. Never throws into the caller. */
  recordCandidate(input: RecordCandidateInput): Promise<void>
  /**
   * Active rules + recent tombstones for the extraction-prompt policy block.
   * Optional: only the ingest lane needs it, and only when the workspace has
   * stated a policy. Absent → the prompt is byte-identical to today.
   */
  loadPolicyForPrompt?(
    workspaceId: string,
  ): Promise<{ rules: TaskRuleRecord[]; tombstones: TaskTombstoneRecord[] }>
}

export type RecordCandidateInput = {
  workspaceId: string
  title: string
  due: Date | null
  lane: TaskLane
  sourceKind: string | null
  sourceEpisodeId: string | null
  createdByAssistantId: string | null
  status: 'pending' | 'dropped'
  reasonCode: TaskAdmissionReasonCode
  matchedTaskId?: string | null
  matchedRuleId?: string | null
  matchedTombstoneId?: string | null
  similarity?: number | null
  expiresAt: Date
}

// ── Title normalization ──────────────────────────────────────────────────────

/**
 * Fold a title to the form similarity runs against.
 *
 * Lowercase, strip punctuation, collapse whitespace. Leading verbs are KEPT —
 * "revise the standup" and "revising the standup" should match, but "review the
 * deck" and "delete the deck" must not, and the verb is the only thing that
 * distinguishes them.
 *
 * Applied identically at write time (`task_tombstones.title_norm`) and at query
 * time, so the two can never drift.
 */
export function normalizeTaskTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKC')
    // Keep letters/digits/whitespace across every script (CJK included).
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'if', 'in',
  'into', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'then', 'this', 'to',
  'up', 'was', 'were', 'will', 'with', 'when', 'we', 'i', 'my', 'our', 'your',
])

/**
 * Content-bearing tokens of a normalized title, used for rule proposal. Tokens
 * under 3 chars are dropped alongside stopwords — they carry no class signal
 * and would make proposed predicates match far more than the cluster.
 */
export function significantTokens(titleNorm: string): string[] {
  return titleNorm
    .split(' ')
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
}

// ── Predicate matching ───────────────────────────────────────────────────────

/**
 * Does `predicate` match `candidate`? Conditions AND; lists within a condition
 * OR; absent conditions are "don't care".
 *
 * `require` is NOT tested here — it is the `require` effect's payload, checked
 * by `unsatisfiedRequirement`, not a matching condition.
 */
export function matchesPredicate(
  predicate: TaskRulePredicate,
  candidate: TaskAdmissionCandidate,
): boolean {
  const titleNorm = normalizeTaskTitle(candidate.title)

  if (predicate.source_kinds?.length) {
    if (!candidate.sourceKind) return false
    if (!predicate.source_kinds.includes(candidate.sourceKind)) return false
  }

  if (predicate.lanes?.length && !predicate.lanes.includes(candidate.lane)) {
    return false
  }

  if (predicate.title_matches?.length) {
    const hit = predicate.title_matches.some((needle) => {
      const n = normalizeTaskTitle(needle)
      return n.length > 0 && titleNorm.includes(n)
    })
    if (!hit) return false
  }

  if (predicate.channel_refs?.length) {
    if (!candidate.channelRef) return false
    if (!predicate.channel_refs.includes(candidate.channelRef)) return false
  }

  return true
}

/** First `require` entry the candidate fails, or null when it satisfies them all. */
export function unsatisfiedRequirement(
  predicate: TaskRulePredicate,
  candidate: TaskAdmissionCandidate,
): TaskRuleRequirement | null {
  for (const req of predicate.require ?? []) {
    if (req === 'assignee' && !candidate.assigneeId) return 'assignee'
    if (req === 'due' && !candidate.due) return 'due'
  }
  return null
}

/**
 * A `deny` rule with no conditions denies every task in the workspace, and a
 * `require` rule with no requirements is a no-op. Both are authoring mistakes
 * worth failing loudly at the store boundary rather than silently honoring.
 */
export function validateRulePredicate(
  effect: TaskRuleEffect,
  predicate: TaskRulePredicate,
): string | null {
  const hasCondition =
    Boolean(predicate.source_kinds?.length) ||
    Boolean(predicate.lanes?.length) ||
    Boolean(predicate.title_matches?.length) ||
    Boolean(predicate.channel_refs?.length)

  if (effect === 'deny' && !hasCondition) {
    return 'A deny rule needs at least one condition (source_kinds, lanes, title_matches, or channel_refs) — an empty predicate would block every task in the workspace.'
  }
  if (effect === 'require' && !predicate.require?.length) {
    return 'A require rule needs at least one requirement (assignee or due).'
  }
  return null
}

// ── The decision ─────────────────────────────────────────────────────────────

export type EvaluateTaskAdmissionInput = {
  candidate: TaskAdmissionCandidate
  /** Only `status: 'active'` rules — `proposed` rules are inert by contract. */
  rules: readonly TaskRuleRecord[]
  tombstoneMatches: readonly ScoredTombstone[]
  taskMatches: readonly ScoredTask[]
}

/**
 * The decision table. First match wins; order is cost-ascending and
 * certainty-descending, so the user's own explicit past decisions outrank
 * anything inferred.
 *
 *   1. tombstone match          -> drop   (they already rejected this)
 *   2. active deny rule         -> drop   (their stated policy)
 *   3. unsatisfied require rule -> hold
 *   4. duplicate  >= 0.88       -> drop   (restatement of tracked work)
 *   5. near-dup   >= 0.65       -> hold
 *   6. otherwise                -> allow
 *
 * A silent drop is only ever justified when the user has already ruled on it.
 * Everything else holds, because a guardrail that silently eats real work is
 * worse than the slop it replaces.
 */
export function evaluateTaskAdmission(
  input: EvaluateTaskAdmissionInput,
): TaskAdmissionDecision {
  const { candidate, rules, tombstoneMatches, taskMatches } = input

  // 1. Tombstone — the user rejected this exact class, with a reason.
  const tombstone = bestAbove(tombstoneMatches, TASK_ADMISSION_THRESHOLDS.TOMBSTONE_MATCH)
  if (tombstone) {
    return {
      outcome: 'drop',
      reasonCode: 'tombstoned',
      explanation: `Not created — this workspace previously rejected "${tombstone.tombstone.title}" with the reason: ${tombstone.tombstone.reason}`,
      matchedTombstoneId: tombstone.tombstone.id,
      similarity: tombstone.similarity,
    }
  }

  // 2. Deny rules.
  for (const rule of rules) {
    if (rule.effect !== 'deny') continue
    if (!matchesPredicate(rule.predicate, candidate)) continue
    return {
      outcome: 'drop',
      reasonCode: 'rule',
      explanation: `Not created — blocked by the workspace task rule${
        rule.nlClause ? `: "${rule.nlClause}"` : ` ${rule.id}`
      }`,
      matchedRuleId: rule.id,
    }
  }

  // 3. Require rules — the task may be real but is not yet well-formed, so it
  //    waits for a human rather than landing half-specified.
  for (const rule of rules) {
    if (rule.effect !== 'require') continue
    if (!matchesPredicate(rule.predicate, candidate)) continue
    const missing = unsatisfiedRequirement(rule.predicate, candidate)
    if (!missing) continue
    return {
      outcome: 'hold',
      reasonCode: 'rule_requires',
      explanation: `Held for review — the workspace requires every task to have ${
        missing === 'assignee' ? 'an assignee' : 'a due date'
      }${rule.nlClause ? ` ("${rule.nlClause}")` : ''}.`,
      matchedRuleId: rule.id,
    }
  }

  // 4/5. Duplicate of a live OPEN task.
  const dup = bestAbove(taskMatches, TASK_ADMISSION_THRESHOLDS.NEAR_DUPLICATE_HOLD)
  if (dup) {
    if (dup.similarity >= TASK_ADMISSION_THRESHOLDS.DUPLICATE_DROP) {
      return {
        outcome: 'drop',
        reasonCode: 'duplicate',
        explanation: `Not created — this duplicates the open task "${dup.title}" [${dup.id}]. Update that one instead.`,
        matchedTaskId: dup.id,
        similarity: dup.similarity,
      }
    }
    return {
      outcome: 'hold',
      reasonCode: 'near_duplicate',
      explanation: `Held for review — this looks similar to the open task "${dup.title}" [${dup.id}].`,
      matchedTaskId: dup.id,
      similarity: dup.similarity,
    }
  }

  return { outcome: 'allow' }
}

function bestAbove<T extends { similarity: number }>(
  scored: readonly T[],
  threshold: number,
): T | null {
  let best: T | null = null
  for (const s of scored) {
    if (s.similarity < threshold) continue
    if (!best || s.similarity > best.similarity) best = s
  }
  return best
}

// ── Orchestration ────────────────────────────────────────────────────────────

export type AdmitTaskResult = TaskAdmissionDecision & {
  /** True when the caller should proceed with the write. */
  admitted: boolean
}

/**
 * Run the gate: fetch what the decision needs, decide, and persist the
 * tray/audit row for anything that did not pass.
 *
 * LANE ASYMMETRY. On the `assistant` lane a `hold` is a non-answer — the user
 * asked directly — so it collapses to `allow` carrying a warning the model is
 * expected to relay ("created; note this looks similar to [id]"). A `drop`
 * still refuses, but returns an explanation phrased for relay rather than a
 * silent no-op. Extraction-lane holds land in the tray as intended.
 *
 * Recording the candidate must never break the write path: a tray insert that
 * fails is logged and swallowed, because losing an audit row is strictly better
 * than losing the user's task.
 */
export async function admitTask(
  port: TaskAdmissionPort,
  candidate: TaskAdmissionCandidate,
  now: Date = new Date(),
): Promise<AdmitTaskResult> {
  const titleNorm = normalizeTaskTitle(candidate.title)
  if (!titleNorm) return { outcome: 'allow', admitted: true }

  const [rules, tombstoneMatches, taskMatches] = await Promise.all([
    port.listActiveRules(candidate.workspaceId),
    port.findSimilarTombstones(
      candidate.workspaceId,
      titleNorm,
      TASK_ADMISSION_THRESHOLDS.TOMBSTONE_MATCH,
    ),
    port.findSimilarTasks(
      candidate.workspaceId,
      titleNorm,
      TASK_ADMISSION_THRESHOLDS.NEAR_DUPLICATE_HOLD,
    ),
  ])

  const decision = evaluateTaskAdmission({
    candidate,
    rules: rules.filter((r) => r.status === 'active'),
    tombstoneMatches,
    taskMatches,
  })

  if (decision.outcome === 'allow') return { ...decision, admitted: true }

  // Assistant lane: a hold becomes an allow-with-warning.
  if (candidate.lane === 'assistant' && decision.outcome === 'hold') {
    return {
      outcome: 'allow',
      admitted: true,
      warning: {
        reasonCode: decision.reasonCode,
        explanation: decision.explanation,
        matchedTaskId: decision.matchedTaskId,
        similarity: decision.similarity,
      },
    }
  }

  const ttlDays =
    decision.outcome === 'hold' ? HELD_CANDIDATE_TTL_DAYS : DROPPED_CANDIDATE_TTL_DAYS

  try {
    await port.recordCandidate({
      workspaceId: candidate.workspaceId,
      title: candidate.title,
      due: candidate.due ?? null,
      lane: candidate.lane,
      sourceKind: candidate.sourceKind ?? null,
      sourceEpisodeId: candidate.sourceEpisodeId ?? null,
      createdByAssistantId: candidate.createdByAssistantId ?? null,
      status: decision.outcome === 'hold' ? 'pending' : 'dropped',
      reasonCode: decision.reasonCode,
      matchedTaskId: decision.matchedTaskId ?? null,
      matchedRuleId: decision.matchedRuleId ?? null,
      matchedTombstoneId: decision.matchedTombstoneId ?? null,
      similarity: decision.similarity ?? null,
      expiresAt: new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000),
    })
  } catch (err) {
    console.warn(
      `[task-admission] failed to record candidate for workspace ${candidate.workspaceId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }

  return { ...decision, admitted: false }
}

// ── Extraction-prompt policy block ───────────────────────────────────────────

/** Caps — the policy block is guidance, not a second system prompt. */
const MAX_PROMPT_RULES = 8
const MAX_PROMPT_TOMBSTONES = 8

/**
 * Render the workspace's task policy for injection into the Pipeline B
 * extraction prompt.
 *
 * Suppressing at the prompt is strictly cheaper than suppressing at the gate —
 * no row written, no candidate to review — so this is the primary defense and
 * the gate is the backstop. It is also the ONLY enforcement a non-deterministic
 * rule ("only things I actually committed to") ever gets.
 *
 * Returns '' when the workspace has stated no policy, so the prompt is
 * byte-identical to today for every workspace that has not opted in.
 */
export function buildTaskPolicyPromptBlock(
  rules: readonly TaskRuleRecord[],
  tombstones: readonly TaskTombstoneRecord[],
): string {
  const clauses = rules
    .filter((r) => r.status === 'active' && r.nlClause?.trim())
    .slice(0, MAX_PROMPT_RULES)
    .map((r) => `- ${r.nlClause!.trim()}`)

  const rejections = tombstones
    .slice(0, MAX_PROMPT_TOMBSTONES)
    .map((t) => `- Rejected: "${t.title}" — ${t.reason}`)

  if (clauses.length === 0 && rejections.length === 0) return ''

  return [
    '',
    'Workspace task policy — this team has rejected tasks like these. Do NOT emit them into "tasks":',
    ...clauses,
    ...rejections,
  ].join('\n')
}

// ── Rule proposal ────────────────────────────────────────────────────────────

export type ProposedRule = {
  predicate: TaskRulePredicate
  nlClause: string
  reason: string
  /** The tombstones that motivated it, for the UI's "why am I seeing this?". */
  tombstoneIds: string[]
}

/**
 * Generalize a cluster of rejections into a rule the user can activate.
 *
 * DELIBERATELY CONSERVATIVE. Fires only when at least PROPOSAL_THRESHOLD
 * tombstones share a `source_kind` AND at least two significant title tokens,
 * and proposes nothing otherwise. A wrong auto-rule suppresses a whole category
 * of real work invisibly, so refusing to guess is the cheaper error — and the
 * result is inserted `status: 'proposed'`, inert until the user says yes.
 *
 * `similarityOf` is injected so the caller supplies the same trigram measure
 * the database uses; the clustering itself stays pure and testable.
 */
export function proposeRuleFromTombstones(
  trigger: TaskTombstoneRecord,
  others: readonly TaskTombstoneRecord[],
  similarityOf: (a: string, b: string) => number,
): ProposedRule | null {
  if (!trigger.sourceKind) return null

  const cluster = [
    trigger,
    ...others.filter(
      (t) =>
        t.id !== trigger.id &&
        t.sourceKind === trigger.sourceKind &&
        similarityOf(t.titleNorm, trigger.titleNorm) >= PROPOSAL_CLUSTER_MATCH,
    ),
  ]
  if (cluster.length < PROPOSAL_THRESHOLD) return null

  // Tokens present in EVERY member — the class signal, not one member's wording.
  const shared = cluster
    .map((t) => new Set(significantTokens(t.titleNorm)))
    .reduce((acc, set) => new Set([...acc].filter((tok) => set.has(tok))))

  const tokens = [...shared].sort()
  if (tokens.length < 2) return null

  return {
    predicate: {
      source_kinds: [trigger.sourceKind],
      title_matches: tokens.slice(0, 4),
    },
    nlClause: `Don't create tasks from ${trigger.sourceKind} mentioning ${tokens
      .slice(0, 4)
      .join(' / ')}.`,
    reason: `Proposed after ${cluster.length} similar tasks were rejected, most recently: ${trigger.reason}`,
    tombstoneIds: cluster.map((t) => t.id),
  }
}
