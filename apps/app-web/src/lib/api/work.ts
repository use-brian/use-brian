import { publicRuntimeConfig } from "@/lib/runtime-public-config";
/**
 * Work entry SDK (project-briefs.md -> "Work"; tasks.md -> "Responsibility").
 * The projection is viewer-bound and read-only; the claim is the same guarded
 * command Brian's `updateTask({ if_unassigned })` uses.
 * [COMP:app-web/brief-work]
 */
import { authFetch } from "@/lib/auth-fetch";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";

export type WorkScope = { kind: "personal" } | { kind: "department" | "project"; id: string };
type WorkHome = { kind: "department" | "project"; id: string };
type WorkNextAction = "assign" | "answer" | "review" | "unblock" | "select_follow_up" | "open";
type WorkReason =
  | "blocked" | "in_review" | "overdue" | "question" | "missing_routing"
  | "assigned_to_you" | "follow_up" | "unassigned";

type WorkExecutor =
  | { kind: "person"; memberId: string; name: string | null }
  | { kind: "assistant"; assistantId: string; name: string | null }
  | { kind: "unassigned" };

type WorkFollowUp =
  | { source: "explicit" | "executor"; memberId: string; name: string | null }
  | { source: "home_owners"; home: WorkHome; viewerIsOwner: boolean }
  | { source: "missing_routing"; reason: "no_home" | "no_eligible_owner" }
  | { source: "owner_queue"; home: WorkHome }
  | { source: "none" };

export type WorkItem = {
  taskId: string;
  title: string;
  status: string;
  due: string | null;
  home: WorkHome | null;
  executor: WorkExecutor;
  followUp: WorkFollowUp;
  reasons: WorkReason[];
  nextAction: WorkNextAction;
  blockerReason: string | null;
  updatedAt: string;
};

export type WorkSectionKey = "needsYou" | "myWork" | "needsAssignment";

export type WorkProjection = {
  scope: WorkScope;
  viewer: { memberId: string };
  sections: Record<WorkSectionKey, WorkItem[]>;
  counts: Record<WorkSectionKey, number>;
  generatedAt: string;
};

export class WorkRequestError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authFetch(`${API_URL}/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new WorkRequestError(body.error ?? "work_unavailable", res.status);
  return body as T;
}

export async function fetchWork(workspaceId: string, scope: WorkScope): Promise<WorkProjection> {
  const path = scope.kind === "personal"
    ? `/workspaces/${workspaceId}/work`
    : `/workspaces/${workspaceId}/briefs/by-owner/${scope.kind}/${scope.id}/work`;
  return (await call<{ work: WorkProjection }>(path)).work;
}

export async function claimWorkTask(
  workspaceId: string,
  taskId: string,
  executor: { kind: "person" } | { kind: "assistant"; assistantId: string },
): Promise<{ id: string }> {
  return (await call<{ task: { id: string } }>(`/workspaces/${workspaceId}/tasks/${taskId}/claim`, {
    method: "POST", body: JSON.stringify({ executor }),
  })).task;
}

/** A copy of the projection with one task removed and the counts kept equal to the rows. */
export function withoutTask(work: WorkProjection, taskId: string): WorkProjection {
  const sections = Object.fromEntries(
    (Object.keys(work.sections) as WorkSectionKey[]).map((key) => [key, work.sections[key].filter((i) => i.taskId !== taskId)]),
  ) as WorkProjection["sections"];
  return {
    ...work,
    sections,
    counts: { needsYou: sections.needsYou.length, myWork: sections.myWork.length, needsAssignment: sections.needsAssignment.length },
  };
}
