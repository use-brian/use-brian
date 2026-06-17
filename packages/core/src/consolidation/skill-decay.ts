/**
 * CL-8 skill invocation feedback — weekly decay.
 *
 * Reads per-skill counters (`invocations`, `succeeded`,
 * `user_corrected_after`, `last_invoked_at`) and soft-deprecates skills
 * matching the demote rules. The skill row persists; `valid_to = now()`
 * excludes it from active skill-pick eval and surfaces it under the
 * "auto-archived skills" view in the management UI.
 *
 * Cadence: runs from Deep weekly (workspace-scoped). See
 * `phases.ts`'s `runDeepSkillDecay` wire-in.
 *
 * Resurrection: a user clicking "restore" calls `markUserVerified`
 * which the WS-A store already handles (`write_origin = 'foreground'`
 * + stamps `verified_by_user_id`). Resurrection itself is the
 * responsibility of WS-F or the UI workstream; this module is
 * write-side only.
 *
 * Spec: `docs/architecture/context-engine/memory-consolidation.md` §"Skill invocation
 * feedback (CL-8 lock)".
 *
 * [COMP:consolidation/skill-decay]
 */

import type { UmbrellaSkill } from './skill-umbrella.js'

// ── Demote rule thresholds ───────────────────────────────────────

const INACTIVE_DAYS_DEFAULT = 30
const LOW_SUCCESS_MIN_INVOCATIONS_DEFAULT = 10
const LOW_SUCCESS_RATE_THRESHOLD_DEFAULT = 0.5
const FREQUENT_CORRECTION_THRESHOLD_DEFAULT = 3

// ── Reasons (typed, surfaced in events + UI) ─────────────────────

export type SkillDecayReason =
  | 'inactive'
  | 'low_success'
  | 'frequent_correction'
  | 'broken_reference'
  | 'superseded_conflict'

// ── Decay candidate shape ────────────────────────────────────────
//
// The decay pass evaluates `UmbrellaSkill` rows (shared with the
// umbrella pass) augmented with two OPTIONAL decay-only signals that
// the wiring layer computes per-skill before evaluation:
//
//  - `hasBrokenReference` — set when one of the skill's
//    `references_entity` / `requires_connector` edge targets was
//    retracted (`retracted_at`) or changed; the skill's procedure may
//    now reference deleted data and be actively wrong. HIGH severity.
//  - `conflictsWithRowId` — set to the rowId of a newer skill induced
//    for the SAME trigger; both rows are flagged for
//    reconciliation/absorption. LOWER severity.
//
// Both are optional so existing callers/tests that don't compute them
// are unaffected and still yield only the original three reasons. These
// are derived signals, not `workspace_skills` columns — the edge state
// they reflect lives on the brain graph, resolved at wiring time.
export type SkillDecayCandidate = UmbrellaSkill & {
  /** A `references_entity` / `requires_connector` edge target was
   *  removed or changed (the skill may now be wrong). HIGH severity. */
  hasBrokenReference?: boolean
  /** rowId of a newer skill induced for the same trigger — flag both
   *  for reconciliation/absorption. LOWER severity. */
  conflictsWithRowId?: string | null
}

// ── Store contract (READ-ONLY adapter over WS-A) ─────────────────

/**
 * Slice of WS-A's `WorkspaceSkillStore` consumed by the decay pass.
 * Soft-deprecation == set `valid_to = now()`; the WS-A store's
 * `delete(userId, workspaceId, skillId)` does exactly this, but the
 * decay pass writes system-level (no userId context) and against the
 * raw `rowId`. We expose a narrow `softDeprecate` method here that the
 * wiring layer maps to a single UPDATE.
 *
 * The candidate-listing method `listDecayCandidates` is similar to
 * `listCuratorEligible` but slightly looser — decay considers any
 * non-pinned, non-foreground, in-(active|stale) row, regardless of
 * the curator's >=7d touched grace.
 */
export type SkillDecayStore = {
  /** Same filter as `listCuratorEligible` — already excludes pinned
   *  + write_origin='foreground' + archived + bi-temporally closed.
   *  Rows may carry the optional `hasBrokenReference` /
   *  `conflictsWithRowId` decay signals when the wiring layer resolved
   *  edge state; absent signals fall through to the original rules. */
  listCuratorEligible(workspaceId: string): Promise<SkillDecayCandidate[]>

  /** Soft-deprecate: set `valid_to = now()`. Idempotent — calling on a
   *  row already past valid_to is a no-op. The wiring layer also stamps
   *  the reason onto a paired audit row, but that's a follow-up; for V2
   *  the reason lives only in the event stream. */
  softDeprecate(skillRowId: string, reason: SkillDecayReason): Promise<void>
}

// ── Event hook ───────────────────────────────────────────────────

export type SkillDecayEvent =
  | {
      type: 'skill_deprecated'
      workspaceId: string
      skillRowId: string
      reason: SkillDecayReason
      detail: {
        invocations: number
        succeeded: number
        userCorrectedAfter: number
        lastInvokedAt: Date | null
        /** rowId of the conflicting newer skill — only present when the
         *  reason is `superseded_conflict`. Drives the reconciliation /
         *  absorption follow-up on the digest + UI. */
        conflictsWithRowId?: string | null
      }
    }
  | {
      type: 'skill_decay_skipped'
      workspaceId: string
      reason: 'no_candidates'
    }

// ── Demote-rule evaluator ────────────────────────────────────────

export type SkillDecayThresholds = {
  inactiveDays: number
  lowSuccessMinInvocations: number
  lowSuccessRateThreshold: number
  frequentCorrectionThreshold: number
}

/**
 * Evaluate the five demote rules against a skill. Returns the first
 * matching reason or null. Rules apply ONCE per skill per run — if a
 * skill triggers several rules, the higher-severity one wins. Priority
 * (highest first):
 *
 *   frequent_correction > broken_reference > superseded_conflict
 *     > low_success > inactive
 *
 * `broken_reference` outranks `low_success` because a skill pointing at
 * deleted/changed data may be actively harmful; `superseded_conflict`
 * sits just below it (a newer skill exists for the same trigger, so the
 * stale one should yield for reconciliation/absorption). This matters
 * because the digest + UI surface one reason per archived row.
 *
 * `hasBrokenReference` and `conflictsWithRowId` are optional decay
 * signals computed by the wiring layer; when absent the function yields
 * only the original three reasons.
 *
 * Exported so the test suite (and future CL-8 dashboard) can call the
 * rule logic directly without touching the store.
 */
export function evaluateDemoteRule(
  skill: SkillDecayCandidate,
  now: Date,
  thresholds: SkillDecayThresholds = {
    inactiveDays: INACTIVE_DAYS_DEFAULT,
    lowSuccessMinInvocations: LOW_SUCCESS_MIN_INVOCATIONS_DEFAULT,
    lowSuccessRateThreshold: LOW_SUCCESS_RATE_THRESHOLD_DEFAULT,
    frequentCorrectionThreshold: FREQUENT_CORRECTION_THRESHOLD_DEFAULT,
  },
): SkillDecayReason | null {
  // Frequent-correction first — the most damaging signal ("actively
  // wrong by user feedback" beats every structural signal).
  if (skill.userCorrectedAfter >= thresholds.frequentCorrectionThreshold) {
    return 'frequent_correction'
  }
  // Broken reference: a `references_entity` / `requires_connector` edge
  // target was removed or changed. A skill pointing at deleted data may
  // be actively harmful, so it outranks low_success / inactive.
  if (skill.hasBrokenReference === true) {
    return 'broken_reference'
  }
  // Superseded conflict: a newer skill was induced for the same trigger.
  // Flag both for reconciliation/absorption — lower severity than a
  // broken reference but still ahead of quality / activity signals.
  if (skill.conflictsWithRowId != null && skill.conflictsWithRowId !== '') {
    return 'superseded_conflict'
  }
  // Low success: enough invocations to be statistically meaningful,
  // success rate below threshold.
  if (skill.invocations >= thresholds.lowSuccessMinInvocations) {
    const rate = skill.succeeded / skill.invocations
    if (rate < thresholds.lowSuccessRateThreshold) {
      return 'low_success'
    }
  }
  // Inactive: zero invocations in the inactive window. The anchor is
  // `lastInvokedAt` when present, otherwise the row's `validFrom` (the
  // create timestamp — a brand-new skill never invoked is inactive
  // after the grace window the same way an old never-invoked one is).
  const anchor = skill.lastInvokedAt ?? skill.validFrom
  const ageDays = (now.getTime() - anchor.getTime()) / (24 * 60 * 60 * 1000)
  if (skill.invocations === 0 && ageDays >= thresholds.inactiveDays) {
    return 'inactive'
  }
  return null
}

// ── Public entry point ───────────────────────────────────────────

export type RunSkillDecayParams = {
  workspaceId: string
  store: SkillDecayStore
  onEvent?: (event: SkillDecayEvent) => void
  now?: () => Date
  thresholds?: Partial<SkillDecayThresholds>
}

export type RunSkillDecayResult = {
  workspaceId: string
  deprecated: number
  reasons: Array<{ skillRowId: string; reason: SkillDecayReason }>
}

export async function runSkillDecay(
  params: RunSkillDecayParams,
): Promise<RunSkillDecayResult> {
  const {
    workspaceId,
    store,
    onEvent,
    now = () => new Date(),
  } = params

  const thresholds: SkillDecayThresholds = {
    inactiveDays: params.thresholds?.inactiveDays ?? INACTIVE_DAYS_DEFAULT,
    lowSuccessMinInvocations:
      params.thresholds?.lowSuccessMinInvocations ?? LOW_SUCCESS_MIN_INVOCATIONS_DEFAULT,
    lowSuccessRateThreshold:
      params.thresholds?.lowSuccessRateThreshold ?? LOW_SUCCESS_RATE_THRESHOLD_DEFAULT,
    frequentCorrectionThreshold:
      params.thresholds?.frequentCorrectionThreshold ?? FREQUENT_CORRECTION_THRESHOLD_DEFAULT,
  }

  const currentTime = now()
  const candidates = await store.listCuratorEligible(workspaceId)

  if (candidates.length === 0) {
    onEvent?.({ type: 'skill_decay_skipped', workspaceId, reason: 'no_candidates' })
    return { workspaceId, deprecated: 0, reasons: [] }
  }

  const reasons: Array<{ skillRowId: string; reason: SkillDecayReason }> = []
  let deprecated = 0

  for (const skill of candidates) {
    // listCuratorEligible already filters pinned + write_origin
    // ='foreground' + archived. We defensively re-check the two
    // hard guards in case the eligible list semantics drift later.
    if (skill.pinned) continue
    if (skill.writeOrigin === 'foreground') continue

    const reason = evaluateDemoteRule(skill, currentTime, thresholds)
    if (!reason) continue

    try {
      await store.softDeprecate(skill.rowId, reason)
      reasons.push({ skillRowId: skill.rowId, reason })
      deprecated++
      onEvent?.({
        type: 'skill_deprecated',
        workspaceId,
        skillRowId: skill.rowId,
        reason,
        detail: {
          invocations: skill.invocations,
          succeeded: skill.succeeded,
          userCorrectedAfter: skill.userCorrectedAfter,
          lastInvokedAt: skill.lastInvokedAt ?? null,
          // Surface the conflicting newer skill so the reconciliation
          // follow-up can pair the two rows. Only meaningful for
          // `superseded_conflict`; null/absent otherwise.
          ...(skill.conflictsWithRowId != null
            ? { conflictsWithRowId: skill.conflictsWithRowId }
            : {}),
        },
      })
    } catch (err) {
      // Per-skill failure must not abort the workspace run. The
      // worker's onError is the audit channel for this; we don't
      // re-throw.
      // eslint-disable-next-line no-console
      console.error(
        `[skill-decay] softDeprecate failed for ${skill.rowId}:`,
        err,
      )
    }
  }

  return { workspaceId, deprecated, reasons }
}
