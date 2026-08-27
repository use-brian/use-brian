/**
 * Tasks operator-surface SDK — the flat task list behind `/w/[id]/tasks`
 * (`GET /api/brain/tasks`, [COMP:brain/tasks-list-http]) plus the typed
 * priority accessor. Mutations reuse the existing brain-inbox wire
 * (`adjustBrainRow` / `deleteBrainRow` in `lib/api/brain-inbox.ts`) and the
 * server bulk lane (`bulkTasks` below) for large uniform edits and every
 * multi-delete.
 *
 * Spec: docs/architecture/features/tasks.md → "Operator surface".
 * [COMP:app-web/tasks-surface]
 */

import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type TaskStatus =
  | "todo"
  | "in_progress"
  | "in_review"
  | "blocked"
  | "done"
  | "archived";

export const TASK_STATUSES: TaskStatus[] = [
  "todo",
  "in_progress",
  "in_review",
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
  /** Stable Project registry id; a Task belongs to at most one Project. */
  projectId?: string | null;
  /** Stable Team ids used only to preserve Team classification on Project edits. */
  contextTeamIds?: string[];
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

/** The conventional `attributes.icon` emoji, or null for absent/junk data. */
export function taskIcon(row: Pick<TaskRow, "attributes">): string | null {
  const value = row.attributes?.icon;
  return typeof value === "string" &&
    value.trim().length > 0 &&
    Array.from(value).length <= 16
    ? value
    : null;
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
  results: {
    id: string;
    ok: boolean;
    newId?: string;
    tombstoned?: boolean;
    activeRuleId?: string | null;
  }[];
};

/**
 * One round-trip bulk mutation. Uniform updates preserve the per-row
 * supersession contract; plain deletes execute set-wise with hosted-goal and
 * audit cascades. The surface uses this for every multi-delete, regardless of
 * selection size.
 */
export async function bulkTasks(
  workspaceId: string,
  body:
    | { action: "update"; ids: string[]; set: BulkTaskSet }
    | {
        action: "delete";
        ids: string[];
        reason?: string;
        create_rule?: boolean;
      },
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
