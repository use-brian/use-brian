/**
 * SDK for the Workflow builder UI (app-web).
 *
 * Ported from `apps/web/src/lib/api/workflow.ts` as part of the app
 * consolidation (docs/architecture/features/doc.md §5a). Identical
 * wire contract — wraps `authFetch` with typed signatures matching the REST
 * routes mounted in `apps/api/src/index.ts`. Kept as its own file (not
 * imported from apps/web), same convention as `lib/api/views.ts` /
 * `lib/api/approvals.ts`.
 *
 *   GET    /api/workflows?workspaceId=
 *   GET    /api/workflows/:id
 *   POST   /api/workflows
 *   PATCH  /api/workflows/:id
 *   DELETE /api/workflows/:id
 *   POST   /api/workflows/:id/run
 *   GET    /api/workflows/:id/runs
 *   GET    /api/workflows/:id/runs/:runId
 *
 * Approval resolution stays on the unified `/api/approvals/:id/resolve`
 * endpoint (see workflow-approvals route + ApprovalBanner).
 *
 * Spec: docs/architecture/features/workflow.md.
 */

import { authFetch } from "@/lib/auth-fetch";
import { DISPLAY_API_URL } from "@/lib/display-api-url";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

// ── Trigger ───────────────────────────────────────────────────────────────

export type ScheduleConfig =
  | { type: "once"; datetime: string }
  | { type: "daily"; time: string }
  | { type: "weekly"; days: string[]; time: string }
  | { type: "monthly"; dayOfMonth: number; time: string }
  | { type: "cron"; expression: string };

/**
 * One event source an `event`-trigger workflow listens on. Mirrors
 * `EventSourceRef` in `packages/core/src/workflow/types.ts`.
 */
type EventSourceRef =
  | {
      type: "connector";
      connectorInstanceId: string;
      /** Denormalized provider slug — 'github' | 'fathom' | 'gmail' | … */
      provider: string;
    }
  | {
      type: "channel";
      channelIntegrationId: string;
      /** Denormalized channel type — 'slack' | 'telegram' | 'whatsapp'. */
      channel: string;
    }
  | {
      type: "page";
      /**
       * The watched page (`saved_views.id`). Fires when a page is created or
       * moved directly under it, or when it is itself updated. The lifecycle
       * action (`created` | `updated` | `moved`) rides the `match.inChannels`
       * sub-channel.
       */
      pageId: string;
    }
  | {
      /**
       * The workspace's task table — id-less: `match` does all the selection.
       * Lifecycle actions (`created` | `completed` | `blocked` | `reopened` |
       * `assigned` | `tagged` | `updated`) ride `match.inChannels`; task tags
       * ride the task-only `match.tags`.
       */
      type: "task";
    };

/**
 * Declarative selectivity on one event subscription. Every present
 * field is AND-combined; the list within a field is OR-combined; an
 * absent field is not a constraint. Mirrors `EventMatch` in
 * `packages/core/src/workflow/types.ts`.
 */
export type EventMatch = {
  /** Case-insensitive substring of the event text. Cap 64. */
  keywords?: string[];
  /** Event actor id ∈ list. Cap 128. */
  fromActors?: string[];
  /** Event sub-channel id ∈ list. Cap 128. */
  inChannels?: string[];
  /** Any entity the event mentions ∈ list. Cap 128. */
  mentions?: string[];
  /**
   * Task-event tag filter (overlap). Full set on `created`, ADDED set on
   * updates. Only task events carry tags. Cap 64.
   */
  tags?: string[];
  /** Allow bot-authored events. Default false (self-loop guard). */
  fromBots?: boolean;
};

/** One `(source, match)` subscription on an event-trigger workflow. */
export type EventSubscription = {
  source: EventSourceRef;
  match?: EventMatch;
};

export type WorkflowTrigger =
  | { kind: "manual" }
  | {
      kind: "schedule";
      schedule: ScheduleConfig;
      timezone?: string;
      /** Timezone ownership — mirrors `scheduled_jobs.mode`. Default 'local'. */
      mode?: "local" | "user";
      /**
       * Type-only delivery sugar. The server resolves the concrete chat id +
       * Telegram topic and stamps it onto the terminal assistant_call step.
       * Mirrors `packages/core/src/workflow/schemas.ts`.
       */
      delivery?: { channel: "telegram" | "slack" | "whatsapp" };
      /** Trigger-row behavioral policy (silent-until-fire + nag). */
      policy?: {
        silentUntilFire?: boolean;
        nagIntervalMins?: number;
        nagUntilKeyword?: string;
      };
    }
  | {
      kind: "webhook";
      /**
       * Optional server-side event filter. `match.condition` is JSONLogic the
       * receiver evaluates against `{ input: <parsed payload> }`; a falsy
       * result ACKs 200 without a run. Mirrors `packages/core/src/workflow/
       * schemas.ts`. Absent → fire on every signed delivery.
       */
      match?: { condition: unknown };
    }
  | { kind: "event"; event: { sources: EventSubscription[] } };

// ── Definition shape (mirrors WorkflowDefinitionSchema) ──────────────────

export type DeliverChannelType = "web" | "telegram" | "slack" | "whatsapp";

/**
 * Page anchor — the bounded "edit page X" / "create a page" step
 * configuration. Mirrors core `PageAnchor` (workflow/types.ts): `{id}`
 * edits an existing page (static uuid, never interpolated); `{create}`
 * makes a saved page each run (title may interpolate `{{vars/input}}`);
 * `{fromStep}` edits the page an earlier create-step made this run.
 */
export type PageAnchor =
  | { id: string }
  | { create: true; title?: string; nestUnder?: string }
  | { fromStep: string };

export type AssistantCallStep = {
  id: string;
  type: "assistant_call";
  description?: string;
  nextStepId?: string | null;
  storeOutputAs?: string;
  target: { assistantId: string; capabilityId?: string };
  prompt: string;
  tools?: string[];
  /**
   * Allow-list of brain skill slugs the callee may activate on this step
   * (built-in ids or workspace skill slugs). When non-empty the callee is
   * offered the `useSkill` tool over exactly these skills, each still gated by
   * the assistant's own enablement + clearance. Absent / empty = no skills.
   * See docs/architecture/features/workflow.md -> "assistant_call skills".
   */
  skills?: string[];
  /**
   * Brain skill slugs the callee is FORCED to run: their instructions are
   * injected into the callee system prompt as mandatory `# Required Skills`,
   * rather than offered via `useSkill`. Same enablement + clearance gates as
   * `skills`; an enforced slug is not also offered for discovery.
   * See docs/architecture/features/workflow.md -> "assistant_call skills".
   */
  enforcedSkills?: string[];
  /** Page anchor — the callee runs doc-anchored against the resolved page. */
  page?: PageAnchor;
  /**
   * Blueprint to fill on this step (a built-in slug or a workspace blueprint
   * template id) — the synthesis blueprint the step's research/gather fills.
   * FE-only mirror for now; // P4 executor consumes this. See
   * docs/architecture/brain/structural-synthesis.md -> "The three fill modes".
   */
  blueprintId?: string;
  /** When set, the step's text output is pushed to this channel after the consult. */
  deliver?: { channelType: DeliverChannelType; channelId: string };
  /** `persistent` reuses one callee session across runs; `per_run` (default) is fresh. */
  session?: "per_run" | "persistent";
  /** Per-step model alias. Backfilled from workflow-level on read for legacy rows. */
  modelAlias?: WorkflowModelAlias;
  /** Per-step research-mode toggle. Backfilled from workflow-level on read. */
  researchMode?: boolean;
  /** Per-step hard turn cap (1..60). Null/undefined = executor default. */
  maxTurns?: number | null;
};

export type ToolCallStep = {
  id: string;
  type: "tool_call";
  description?: string;
  nextStepId?: string | null;
  storeOutputAs?: string;
  toolName: string;
  arguments: Record<string, unknown>;
  approval?: {
    deliveryChannel?: "web" | "telegram" | "slack" | "whatsapp";
    expiresAfterHours?: number;
  };
};

export type WaitStep = {
  id: string;
  type: "wait";
  description?: string;
  nextStepId?: string | null;
  storeOutputAs?: string;
  until?: { duration: { minutes?: number; hours?: number; days?: number } };
  at?: { datetime: string; timezone?: string };
};

export type BranchStep = {
  id: string;
  type: "branch";
  description?: string;
  storeOutputAs?: string;
  condition: unknown;
  nextStepIdIfTrue: string | null;
  nextStepIdIfFalse: string | null;
};

export type WorkflowStep = AssistantCallStep | ToolCallStep | WaitStep | BranchStep;

export type WorkflowDefinition = {
  startStepId: string;
  steps: WorkflowStep[];
};

// ── Records ───────────────────────────────────────────────────────────────

/** Mig 308 — the retirement ladder. Archived rows are hidden by default. */
type WorkflowLifecycleState = "active" | "stale" | "archived";

export type WorkflowSummary = {
  id: string;
  workspaceId: string;
  name: string;
  description?: string | null;
  enabled: boolean;
  /** Mig 302 — why the storm guard auto-disabled this workflow; null otherwise. */
  pausedReason?: string | null;
  trigger: WorkflowTrigger;
  stepCount: number;
  /** Mig 308 — sweep-maintained; `stale` badges the card, `archived` hides it. */
  lifecycleState?: WorkflowLifecycleState;
  /** Mig 308 — human-readable cause of the current lifecycle state. */
  lifecycleReason?: string | null;
  /** Mig 308 — the lifecycle-sweep veto flag. */
  pinned?: boolean;
  updatedAt: string;
  lastRunAt?: string | null;
};

/** Workflow-level run settings — mirrors the server's `WorkflowModelAlias`. */
export type WorkflowModelAlias = "standard" | "pro" | "max";

/**
 * One ACTUAL scheduled-trigger row firing a workflow (any member's). The
 * `trigger` display column can drift from these (it said "manual" while two
 * hourly crons fired in the 2026-06-10 incident) — the rows are the truth.
 */
export type WorkflowTriggerJob = {
  id: string;
  schedule: ScheduleConfig;
  timezone: string;
  enabled: boolean;
  nextRunAt: string;
  lastStatus: string | null;
  ownedByMe: boolean;
};

export type WorkflowFull = {
  id: string;
  workspaceId: string;
  createdBy: string;
  name: string;
  description: string | null;
  definition: WorkflowDefinition;
  enabled: boolean;
  /** Mig 302 — why the storm guard auto-disabled this workflow; null otherwise. */
  pausedReason?: string | null;
  trigger: WorkflowTrigger;
  webhookSlug: string | null;
  webhookSecret: string | null;
  /** Mig 196. Model used for every `assistant_call` step. */
  modelAlias: WorkflowModelAlias;
  /** Mig 196. Hard turn cap (1..60), null = executor default. */
  maxTurns: number | null;
  /** Mig 196. When true, executor injects the `deep` research budget. */
  researchMode: boolean;
  /** Mig 308 — sweep-maintained retirement ladder position. */
  lifecycleState?: WorkflowLifecycleState;
  /** Mig 308 — human-readable cause of the current lifecycle state. */
  lifecycleReason?: string | null;
  /** Mig 308 — the lifecycle-sweep veto flag. */
  pinned?: boolean;
  /** Present on GET detail. The real firing rows; see WorkflowTriggerJob. */
  triggerJobs?: WorkflowTriggerJob[];
  /**
   * Present on GET detail (mig 321). Page-action buttons whose action starts
   * this workflow — the same read-surface honesty as `triggerJobs`: the
   * trigger column can say "Manual" while buttons fire it.
   */
  buttonBindings?: WorkflowButtonBinding[];
  createdAt: string;
  updatedAt: string;
};

export type WorkflowButtonBinding = {
  id: string;
  label: string;
  blueprintId: string | null;
  pageId: string | null;
  enabled: boolean;
};

export type WorkflowRunSummary = {
  id: string;
  workflowId: string;
  triggerKind: "manual" | "schedule" | "event" | "button";
  status:
    | "pending"
    | "running"
    | "awaiting_wait"
    | "awaiting_input"
    | "completed"
    | "failed"
    | "timeout";
  currentStepId: string | null;
  startedAt: string;
  finishedAt: string | null;
  error: Record<string, unknown> | null;
};

export type WorkflowStepRunDetail = {
  id: string;
  stepId: string;
  type: WorkflowStep["type"];
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  startedAt: string;
  finishedAt: string | null;
};

export type WorkflowRunDetail = WorkflowRunSummary & {
  input: Record<string, unknown>;
  vars: Record<string, unknown>;
  steps: WorkflowStepRunDetail[];
};

// ── Legacy shapes kept for the existing detail page renderer ─────────────

type WorkflowStepView = {
  id: string;
  name: string;
  status: "idle" | "running" | "awaiting_approval" | "completed" | "failed";
  pendingApprovalId?: string | null;
  description?: string | null;
};

type WorkflowDetail = {
  id: string;
  name: string;
  description?: string | null;
  steps: WorkflowStepView[];
};

type ApprovalOutcome = "approved" | "rejected";

// ── Read operations ──────────────────────────────────────────────────────

export async function listWorkflows(
  workspaceId: string,
  opts?: { includeArchived?: boolean },
): Promise<WorkflowSummary[]> {
  const q = new URLSearchParams({ workspaceId });
  // Mig 308 — the server hides archived workflows unless asked; the Workflow
  // page asks so it can render the collapsed Archived section.
  if (opts?.includeArchived) q.set("state", "all");
  const res = await authFetch(`${API_URL}/api/workflows?${q.toString()}`);
  if (!res.ok) return [];
  const data = (await res.json()) as { workflows?: WorkflowSummary[] };
  return Array.isArray(data.workflows) ? data.workflows : [];
}

/** Mig 308 — restore an archived/stale workflow to `active` (re-enables it). */
export async function restoreWorkflow(workflowId: string): Promise<boolean> {
  const res = await authFetch(
    `${API_URL}/api/workflows/${encodeURIComponent(workflowId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lifecycleState: "active" }),
    },
  );
  return res.ok;
}

export async function getWorkflowFull(workflowId: string): Promise<WorkflowFull | null> {
  const res = await authFetch(
    `${API_URL}/api/workflows/${encodeURIComponent(workflowId)}`,
  );
  if (!res.ok) return null;
  return (await res.json()) as WorkflowFull;
}

/**
 * Compatibility shim — earlier detail page consumed a simplified shape.
 * Bridges the new full-detail response into the older renderer until the
 * detail page rewrite is complete.
 */
export async function getWorkflow(
  workflowId: string,
  _workspaceId: string,
): Promise<WorkflowDetail | null> {
  const full = await getWorkflowFull(workflowId);
  if (!full) return null;
  return {
    id: full.id,
    name: full.name,
    description: full.description,
    steps: full.definition.steps.map((s) => ({
      id: s.id,
      name: s.description ?? s.id,
      status: "idle" as const,
      description: stepKindLabel(s),
    })),
  };
}

function stepKindLabel(s: WorkflowStep): string {
  switch (s.type) {
    case "assistant_call":
      return `assistant_call → ${s.target.assistantId}`;
    case "tool_call":
      return `tool_call → ${s.toolName}`;
    case "wait":
      return s.until ? `wait ${JSON.stringify(s.until.duration)}` : `wait until ${s.at?.datetime ?? "?"}`;
    case "branch":
      return `branch`;
  }
}

export async function listWorkflowRuns(
  workflowId: string,
  limit = 20,
): Promise<WorkflowRunSummary[]> {
  const q = new URLSearchParams({ limit: String(limit) });
  const res = await authFetch(
    `${API_URL}/api/workflows/${encodeURIComponent(workflowId)}/runs?${q.toString()}`,
  );
  if (!res.ok) return [];
  const data = (await res.json()) as { runs?: WorkflowRunSummary[] };
  return Array.isArray(data.runs) ? data.runs : [];
}

/**
 * One run a doc page triggered, for the page-header feedback chip. Keyed on the
 * CHANGED page (`workflow_runs.trigger_page_id`). `outcomeSummary` is present
 * once the run terminates. Mirrors the server `PageWorkflowRunSummary`.
 */
export type PageWorkflowRunSummary = {
  runId: string;
  workflowId: string;
  workflowName: string;
  status: WorkflowRunSummary["status"];
  startedAt: string;
  finishedAt: string | null;
  outcomeSummary: string | null;
};

/** List the workflow runs a doc page triggered, newest first. */
export async function listPageWorkflowRuns(
  pageId: string,
  limit = 20,
): Promise<PageWorkflowRunSummary[]> {
  const q = new URLSearchParams({ limit: String(limit) });
  const res = await authFetch(
    `${API_URL}/api/pages/${encodeURIComponent(pageId)}/workflow-runs?${q.toString()}`,
  );
  if (!res.ok) return [];
  const data = (await res.json()) as { runs?: PageWorkflowRunSummary[] };
  return Array.isArray(data.runs) ? data.runs : [];
}

export async function getWorkflowRun(
  workflowId: string,
  runId: string,
): Promise<WorkflowRunDetail | null> {
  const res = await authFetch(
    `${API_URL}/api/workflows/${encodeURIComponent(workflowId)}/runs/${encodeURIComponent(runId)}`,
  );
  if (!res.ok) return null;
  return (await res.json()) as WorkflowRunDetail;
}

// ── Write operations ─────────────────────────────────────────────────────

/**
 * Structured validation issue mirrored from the server's Zod error.
 * `path` is `['definition', 'steps', 0, 'id']`-style — the first segment
 * names the section (`name` / `description` / `trigger` / `definition`)
 * and lets the UI scroll and highlight the right pane.
 */
export type WorkflowIssue = {
  path: Array<string | number>;
  message: string;
};

export type CreateWorkflowInput = {
  workspaceId: string;
  name: string;
  description?: string;
  definition: WorkflowDefinition;
  trigger?: WorkflowTrigger;
  modelAlias?: WorkflowModelAlias;
  maxTurns?: number | null;
  researchMode?: boolean;
};

export type CreateWorkflowResult =
  | { ok: true; workflow: WorkflowFull; warnings?: WorkflowIssue[] }
  | { ok: false; error: string; issues?: WorkflowIssue[] };

export async function createWorkflow(
  input: CreateWorkflowInput,
): Promise<CreateWorkflowResult> {
  const res = await authFetch(`${API_URL}/api/workflows`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      issues?: WorkflowIssue[];
    };
    return {
      ok: false,
      error: body.error ?? `HTTP ${res.status}`,
      issues: body.issues,
    };
  }
  const created = (await res.json()) as WorkflowFull & {
    warnings?: WorkflowIssue[];
  };
  return { ok: true, workflow: created, warnings: created.warnings };
}

export type UpdateWorkflowInput = {
  name?: string;
  description?: string | null;
  definition?: WorkflowDefinition;
  enabled?: boolean;
  trigger?: WorkflowTrigger;
  rotateWebhookSecret?: boolean;
  modelAlias?: WorkflowModelAlias;
  maxTurns?: number | null;
  researchMode?: boolean;
  /** Mig 308 — lifecycle-sweep veto flag. */
  pinned?: boolean;
  /** Mig 308 — restore only: `'active'` is the single accepted value. */
  lifecycleState?: "active";
};

export type UpdateWorkflowResult =
  | { ok: true; workflow: WorkflowFull; warnings?: WorkflowIssue[] }
  | { ok: false; error: string; issues?: WorkflowIssue[] };

export async function updateWorkflow(
  workflowId: string,
  input: UpdateWorkflowInput,
): Promise<UpdateWorkflowResult> {
  const res = await authFetch(
    `${API_URL}/api/workflows/${encodeURIComponent(workflowId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      issues?: WorkflowIssue[];
    };
    return {
      ok: false,
      error: body.error ?? `HTTP ${res.status}`,
      issues: body.issues,
    };
  }
  const updated = (await res.json()) as WorkflowFull & {
    warnings?: WorkflowIssue[];
  };
  return { ok: true, workflow: updated, warnings: updated.warnings };
}

export async function deleteWorkflow(workflowId: string): Promise<boolean> {
  const res = await authFetch(
    `${API_URL}/api/workflows/${encodeURIComponent(workflowId)}`,
    { method: "DELETE" },
  );
  return res.ok;
}

export type RunWorkflowResult = {
  runId: string;
  status: WorkflowRunSummary["status"];
  finalOutput: unknown;
  error: Record<string, unknown> | null;
  paused: { stepId: string; reason: "wait" | "approval" } | null;
  steps: Array<{
    id: string;
    stepId: string;
    type: WorkflowStep["type"];
    status: "pending" | "running" | "completed" | "failed" | "skipped";
    durationMs: number | null;
    output: Record<string, unknown> | null;
    error: Record<string, unknown> | null;
  }>;
};

export async function runWorkflowNow(
  workflowId: string,
  input?: Record<string, unknown>,
): Promise<RunWorkflowResult | null> {
  const res = await authFetch(
    `${API_URL}/api/workflows/${encodeURIComponent(workflowId)}/run`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: input ?? {} }),
    },
  );
  if (!res.ok) return null;
  return (await res.json()) as RunWorkflowResult;
}

// ── Approval (kept) ──────────────────────────────────────────────────────

export async function resolveApproval(
  approvalId: string,
  outcome: ApprovalOutcome,
  comment?: string,
): Promise<boolean> {
  const res = await authFetch(
    `${API_URL}/api/approvals/${encodeURIComponent(approvalId)}/resolve`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outcome, comment }),
    },
  );
  return res.ok;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Build a webhook URL surfaced in the UI (read-only display). Displayed and
 *  copied for external callers, so it uses the absolute origin — never the
 *  dev-blanked fetch base (see lib/display-api-url.ts). */
export function webhookUrlForSlug(slug: string): string {
  return `${DISPLAY_API_URL}/api/workflow-webhooks/${slug}`;
}

/** Build the public manual-run endpoint surfaced in the UI (same display rule). */
export function manualRunUrlForId(workflowId: string): string {
  return `${DISPLAY_API_URL}/api/workflows/${workflowId}/run`;
}

// ── Event-trigger source pickers ──────────────────────────────────────────
//
// The event trigger UI needs the workspace's connector instances + channel
// integrations to build the source dropdown. Both lists already exist on
// the workspace settings surfaces — these are thin readers scoped to what
// the trigger picker needs (id, label, provider/channel slug).

export type WorkspaceConnectorOption = {
  id: string;
  provider: string;
  label: string;
  connected: boolean;
};

export async function listWorkspaceConnectorOptions(
  workspaceId: string,
): Promise<WorkspaceConnectorOption[]> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/connectors`,
  );
  if (!res.ok) return [];
  type Row = {
    id: string;
    provider: string;
    label: string;
    connected: boolean;
  };
  const data = (await res.json()) as { teamNative?: Row[] } | null;
  const rows = Array.isArray(data?.teamNative) ? data!.teamNative : [];
  return rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    label: r.label || r.provider,
    connected: !!r.connected,
  }));
}

export type WorkspaceChannelOption = {
  id: string;
  channelType: "slack" | "telegram" | "whatsapp";
  displayName: string;
};

export type WorkspacePageOption = {
  /** `saved_views.id` — the parent page a `page` event source watches. */
  id: string;
  label: string;
  /** Page emoji, or null for the derived glyph. */
  icon: string | null;
};

/**
 * The workspace's doc pages, for the `page` event-source parent picker. Thin
 * reader over the same saved-views list the sidebar tree uses; any page can be
 * a watched parent (the source fires on its direct children's lifecycle).
 */
export async function listWorkspacePageOptions(
  workspaceId: string,
): Promise<WorkspacePageOption[]> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/saved-views?state=all`,
  );
  if (!res.ok) return [];
  type Row = { id: string; name: string; icon: string | null };
  const data = (await res.json()) as { savedViews?: Row[] } | null;
  const rows = Array.isArray(data?.savedViews) ? data!.savedViews : [];
  return rows.map((r) => ({ id: r.id, label: r.name, icon: r.icon ?? null }));
}

export type WorkspaceMemberOption = {
  /** `users.id` — the value stored in a page source's `match.fromActors`. */
  id: string;
  label: string;
};

/**
 * The workspace's members, for the page event-source "Changed by" picker. The
 * page `actorId` is the workspace user id of whoever wrote the page, so this
 * lets the builder filter by member NAME while storing the user id. Backed by
 * the workspace-detail route (`GET /api/workspaces/:id` → `members[]`), the
 * same source the doc `@`-mention popup uses.
 */
export async function listWorkspaceMemberOptions(
  workspaceId: string,
): Promise<WorkspaceMemberOption[]> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}`,
  );
  if (!res.ok) return [];
  type Row = { userId: string; userName: string | null; email: string | null };
  const data = (await res.json()) as { members?: Row[] } | null;
  const rows = Array.isArray(data?.members) ? data!.members : [];
  return rows.map((m) => ({
    id: m.userId,
    label: m.userName || m.email || "Member",
  }));
}

/**
 * Recent chat destinations the workspace's bots have talked in — backs the
 * per-step `deliver.channelId` dropdown so users don't paste raw platform IDs.
 * Derived from `sessions` joined to `assistants` (workspace filter).
 */
export type ChannelDestination = {
  channelType: "telegram" | "slack" | "whatsapp";
  channelId: string;
  title: string | null;
  lastActiveAt: string;
};

export async function listChannelDestinations(
  workspaceId: string,
): Promise<ChannelDestination[]> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/channel-destinations`,
  );
  if (!res.ok) return [];
  const data = (await res.json()) as { destinations?: ChannelDestination[] };
  return Array.isArray(data.destinations) ? data.destinations : [];
}

/**
 * A Slack channel the workspace bot can see, resolved live via Slack
 * `conversations.list`. Powers the deliver picker's Slack destination
 * dropdown so authors pick a channel by NAME (`#dev-work`) instead of a raw
 * `C…` id — and non-Slack ids can never appear (only real channels are
 * returned). `isMember` channels are postable without a join.
 */
export type SlackChannelOption = {
  id: string;
  name: string;
  isMember: boolean;
};

export async function listWorkspaceSlackChannels(
  workspaceId: string,
): Promise<SlackChannelOption[]> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/slack-channels`,
  );
  if (!res.ok) return [];
  const data = (await res.json()) as { channels?: SlackChannelOption[] };
  return Array.isArray(data.channels) ? data.channels : [];
}

export async function listWorkspaceChannelOptions(
  workspaceId: string,
): Promise<WorkspaceChannelOption[]> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/channels`,
  );
  if (!res.ok) return [];
  type Row = {
    channelType: WorkspaceChannelOption["channelType"];
    displayName: string;
    status: "active" | "revoked" | "invalid";
    integrationId: string | null;
  };
  const data = (await res.json()) as { channels?: Row[] } | null;
  const rows = Array.isArray(data?.channels) ? data!.channels : [];
  // The event dispatcher routes through `channel_integrations.id`, so a
  // channel without an attached integration row is unselectable.
  return rows
    .filter((r) => r.status === "active" && r.integrationId)
    .map((r) => ({
      id: r.integrationId!,
      channelType: r.channelType,
      displayName: r.displayName,
    }));
}
