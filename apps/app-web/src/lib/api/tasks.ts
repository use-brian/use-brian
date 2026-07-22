/**
 * Tasks operator-surface SDK — the flat task list behind `/w/[id]/tasks`
 * (`GET /api/brain/tasks`, [COMP:brain/tasks-list-http]) plus the typed
 * priority accessor. Mutations reuse the existing brain-inbox wire
 * (`adjustBrainRow` / `deleteBrainRow` in `lib/api/brain-inbox.ts`) and the
 * server bulk lane (`bulkTasks` below) for large selections.
 *
 * Spec: docs/architecture/features/tasks.md → "Operator surface".
 * [COMP:app-web/tasks-surface]
 */

import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type TaskStatus =
  | "todo"
  | "in_progress"
  | "blocked"
  | "done"
  | "archived";

export const TASK_STATUSES: TaskStatus[] = [
  "todo",
  "in_progress",
  "blocked",
  "done",
  "archived",
];

export type TaskPriority = "low" | "medium" | "high" | "urgent";

export const TASK_PRIORITIES: TaskPriority[] = [
  "low",
  "medium",
  "high",
  "urgent",
];

/** One flat task row off `GET /api/brain/tasks`. */
export type TaskRow = {
  id: string;
  title: string;
  status: TaskStatus;
  /** A `workspace_members` row id (NOT a user id), or null = unassigned. */
  assigneeId: string | null;
  /** ISO timestamp, or null. */
  due: string | null;
  tags: string[];
  parentId: string | null;
  /** Free-form JSONB; the conventional `priority` key lives here. */
  attributes: Record<string, unknown>;
  /** ISO timestamp. */
  updatedAt: string;
};

/** The conventional `attributes.priority` value, or null when unset/junk. */
export function taskPriority(row: Pick<TaskRow, "attributes">): TaskPriority | null {
  const value = row.attributes?.priority;
  return typeof value === "string" &&
    (TASK_PRIORITIES as string[]).includes(value)
    ? (value as TaskPriority)
    : null;
}

/** The conventional `attributes.description` page body, or null. */
export function taskDescription(row: Pick<TaskRow, "attributes">): string | null {
  const value = row.attributes?.description;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export async function fetchWorkspaceTasks(
  workspaceId: string,
): Promise<TaskRow[]> {
  const res = await authFetch(
    `${API_URL}/api/brain/tasks?workspaceId=${encodeURIComponent(workspaceId)}`,
  );
  if (!res.ok) throw new Error(`Failed to load tasks (${res.status})`);
  const body = (await res.json()) as { tasks?: TaskRow[] };
  return body.tasks ?? [];
}

// ── Server bulk lane ([COMP:api/tasks-bulk-route]) ──────────────────────

export type BulkTaskSet = {
  status?: TaskStatus;
  /** null unassigns. */
  assignee_id?: string | null;
  /** null clears the conventional `attributes.priority` key. */
  priority?: TaskPriority | null;
  /** ISO date string, or null to clear. */
  due_at?: string | null;
};

export type BulkTasksResult = {
  ok: boolean;
  /** Per-id outcome; `newId` is the supersession id on updates. */
  results: { id: string; ok: boolean; newId?: string }[];
};

/**
 * One round-trip bulk mutation — the server loops the same per-row update /
 * soft-delete the single-row endpoints use. The surface reaches for this on
 * LARGE selections; small ones keep the client loop (per-row retry UX).
 */
export async function bulkTasks(
  workspaceId: string,
  body:
    | { action: "update"; ids: string[]; set: BulkTaskSet }
    | { action: "delete"; ids: string[] },
): Promise<BulkTasksResult | { ok: false; error: string }> {
  const res = await authFetch(
    `${API_URL}/api/brain-inbox/${encodeURIComponent(workspaceId)}/tasks/bulk`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: data.error ?? `Bulk failed (${res.status})` };
  }
  return (await res.json()) as BulkTasksResult;
}
