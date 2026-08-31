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
 *     parent);
 *   - tasks      → `workflow/task-event-trigger.ts` (the task write path);
 *   - knowledge  → `workflow/knowledge-event-trigger.ts` (the KB store's
 *     write chokepoints — sync worker, assistant write-through, manual edits).
 *   - brand      → `workflow/brand-event-trigger.ts` (the brand store's write
 *     chokepoints — Studio routes, the updateBrandDraft tool, brain MCP).
 *   - crm        → `workflow/crm-event-trigger.ts` (the committed CRM domain
 *     event outbox worker).
 * Each producer normalizes its native event into a `DispatchEvent`; the
 * dispatcher never knows whether an event came from a poller, a webhook, or a
 * page write. Every source kind is equally first-class.
 *
 * Design — ports over imports. `packages/core` stays pg-free; the API
 * package fulfils `findEventTriggeredWorkflows` (a workspace-scoped read of
 * `workflows.trigger`) and `startWorkflowRun` (create run + advance) at boot.
 *
 * `dispatch` is best-effort and never throws. The dispatcher fans out to N workflows as a
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
   * `EventMatch.inChannels`. For a `page` / `task` / `knowledge` source this
   * carries the primary lifecycle action (`created` | `updated` | …).
   */
  channelId: string | null
  /**
   * Every lifecycle facet of the write, when one write carries several (a
   * task update can be `completed` AND `tagged`). `EventMatch.inChannels`
   * matches this **set** when present — intersection ≠ ∅ passes — falling
   * back to `[channelId]` when absent, so single-action producers
   * (connector / channel / page) are unaffected. `channelId` stays the
   * display-precedence primary.
   */
  actions?: string[]
  /** Entities the event mentions — matched by `EventMatch.mentions`. */
  mentions: string[]
  /**
   * Event tags — matched by `EventMatch.tags` (overlap). Only `task` and
   * `knowledge` events carry these: for tasks the full tag set on `created`
   * and the ADDED set on updates (appearance semantics — see workflow.md →
   * "Task event source"); for knowledge the entry's frontmatter tags.
   */
  tags?: string[]
  /** Current full task tag set, matched only by task `EventMatch.currentTags`. */
  currentTags?: string[]
  /** Whether a bot authored the event — gated by `EventMatch.fromBots`. */
  isBot: boolean
  /** Whether a channel event came from a shared group conversation. */
  isGroupChat?: boolean
  /** Provider account that received the event (for source-bound replies). */
  providerAccountId?: string
  /** Provider-authored occurrence time, normalized to ISO-8601. */
  occurredAt?: string
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
    /** Trusted provider account id, when the producer supplies one. */
    providerAccountId?: string
    /** Trusted provider event time, normalized to ISO-8601. */
    occurredAt?: string
    /** Trusted channel conversation shape, when the producer supplies one. */
    isGroupChat?: boolean
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
   * System-side exposure lookup for connector events. The producer workspace
   * always remains a target; this port returns additional workspaces that
   * currently hold a live connector grant for the exact instance. Omitted for
   * minimal boots/tests. A lookup failure fails closed for additional targets
   * while preserving the producer workspace's existing behavior.
   */
  findAdditionalConnectorEventWorkspaces?: (params: {
    connectorInstanceId: string
    producerWorkspaceId: string
  }) => Promise<string[]>
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
  /**
   * Same fan-out, but rejects after attempting every subscriber when any
   * finder/start failed. Durable outbox workers use this to retain retry state;
   * best-effort inline producers keep using `dispatch`.
   */
  dispatchStrict?: (event: DispatchEvent) => Promise<void>
}

export type StrictWorkflowEventDispatcher = WorkflowEventDispatcher & {
  dispatchStrict(event: DispatchEvent): Promise<void>
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
  if (event.type === 'task' && ref.type === 'task') {
    // Id-less source: every task event in the (already workspace-scoped)
    // dispatch matches; `match` carries all the selectivity.
    return true
  }
  if (event.type === 'knowledge' && ref.type === 'knowledge') {
    // Id-less source, same reasoning as `task`: a workspace's KB is one
    // corpus even when several sources feed it.
    return true
  }
  if (event.type === 'brand' && ref.type === 'brand') {
    // Id-less source, same reasoning again: a workspace's brand system is one
    // corpus; the slug rides `match.tags` when a subscription needs to narrow
    // to a single brand.
    return true
  }
  if (event.type === 'crm' && ref.type === 'crm') {
    // Id-less committed domain source; match fields provide selectivity.
    return true
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
    // Match the action SET when the producer emits one (a task write can be
    // `completed` AND `tagged` in one event); single-action producers fall
    // back to the singleton [channelId].
    const eventChannels =
      event.actions && event.actions.length > 0
        ? event.actions
        : event.channelId !== null
          ? [event.channelId]
          : []
    const want = m.inChannels
    if (!eventChannels.some((c) => want.includes(c))) return false
  }
  if (m.mentions && m.mentions.length > 0) {
    const want = m.mentions
    if (!event.mentions.some((x) => want.includes(x))) return false
  }
  if (m.tags && m.tags.length > 0) {
    const eventTags = event.tags ?? []
    const want = m.tags
    if (!eventTags.some((t) => want.includes(t))) return false
  }
  if (m.currentTags && m.currentTags.length > 0) {
    if (event.source.type !== 'task') return false
    const currentTags = event.currentTags ?? []
    const want = m.currentTags
    if (!currentTags.some((tag) => want.includes(tag))) return false
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
      ...(event.providerAccountId ? { providerAccountId: event.providerAccountId } : {}),
      ...(event.occurredAt ? { occurredAt: event.occurredAt } : {}),
      ...(event.isGroupChat !== undefined ? { isGroupChat: event.isGroupChat } : {}),
    }
  } else if (src.type === 'page') {
    trigger = {
      sourceType: 'page',
      provider: 'page',
      pageId: src.pageId,
      // For a page source `channelId` is the lifecycle action.
      channelId: event.channelId,
      actorId: event.actorId,
    }
  } else if (src.type === 'task') {
    trigger = {
      sourceType: 'task',
      provider: 'task',
      // For a task source `channelId` is the primary lifecycle action; the
      // full action set lives in the payload (`input.event.actions`).
      channelId: event.channelId,
      actorId: event.actorId,
    }
  } else if (src.type === 'knowledge') {
    trigger = {
      sourceType: 'knowledge',
      provider: 'knowledge',
      // For a knowledge source `channelId` is the lifecycle action; the
      // entry's id + path live in the payload (`input.event.entryId` /
      // `input.event.path`).
      channelId: event.channelId,
      actorId: event.actorId,
    }
  } else if (src.type === 'brand') {
    trigger = {
      sourceType: 'brand',
      provider: 'brand',
      // For a brand source `channelId` is the lifecycle action; the brand's
      // id + slug live in the payload (`input.event.brandId` /
      // `input.event.slug`).
      channelId: event.channelId,
      actorId: event.actorId,
    }
  } else {
    trigger = {
      sourceType: 'crm',
      provider: 'crm',
      // The closed CRM event type is the source sub-channel.
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
): StrictWorkflowEventDispatcher {
  async function targetEvents(event: DispatchEvent, failures?: unknown[]): Promise<DispatchEvent[]> {
    const findAdditional = deps.findAdditionalConnectorEventWorkspaces
    if (event.source.type !== 'connector' || !findAdditional) return [event]

    let additionalWorkspaceIds: string[]
    try {
      additionalWorkspaceIds = await findAdditional({
        connectorInstanceId: event.source.connectorInstanceId,
        producerWorkspaceId: event.workspaceId,
      })
    } catch (err) {
      // The original producer workspace is already a trusted routing result.
      // A grant lookup outage must not broaden access, and must not regress
      // that existing target either.
      deps.onError?.(err, { workspaceId: event.workspaceId })
      failures?.push(err)
      return [event]
    }

    const workspaceIds = [...new Set([
      event.workspaceId,
      ...additionalWorkspaceIds.filter((id) => id.length > 0),
    ])]
    return workspaceIds.map((workspaceId) =>
      workspaceId === event.workspaceId ? event : { ...event, workspaceId },
    )
  }

  // ── Subscriber 1: event-triggered workflows. The original behavior, kept
  //    byte-for-byte — its early returns scope to this helper, never to the
  //    whole dispatch (so they cannot suppress the goal subscriber below). ──
  async function dispatchToWorkflows(event: DispatchEvent, failures?: unknown[]): Promise<void> {
    let workflows: EventTriggeredWorkflow[]
    try {
      workflows = await deps.findEventTriggeredWorkflows({
        workspaceId: event.workspaceId,
      })
    } catch (err) {
      deps.onError?.(err, { workspaceId: event.workspaceId })
      failures?.push(err)
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
        failures?.push(err)
      }
    }
  }

  // ── Subscriber 2 (optional, additive): goals parked on `until:event`. A
  //    no-op unless BOTH goal deps are wired, so default dispatch is identical
  //    to workflow-only behavior. Independent of subscriber 1 — runs even when
  //    the workspace has no event workflows, and is isolated per-goal exactly
  //    as the workflow start is isolated per-workflow. ──
  async function dispatchToGoals(event: DispatchEvent, failures?: unknown[]): Promise<void> {
    const findGoals = deps.findEventWaitingGoals
    const resumeGoal = deps.resumeEventWaitingGoal
    if (!findGoals || !resumeGoal) return

    let goals: EventWaitingGoal[]
    try {
      goals = await findGoals({ workspaceId: event.workspaceId })
    } catch (err) {
      deps.onError?.(err, { workspaceId: event.workspaceId })
      failures?.push(err)
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
        failures?.push(err)
      }
    }
  }

  async function run(event: DispatchEvent, strict: boolean): Promise<void> {
    const failures = strict ? [] as unknown[] : undefined
    // One physical connector event may target several explicitly exposed
    // workspaces. Each target still needs its own matching subscription;
    // merely holding a grant never persists the event or starts a run.
    const events = await targetEvents(event, failures)
    for (const targetEvent of events) {
      // Two independent subscriber fan-outs over one workspace event.
      // Workflows first, then the optional goal subscriber. Neither
      // suppresses the other; each isolates failures to `onError`.
      await dispatchToWorkflows(targetEvent, failures)
      await dispatchToGoals(targetEvent, failures)
    }
    if (failures?.length) {
      const error = new Error(`Workflow event dispatch failed for ${failures.length} subscriber operation(s).`)
      ;(error as Error & { causes?: unknown[] }).causes = failures
      throw error
    }
  }

  return {
    dispatch: (event) => run(event, false),
    dispatchStrict: (event) => run(event, true),
  }
}
