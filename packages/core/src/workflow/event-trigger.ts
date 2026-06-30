/**
 * Workflow event-trigger dispatcher.
 *
 * The source-agnostic core of the `event` workflow trigger. A `DispatchEvent`
 * — produced by any event source, connector or channel — is matched against
 * every enabled `trigger.kind='event'` workflow in its workspace; each
 * workflow with a subscription that matches gets a run started.
 *
 * One dispatcher, N producers. The producers are the seam where source
 * specifics live:
 *   - connectors → `ingest/workflow-trigger.ts` (the ingest engine `onEvent`
 *     seam — GitHub, Fathom, Gmail, Calendar);
 *   - channels   → the channel webhook (`packages/api/.../routes/slack.ts`).
 *   - pages      → `workflow/page-event-trigger.ts` (the saved-views store
 *     write path — a doc page created / updated / moved under a watched
 *     parent).
 * Each producer normalizes its native event into a `DispatchEvent`; the
 * dispatcher never knows whether an event came from a poller, a webhook, or a
 * page write. Connectors, channels, and pages are equal first-class sources.
 *
 * Design — ports over imports. `packages/core` stays pg-free; the API
 * package fulfils `findEventTriggeredWorkflows` (a workspace-scoped read of
 * `workflows.trigger`) and `startWorkflowRun` (create run + advance) at boot.
 *
 * Best-effort, never throws. The dispatcher fans out to N workflows as a
 * reactive side-effect: a failed finder or a failed per-workflow start must
 * neither block the producer nor abort the sibling workflows. Every failure
 * routes to the `onError` sink.
 *
 * Self-loop safety: a workflow that posts back into a watched channel can
 * re-trigger itself. `matchesEvent`'s `fromBots`-defaults-false gate is the
 * boundary — bot-authored events fire a subscription only when it opts in.
 *
 * Spec: docs/plans/company-brain/workflow-builder.md §Event trigger;
 * docs/architecture/features/workflow.md §Trigger surface.
 *
 * [COMP:workflow/event-trigger]
 */

import type { EventSourceRef, EventSubscription } from './types.js'

/**
 * A normalized event handed to the dispatcher. Producers populate the
 * matchable fields (`text` / `actorId` / `channelId` / `mentions` / `isBot`)
 * from their native payload; `payload` is the raw normalized event written
 * verbatim to `workflow_runs.input.event`.
 */
export type DispatchEvent = {
  /** Workspace the event — and any workflow it triggers — belongs to. */
  workspaceId: string
  /** Which source produced the event. Matched against each subscription. */
  source: EventSourceRef
  /** Human-readable event text — matched by `EventMatch.keywords`. */
  text: string | null
  /** Event actor id — matched by `EventMatch.fromActors`. */
  actorId: string | null
  /**
   * Sub-channel within the source (Slack channel, GitHub repo) — matched by
   * `EventMatch.inChannels`. For a `page` source this carries the lifecycle
   * action (`created` | `updated` | `moved`).
   */
  channelId: string | null
  /** Entities the event mentions — matched by `EventMatch.mentions`. */
  mentions: string[]
  /** Whether a bot authored the event — gated by `EventMatch.fromBots`. */
  isBot: boolean
  /** Raw normalized payload, written verbatim to `workflow_runs.input.event`. */
  payload: Record<string, unknown>
}

/**
 * A runnable event-triggered workflow. The finder returns only `enabled`
 * workflows carrying `trigger.kind='event'`; `sources` is their
 * `trigger.event.sources` list.
 */
export type EventTriggeredWorkflow = {
  workflowId: string
  workspaceId: string
  sources: EventSubscription[]
}

/**
 * Resolve a workspace → its event-triggered workflows. Called once per
 * dispatched event. The concrete impl reads `workflows` where
 * `trigger->>'kind' = 'event'` and `enabled = true` for the workspace; the
 * dispatcher does the source + `match` filtering in-process.
 */
export type EventTriggeredWorkflowFinder = (params: {
  workspaceId: string
}) => Promise<EventTriggeredWorkflow[]>

/**
 * Start one workflow run. The concrete impl mirrors the webhook receiver
 * (`runStore.createRun(...)` then `advanceWorkflowRun(...)`). Resolves once
 * the run is *started* — a run may still pause on `wait` / approval.
 */
export type WorkflowRunStarter = (params: {
  workflowId: string
  workspaceId: string
  input: WorkflowEventInput
}) => Promise<void>

/**
 * Shape written to `workflow_runs.input` for an event-triggered run. Steps
 * address it as `{{input.trigger.X}}` / `{{input.event.X}}`.
 */
export type WorkflowEventInput = {
  trigger: {
    /** Which kind of source fired the run. */
    sourceType: EventSourceRef['type']
    /** Provider / channel type — 'github' | 'fathom' | 'slack' | 'page' | … */
    provider: string
    /** Set when `sourceType='connector'`. */
    connectorInstanceId?: string
    /** Set when `sourceType='channel'`. */
    channelIntegrationId?: string
    /** Set when `sourceType='page'` — the watched page id. */
    pageId?: string
    /**
     * Sub-channel (Slack channel id, GitHub repo), or null. For a `page`
     * source this is the lifecycle action (`created` | `updated` | `moved`).
     */
    channelId: string | null
    /** Event actor id, or null. */
    actorId: string | null
  }
  /** The source-normalized event payload. */
  event: Record<string, unknown>
}

// ── Second subscriber type: goals parked on `until:event` ─────────────────
//
// The acting-loop driver (`packages/api/src/goals/driver.ts`) can park a goal
// on `until:event` — the iteration declared it is waiting on a specific event
// rather than polling. Such a goal is a SECOND first-class subscriber on the
// same event stream as workflows: the dispatcher matches the workspace's
// event-waiting goals against each event with the SAME `matchesEvent` and
// resumes the first hit (schedules a goal-tick). This is strictly additive —
// the workflow fan-out is untouched and runs whether or not the goal deps are
// wired.
//
// NOTE: the finder's data source — a DURABLE record of "goal G parked on
// subscription S" — is the gating follow-up (a `goals` migration + goals-store
// finder/writer + a `GoalResume` that carries the `EventSubscription`). Until
// that lands the deps below stay unwired and a parked goal falls back to the
// driver's safety-net poll. The seam is kept here, matched + isolated exactly
// like the workflow path, so wiring it is a pure addition. See
// docs/plans/task-goal-seeker.md.

/**
 * A goal parked on `until:event`. The finder returns goals in the workspace
 * whose acting loop declared it is waiting on one or more event subscriptions
 * (`sources`, OR-combined — mirrors `EventTriggeredWorkflow.sources`).
 */
export type EventWaitingGoal = {
  goalId: string
  workspaceId: string
  /** The subscriptions this goal parked on; any one matching resumes it. */
  sources: EventSubscription[]
}

/**
 * Resolve a workspace → its event-waiting goals. The optional second-subscriber
 * analog of `EventTriggeredWorkflowFinder`. Absent → no goal fan-out (default).
 */
export type EventWaitingGoalFinder = (params: {
  workspaceId: string
}) => Promise<EventWaitingGoal[]>

/**
 * Resume one event-waiting goal — the concrete impl schedules a goal-tick
 * carrying the event, exactly as the driver's re-arm does. The optional
 * second-subscriber analog of `WorkflowRunStarter`. Resolves once the resume
 * is *scheduled* (the tick fires asynchronously).
 */
export type EventWaitingGoalResumer = (params: {
  goalId: string
  workspaceId: string
  event: DispatchEvent
}) => Promise<void>

/** Context handed to `onError` so the sink can attribute a failure. */
export type WorkflowEventDispatchError = {
  workspaceId: string
  /** Set when a specific workflow's start failed; absent for a finder failure. */
  workflowId?: string
  /** Set when a specific goal's resume failed (the goal-subscriber path). */
  goalId?: string
}

export type WorkflowEventDispatcherDeps = {
  findEventTriggeredWorkflows: EventTriggeredWorkflowFinder
  startWorkflowRun: WorkflowRunStarter
  /**
   * OPTIONAL second subscriber type: goals parked on `until:event`. Wire BOTH
   * to enable the goal fan-out; if either is absent the dispatcher behaves
   * byte-for-byte as workflow-only (the default — see the `EventWaitingGoal`
   * note above for the gating follow-up). The goal fan-out runs INDEPENDENTLY
   * of the workflow path: a workspace with no event workflows still resumes a
   * matching goal, and a failure on either side never suppresses the other.
   */
  findEventWaitingGoals?: EventWaitingGoalFinder
  resumeEventWaitingGoal?: EventWaitingGoalResumer
  /**
   * Failure sink. The dispatcher never throws; every failure (the workflow
   * finder, a per-workflow start, the goal finder, or a per-goal resume) is
   * reported here. Defaults to a no-op.
   */
  onError?: (err: unknown, ctx: WorkflowEventDispatchError) => void
}

export type WorkflowEventDispatcher = {
  /** Match one event against the workspace's event workflows; start each hit. */
  dispatch(event: DispatchEvent): Promise<void>
}

/**
 * Does an event's source match a subscription's source ref? Same
 * discriminant, same instance id.
 */
function sourceMatches(event: EventSourceRef, ref: EventSourceRef): boolean {
  if (event.type === 'connector' && ref.type === 'connector') {
    return event.connectorInstanceId === ref.connectorInstanceId
  }
  if (event.type === 'channel' && ref.type === 'channel') {
    return event.channelIntegrationId === ref.channelIntegrationId
  }
  if (event.type === 'page' && ref.type === 'page') {
    return event.pageId === ref.pageId
  }
  return false
}

/**
 * Evaluate one `event`-trigger subscription against an event. The source
 * must match; then the optional `match` filter — every present field
 * AND-combined, the list within a field OR-combined.
 *
 * The bot gate applies *even with no `match` block*: a bot-authored event
 * fires a subscription only when it set `match.fromBots = true`. An absent
 * `match` therefore means "every non-bot event from this source".
 */
export function matchesEvent(
  event: DispatchEvent,
  sub: EventSubscription,
): boolean {
  if (!sourceMatches(event.source, sub.source)) return false

  const m = sub.match
  if (event.isBot && m?.fromBots !== true) return false
  if (!m) return true

  if (m.keywords && m.keywords.length > 0) {
    const haystack = (event.text ?? '').toLowerCase()
    if (!m.keywords.some((k) => haystack.includes(k.toLowerCase()))) return false
  }
  if (m.fromActors && m.fromActors.length > 0) {
    if (event.actorId === null || !m.fromActors.includes(event.actorId)) {
      return false
    }
  }
  if (m.inChannels && m.inChannels.length > 0) {
    if (event.channelId === null || !m.inChannels.includes(event.channelId)) {
      return false
    }
  }
  if (m.mentions && m.mentions.length > 0) {
    const want = m.mentions
    if (!event.mentions.some((x) => want.includes(x))) return false
  }
  return true
}

/** Build the `workflow_runs.input` payload for an event-triggered run. */
function buildInput(event: DispatchEvent): WorkflowEventInput {
  const src = event.source
  let trigger: WorkflowEventInput['trigger']
  if (src.type === 'connector') {
    trigger = {
      sourceType: 'connector',
      provider: src.provider,
      connectorInstanceId: src.connectorInstanceId,
      channelId: event.channelId,
      actorId: event.actorId,
    }
  } else if (src.type === 'channel') {
    trigger = {
      sourceType: 'channel',
      provider: src.channel,
      channelIntegrationId: src.channelIntegrationId,
      channelId: event.channelId,
      actorId: event.actorId,
    }
  } else {
    trigger = {
      sourceType: 'page',
      provider: 'page',
      pageId: src.pageId,
      // For a page source `channelId` is the lifecycle action.
      channelId: event.channelId,
      actorId: event.actorId,
    }
  }
  return { trigger, event: event.payload }
}

/**
 * Build the shared workflow event dispatcher. Construct one at app boot and
 * hand it to every event producer — the connector poll producers (via the
 * ingest `onEvent` adapter) and the channel webhooks.
 */
export function createWorkflowEventDispatcher(
  deps: WorkflowEventDispatcherDeps,
): WorkflowEventDispatcher {
  // ── Subscriber 1: event-triggered workflows. The original behavior, kept
  //    byte-for-byte — its early returns scope to this helper, never to the
  //    whole dispatch (so they cannot suppress the goal subscriber below). ──
  async function dispatchToWorkflows(event: DispatchEvent): Promise<void> {
    let workflows: EventTriggeredWorkflow[]
    try {
      workflows = await deps.findEventTriggeredWorkflows({
        workspaceId: event.workspaceId,
      })
    } catch (err) {
      deps.onError?.(err, { workspaceId: event.workspaceId })
      return
    }
    if (workflows.length === 0) return

    const input = buildInput(event)

    for (const wf of workflows) {
      // A workflow fires at most once per event, even when several of its
      // subscriptions match.
      if (!wf.sources.some((sub) => matchesEvent(event, sub))) continue
      try {
        await deps.startWorkflowRun({
          workflowId: wf.workflowId,
          workspaceId: wf.workspaceId,
          input,
        })
      } catch (err) {
        deps.onError?.(err, {
          workspaceId: wf.workspaceId,
          workflowId: wf.workflowId,
        })
      }
    }
  }

  // ── Subscriber 2 (optional, additive): goals parked on `until:event`. A
  //    no-op unless BOTH goal deps are wired, so default dispatch is identical
  //    to workflow-only behavior. Independent of subscriber 1 — runs even when
  //    the workspace has no event workflows, and is isolated per-goal exactly
  //    as the workflow start is isolated per-workflow. ──
  async function dispatchToGoals(event: DispatchEvent): Promise<void> {
    const findGoals = deps.findEventWaitingGoals
    const resumeGoal = deps.resumeEventWaitingGoal
    if (!findGoals || !resumeGoal) return

    let goals: EventWaitingGoal[]
    try {
      goals = await findGoals({ workspaceId: event.workspaceId })
    } catch (err) {
      deps.onError?.(err, { workspaceId: event.workspaceId })
      return
    }

    for (const g of goals) {
      // A goal resumes at most once per event, even when several of the
      // subscriptions it parked on match.
      if (!g.sources.some((sub) => matchesEvent(event, sub))) continue
      try {
        await resumeGoal({ goalId: g.goalId, workspaceId: g.workspaceId, event })
      } catch (err) {
        deps.onError?.(err, { workspaceId: g.workspaceId, goalId: g.goalId })
      }
    }
  }

  return {
    async dispatch(event) {
      // Two independent subscriber fan-outs over one event. Workflows first
      // (unchanged), then the optional goal subscriber. Neither suppresses the
      // other; each isolates its own failures to `onError`.
      await dispatchToWorkflows(event)
      await dispatchToGoals(event)
    },
  }
}
