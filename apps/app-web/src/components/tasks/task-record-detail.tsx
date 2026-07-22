"use client";

/**
 * Task peek panel — clicking a task row/card opens THIS floating editor
 * over the surface (the CRM record-detail pattern), not a bounce into the
 * Brain view: title + every operator field edit in place through the same
 * inline cells the table uses; "Open in Brain" remains the doorway to the
 * full entry page (source, thread, sensitivity).
 *
 * A floating overlay, never a flex sibling — opening a task must not
 * reflow the table/board underneath.
 *
 * [COMP:app-web/tasks-surface] (the peek-panel flavour)
 */

import Link from "next/link";
import { ExternalLink, X } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { brainRowUrl } from "@/lib/brain-deep-link";
import { type AdjustMemoryChanges } from "@/lib/api/brain-inbox";
import { taskPriority, type TaskRow } from "@/lib/api/tasks";
import { taskProject, tagsWithProject } from "@/lib/tasks-view";
import { type AssignableMember } from "@/components/brain/property-edit";
import { EditableTitle } from "@/components/operator/editable-title";
import {
  AssigneeCell,
  DueCell,
  PriorityCell,
  ProjectCell,
  StatusCell,
} from "./task-cells";

export function TaskRecordDetail({
  workspaceId,
  row,
  roster,
  projects,
  commitField,
  onClose,
}: {
  workspaceId: string;
  row: TaskRow;
  roster: AssignableMember[] | null;
  projects: string[];
  /** The surface's adjust wire (supersession-aware local patch included). */
  commitField: (
    row: TaskRow,
    changes: AdjustMemoryChanges,
    patch: Partial<TaskRow>,
  ) => Promise<{ ok: boolean; error?: string }>;
  onClose: () => void;
}) {
  const t = useT().tasksPage;

  return (
    <aside className="absolute inset-y-0 right-0 z-20 flex w-[380px] max-w-[92vw] flex-col border-l border-border/60 bg-background shadow-2xl animate-in slide-in-from-right-4 fade-in duration-200">
      {/* Header */}
      <div className="flex items-start gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="mb-0.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/60">
            {t.detailKind}
          </div>
          <EditableTitle
            value={row.title}
            ariaLabel={t.detailTitleAria}
            onCommit={(title) => commitField(row, { title }, { title })}
          />
        </div>
        <Link
          href={brainRowUrl("", workspaceId, row.id, "task")}
          title={t.openInBrain}
          className="mt-0.5 rounded-md p-1 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
        >
          <ExternalLink className="size-4" aria-hidden />
        </Link>
        <button
          type="button"
          aria-label={t.closeDetail}
          onClick={onClose}
          className="mt-0.5 rounded-md p-1 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>

      {/* Fields — the same inline cells the table rows use. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <FieldRow label={t.filterStatus}>
          <StatusCell
            value={row.status}
            onCommit={(status) => commitField(row, { status }, { status })}
          />
        </FieldRow>
        <FieldRow label={t.filterAssignee}>
          <AssigneeCell
            assigneeId={row.assigneeId}
            roster={roster}
            onCommit={(assigneeId) =>
              commitField(row, { assignee_id: assigneeId }, { assigneeId })
            }
          />
        </FieldRow>
        <FieldRow label={t.filterPriority}>
          <PriorityCell
            value={taskPriority(row)}
            onCommit={(priority) =>
              commitField(
                row,
                { priority },
                {
                  attributes:
                    priority === null
                      ? Object.fromEntries(
                          Object.entries(row.attributes).filter(
                            ([k]) => k !== "priority",
                          ),
                        )
                      : { ...row.attributes, priority },
                },
              )
            }
          />
        </FieldRow>
        <FieldRow label={t.filterDue}>
          <DueCell
            value={row.due}
            onCommit={(due) => commitField(row, { due_at: due }, { due })}
          />
        </FieldRow>
        <FieldRow label={t.filterProject}>
          <ProjectCell
            value={taskProject(row)}
            projects={projects}
            onCommit={(project) => {
              const tags = tagsWithProject(row.tags, project);
              return commitField(row, { tags }, { tags });
            }}
          />
        </FieldRow>
      </div>
    </aside>
  );
}

function FieldRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-8 items-center gap-2">
      <span className="w-20 shrink-0 text-[12px] text-muted-foreground">
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
