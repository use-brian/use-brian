/**
 * D-lock D.6 (sensitivity reclassification). Spec:
 * docs/architecture/brain/corrections.md §D.6.
 *
 * Pure orchestration module. All persistence is delegated to injected
 * `SensitivityReclassificationRepository` (+ optional
 * `ChannelSensitivityRuleRepository`) ports. No DB driver, no SQL, no
 * I/O in this file. The DB adapter that fulfils these ports lives in
 * the API package (separate work unit).
 *
 * Two orchestrators sharing a direction algebra:
 *
 *  • `reclassifyRowSensitivity` — per-row tier change. Upgrades cascade
 *    through derived rows via the MAX(sources) rule. Downgrades are
 *    forward-only at the touched row (no cascade) and require
 *    `triggeredBy='per_row_operator'` — the asymmetry encodes
 *    bias-toward-over-protection: wrongly-low leaks, wrongly-high is
 *    over-cautious.
 *
 *  • `supersedeChannelSensitivityRule` — install a new
 *    `channel_sensitivity_rules` row that supersedes a prior rule.
 *    With `applyRetroactively=true`, an upgrade walks rows scoped to
 *    the prior rule and reclassifies each; a downgrade is refused
 *    (`retroactive_downgrade_refused` — per-row operator review must
 *    drive any retroactive downgrade).
 *
 * Out of scope (enforced elsewhere):
 *
 *  • Operator-gate identity verification — the module trusts the
 *    `triggeredBy` discriminator. The tool layer is responsible for
 *    verifying the actor is actually an operator when
 *    `triggeredBy='per_row_operator'`.
 *
 *  • Side-channel privacy — when a reclassification revokes a user's
 *    effective read access, no notification fires (D.6 §Side-channel
 *    privacy). Notifications aren't this module's concern; just don't
 *    add one.
 *
 *  • Cross-table audit envelope (D.8 analytics_events) — the adapter
 *    emits one event per state change. The pure module emits no
 *    events.
 *
 *  • `permissions.md` MAX(sources) rule is applied one hop at a time;
 *    recursion is driven here in the orchestrator with a cycle guard.
 */

import type { Sensitivity } from '../security/sensitivity.js'
import { RANK } from '../security/sensitivity.js'

// ── Discriminators ──────────────────────────────────────────────────

export type ReclassifiablePrimitive =
  | 'memory'
  | 'entity'
  | 'task'
  | 'episode'
  | 'kb_chunk'
  | 'contact'
  | 'company'
  | 'deal'
  | 'workspace_file'
  | 'entity_link'

export type ReclassificationDirection = 'upgrade' | 'downgrade' | 'no_change'

export type TriggeredBy =
  | 'channel_rule'
  | 'per_row_operator'
  | 'automatic_detection'

// ── Snapshots ───────────────────────────────────────────────────────

export interface RowSensitivitySnapshot {
  primitive: ReclassifiablePrimitive
  rowId: string
  workspaceId: string
  sensitivity: Sensitivity
  sourceEpisodeId: string | null
  validTo: Date | null
}

export interface ChannelSensitivityRule {
  id: string
  workspaceId: string
  sourceKind: string
  sourceRefMatch: Record<string, unknown>
  defaultSensitivity: Sensitivity
  appliedFrom: Date
  supersededAt: Date | null
  supersededBy: string | null
}

export interface DerivedRowRef {
  primitive: ReclassifiablePrimitive
  rowId: string
  sensitivity: Sensitivity
}

// ── Args & results ──────────────────────────────────────────────────

export interface ReclassifyRowArgs {
  primitive: ReclassifiablePrimitive
  workspaceId: string
  rowId: string
  newSensitivity: Sensitivity
  actorUserId: string
  reason: string
  triggeredBy: TriggeredBy
  ruleId?: string
}

export interface ChannelSensitivityRuleSeed {
  sourceKind: string
  sourceRefMatch: Record<string, unknown>
  defaultSensitivity: Sensitivity
}

export interface SupersedeChannelRuleArgs {
  workspaceId: string
  priorRuleId: string
  newRule: ChannelSensitivityRuleSeed
  actorUserId: string
  reason: string
  applyRetroactively: boolean
}

export interface ReclassificationOutcome {
  rowId: string
  primitive: ReclassifiablePrimitive
  priorSensitivity: Sensitivity
  newSensitivity: Sensitivity
  direction: ReclassificationDirection
  cascadeApplied: number
}

export interface SupersedeRuleOutcome {
  priorRuleId: string
  newRuleId: string
  retroactiveReclassifications: number
}

// ── Failure model ───────────────────────────────────────────────────

export type ReclassifyFailureCode =
  | 'row_not_found'
  | 'workspace_mismatch'
  | 'no_change'
  | 'downgrade_requires_operator'
  | 'rule_id_required_for_channel_rule'
  | 'reason_required'

export type SupersedeRuleFailureCode =
  | 'rule_not_found'
  | 'workspace_mismatch'
  | 'rule_already_superseded'
  | 'retroactive_downgrade_refused'
  | 'reason_required'

export class SensitivityReclassificationError extends Error {
  readonly code: ReclassifyFailureCode
  constructor(code: ReclassifyFailureCode, message: string) {
    super(message)
    this.name = 'SensitivityReclassificationError'
    this.code = code
  }
}

export class ChannelRuleSupersessionError extends Error {
  readonly code: SupersedeRuleFailureCode
  constructor(code: SupersedeRuleFailureCode, message: string) {
    super(message)
    this.name = 'ChannelRuleSupersessionError'
    this.code = code
  }
}

// ── Ports (implemented by the DB adapter, not by this module) ───────

export interface ApplyRowReclassificationInput {
  primitive: ReclassifiablePrimitive
  workspaceId: string
  rowId: string
  priorSensitivity: Sensitivity
  newSensitivity: Sensitivity
  direction: 'upgrade' | 'downgrade'
  triggeredBy: TriggeredBy
  ruleId: string | null
  actorUserId: string
  reason: string
  now: Date
}

export interface FindDerivedRowsInput {
  workspaceId: string
  sourceRowId: string
  sourcePrimitive: ReclassifiablePrimitive
}

export interface SensitivityReclassificationRepository {
  readRowForReclassification(
    primitive: ReclassifiablePrimitive,
    workspaceId: string,
    rowId: string,
  ): Promise<RowSensitivitySnapshot | null>

  applyRowReclassification(
    input: ApplyRowReclassificationInput,
  ): Promise<void>

  /**
   * One hop of the cascade graph: returns rows derived directly from
   * `sourceRowId`. The orchestrator recurses across hops with a cycle
   * guard.
   */
  findDerivedRows(
    input: FindDerivedRowsInput,
  ): Promise<readonly DerivedRowRef[]>
}

export interface InsertSupersedingRuleInput {
  workspaceId: string
  priorRuleId: string
  newRule: ChannelSensitivityRuleSeed
  actorUserId: string
  reason: string
  now: Date
}

export interface ChannelSensitivityRuleRepository {
  readRule(
    workspaceId: string,
    ruleId: string,
  ): Promise<ChannelSensitivityRule | null>

  insertSupersedingRule(
    input: InsertSupersedingRuleInput,
  ): Promise<{ newRuleId: string }>

  /**
   * Active (`valid_to IS NULL`) rows historically classified under the
   * scope of `ruleId`. Used to drive the retroactive upgrade walk.
   */
  findRowsUnderRuleScope(input: {
    workspaceId: string
    ruleId: string
  }): Promise<readonly RowSensitivitySnapshot[]>
}

export interface SensitivityReclassificationDeps {
  rowRepo: SensitivityReclassificationRepository
  ruleRepo?: ChannelSensitivityRuleRepository
  clock?: () => Date
}

// ── Direction algebra (pure) ────────────────────────────────────────

export function inferDirection(
  prior: Sensitivity,
  next: Sensitivity,
): ReclassificationDirection {
  if (RANK[next] > RANK[prior]) return 'upgrade'
  if (RANK[next] < RANK[prior]) return 'downgrade'
  return 'no_change'
}

export function requiresOperator(
  direction: ReclassificationDirection,
  triggeredBy: TriggeredBy,
): boolean {
  return direction === 'downgrade' && triggeredBy !== 'per_row_operator'
}

/**
 * MAX(derived, source) by RANK. Used during upgrade cascade so a
 * derived row never drops below the upgraded source. Idempotent floor:
 * if the derived row is already at or above the source, returns it
 * unchanged.
 */
export function cascadedSensitivity(
  derivedCurrent: Sensitivity,
  upgradedSource: Sensitivity,
): Sensitivity {
  return RANK[upgradedSource] > RANK[derivedCurrent]
    ? upgradedSource
    : derivedCurrent
}

// ── Guards ──────────────────────────────────────────────────────────

function isNonEmpty(s: string | undefined | null): s is string {
  return typeof s === 'string' && s.trim().length > 0
}

/** Bounded depth in case the source-derivation graph contains a cycle. */
const CASCADE_DEPTH_BOUND = 32

function cascadeKey(p: ReclassifiablePrimitive, id: string): string {
  return `${p}:${id}`
}

// ── Orchestration ───────────────────────────────────────────────────

export async function reclassifyRowSensitivity(
  args: ReclassifyRowArgs,
  deps: SensitivityReclassificationDeps,
): Promise<ReclassificationOutcome> {
  if (!isNonEmpty(args.reason)) {
    throw new SensitivityReclassificationError(
      'reason_required',
      'reason must be a non-empty string',
    )
  }
  if (args.triggeredBy === 'channel_rule' && !isNonEmpty(args.ruleId)) {
    throw new SensitivityReclassificationError(
      'rule_id_required_for_channel_rule',
      'ruleId is required when triggeredBy is channel_rule',
    )
  }

  const snapshot = await deps.rowRepo.readRowForReclassification(
    args.primitive,
    args.workspaceId,
    args.rowId,
  )
  if (!snapshot) {
    throw new SensitivityReclassificationError(
      'row_not_found',
      `no ${args.primitive} with that id in this workspace`,
    )
  }
  if (snapshot.workspaceId !== args.workspaceId) {
    throw new SensitivityReclassificationError(
      'workspace_mismatch',
      'row belongs to a different workspace',
    )
  }

  const direction = inferDirection(snapshot.sensitivity, args.newSensitivity)
  if (direction === 'no_change') {
    throw new SensitivityReclassificationError(
      'no_change',
      'newSensitivity matches current sensitivity',
    )
  }
  if (requiresOperator(direction, args.triggeredBy)) {
    throw new SensitivityReclassificationError(
      'downgrade_requires_operator',
      'downgrades require triggeredBy=per_row_operator',
    )
  }

  const now = (deps.clock ?? (() => new Date()))()
  await deps.rowRepo.applyRowReclassification({
    primitive: args.primitive,
    workspaceId: args.workspaceId,
    rowId: args.rowId,
    priorSensitivity: snapshot.sensitivity,
    newSensitivity: args.newSensitivity,
    direction,
    triggeredBy: args.triggeredBy,
    ruleId: args.ruleId ?? null,
    actorUserId: args.actorUserId,
    reason: args.reason,
    now,
  })

  let cascadeApplied = 0
  if (direction === 'upgrade') {
    cascadeApplied = await cascadeUpgrade({
      sourcePrimitive: args.primitive,
      sourceRowId: args.rowId,
      workspaceId: args.workspaceId,
      upgradedSource: args.newSensitivity,
      actorUserId: args.actorUserId,
      reason: args.reason,
      triggeredBy: args.triggeredBy,
      ruleId: args.ruleId ?? null,
      now,
      visited: new Set<string>([cascadeKey(args.primitive, args.rowId)]),
      depth: 0,
      rowRepo: deps.rowRepo,
    })
  }

  return {
    rowId: args.rowId,
    primitive: args.primitive,
    priorSensitivity: snapshot.sensitivity,
    newSensitivity: args.newSensitivity,
    direction,
    cascadeApplied,
  }
}

interface CascadeUpgradeFrame {
  sourcePrimitive: ReclassifiablePrimitive
  sourceRowId: string
  workspaceId: string
  upgradedSource: Sensitivity
  actorUserId: string
  reason: string
  triggeredBy: TriggeredBy
  ruleId: string | null
  now: Date
  visited: Set<string>
  depth: number
  rowRepo: SensitivityReclassificationRepository
}

async function cascadeUpgrade(frame: CascadeUpgradeFrame): Promise<number> {
  if (frame.depth >= CASCADE_DEPTH_BOUND) return 0

  const derived = await frame.rowRepo.findDerivedRows({
    workspaceId: frame.workspaceId,
    sourceRowId: frame.sourceRowId,
    sourcePrimitive: frame.sourcePrimitive,
  })

  let total = 0
  for (const child of derived) {
    const key = cascadeKey(child.primitive, child.rowId)
    if (frame.visited.has(key)) continue
    frame.visited.add(key)

    const cascaded = cascadedSensitivity(child.sensitivity, frame.upgradedSource)
    if (cascaded !== child.sensitivity) {
      await frame.rowRepo.applyRowReclassification({
        primitive: child.primitive,
        workspaceId: frame.workspaceId,
        rowId: child.rowId,
        priorSensitivity: child.sensitivity,
        newSensitivity: cascaded,
        direction: 'upgrade',
        triggeredBy: frame.triggeredBy,
        ruleId: frame.ruleId,
        actorUserId: frame.actorUserId,
        reason: frame.reason,
        now: frame.now,
      })
      total += 1
    }

    // Recurse regardless of whether this hop changed — descendants may
    // still need raising even when an intermediate row already exceeds
    // the upgraded source.
    total += await cascadeUpgrade({
      ...frame,
      sourcePrimitive: child.primitive,
      sourceRowId: child.rowId,
      depth: frame.depth + 1,
    })
  }

  return total
}

export async function supersedeChannelSensitivityRule(
  args: SupersedeChannelRuleArgs,
  deps: SensitivityReclassificationDeps,
): Promise<SupersedeRuleOutcome> {
  if (!isNonEmpty(args.reason)) {
    throw new ChannelRuleSupersessionError(
      'reason_required',
      'reason must be a non-empty string',
    )
  }
  if (!deps.ruleRepo) {
    throw new ChannelRuleSupersessionError(
      'rule_not_found',
      'ruleRepo is required for supersedeChannelSensitivityRule',
    )
  }

  const prior = await deps.ruleRepo.readRule(args.workspaceId, args.priorRuleId)
  if (!prior) {
    throw new ChannelRuleSupersessionError(
      'rule_not_found',
      'no rule with that id in this workspace',
    )
  }
  if (prior.workspaceId !== args.workspaceId) {
    throw new ChannelRuleSupersessionError(
      'workspace_mismatch',
      'rule belongs to a different workspace',
    )
  }
  if (prior.supersededAt !== null) {
    throw new ChannelRuleSupersessionError(
      'rule_already_superseded',
      'rule has already been superseded',
    )
  }

  if (args.applyRetroactively) {
    const direction = inferDirection(
      prior.defaultSensitivity,
      args.newRule.defaultSensitivity,
    )
    if (direction === 'downgrade') {
      throw new ChannelRuleSupersessionError(
        'retroactive_downgrade_refused',
        'retroactive downgrades are refused; use per-row operator review',
      )
    }
  }

  const now = (deps.clock ?? (() => new Date()))()
  const { newRuleId } = await deps.ruleRepo.insertSupersedingRule({
    workspaceId: args.workspaceId,
    priorRuleId: args.priorRuleId,
    newRule: args.newRule,
    actorUserId: args.actorUserId,
    reason: args.reason,
    now,
  })

  let retroactiveReclassifications = 0
  if (args.applyRetroactively) {
    const direction = inferDirection(
      prior.defaultSensitivity,
      args.newRule.defaultSensitivity,
    )
    if (direction === 'upgrade') {
      const rows = await deps.ruleRepo.findRowsUnderRuleScope({
        workspaceId: args.workspaceId,
        ruleId: args.priorRuleId,
      })
      for (const row of rows) {
        if (
          inferDirection(row.sensitivity, args.newRule.defaultSensitivity)
          !== 'upgrade'
        ) {
          continue
        }
        await reclassifyRowSensitivity(
          {
            primitive: row.primitive,
            workspaceId: args.workspaceId,
            rowId: row.rowId,
            newSensitivity: args.newRule.defaultSensitivity,
            actorUserId: args.actorUserId,
            reason: args.reason,
            triggeredBy: 'channel_rule',
            ruleId: newRuleId,
          },
          deps,
        )
        retroactiveReclassifications += 1
      }
    }
    // direction === 'no_change' → 0 reclassifications; succeed.
  }

  return {
    priorRuleId: args.priorRuleId,
    newRuleId,
    retroactiveReclassifications,
  }
}
