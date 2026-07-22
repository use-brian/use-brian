/**
 * Home dock — the merge (the freshness contract made concrete).
 *
 * `mergeHomeDock(layout, signals)` folds the assistant's curation artifact over
 * the live signals into a `ResolvedDock` the frontend renders directly:
 *
 *   - The assistant owns ORDER + CAPTION + NOTE (from `layout`).
 *   - The signals own every NUMBER and the dead-card rule.
 *
 * So a stale artifact can only ever lag in which action cards / what order /
 * what caption — never in showing a wrong count or a card whose signal is gone
 * (a now-zero count drops the card regardless of what the assistant selected).
 * Absent artifact → deterministic default ordering, so the dock always renders.
 *
 * Pure (no IO) so it's unit-testable and runnable in packages/api at GET time.
 *
 * [COMP:home/merge]
 */

import { URGENT_NEED_KINDS, type HomeDockLayout, type HomeSignals, type NeedCardKind } from './types.js'

export type ResolvedNeed = {
  kind: NeedCardKind
  count: number
  caption: string | null
}

export type ResolvedDock = {
  /** 'assistant' when a curation artifact drove the ordering, else 'default'. */
  source: 'assistant' | 'default'
  /** When the artifact was generated (null for the deterministic fallback). */
  generatedAt: string | null
  /** The assistant's freeform note, or null to render none. */
  note: string | null
  /** "Needs you" action cards — ordered, live-counted, dead cards dropped. */
  needsYou: ResolvedNeed[]
  /** "Pick up where you left off" — recent drafts. */
  pickUp: { id: string; name: string; updatedAt: string }[]
  /** "Coming up" — upcoming scheduled workflow runs. */
  comingUp: { id: string; name: string; nextRunAt: string }[]
  /** "Your brain" — growth stat + sparkline + connector nudge state. */
  brain: {
    entryCount: number
    growth7d: number
    sparkline: number[]
    hasConnector: boolean
  }
}

/** Deterministic ordering when no assistant artifact exists. Attention-class
 *  kinds (broken connector, failed runs) lead: they block everything else. */
const DEFAULT_NEEDS: ReadonlyArray<{ kind: NeedCardKind; caption?: string }> = [
  { kind: 'connector_attention' },
  { kind: 'workflow_attention' },
  { kind: 'brain_review' },
  { kind: 'approvals' },
  { kind: 'task_triage' },
  { kind: 'autopilot' },
  { kind: 'task_cleanup' },
  { kind: 'deal_attention' },
]

function countFor(kind: NeedCardKind, signals: HomeSignals): number {
  switch (kind) {
    case 'brain_review':
      return signals.brainReviewCount
    case 'approvals':
      return signals.approvalsCount
    case 'autopilot':
      return signals.autopilotCount
    case 'task_triage':
      return signals.taskTriageCount
    case 'task_cleanup':
      return signals.taskCleanupCount
    case 'deal_attention':
      return signals.dealAttentionCount
    case 'connector_attention':
      return signals.connectorAttentionCount
    case 'workflow_attention':
      return signals.workflowAttentionCount
  }
}

export function mergeHomeDock(
  layout: HomeDockLayout | null,
  signals: HomeSignals,
): ResolvedDock {
  const order =
    layout && layout.needsYou.length > 0 ? layout.needsYou : DEFAULT_NEEDS

  const seen = new Set<NeedCardKind>()
  const needsYou: ResolvedNeed[] = []
  for (const card of order) {
    if (seen.has(card.kind)) continue // de-dup a card the assistant listed twice
    seen.add(card.kind)
    const count = countFor(card.kind, signals)
    if (count <= 0) continue // freshness: a dead signal drops the card
    needsYou.push({
      kind: card.kind,
      count,
      caption: card.caption ?? null,
    })
  }

  // Always-surface kinds the artifact did not mention still appear while live —
  // attention kinds (silent breakage) AND pending-you actions (a new approval, a
  // goal draft awaiting confirm). A stale artifact (e.g. a month-old layout
  // listing only brain_review) may lag their order/caption, never hide them: a
  // blocking item you must act on cannot wait for the next curation turn.
  for (const kind of URGENT_NEED_KINDS) {
    if (seen.has(kind)) continue
    const count = countFor(kind, signals)
    if (count <= 0) continue
    needsYou.push({ kind, count, caption: null })
  }

  return {
    source: layout ? 'assistant' : 'default',
    generatedAt: layout?.generatedAt ?? null,
    note: layout?.note ?? null,
    needsYou,
    pickUp: signals.recentDrafts,
    comingUp: signals.upcomingWorkflows,
    brain: {
      entryCount: signals.brainEntryCount,
      growth7d: signals.brainGrowth7d,
      sparkline: signals.brainSparkline,
      hasConnector: signals.onboarding.hasConnector,
    },
  }
}
