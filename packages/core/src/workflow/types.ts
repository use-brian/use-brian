/**
 * Workflow primitive — type vocabulary + store interfaces.
 *
 * V1 ships four step types fused with the brain (assistant_call, tool_call,
 * wait, branch). See docs/architecture/features/workflow.md for the spec and
 * `schemas.ts` for the runtime Zod source-of-truth.
 *
 * Stores follow the same boundary as the rest of `@sidanclaw/core`: the core
 * declares the interface; concrete `pg`-backed implementations live in
 * `packages/api/src/db/workflow-store.ts`.
 *
 * [COMP:workflow/types]
 */

import type { ResearchDepthConfig } from '../engine/research-depth.js'

// ── Definition shape ────────────────────────────────────────────────────

/**
 * `'primary'` is a sentinel that resolves at run time to the workspace's
 * `kind='primary'` assistant. UUIDs are pinned and durable but become
 * dangling if the target is deleted (failed step at run time).
 */
export type AssistantTargetRef = string | 'primary'

export type WorkflowStepCommon = {
  /** Stable identifier within the definition. */
  id: string
  /** Optional human-readable label for audit + getWorkflowRun output. */
  description?: string
  /**
   * Override for sequential fall-through. `null` = terminal (run completes
   * after this step). Omit = use the next step in `definition.steps[]`.
   * Branch steps ignore this (their if/else pair wins).
   */
  nextStepId?: string | null
  /**
   * If set, the step's output is stashed into `vars[storeOutputAs]` so
   * subsequent steps can reference it via `{{vars.X}}` interpolation or in
   * branch conditions.
   */
  storeOutputAs?: string
}

/**
 * Page anchor on an `assistant_call` step. When set, the callee runs
 * doc-anchored exactly like an interactive doc chat turn:
 * `ToolContext.docViewId` is the resolved page id and the doc tools
 * (`getCurrentPage` / `patchPage` / `renderPage` / ...) are injected into
 * the callee surface. Three variants, resolved by the executor to one
 * concrete page uuid before the consult (`ConsultRequest.pageAnchorId`):
 *
 *  - `{ id }`       — edit an existing page: a static uuid, or exactly one
 *                     whole-string `{{vars.x}}` / `{{input.x}}` token
 *                     (Phase B) resolved at run time and UUID-shape-checked
 *                     before the consult (typed `invalid_page_anchor` on a
 *                     bad resolution). Mixed strings are rejected at
 *                     authoring. Cross-step composition within one run is
 *                     still `fromStep`, not interpolation.
 *  - `{ create }`   — the executor creates a fresh **saved** page this run
 *                     (a configured deliverable must not auto-prune) via the
 *                     `ExecutorDeps.createAnchorPage` port, then anchors the
 *                     callee to it. `title` IS interpolatable; default is
 *                     `"<workflow.name> <YYYY-MM-DD>"`. The created id is
 *                     stored in run vars under the reserved key
 *                     `__pageAnchor_<stepId>`. `reuse` controls cross-run
 *                     identity: `'per-run'` (default) mints a fresh page every
 *                     run; `'per-workflow'` does find-or-create against a
 *                     stable `<workflowId>:<stepId>` anchor key so a recurring
 *                     workflow appends to ONE page instead of leaving a trail
 *                     of empty duplicates (the recurring-anchor footgun fix).
 *  - `{ fromStep }` — anchor to the page a prior `{ create }` step made in
 *                     THIS run (read from `vars.__pageAnchor_<fromStep>`).
 *
 * See docs/plans/workflow-page-anchor.md and
 * docs/architecture/features/workflow.md → "assistant_call page anchor".
 */
export type PageAnchor =
  | { id: string }
  | { create: true; title?: string; nestUnder?: string; reuse?: 'per-run' | 'per-workflow' }
  | { fromStep: string }

export type AssistantCallStep = WorkflowStepCommon & {
  type: 'assistant_call'
  target: {
    assistantId: AssistantTargetRef
    /** V1: undefined (free mode). Restricted mode + capabilities deferred. */
    capabilityId?: string
  }
  /** May reference `{{vars.X}}` and `{{input.X}}`. */
  prompt: string
  /**
   * Optional allow-list of tool names the callee may use during this step.
   * Enforced via `ConsultRequest.allowedTools` — the callee's tool surface is
   * narrowed to exactly this set.
   * See `docs/plans/company-brain/workflow-builder.md`.
   */
  tools?: string[]
  /**
   * Optional allow-list of brain skill slugs the callee may activate during
   * this step. When non-empty, the callee is offered the `useSkill` tool over
   * exactly these skills (built-in ids or workspace skill slugs), each still
   * passed through the normal enablement + clearance gates — a slug the callee
   * assistant is not entitled to is silently dropped. Threaded via
   * `ConsultRequest.skills`. Absent / empty → no skill surface, exactly the
   * historical behavior. Independent of `tools`: skills are injected AFTER the
   * `tools` allow-list, so a `tools` restriction never strips `useSkill`.
   * See `docs/architecture/features/workflow.md` → "assistant_call skills".
   */
  skills?: string[]
  /**
   * Optional list of brain skill slugs the callee is FORCED to run this step.
   * Unlike `skills` (discovery — offered via `useSkill`, the model chooses),
   * each enforced skill's instructions are loaded (with support-file pointer
   * expansion) and injected directly into the callee's system prompt under a
   * `# Required Skills` block, so the assistant follows them regardless of
   * whether it would have picked them. Same governance as `skills`: a slug the
   * callee assistant is not entitled to (disabled / out of clearance / wrong
   * app_type / missing connector) is silently dropped — a workflow step cannot
   * escalate a skill the assistant could not otherwise run. A slug that is
   * enforced is not also offered for discovery (no double surface). Threaded
   * via `ConsultRequest.enforcedSkills`.
   * See `docs/architecture/features/workflow.md` → "assistant_call skills".
   */
  enforcedSkills?: string[]
  /**
   * Optional page anchor — the bounded "edit page X" / "create a page"
   * configuration. See `PageAnchor`. Composes with `tools`: the allow-list
   * is applied AFTER doc-tool injection, so it can pin an anchored callee
   * to a doc subset (an allow-list naming no doc tool strips them all —
   * surfaced as an authoring warning).
   */
  page?: PageAnchor
  /**
   * Optional delivery target. When set, the step's text response is pushed
   * to this user channel after the consult completes (best-effort).
   * See `docs/architecture/engine/scheduled-jobs.md` → "Channel delivery".
   */
  deliver?: {
    channelType: 'web' | 'telegram' | 'slack' | 'whatsapp'
    channelId: string
  }
  /**
   * Session continuity. `persistent` reuses one durable callee session
   * across fires (recurring-workflow memory); `per_run` (default) is a
   * fresh consult each time.
   * See `docs/architecture/engine/scheduled-jobs.md` → "Session continuity".
   */
  session?: 'per_run' | 'persistent'
  /**
   * Optional research-depth override for this step's agentic loop — a tier
   * preset and/or numeric overrides (`{ tier?, maxTurns?, maxToolCalls?,
   * timeoutMs? }`). Resolved by the callee executor against
   * `ASSISTANT_CALL_DEFAULT_BUDGET`. Absent = the historical 5-turn / 30s
   * step budget. See `packages/core/src/engine/research-depth.ts`.
   */
  depth?: ResearchDepthConfig
  /** Per-step model alias. Falls back to executor default ('standard') when absent. */
  modelAlias?: WorkflowModelAlias
  /** When true, executor applies the `deep` research tier for this step. */
  researchMode?: boolean
  /** Hard turn cap for this step's callee loop. Null/undefined = executor default. */
  maxTurns?: number | null
  /**
   * Optional blueprint to FILL on a research step (structural-synthesis P4). With
   * a page anchor on a `researchMode`/`deep` step, the executor runs the research
   * fan-out as the gather, then fills this blueprint into the anchored page via
   * `synthesizeFromSource` (the structured authoring half) instead of free-form
   * authoring. A blueprint slug: a built-in skill id, workspace skill slug, or
   * page-template id. Mirrors `blueprintId` in `schemas.ts` (Zod authoritative).
   * See docs/architecture/brain/structural-synthesis.md → "The three fill modes".
   */
  blueprintId?: string
}

export type ToolCallStep = WorkflowStepCommon & {
  type: 'tool_call'
  toolName: string
  /** Values may interpolate `{{vars.X}}` / `{{input.X}}` (deep walk). */
  arguments: Record<string, unknown>
  /**
   * Phase C — used only when the resolved tool is `ask`-policy. Optional;
   * omitted = use workflow-level default; missing both = web-UI-only delivery.
   */
  approval?: {
    deliveryChannel?: 'web' | 'telegram' | 'slack' | 'whatsapp'
    /**
     * Hours before the approval auto-expires (status='expired').
     * Omit for no expiry — totally detached, user can return any time.
     */
    expiresAfterHours?: number
  }
}

export type WaitDuration = {
  minutes?: number
  hours?: number
  days?: number
}

export type WaitStep = WorkflowStepCommon & {
  type: 'wait'
  /** Exactly one of `until` or `at`. Validated by Zod. */
  until?: { duration: WaitDuration }
  at?: {
    /** Local datetime (no Z / offset), e.g. "2026-05-10T08:00:00". */
    datetime: string
    /** IANA timezone, e.g. "Asia/Hong_Kong". Defaults to "UTC". */
    timezone?: string
  }
}

/**
 * Vendored JSONLogic rule. See `condition.ts` for the supported subset.
 * Validated by `schemas.ts` to be a non-null object/array; semantic
 * validation happens at evaluation time.
 */
export type JsonLogicRule = unknown

export type BranchStep = WorkflowStepCommon & {
  type: 'branch'
  condition: JsonLogicRule
  /** `null` = terminal. */
  nextStepIdIfTrue: string | null
  nextStepIdIfFalse: string | null
}

export type WorkflowStep =
  | AssistantCallStep
  | ToolCallStep
  | WaitStep
  | BranchStep

export type WorkflowStepType = WorkflowStep['type']

export const WORKFLOW_STEP_TYPES = [
  'assistant_call',
  'tool_call',
  'wait',
  'branch',
] as const satisfies ReadonlyArray<WorkflowStepType>

export type WorkflowDefinition = {
  startStepId: string
  steps: WorkflowStep[]
}

// ── Event trigger ───────────────────────────────────────────────────────

/**
 * One event source an `event`-trigger workflow listens on. Connectors,
 * channels, and the workspace's own doc pages are all first-class:
 *
 *  - `connector` — a `connector_instance` row (GitHub, Fathom, Gmail,
 *    Calendar — anything with an ingest poller). Its events reach the
 *    workflow dispatcher through the ingest engine's `onEvent` seam.
 *  - `channel` — a `channel_integrations` row (Slack, Telegram, WhatsApp —
 *    a BYO bot). Its events reach the dispatcher straight from the channel
 *    webhook, with no `connector_instance` substrate in between.
 *  - `page` — an *internal* source: one watched doc page. It fires when a
 *    page is **created or moved directly under** the watched page (the watched
 *    page is the new parent), or when the watched page **itself is updated**.
 *    Its events reach the dispatcher from the saved-views store write path
 *    (`page-event-fanout.ts` → `pageLifecycleToDispatchEvent`), not a poller or
 *    webhook. The lifecycle action (`created` | `updated` | `moved`) is the
 *    event sub-channel — `match.inChannels: ['created']` narrows a subscription
 *    to one action, exactly as `inChannels` narrows a GitHub repo or Slack
 *    channel. See docs/architecture/features/workflow.md → "Page event source".
 *
 * A workflow can wire any kind, or several of any, into one trigger.
 */
export type EventSourceRef =
  | {
      type: 'connector'
      /** `connector_instance.id` whose ingest events feed this workflow. */
      connectorInstanceId: string
      /** Denormalized `connector_instance.provider` — 'github' | 'fathom' | … */
      provider: string
    }
  | {
      type: 'channel'
      /** `channel_integrations.id` whose inbound messages feed this workflow. */
      channelIntegrationId: string
      /** Denormalized channel type — 'slack' | 'telegram' | 'whatsapp'. */
      channel: string
    }
  | {
      type: 'page'
      /**
       * The watched page (`saved_views.id`). Two event shapes fire it, both
       * relative to this page:
       *   - a page is **created or moved directly under** it — the watched
       *     page is the new `nest_parent_id` (action `created` / `moved`);
       *   - the watched page **itself is updated** (action `updated`).
       * This is the source's identity — the `connectorInstanceId` /
       * `channelIntegrationId` analog that `sourceMatches` compares exactly.
       * Workspace-root pages (`nest_parent_id IS NULL`) carry the
       * `PAGE_EVENT_ROOT` sentinel, so "created/moved at the workspace root" is
       * not targetable by a uuid subscription; a root page's own `updated`
       * event still is (it carries the page's own uuid).
       */
      pageId: string
    }
  | {
      /**
       * The workspace's task table — an *internal*, **id-less** source: there
       * is no natural "one task to watch", so the subscription scope is every
       * task write in the workspace and `match` does all the selection.
       * Lifecycle actions (`created` | `completed` | `blocked` | `reopened` |
       * `assigned` | `tagged` | `updated`) ride the `inChannels` axis; task
       * tags ride the task-only `match.tags` filter (full set on `created`,
       * ADDED set on updates — appearance semantics). Events reach the
       * dispatcher from the task write path (`task-event-fanout.ts` →
       * `taskLifecycleToDispatchEvent`), not a poller or webhook. See
       * docs/architecture/features/workflow.md → "Task event source".
       */
      type: 'task'
    }

/**
 * Declarative selectivity on one event subscription. Every present field is
 * AND-combined; the list within a field is OR-combined; an absent field is
 * not a constraint. Evaluated by `matchesEvent` (`event-trigger.ts`) — there
 * is no filter registry, the struct *is* the filter.
 *
 * `fromBots` defaults to `false`: a bot-authored event fires a workflow only
 * when its subscription opts in. That default is the self-loop guard — a
 * workflow that posts back into a watched channel does not re-trigger itself
 * unless it explicitly asked to see bot traffic.
 */
export type EventMatch = {
  /** Case-insensitive substring of the event text. */
  keywords?: string[]
  /** Event actor id (Slack user id, GitHub login) ∈ list. */
  fromActors?: string[]
  /**
   * Event sub-channel (Slack channel id, GitHub repo, lifecycle action) ∈
   * list. Evaluated against the event's action **set** when the producer
   * emits one (`DispatchEvent.actions`), so a multi-facet write (a task
   * update that both completes and tags) satisfies a filter on either facet.
   */
  inChannels?: string[]
  /** Any entity the event mentions ∈ list. */
  mentions?: string[]
  /**
   * Event tags ∩ list ≠ ∅. Only `task` events carry tags (full set on
   * `created`, ADDED set on updates — appearance semantics); a `tags` filter
   * on a connector / channel / page subscription never matches.
   */
  tags?: string[]
  /** Allow bot-authored events to fire this subscription. Default false. */
  fromBots?: boolean
}

/** One `(source, match)` subscription on an `event`-trigger workflow. */
export type EventSubscription = {
  source: EventSourceRef
  /** Optional selectivity. Absent → every non-bot event from the source. */
  match?: EventMatch
}

/**
 * Trigger config stored on `workflows.trigger` (mig 141). Mirrors
 * `WorkflowTriggerSchema` in `schemas.ts` — the Zod schema is authoritative.
 */
export type WorkflowTrigger =
  | { kind: 'manual' }
  | {
      kind: 'schedule'
      schedule:
        | { type: 'once'; datetime: string }
        | { type: 'daily'; time: string }
        | { type: 'weekly'; days: string[]; time: string }
        | { type: 'monthly'; dayOfMonth: number; time: string }
        | { type: 'cron'; expression: string }
      timezone?: string
      /** Timezone ownership — mirrors `scheduled_jobs.mode`. Default 'local'. */
      mode?: 'local' | 'user'
      /**
       * Authoring sugar — a delivery channel TYPE the create/update path
       * resolves to a concrete chat id + Telegram topic and stamps onto the
       * sole/terminal `assistant_call` step's `deliver`. See
       * docs/plans/scheduling-authoring-unification.md §3.
       */
      delivery?: { channel: 'telegram' | 'slack' | 'whatsapp' }
      /**
       * Trigger-row behavioral policy — mirrors the `scheduled_jobs` columns.
       * The nag pair (interval + keyword) must be set together.
       */
      policy?: {
        silentUntilFire?: boolean
        nagIntervalMins?: number
        nagUntilKeyword?: string
      }
    }
  | {
      kind: 'webhook'
      /**
       * Optional server-side event filter. `match.condition` is JSONLogic
       * (`condition.ts`) the receiver evaluates against `{ input: <payload> }`;
       * a falsy result ACKs 200 without a run. Mirrors the schema's webhook
       * `match`. Absent → fire on every signed delivery.
       */
      match?: { condition: JsonLogicRule }
    }
  | {
      /**
       * Fired when an event arrives on any subscribed source — connector
       * instance, channel integration, or doc-page subtree — whose optional
       * `match` filter passes. The generic `createWorkflowEventDispatcher`
       * (`workflow/event-trigger.ts`) dispatches; connector events reach it
       * through the ingest engine's `onEvent` seam, channel events straight
       * from the channel webhook, page events from the saved-views store write
       * path. Independent of the ingest rule's `alert` flag. See
       * docs/plans/company-brain/workflow-builder.md §Event trigger.
       */
      kind: 'event'
      event: {
        /** Sources this workflow listens on. At least one. */
        sources: EventSubscription[]
      }
    }

// ── Run-state machine ───────────────────────────────────────────────────

/**
 * Mirrors the sessions.status pattern. `awaiting_wait` is set by Phase B's
 * `wait` step; `awaiting_input` is set by Phase C's `ask`-policy pause.
 */
export const WORKFLOW_RUN_STATUSES = [
  'pending',
  'running',
  'awaiting_wait',
  'awaiting_input',
  'completed',
  'failed',
  'timeout',
] as const
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number]

export const WORKFLOW_STEP_RUN_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
] as const
export type WorkflowStepRunStatus = (typeof WORKFLOW_STEP_RUN_STATUSES)[number]

export type WorkflowTriggerKind = 'manual' | 'schedule'

// ── Records ─────────────────────────────────────────────────────────────

/** Workflow-level model alias — matches the per-assistant column vocabulary. */
export type WorkflowModelAlias = 'standard' | 'pro' | 'max'

export type WorkflowRecord = {
  id: string
  workspaceId: string
  createdBy: string
  name: string
  description: string | null
  definition: WorkflowDefinition
  enabled: boolean
  /**
   * Mig 302. Why the workflow was auto-disabled (the event-dispatch storm
   * guard), human-readable. Null when never paused; cleared when a PATCH
   * re-enables the workflow.
   */
  pausedReason: string | null
  /** Mig 141. Defaults to `{ kind: 'manual' }`. */
  trigger: WorkflowTrigger
  /** Mig 141. Set when `trigger.kind === 'webhook'`; null otherwise. */
  webhookSlug: string | null
  /** Mig 141. Set alongside `webhookSlug`. */
  webhookSecret: string | null
  /**
   * Mig 196. Per-workflow run-time settings — the model + research budget the
   * executor applies to every `assistant_call` step in this workflow. A step's
   * own `depth` override still wins; otherwise the executor inherits these.
   */
  modelAlias: WorkflowModelAlias
  /** Mig 196. Hard turn cap for the callee loop. Null = use defaults. */
  maxTurns: number | null
  /** Mig 196. When true, executor injects `deep` research budget by default. */
  researchMode: boolean
  /**
   * Mig 202. Set to true when the user renames the workflow via PATCH; the
   * auto-titler (mirrors `sessions.title_manually_set`) refuses to overwrite
   * the name once this flips.
   */
  nameManuallySet: boolean
  createdAt: Date
  updatedAt: Date
}

/**
 * Distilled, durable summary of a TERMINAL run, written once when the run
 * reaches `completed` / `failed` / `timeout`. The next run of the same
 * workflow reads it as `{{lastRun.*}}` (the cross-run loop substrate) and a
 * branch step can route on it. Null until the run terminates.
 *
 * Population (executor `composeRunOutcome`):
 *  - `status` / `finishedAt` / `logs` / `summary` — always engine-derived.
 *  - `blockers` — failure messages, UNIONed with an author-stored `blockers`
 *    var (string | string[]).
 *  - `todo` — from an author-stored `todo` var (string | string[]).
 *  - `state` — from an author-stored `state` var (object); the carry-forward
 *    bag. Authors hand data to the next run with `storeOutputAs: 'state' |
 *    'todo' | 'blockers' | 'summary'` (plain identifiers — the `__`-prefixed
 *    reserved keys are engine-only). See docs/architecture/features/workflow.md
 *    → "Cross-run state".
 */
export type WorkflowRunOutcome = {
  status: Extract<WorkflowRunStatus, 'completed' | 'failed' | 'timeout'>
  /** One-line gist — author `summary` var, else the last step's text output. */
  summary: string | null
  /** Per-step trace: what ran and how it ended. */
  logs: Array<{
    stepId: string
    type: WorkflowStepType
    status: 'completed' | 'failed'
    summary: string
  }>
  /** Open questions / failures the next run should check are resolved. */
  blockers: string[]
  /** Hand-off items the next run should work through. */
  todo: string[]
  /** Free-form carry-forward bag (`{{lastRun.state.X}}`). */
  state: Record<string, unknown>
  /** ISO timestamp the run terminated. */
  finishedAt: string
}

/**
 * The var names that double as the cross-run hand-off: a step storing into one
 * of these via `storeOutputAs` has its value distilled into the run's
 * `WorkflowRunOutcome` (→ `{{lastRun.<name>}}` on the next run). The single
 * canonical list both `composeRunOutcome` (executor) and the `proposeWorkflow`
 * authoring warning (tools) read, so the contract can never drift between the
 * capture site and the guard. See docs/architecture/features/workflow.md →
 * "Cross-run state".
 */
export const RESERVED_OUTCOME_VAR_NAMES = ['summary', 'state', 'todo', 'blockers'] as const
export type ReservedOutcomeVarName = (typeof RESERVED_OUTCOME_VAR_NAMES)[number]

export type WorkflowRunRecord = {
  id: string
  workflowId: string
  workspaceId: string
  triggeredBy: string | null
  triggerKind: WorkflowTriggerKind
  status: WorkflowRunStatus
  input: Record<string, unknown>
  vars: Record<string, unknown>
  currentStepId: string | null
  error: Record<string, unknown> | null
  /** Mig 279. Cross-run outcome; null until the run terminates. */
  outcome: WorkflowRunOutcome | null
  startedAt: Date
  finishedAt: Date | null
  lastActiveAt: Date
}

export type WorkflowStepRunRecord = {
  id: string
  runId: string
  stepId: string
  stepType: WorkflowStepType
  status: WorkflowStepRunStatus
  input: Record<string, unknown>
  output: Record<string, unknown> | null
  error: Record<string, unknown> | null
  startedAt: Date
  finishedAt: Date | null
}

// ── Store interfaces ────────────────────────────────────────────────────

export type WorkflowStore = {
  create(params: {
    userId: string
    workspaceId: string
    name: string
    description?: string | null
    definition: WorkflowDefinition
    trigger?: WorkflowTrigger
    webhookSlug?: string | null
    webhookSecret?: string | null
    modelAlias?: WorkflowModelAlias
    maxTurns?: number | null
    researchMode?: boolean
  }): Promise<WorkflowRecord>

  getById(userId: string, id: string): Promise<WorkflowRecord | null>

  list(userId: string, workspaceId: string): Promise<WorkflowRecord[]>

  /**
   * Patch any subset of name / description / definition / enabled / trigger /
   * webhook columns. Returns the updated row or null if not found / not
   * member-visible. Mig 141 fields land here.
   *
   * `nameManuallySet` (mig 202) is opt-in: pass `true` from a user-initiated
   * rename so the auto-titler stops touching the row. Pass `false` from the
   * auto-titler itself.
   */
  update(
    userId: string,
    id: string,
    fields: Partial<{
      name: string
      description: string | null
      definition: WorkflowDefinition
      enabled: boolean
      trigger: WorkflowTrigger
      webhookSlug: string | null
      webhookSecret: string | null
      modelAlias: WorkflowModelAlias
      maxTurns: number | null
      researchMode: boolean
      nameManuallySet: boolean
    }>,
  ): Promise<WorkflowRecord | null>

  /**
   * Auto-titler write path (mig 202). Updates `name` only when
   * `name_manually_set = false`. Returns true when a row was written.
   * Mirrors `sessions.updateSessionTitle`.
   */
  updateAutoName(userId: string, id: string, name: string): Promise<boolean>

  /** Hard delete. Workflow_runs cascade via FK. */
  delete(userId: string, id: string): Promise<boolean>

  /**
   * System lookup by webhook slug. Bypasses RLS — used by the public
   * webhook receiver before any user identity is available. Returns null
   * when the slug is unknown or the workflow is disabled.
   */
  findByWebhookSlugSystem(slug: string): Promise<WorkflowRecord | null>

  /**
   * System lookup by workflow id. Bypasses RLS — used by the workflow
   * executor on scheduled-trigger runs (`workflow_runs.triggered_by` is
   * null by spec, so the RLS-gated `getById` has no per-user context).
   * Workspace membership is already enforced upstream when the trigger
   * row (`scheduled_jobs` / webhook) is provisioned, and the run carries
   * the workspace_id needed for downstream authorization.
   *
   * Without this method, the executor fell back to a zero UUID for the
   * RLS lookup — that UUID matches no `workspace_members` row, so every
   * scheduled run failed with `workflow_not_found` (see migration 159
   * cutover postmortem). Mirror of `findByWebhookSlugSystem`.
   */
  findByIdSystem(workflowId: string): Promise<WorkflowRecord | null>
}

/**
 * Lightweight summary of one run a doc page triggered, for the page-header
 * feedback chip. Keyed on the CHANGED page (`workflow_runs.trigger_page_id` =
 * `input.event.pageId`). Carries just what the chip renders — never the full
 * run / step trail — so the page surface stays cheap and never blocks render.
 * `outcomeSummary` is the distilled `outcome.summary`, present once the run
 * terminates (see `WorkflowRunOutcome`).
 */
export type PageWorkflowRunSummary = {
  runId: string
  workflowId: string
  workflowName: string
  status: WorkflowRunStatus
  startedAt: Date
  finishedAt: Date | null
  outcomeSummary: string | null
}

export type WorkflowRunStore = {
  /** Insert a new run row in `pending` state. */
  createRun(params: {
    workflowId: string
    workspaceId: string
    triggeredBy: string | null
    triggerKind: WorkflowTriggerKind
    input?: Record<string, unknown>
  }): Promise<WorkflowRunRecord>

  getRunById(userId: string, id: string): Promise<WorkflowRunRecord | null>
  /** System-level read for the executor (no RLS). */
  getRunSystem(id: string): Promise<WorkflowRunRecord | null>

  /** Patch run status / current step / vars / error / outcome. */
  updateRun(
    id: string,
    fields: Partial<{
      status: WorkflowRunStatus
      currentStepId: string | null
      vars: Record<string, unknown>
      error: Record<string, unknown> | null
      finishedAt: Date | null
      /** Mig 279. Written once at terminal state for cross-run `{{lastRun}}`. */
      outcome: WorkflowRunOutcome | null
    }>,
  ): Promise<WorkflowRunRecord | null>

  /** Insert a step-run row. */
  createStepRun(params: {
    runId: string
    stepId: string
    stepType: WorkflowStepType
    input?: Record<string, unknown>
  }): Promise<WorkflowStepRunRecord>

  /** Patch a step-run (terminal status + output / error). */
  updateStepRun(
    id: string,
    fields: Partial<{
      status: WorkflowStepRunStatus
      output: Record<string, unknown> | null
      error: Record<string, unknown> | null
      finishedAt: Date | null
    }>,
  ): Promise<WorkflowStepRunRecord | null>

  listStepRuns(userId: string, runId: string): Promise<WorkflowStepRunRecord[]>

  /**
   * List runs for a single workflow, ordered by `started_at DESC`. Used by
   * the Q5 Views feature (workflow_runs Table). RLS-gated via the
   * workspace_member policy on `workflow_runs`. Index `idx_workflow_runs_workflow`
   * (migration 115) covers the access path.
   */
  listRunsForWorkflow(
    userId: string,
    workflowId: string,
    opts?: {
      status?: WorkflowRunStatus[]
      limit?: number
    },
  ): Promise<WorkflowRunRecord[]>

  /**
   * The `outcome` of the workflow's most recent TERMINAL run
   * (`completed` / `failed` / `timeout`), excluding `excludeRunId` (the run
   * currently executing). System read (no RLS) — the executor calls it on
   * every advance to build the `{{lastRun.*}}` interpolation scope. Returns
   * null when there is no prior terminal run, or its outcome was never
   * written (pre-mig-279 runs). Mig 279.
   */
  getLatestOutcomeForWorkflowSystem(
    workflowId: string,
    excludeRunId: string,
  ): Promise<WorkflowRunOutcome | null>

  /**
   * List the runs a doc page triggered, newest first, for the page-header
   * feedback chip. Keyed on `workflow_runs.trigger_page_id` (the CHANGED page
   * = `input.event.pageId`), joined to `workflows` for the name. RLS-gated via
   * the workspace_member policy on both tables; the partial index
   * `idx_workflow_runs_trigger_page` (migration 282) covers the access path.
   */
  listRunsForPage(
    userId: string,
    pageId: string,
    opts?: { limit?: number },
  ): Promise<PageWorkflowRunSummary[]>
}
