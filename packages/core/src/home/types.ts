/**
 * Home dock — types + the layout artifact schema.
 *
 * The "Suggested for you" surface (apps/app-web Home content pane) is built
 * from two layers (docs/plans/home-dock.md, docs/architecture/features/home-dock.md):
 *
 *   - **Live signals** (`HomeSignals`) — assembled server-side per request from
 *     the brain inbox, approvals, autopilot goals, workflows, drafts, and brain
 *     counts. The source of truth for every NUMBER the dock shows.
 *   - **Layout artifact** (`HomeDockLayout`) — the primary assistant's curation:
 *     a freeform note + the ordering/captions of the "needs you" action cards.
 *     Carries NO counts (the freshness contract): order + caption + note only.
 *
 * `mergeHomeDock(layout, signals)` (see merge.ts) folds them into a
 * `ResolvedDock` the frontend renders directly. The assistant writes the
 * artifact through the `setHomeDock` tool (see tools.ts), injected ONLY in the
 * home-refresh turn.
 *
 * [COMP:home/types]
 */

import { z } from 'zod'

// ── Live signals (assembled in packages/api/src/home/signals.ts) ──────────

export type HomeSignals = {
  /** Unverified brain-inbox rows awaiting review. */
  brainReviewCount: number
  /** Pending approvals for the workspace. */
  approvalsCount: number
  /** Autopilot goals needing the user: unconfirmed drafts + blocked goals.
   *  (A confirmed goal in `awaiting_approval` counts under `approvalsCount`.) */
  autopilotCount: number
  /** Soonest-first upcoming scheduled workflow runs (pre-capped). */
  upcomingWorkflows: { id: string; name: string; nextRunAt: string }[]
  /** Most-recently-edited drafts to resume (pre-capped). */
  recentDrafts: { id: string; name: string; updatedAt: string }[]
  /** Total brain entries (entities + memories) in the workspace. */
  brainEntryCount: number
  /** Brain entries created in the last 7 days. */
  brainGrowth7d: number
  onboarding: {
    /** Whether the workspace has at least one connected connector. */
    hasConnector: boolean
  }
}

// ── Layout artifact (what `setHomeDock` writes) ───────────────────────────

/** The action-card kinds the assistant may order in the "Needs you" group. */
export const NEED_CARD_KINDS = ['brain_review', 'approvals', 'autopilot'] as const
export type NeedCardKind = (typeof NEED_CARD_KINDS)[number]

export const homeDockLayoutSchema = z.object({
  version: z.literal(1),
  /** Freeform assistant note, or null to show none. Capped for the banner. */
  note: z.string().max(280).nullable(),
  /** Ordered "needs you" action cards with optional caption overrides. */
  needsYou: z
    .array(
      z.object({
        kind: z.enum(NEED_CARD_KINDS),
        caption: z.string().max(120).optional(),
      }),
    )
    .max(6),
  /** ISO timestamp the artifact was generated. */
  generatedAt: z.string(),
  /** The assistant that produced it (null when unknown). */
  generatedByAssistantId: z.string().nullable(),
})

export type HomeDockLayout = z.infer<typeof homeDockLayoutSchema>

// ── Store interface (implemented in packages/api/src/db/home-dock-store.ts) ─

export type HomeDockStore = {
  /** The workspace's current layout artifact, or null if never curated. */
  get(userId: string, workspaceId: string): Promise<HomeDockLayout | null>
  /** Upsert the workspace's layout artifact (one row per workspace). */
  put(userId: string, workspaceId: string, layout: HomeDockLayout): Promise<void>
}
