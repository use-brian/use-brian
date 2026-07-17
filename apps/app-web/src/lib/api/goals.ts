/**
 * SDK for the read-only Goals board (app-web).
 *
 * Wraps `authFetch` with a typed signature for the goals board route mounted
 * at `/api/goals` in `packages/api/src/boot.ts`. Read-only in v1 — the board
 * observes the goal-seeker primitive: goals are minted by the `setGoal` chat
 * tool and completed by the structural rollup; the acting loop is gated behind
 * the COGS-metering barrier. See `docs/architecture/features/goals.md`.
 *
 *   GET /api/goals?workspaceId=[&status=&hostType=&includeTerminal=]
 *
 * [COMP:app-web/goals-board]
 */

import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type GoalStatus =
  | "active"
  | "running"
  | "awaiting_approval"
  | "blocked"
  | "done"
  | "abandoned";

type GoalHostType = "task" | "page" | "entity" | "workflow";

export type GoalRow = {
  id: string;
  outcome: string;
  status: GoalStatus;
  host: { type: GoalHostType; id: string } | null;
  parentGoalId: string | null;
  recipeId: string | null;
  blockerReason: string | null;
  /** null = a DRAFT (auto-created for a task, unconfirmed). */
  confirmedAt: string | null;
  /** true once a workflow means is set (the goal is being worked / armed). */
  hasWorkflow: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ListGoalsOptions = {
  status?: GoalStatus;
  hostType?: GoalHostType;
  /** Filter to a specific host id (e.g. a task's goal). */
  hostId?: string;
  includeTerminal?: boolean;
};

// ── Goal detail (the board drill-down) ───────────────────────────────────────
// Local mirrors of the core acceptance-contract types
// (`packages/core/src/goals/{types,done-when}.ts`) — the SDK carries the
// structured payload; the detail page renders an i18n summary over it.

/** The goal's engine-verifiable acceptance tree. The detail page summarises it
 *  (e.g. "sub-tasks closed" / "verified by an agent"); it never evaluates it. */
export type DoneWhenNode =
  | { kind: "subtasks" }
  | { kind: "query"; query: { description?: string; predicate: Record<string, unknown> } }
  | { kind: "tool"; tool: { tool: string; args?: Record<string, unknown>; description?: string } }
  | { kind: "verify" }
  | { all: DoneWhenNode[] }
  | { any: DoneWhenNode[] }
  | { not: DoneWhenNode };

type GoalBudget = {
  maxIterations?: number;
  /** The load-bearing dollar cap (gated on COGS metering). */
  maxSpend?: number;
  /** ISO-8601 timestamp. */
  deadline?: string | null;
};

type GoalPolicy = {
  blastRadius?: "internal" | "external";
  approval?: "auto" | "ask";
  escalateTo?: string | null;
};

type GoalMeans = {
  workflowId?: string | null;
  blueprintIds?: string[];
  skillIds?: string[];
};

/** Agentic-termination verified-done marker (§12): present only once an
 *  adversarial verifier passed a completion claim. */
type GoalCompletionClaim = { because: string; verifiedAt: string };

/** The board row plus the full acceptance contract + completion claim. */
export type GoalDetail = GoalRow & {
  doneWhen: DoneWhenNode;
  means: GoalMeans;
  budget: GoalBudget;
  policy: GoalPolicy;
  completionClaim: GoalCompletionClaim | null;
};

/** List goals for the workspace, most-recently-updated first. Returns `[]` on
 *  any non-OK response (the board renders its empty state). */
export async function listGoals(
  workspaceId: string,
  opts: ListGoalsOptions = {},
): Promise<GoalRow[]> {
  const q = new URLSearchParams({ workspaceId });
  if (opts.status) q.set("status", opts.status);
  if (opts.hostType) q.set("hostType", opts.hostType);
  if (opts.hostId) q.set("hostId", opts.hostId);
  if (opts.includeTerminal) q.set("includeTerminal", "true");
  const res = await authFetch(`${API_URL}/api/goals?${q.toString()}`);
  if (!res.ok) return [];
  const data = (await res.json()) as { goals?: GoalRow[] };
  return Array.isArray(data.goals) ? data.goals : [];
}

/** The goal bound to a task (the auto-drafted autopilot goal), or null. */
export async function goalForTask(workspaceId: string, taskId: string): Promise<GoalRow | null> {
  const goals = await listGoals(workspaceId, { hostType: "task", hostId: taskId, includeTerminal: true });
  return goals[0] ?? null;
}

/** Fetch one goal's richer detail (the board drill-down). RLS-scoped server-side
 *  by membership — returns `null` on any non-OK response (not found / non-member
 *  / network), so the detail page renders its not-found state. */
export async function getGoalDetail(goalId: string): Promise<GoalDetail | null> {
  const res = await authFetch(`${API_URL}/api/goals/${encodeURIComponent(goalId)}`);
  if (!res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as { goal?: GoalDetail };
  return data.goal ?? null;
}

type GoalActionResult = {
  ok: boolean;
  goal?: GoalRow;
  error?: string;
  /** confirm only: the goal was too vague to arm (the §12 clarity gate). The
   *  goal is NOT confirmed; surface `question` for the user to answer. */
  needsClarification?: boolean;
  question?: string;
};

async function goalAction(
  goalId: string,
  action: "confirm" | "work" | "abandon" | "outcome",
  body: unknown,
): Promise<GoalActionResult> {
  const res = await authFetch(`${API_URL}/api/goals/${encodeURIComponent(goalId)}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    goal?: GoalRow;
    error?: string;
    needsClarification?: boolean;
    question?: string;
  };
  if (!res.ok) return { ok: false, error: data.error ?? `Request failed (${res.status})` };
  // The confirm clarity gate returns HTTP 200 with `ok:false` + a question
  // rather than arming the goal — relay it as a non-OK action result.
  if (data.needsClarification) {
    return { ok: false, needsClarification: true, question: data.question };
  }
  return { ok: true, goal: data.goal };
}

/** Confirm (arm) a draft goal, optionally refining its outcome. */
export function confirmGoal(goalId: string, outcome?: string): Promise<GoalActionResult> {
  return goalAction(goalId, "confirm", { outcome });
}

/** Edit a goal's outcome text (draft or armed). Never confirms a draft; a
 *  completed goal is refused server-side (409). */
export function updateGoalOutcome(goalId: string, outcome: string): Promise<GoalActionResult> {
  return goalAction(goalId, "outcome", { outcome });
}

/** Spin up the assistant to work the task to done (sets the means + kicks off the loop). */
export function workGoal(goalId: string, workflowId?: string): Promise<GoalActionResult> {
  return goalAction(goalId, "work", { workflowId });
}

/** Discard a goal (a draft the user won't confirm, or an active goal to stand
 *  down). Reversible server-side: sets status='abandoned' — the record survives
 *  and is retrievable via the status filter. Refused (409) for a completed goal. */
export function abandonGoal(goalId: string): Promise<GoalActionResult> {
  return goalAction(goalId, "abandon", {});
}
