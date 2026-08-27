/**
 * Daily, bounded reflection over deliberate member decisions. This is
 * additive to transcript playbook reflection and can only project scoped
 * behavioral rules validated again by the store.
 *
 * [COMP:workers/decision-reflection]
 */

import {
  readDecisionEvidence,
  listDecisionReflectionSubjects,
  type DecisionEvidenceBundle,
  type DecisionReflectionSubject,
} from '../decision-learning/evidence-reader.js'
import {
  decisionRuleProposalSchema,
  insertDecisionReflectedRules,
  isProhibitedDecisionRule,
  type DecisionRuleProposal,
  type InsertDecisionRulesResult,
} from '../db/playbook-store.js'

const DEFAULT_TICK_INTERVAL_MS = 24 * 60 * 60 * 1_000
const DEFAULT_FIRST_TICK_DELAY_MS = 60_000
const MAX_OUTPUT_TOKENS = 1_200

export type DecisionReflectionModelCall = (request: {
  systemPrompt: string
  prompt: string
  maxTokens: number
  attribution: { userId: string; assistantId: string }
}) => Promise<string>

export type DecisionReflectionWorkerEvent =
  | { type: 'tick_start'; subjectCount: number }
  | ({ type: 'subject_processed'; assistantId: string; actorUserId: string } & InsertDecisionRulesResult)
  | { type: 'subject_skipped'; assistantId: string; actorUserId: string; reason: 'no_new_evidence' | 'parse_failed' }
  | { type: 'error'; assistantId: string | null; actorUserId: string | null; error: string }
  | { type: 'tick_complete'; processed: number; skipped: number; errors: number }

type DecisionReflectionDeps = {
  listSubjects: () => Promise<DecisionReflectionSubject[]>
  readEvidence: (subject: DecisionReflectionSubject) => Promise<DecisionEvidenceBundle>
  insertRules: typeof insertDecisionReflectedRules
}

export type DecisionReflectionWorkerOptions = {
  modelCall: DecisionReflectionModelCall
  onEvent?: (event: DecisionReflectionWorkerEvent) => void
  tickIntervalMs?: number
  firstTickDelayMs?: number
  deps?: Partial<DecisionReflectionDeps>
}

export const DECISION_REFLECTION_SYSTEM_PROMPT = `You reflect on deliberate decisions made by one authenticated member while working with one assistant. The evidence is already minimized and grouped by source object.

Return at most two behavioral playbook rules. Each rule must be an imperative sentence no longer than 280 characters, apply only to this member on this assistant, and cite only supplied decision event ids. Choose applicabilityKind general, email, or tool; applicabilityKey may name only the supplied non-secret mailbox/account key or canonical tool name. Mark eligibility as suggestion or activation, but the server independently recomputes thresholds.

Never propose or imply identity resolution, contact merging, permissions, access grants, roles, workspace policy, task policy, skill creation/mutation, workflow creation/mutation, or any wider scope. Do not quote email content or reasons in the rule. Do not repeat a suggested, active, rejected, or retired corpus rule or a semantic variant.

Reply with only JSON:
{"rules":[{"rule":"...","applicabilityKind":"general|email|tool","applicabilityKey":null,"sourceEventIds":["uuid"],"eligibility":"suggestion|activation"}]}

An empty rules array is correct when evidence is inconsistent or already covered.`

function promptForEvidence(bundle: DecisionEvidenceBundle): string {
  return JSON.stringify({
    existingRuleCorpus: bundle.corpus.map((entry) => ({
      rule: entry.rule,
      status: entry.status,
      applicabilityOwner: entry.appliesToUserId === null ? 'assistant' : 'member',
    })),
    evidence: bundle.evidence.map((item) => ({
      eventIds: item.eventIds,
      sourceObjectId: item.sourceObjectId,
      sourceKind: item.sourceKind,
      applicabilityKind: item.applicabilityKind,
      applicabilityKey: item.applicabilityKey,
      occurredAt: item.occurredAt.toISOString(),
      reason: item.reason,
      ...(item.changedRegion ? { changedRegion: item.changedRegion } : {}),
    })),
  })
}

/** Tolerant JSON extraction; malformed or prohibited output is a no-op. */
export function parseDecisionReflectionOutput(raw: string): DecisionRuleProposal[] | null {
  const object = raw.match(/\{[\s\S]*\}/)?.[0]
  if (!object) return null
  try {
    const parsed = JSON.parse(object) as { rules?: unknown }
    if (!Array.isArray(parsed.rules)) return null
    const proposals: DecisionRuleProposal[] = []
    for (const candidate of parsed.rules.slice(0, 2)) {
      const proposal = decisionRuleProposalSchema.safeParse(candidate)
      if (!proposal.success || isProhibitedDecisionRule(
        proposal.success ? proposal.data.rule : '',
      )) return null
      proposals.push(proposal.data)
    }
    return proposals
  } catch {
    return null
  }
}

export function createDecisionReflectionWorker(options: DecisionReflectionWorkerOptions) {
  const deps: DecisionReflectionDeps = {
    listSubjects: options.deps?.listSubjects ?? (() => listDecisionReflectionSubjects()),
    readEvidence: options.deps?.readEvidence ?? ((subject) => readDecisionEvidence(subject)),
    insertRules: options.deps?.insertRules ?? insertDecisionReflectedRules,
  }
  const emit = (event: DecisionReflectionWorkerEvent) => options.onEvent?.(event)
  const tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS
  const firstTickDelayMs = options.firstTickDelayMs ?? DEFAULT_FIRST_TICK_DELAY_MS
  let interval: ReturnType<typeof setInterval> | null = null
  let first: ReturnType<typeof setTimeout> | null = null
  let running = false

  async function processSubject(subject: DecisionReflectionSubject): Promise<'processed' | 'skipped'> {
    const bundle = await deps.readEvidence(subject)
    if (!bundle.hasNewEvidence || bundle.evidence.length === 0) {
      emit({
        type: 'subject_skipped',
        assistantId: subject.assistantId,
        actorUserId: subject.actorUserId,
        reason: 'no_new_evidence',
      })
      return 'skipped'
    }
    const raw = await options.modelCall({
      systemPrompt: DECISION_REFLECTION_SYSTEM_PROMPT,
      prompt: promptForEvidence(bundle),
      maxTokens: MAX_OUTPUT_TOKENS,
      attribution: { userId: subject.actorUserId, assistantId: subject.assistantId },
    })
    const proposals = parseDecisionReflectionOutput(raw)
    if (!proposals) {
      emit({
        type: 'subject_skipped',
        assistantId: subject.assistantId,
        actorUserId: subject.actorUserId,
        reason: 'parse_failed',
      })
      return 'skipped'
    }
    const inserted = await deps.insertRules({
      assistantId: subject.assistantId,
      actorUserId: subject.actorUserId,
      workspaceId: subject.workspaceId,
      proposals,
    })
    emit({
      type: 'subject_processed',
      assistantId: subject.assistantId,
      actorUserId: subject.actorUserId,
      ...inserted,
    })
    return 'processed'
  }

  async function tick(): Promise<void> {
    if (running) return
    running = true
    let processed = 0
    let skipped = 0
    let errors = 0
    try {
      const subjects = await deps.listSubjects()
      emit({ type: 'tick_start', subjectCount: subjects.length })
      // Deliberately sequential: one assistant/actor model call at a time.
      for (const subject of subjects) {
        try {
          if (await processSubject(subject) === 'processed') processed++
          else skipped++
        } catch (err) {
          errors++
          emit({
            type: 'error',
            assistantId: subject.assistantId,
            actorUserId: subject.actorUserId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    } catch (err) {
      errors++
      emit({
        type: 'error',
        assistantId: null,
        actorUserId: null,
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      running = false
      emit({ type: 'tick_complete', processed, skipped, errors })
    }
  }

  return {
    tick,
    start(): void {
      first = setTimeout(() => void tick(), firstTickDelayMs)
      if (typeof first.unref === 'function') first.unref()
      interval = setInterval(() => void tick(), tickIntervalMs)
      if (typeof interval.unref === 'function') interval.unref()
    },
    stop(): void {
      if (first) clearTimeout(first)
      if (interval) clearInterval(interval)
      first = null
      interval = null
    },
  }
}
