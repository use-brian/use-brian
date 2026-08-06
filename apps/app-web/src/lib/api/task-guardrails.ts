/**
 * Task guardrails SDK — the suggestions tray, workspace rules, and the
 * rejection log behind `/api/task-guardrails`.
 *
 * Spec: docs/architecture/features/task-guardrails.md
 * [COMP:app-web/task-suggestions]
 */

import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

type TaskLane = "extracted" | "assistant";

type TaskRuleEffect = "deny" | "require" | "allow";
export type TaskRuleStatus = "active" | "proposed" | "disabled";

export type TaskRulePredicate = {
  source_kinds?: string[];
  lanes?: TaskLane[];
  title_matches?: string[];
  channel_refs?: string[];
  require?: (
    | "assignee"
    | "due"
    | "description"
    | "resolved_target"
    | "explicit_commitment"
    | "completion_signal"
    | "agent_ready"
  )[];
};

export type TaskRule = {
  id: string;
  workspaceId: string;
  status: TaskRuleStatus;
  effect: TaskRuleEffect;
  predicate: TaskRulePredicate;
  nlClause: string | null;
  reason: string | null;
  origin: "user" | "proposed";
  createdAt: string;
};

/** Why a candidate did not become a task (or, for `auto_rule`, why it did). */
type TaskCandidateReason =
  | "tombstoned"
  | "rule"
  | "rule_requires"
  | "duplicate"
  | "near_duplicate"
  | "not_a_task"
  | "needs_spec"
  | "quality_unverified"
  | "suggested"
  | "auto_rule";

type TaskReadinessAssessment = {
  classification: "ready" | "needs_spec" | "not_a_task";
  evidenceQuote: string | null;
  evidenceVerified: boolean;
  commitment: "explicit" | "implicit" | "hedged" | "none";
  objective: string | null;
  target: string | null;
  description: string | null;
  startingPointKind: "explicit" | "discoverable" | "missing";
  startingPoint: string | null;
  completionSignal: string | null;
  missing: (
    | "evidence"
    | "commitment"
    | "objective"
    | "target"
    | "description"
    | "starting_point"
    | "completion_signal"
  )[];
  explanation: string;
};

export type TaskCandidate = {
  id: string;
  title: string;
  due: string | null;
  sourceKind: string | null;
  channelRef: string | null;
  lane: TaskLane;
  sourceEpisodeId: string | null;
  status: string;
  reasonCode: TaskCandidateReason;
  matchedTaskId: string | null;
  matchedTaskTitle: string | null;
  matchedRuleId: string | null;
  matchedRuleClause: string | null;
  similarity: number | null;
  quality: TaskReadinessAssessment | null;
  createdTaskId: string | null;
  createdAt: string;
  expiresAt: string;
};

export type TaskTombstone = {
  id: string;
  title: string;
  reason: string;
  sourceKind: string | null;
  lane: TaskLane | null;
  createdAt: string;
};

async function json<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to ${what}`);
  }
  return (await res.json()) as T;
}

// ── Suggestions tray ────────────────────────────────────────────────

export async function loadTaskCandidates(
  workspaceId: string,
  status: "pending" | "auto_accepted" = "pending",
): Promise<TaskCandidate[]> {
  const query = status === "auto_accepted" ? "?status=auto_accepted" : "";
  const res = await authFetch(
    `${API_URL}/api/task-guardrails/${workspaceId}/candidates${query}`,
  );
  const body = await json<{ candidates: TaskCandidate[] }>(
    res,
    "load task suggestions",
  );
  return body.candidates;
}

/**
 * Approve a suggestion into a real task. `title` approves under a corrected
 * title; `always` additionally activates a class-level allow rule so future
 * ready suggestions from this source/channel auto-create.
 */
export async function acceptTaskCandidate(
  workspaceId: string,
  candidateId: string,
  opts: { title?: string; always?: boolean } = {},
): Promise<{ allowRuleId: string | null }> {
  const res = await authFetch(
    `${API_URL}/api/task-guardrails/${workspaceId}/candidates/${candidateId}/accept`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(opts.title ? { title: opts.title } : {}),
        ...(opts.always ? { always: true } : {}),
      }),
    },
  );
  const body = await json<{ allowRuleId?: string | null }>(
    res,
    "accept suggestion",
  );
  return { allowRuleId: body.allowRuleId ?? null };
}

/**
 * Dismiss a suggestion. Passing a `reason` also writes a tombstone, so the
 * same "no, and here's why" that teaches the workspace when deleting a task
 * works from the tray - without the task ever having existed.
 */
export async function dismissTaskCandidate(
  workspaceId: string,
  candidateId: string,
  reason?: string,
): Promise<void> {
  const res = await authFetch(
    `${API_URL}/api/task-guardrails/${workspaceId}/candidates/${candidateId}/dismiss`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reason ? { reason } : {}),
    },
  );
  await json(res, "dismiss suggestion");
}

// ── Rules ───────────────────────────────────────────────────────────

export async function loadTaskRules(workspaceId: string): Promise<TaskRule[]> {
  const res = await authFetch(
    `${API_URL}/api/task-guardrails/${workspaceId}/rules`,
  );
  const body = await json<{ rules: TaskRule[] }>(res, "load task rules");
  return body.rules;
}

export async function setTaskRuleStatus(
  workspaceId: string,
  ruleId: string,
  status: TaskRuleStatus,
): Promise<TaskRule> {
  const res = await authFetch(
    `${API_URL}/api/task-guardrails/${workspaceId}/rules/${ruleId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    },
  );
  const body = await json<{ rule: TaskRule }>(res, "update task rule");
  return body.rule;
}

export async function deleteTaskRule(
  workspaceId: string,
  ruleId: string,
): Promise<void> {
  const res = await authFetch(
    `${API_URL}/api/task-guardrails/${workspaceId}/rules/${ruleId}`,
    { method: "DELETE" },
  );
  await json(res, "delete task rule");
}

// ── Rejection log ───────────────────────────────────────────────────

export async function loadTaskTombstones(
  workspaceId: string,
): Promise<TaskTombstone[]> {
  const res = await authFetch(
    `${API_URL}/api/task-guardrails/${workspaceId}/tombstones`,
  );
  const body = await json<{ tombstones: TaskTombstone[] }>(
    res,
    "load rejections",
  );
  return body.tombstones;
}

export async function deleteTaskTombstone(
  workspaceId: string,
  tombstoneId: string,
): Promise<void> {
  const res = await authFetch(
    `${API_URL}/api/task-guardrails/${workspaceId}/tombstones/${tombstoneId}`,
    { method: "DELETE" },
  );
  await json(res, "delete rejection");
}

/**
 * Render a predicate as a short human phrase for a rule the user never put
 * into words (a proposed rule, or one authored through the API).
 */
export function describeTaskRulePredicate(p: TaskRulePredicate): string {
  const parts: string[] = [];
  if (p.source_kinds?.length) parts.push(`from ${p.source_kinds.join(", ")}`);
  if (p.lanes?.length) parts.push(`lane ${p.lanes.join(", ")}`);
  if (p.title_matches?.length)
    parts.push(`mentioning ${p.title_matches.join(", ")}`);
  if (p.channel_refs?.length) parts.push(`in ${p.channel_refs.join(", ")}`);
  if (p.require?.length) parts.push(`must have ${p.require.join(" + ")}`);
  return parts.join(" ");
}
