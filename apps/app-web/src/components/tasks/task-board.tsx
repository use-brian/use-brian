"use client";

/**
 * Task board — the kanban flavour of the Tasks operator surface
 * (tasks-operator-surface §6 Phase 3): one column per lifecycle status,
 * HTML5 drag-a-card-between-columns to change status (the same
 * `adjustBrainRow` wire the table's inline status cell commits through —
 * the surface owns the commit, the board just raises `onStatusDrop`).
 *
 * Done/archived columns show only when the completed reveal is on, so the
 * default board is the live-work triptych (todo / in progress / blocked).
 *
 * [COMP:app-web/tasks-surface] (the board flavour)
 */

import { useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { UserAvatar } from "@/components/ui/user-avatar";
import {
  memberDisplayName,
  resolveAssignee,
  type AssignableMember,
} from "@/components/brain/property-edit";
import { taskPriority, type TaskRow, type TaskStatus } from "@/lib/api/tasks";
import { taskProject } from "@/lib/tasks-view";
import { STATUS_DOT } from "./task-cells";

const LIVE_COLUMNS: readonly TaskStatus[] = ["todo", "in_progress", "blocked"];
const COMPLETED_COLUMNS: readonly TaskStatus[] = ["done", "archived"];

const PRIORITY_TINT: Record<string, string> = {
  urgent: "text-red-500",
  high: "text-amber-500",
  medium: "text-blue-500",
  low: "text-muted-foreground",
};

export function TaskBoard({
  rows,
  roster,
  showCompleted,
  onStatusDrop,
  workspaceId,
}: {
  rows: TaskRow[];
  roster: AssignableMember[] | null;
  /** Reveal the done/archived columns. */
  showCompleted: boolean;
  onStatusDrop: (row: TaskRow, status: TaskStatus) => void;
  workspaceId: string;
}) {
  const t = useT().tasksPage;
  const statusLabels = useT().brainPage.taskStatus as Record<string, string>;
  const priorityLabels = useT().brainPage.taskPriority as Record<string, string>;
  const [dragId, setDragId] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<TaskStatus | null>(null);

  const columns = showCompleted
    ? [...LIVE_COLUMNS, ...COMPLETED_COLUMNS]
    : LIVE_COLUMNS;

  return (
    <div className="flex h-full min-w-max gap-3 p-4">
      {columns.map((status) => {
        const cards = rows.filter((r) => r.status === status);
        return (
          <div
            key={status}
            onDragOver={(e) => {
              e.preventDefault();
              setOverColumn(status);
            }}
            onDragLeave={() => setOverColumn((c) => (c === status ? null : c))}
            onDrop={(e) => {
              e.preventDefault();
              setOverColumn(null);
              const id = e.dataTransfer.getData("text/task-id") || dragId;
              setDragId(null);
              const row = rows.find((r) => r.id === id);
              if (row && row.status !== status) onStatusDrop(row, status);
            }}
            className={cn(
              "flex w-72 shrink-0 flex-col rounded-2xl bg-muted/30 transition-shadow",
              overColumn === status && "ring-2 ring-primary/40",
            )}
          >
            <div className="flex items-center gap-1.5 px-3.5 pb-1 pt-2.5 text-[12.5px] font-semibold text-foreground/80">
              <span
                className={cn("size-2 rounded-full", STATUS_DOT[status])}
                aria-hidden
              />
              {statusLabels[status] ?? status}
              <span className="tabular-nums font-normal">{cards.length}</span>
            </div>
            <div className="flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto p-2 pt-1">
              {cards.length === 0 && (
                <div className="rounded-xl border border-dashed border-border/60 px-3 py-5 text-center text-[12px] text-muted-foreground/50">
                  {t.boardEmptyColumn}
                </div>
              )}
              {cards.map((row) => {
                const member =
                  row.assigneeId && roster
                    ? resolveAssignee(roster, row.assigneeId)
                    : null;
                const priority = taskPriority(row);
                const project = taskProject(row);
                return (
                  <div
                    key={row.id}
                    draggable
                    onDragStart={(e) => {
                      setDragId(row.id);
                      e.dataTransfer.setData("text/task-id", row.id);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={() => setDragId(null)}
                    className={cn(
                      "cursor-grab rounded-xl border border-border/60 bg-card p-3 shadow-xs transition-all hover:-translate-y-px hover:shadow-md active:cursor-grabbing",
                      dragId === row.id && "opacity-50",
                    )}
                  >
                    <Link
                      href={`/w/${workspaceId}/brain?row=${encodeURIComponent(row.id)}&kind=task`}
                      className="block text-[13px] font-medium leading-snug text-foreground hover:underline"
                      draggable={false}
                    >
                      {row.title}
                    </Link>
                    <div className="mt-2 flex items-center gap-1.5">
                      {priority && (
                        <span
                          className={cn(
                            "text-[10px] font-semibold uppercase tracking-wide",
                            PRIORITY_TINT[priority],
                          )}
                        >
                          {priorityLabels[priority] ?? priority}
                        </span>
                      )}
                      {project && (
                        <span className="truncate rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground border border-border">
                          {project}
                        </span>
                      )}
                      {row.due && (
                        <span
                          className={cn(
                            "text-[11px] tabular-nums text-muted-foreground",
                            new Date(row.due).getTime() < Date.now() &&
                              "text-red-500",
                          )}
                        >
                          {new Date(row.due).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                          })}
                        </span>
                      )}
                      {member && (
                        <span
                          className="ml-auto"
                          title={memberDisplayName(member) ?? undefined}
                        >
                          <UserAvatar
                            name={memberDisplayName(member) ?? undefined}
                            email={member.email ?? undefined}
                            avatarUrl={member.avatarUrl}
                            size={18}
                          />
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
