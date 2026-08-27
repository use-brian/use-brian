"use client";

/**
 * Task peek panel — clicking a task row/card opens THIS floating editor
 * over the surface, not a bounce into the Brain view. Built from the SAME
 * property-page primitives the Brain entry page uses
 * (`brain/property-field.tsx`: big muted kind icon + `PageTitle`,
 * icon-led `PropertyRow`s, Notion-style dot-pill values, "Empty"
 * placeholders) so a task reads identically here and in Brain — the peek
 * is the entry page's field block in side-panel size. "Open in Brain"
 * remains the doorway to the full page (source, thread, sensitivity).
 *
 * A floating overlay, never a flex sibling — opening a task must not
 * reflow the table/board underneath.
 *
 * [COMP:app-web/tasks-surface] (the peek-panel flavour)
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  Calendar,
  CircleDashed,
  Clock3,
  ExternalLink,
  Flag,
  Folder,
  SquareCheckBig,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { brainRowUrl } from "@/lib/brain-deep-link";
import {
  explainBrainRow,
  type AdjustMemoryChanges,
  type ExplainContext,
} from "@/lib/api/brain-inbox";
import {
  taskDescription,
  taskIcon,
  taskPriority,
  type TaskRow,
  type TaskStatus,
} from "@/lib/api/tasks";
import { localIsoDay, taskProject } from "@/lib/tasks-view";
import type { ContextProject } from "@/lib/api/context-scopes";
import {
  memberDisplayName,
  resolveAssignee,
  TASK_PRIORITY_DOT_CLASS,
  TASK_STATUS_DOT_CLASS,
  type AssignableMember,
} from "@/components/brain/property-edit";
import {
  DateProperty,
  EditableBody,
  PageTitle,
  PersonProperty,
  SelectProperty,
  StaticProperty,
  type PersonPropertyOption,
  type SelectPropertyOption,
} from "@/components/brain/property-field";
import { originClue } from "@/components/brain/source-origin";
import { ResizablePeek } from "@/components/operator/resizable-peek";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import { promptDialog } from "@/components/ui/prompt-dialog";

export function TaskRecordDetail({
  workspaceId,
  row,
  roster,
  projects,
  commitField,
  commitProject,
  onDelete,
  onClose,
}: {
  workspaceId: string;
  row: TaskRow;
  roster: AssignableMember[] | null;
  projects: ContextProject[];
  /** The surface's adjust wire (supersession-aware local patch included). */
  commitField: (
    row: TaskRow,
    changes: AdjustMemoryChanges,
    patch: Partial<TaskRow>,
  ) => Promise<{ ok: boolean; error?: string }>;
  commitProject: (
    row: TaskRow,
    projectId: string | null,
  ) => Promise<{ ok: boolean; error?: string }>;
  /** `reason` is "" when the user deleted without teaching a rule. */
  onDelete: (reason: string) => Promise<{ ok: boolean; error?: string }>;
  onClose: () => void;
}) {
  const t = useT();
  const tp = t.tasksPage;
  const review = t.memoriesReview;
  const statusLabels = t.brainPage.taskStatus as Record<string, string>;
  const priorityLabels = t.brainPage.taskPriority as Record<string, string>;
  const memberRoleLabels = t.brainPage.detailDrawer.memberRole as Record<
    string,
    string
  >;
  const drawerLabels = t.brainPage.detailDrawer.propertyLabels as Record<
    string,
    string
  >;

  const statusOptions: SelectPropertyOption[] = (
    ["todo", "in_progress", "in_review", "blocked", "done", "archived"] as TaskStatus[]
  ).map((s) => ({
    value: s,
    label: statusLabels[s] ?? s,
    dotClassName: TASK_STATUS_DOT_CLASS[s],
  }));

  // "none" is a select-only sentinel — the wire clears with null.
  const priorityOptions: SelectPropertyOption[] = (
    ["none", "low", "medium", "high", "urgent"] as const
  ).map((p) => ({
    value: p,
    label: priorityLabels[p] ?? p,
    dotClassName: TASK_PRIORITY_DOT_CLASS[p],
  }));

  const projectOptions: SelectPropertyOption[] = [
    { value: "__none__", label: tp.noProject },
    ...projects.map((project) => ({ value: project.id, label: project.name })),
  ];

  const assigneeMember =
    row.assigneeId && roster ? resolveAssignee(roster, row.assigneeId) : null;
  const assigneeOptions: PersonPropertyOption[] = (roster ?? []).map((m) => ({
    id: m.id,
    name: memberDisplayName(m) ?? tp.memberUnknown,
    email: m.email,
    avatarUrl: m.avatarUrl,
    roleLabel: memberRoleLabels[m.role] ?? null,
  }));

  const priority = taskPriority(row) ?? "none";
  const project = taskProject(row);
  const icon = taskIcon(row);
  const [creationContext, setCreationContext] = useState<
    ExplainContext | null | undefined
  >(undefined);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function deleteWithReason() {
    const answer = await promptDialog({
      title: tp.deleteTaskTitle,
      description: tp.deleteTaskDescription,
      placeholder: tp.deleteReasonPlaceholder,
      confirmLabel: tp.deleteAndAddRule,
      emptyConfirmLabel: tp.deleteTaskOnly,
      cancelLabel: t.common.cancel,
      multiline: true,
      // An empty reason still deletes; it just teaches nothing.
      allowEmpty: true,
    });
    if (answer === null) return;
    const reason = answer.trim();
    if (reason.length > 0 && reason.length < 3) {
      setDeleteError(tp.deleteReasonTooShort);
      return;
    }
    setDeleteError(null);
    setDeleting(true);
    const result = await onDelete(reason).catch(() => ({
      ok: false,
      error: tp.deleteFailed,
    }));
    setDeleting(false);
    if (!result.ok) {
      setDeleteError(result.error ?? tp.deleteFailed);
      return;
    }
    onClose();
  }

  useEffect(() => {
    let alive = true;
    setCreationContext(undefined);
    void explainBrainRow(workspaceId, "task", row.id)
      .then((context) => {
        if (alive) setCreationContext(context);
      })
      .catch(() => {
        if (alive) setCreationContext(null);
      });
    return () => {
      alive = false;
    };
  }, [row.id, workspaceId]);

  const createdBy = creationContext
    ? originClue(
        creationContext.origin,
        review,
        creationContext.savedAt,
        creationContext.savedByAssistantName,
      ) ?? review.whyNoMessages
    : creationContext === undefined
      ? review.loading
      : review.whyUnavailable;
  const createdAt = creationContext
    ? new Date(creationContext.savedAt).toLocaleString()
    : creationContext === undefined
      ? review.loading
      : review.whyUnavailable;

  return (
    <ResizablePeek storageKey="operator:peek-width" ariaLabel={row.title} onDismiss={onClose}>
      {/* Slim action toolbar — the Brain entry page's top-row shape. */}
      <div className="flex items-center justify-end gap-1 border-b border-border/60 px-3 py-2">
        <button
          type="button"
          aria-label={tp.deleteTaskAria}
          title={tp.deleteTaskAria}
          disabled={deleting}
          onClick={() => void deleteWithReason()}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:pointer-events-none disabled:opacity-50"
        >
          <Trash2 className="size-4" aria-hidden />
        </button>
        <Link
          href={brainRowUrl("", workspaceId, row.id, "task")}
          title={tp.openInBrain}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
        >
          <ExternalLink className="size-4" aria-hidden />
        </Link>
        <button
          type="button"
          aria-label={tp.closeDetail}
          onClick={onClose}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>

      {deleteError ? (
        <div
          role="alert"
          className="border-b border-destructive/20 bg-destructive/10 px-4 py-2 text-xs text-destructive"
        >
          {deleteError}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {/* The leading glyph is the icon editor. Outside the peek, only an
            assigned emoji renders beside the title. */}
        <div className="flex items-start gap-3">
          <EmojiPicker
            side="bottom"
            align="start"
            onPick={(next) => {
              const attributes = { ...row.attributes };
              if (next === null) delete attributes.icon;
              else attributes.icon = next;
              void commitField(row, { icon: next }, { attributes });
            }}
            trigger={
              <button
                type="button"
                aria-label={tp.iconButtonAria}
                className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground/40 transition-colors hover:bg-muted hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                {icon ? (
                  <span className="text-2xl leading-none" aria-hidden>
                    {icon}
                  </span>
                ) : (
                  <SquareCheckBig className="size-8 stroke-[1.5]" aria-hidden />
                )}
              </button>
            }
          />
          <div className="min-w-0 flex-1">
            <PageTitle
              value={row.title}
              editable
              onCommit={(title) => commitField(row, { title }, { title })}
            />
          </div>
        </div>

        {/* Property list — the entry page's field block. */}
        <div className="mt-3 flex flex-col">
          <SelectProperty
            icon={<CircleDashed />}
            label={drawerLabels.status ?? tp.filterStatus}
            value={row.status}
            options={statusOptions}
            onCommit={(status) =>
              commitField(
                row,
                { status: status as TaskStatus },
                { status: status as TaskStatus },
              )
            }
          />
          <SelectProperty
            icon={<Flag />}
            label={drawerLabels.priority ?? tp.filterPriority}
            value={priority}
            options={priorityOptions}
            onCommit={(next) =>
              commitField(
                row,
                {
                  priority:
                    next === "none"
                      ? null
                      : (next as "low" | "medium" | "high" | "urgent"),
                },
                {
                  attributes:
                    next === "none"
                      ? Object.fromEntries(
                          Object.entries(row.attributes).filter(
                            ([k]) => k !== "priority",
                          ),
                        )
                      : { ...row.attributes, priority: next },
                },
              )
            }
          />
          <DateProperty
            icon={<Calendar />}
            label={drawerLabels.due_at ?? tp.filterDue}
            value={row.due ? localIsoDay(row.due) : ""}
            onCommit={(next) =>
              commitField(
                row,
                { due_at: next.length > 0 ? next : null },
                { due: next.length > 0 ? next : null },
              )
            }
          />
          <PersonProperty
            icon={<UserRound />}
            label={drawerLabels.assignee_id ?? tp.filterAssignee}
            value={
              assigneeMember
                ? {
                    name: memberDisplayName(assigneeMember) ?? tp.memberUnknown,
                    email: assigneeMember.email,
                    avatarUrl: assigneeMember.avatarUrl,
                    roleLabel:
                      memberRoleLabels[assigneeMember.role] ?? null,
                  }
                : null
            }
            loading={roster === null}
            unknownLabel={
              row.assigneeId && !assigneeMember ? tp.memberUnknown : null
            }
            options={assigneeOptions}
            currentId={row.assigneeId}
            clearLabel={tp.unassignedOption}
            onCommit={(assigneeId) =>
              commitField(row, { assignee_id: assigneeId }, { assigneeId })
            }
          />
          <SelectProperty
            icon={<Folder />}
            label={tp.filterProject}
            value={project ?? "__none__"}
            options={projectOptions}
            onCommit={(next) => commitProject(row, next === "__none__" ? null : next)}
          />
          <StaticProperty
            icon={<Clock3 />}
            label={tp.createdAtLabel}
            value={createdAt}
          />
          <StaticProperty
            icon={<UserRound />}
            label={tp.createdByLabel}
            value={createdBy}
          />
        </div>

        {/* Page body — the conventional `attributes.description` markdown
            (frozen-v1: no typed column), the same section the Brain entry
            page renders. */}
        <div className="mt-4">
          <EditableBody
            label={drawerLabels.description ?? tp.descriptionLabel}
            value={taskDescription(row)}
            placeholder={tp.descriptionPlaceholder}
            onCommit={(next) => {
              const value = next.trim().length > 0 ? next : null;
              return commitField(
                row,
                { description: value },
                {
                  attributes:
                    value === null
                      ? Object.fromEntries(
                          Object.entries(row.attributes).filter(
                            ([k]) => k !== "description",
                          ),
                        )
                      : { ...row.attributes, description: value },
                },
              );
            }}
          />
        </div>
      </div>
    </ResizablePeek>
  );
}
