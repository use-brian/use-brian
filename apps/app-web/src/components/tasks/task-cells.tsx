"use client";

/**
 * Inline cell editors for the Tasks operator surface — compact, quiet
 * pickers that commit a single field without opening the detail drawer
 * (tasks-operator-surface §3: "update details" without death-by-clicks).
 * The same pickers back the bulk-action bar (value-less flavour: pick →
 * apply to the whole selection).
 *
 * All dropdowns ride the project primitives (`Select`/`Popover`) — never a
 * native `<select>` (root CLAUDE.md). Commit contract mirrors
 * `property-field.tsx`: async commit, busy dim, revert-and-surface on error.
 *
 * [COMP:app-web/tasks-surface]
 */

import { useState } from "react";
import { CalendarDays } from "lucide-react";
import { cn } from "@/lib/utils";
import { localIsoDay } from "@/lib/tasks-view";
import { useT } from "@/lib/i18n/client";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { UserAvatar } from "@/components/ui/user-avatar";
import {
  memberDisplayName,
  resolveAssignee,
  type AssignableMember,
} from "@/components/brain/property-edit";
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  type TaskPriority,
  type TaskStatus,
} from "@/lib/api/tasks";

export type CellCommit<T> = (next: T) => Promise<{ ok: boolean; error?: string }>;

/** Status dot tints — matches the Brain list's status chip palette. */
export const STATUS_DOT: Record<TaskStatus, string> = {
  todo: "bg-muted-foreground/50",
  in_progress: "bg-blue-500",
  in_review: "bg-violet-500",
  blocked: "bg-amber-500",
  done: "bg-emerald-500",
  archived: "bg-muted-foreground/30",
};

const CELL_TRIGGER =
  "inline-flex h-7 max-w-full items-center gap-1.5 rounded-md px-1.5 text-[13px] " +
  "text-foreground/90 transition-colors hover:bg-muted/70 disabled:opacity-50";

/** Status pill cell — a `Select` over the five lifecycle statuses. */
export function StatusCell({
  value,
  onCommit,
  disabled,
}: {
  value: TaskStatus;
  onCommit: CellCommit<TaskStatus>;
  disabled?: boolean;
}) {
  const t = useT().brainPage;
  const labels = t.taskStatus as Record<string, string>;
  const [busy, setBusy] = useState(false);
  return (
    <Select
      value={value}
      onValueChange={(v) => {
        if (typeof v !== "string" || v === value) return;
        setBusy(true);
        void onCommit(v as TaskStatus).finally(() => setBusy(false));
      }}
      disabled={disabled || busy}
      items={Object.fromEntries(TASK_STATUSES.map((s) => [s, labels[s] ?? s]))}
    >
      <SelectTrigger
        className={cn(
          CELL_TRIGGER,
          "w-auto border-0 bg-transparent shadow-none dark:bg-transparent",
          "[&>svg:last-child]:opacity-0 hover:[&>svg:last-child]:opacity-60",
          busy && "opacity-60",
        )}
      >
        <span className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[value])} aria-hidden />
        <span className="truncate">{labels[value] ?? value}</span>
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {TASK_STATUSES.map((s) => (
          <SelectItem key={s} value={s}>
            <span className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[s])} aria-hidden />
            <span>{labels[s] ?? s}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Priority cell — `Select` over none/low/medium/high/urgent. */
export function PriorityCell({
  value,
  onCommit,
  disabled,
}: {
  value: TaskPriority | null;
  onCommit: CellCommit<TaskPriority | null>;
  disabled?: boolean;
}) {
  const t = useT().brainPage;
  const labels = t.taskPriority as Record<string, string>;
  const [busy, setBusy] = useState(false);
  const NONE = "__none__";
  return (
    <Select
      value={value ?? NONE}
      onValueChange={(v) => {
        if (typeof v !== "string") return;
        const next = v === NONE ? null : (v as TaskPriority);
        if (next === value) return;
        setBusy(true);
        void onCommit(next).finally(() => setBusy(false));
      }}
      disabled={disabled || busy}
      items={{
        [NONE]: labels.none ?? "None",
        ...Object.fromEntries(
          TASK_PRIORITIES.map((p) => [p, labels[p] ?? p]),
        ),
      }}
    >
      <SelectTrigger
        className={cn(
          CELL_TRIGGER,
          "w-auto border-0 bg-transparent shadow-none dark:bg-transparent",
          "[&>svg:last-child]:opacity-0 hover:[&>svg:last-child]:opacity-60",
          value === null && "text-muted-foreground/60",
          busy && "opacity-60",
        )}
      >
        <span className="truncate">
          {value ? labels[value] ?? value : labels.none ?? "None"}
        </span>
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        <SelectItem value={NONE}>{labels.none ?? "None"}</SelectItem>
        {TASK_PRIORITIES.map((p) => (
          <SelectItem key={p} value={p}>
            {labels[p] ?? p}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Assignee cell — roster popover; picking commits the member id, the
 *  clear row commits null. Compact clone of `PersonProperty`'s editable
 *  flavour. */
export function AssigneeCell({
  assigneeId,
  roster,
  onCommit,
  disabled,
}: {
  assigneeId: string | null;
  roster: AssignableMember[] | null;
  onCommit: CellCommit<string | null>;
  disabled?: boolean;
}) {
  const t = useT().tasksPage;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const member =
    assigneeId && roster ? resolveAssignee(roster, assigneeId) : null;
  const name = member ? memberDisplayName(member) : null;

  function commit(nextId: string | null) {
    setOpen(false);
    if (nextId === assigneeId) return;
    setBusy(true);
    void onCommit(nextId).finally(() => setBusy(false));
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled || busy || !roster}
        aria-label={t.filterAssignee}
        className={cn(CELL_TRIGGER, busy && "opacity-60")}
      >
        {member ? (
          <>
            <UserAvatar
              name={name ?? undefined}
              email={member.email ?? undefined}
              avatarUrl={member.avatarUrl}
              size={18}
            />
            <span className="hidden truncate md:inline">{name}</span>
          </>
        ) : (
          <span className="text-muted-foreground/60">{t.unassignedOption}</span>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-72 w-60 overflow-y-auto p-1">
        <button
          type="button"
          onClick={() => commit(null)}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted",
            !assigneeId && "bg-muted/60",
          )}
        >
          <span className="text-muted-foreground">{t.unassignedOption}</span>
        </button>
        {(roster ?? []).map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => commit(m.id)}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted",
              assigneeId === m.id && "bg-muted/60",
            )}
          >
            <UserAvatar
              name={memberDisplayName(m) ?? undefined}
              email={m.email ?? undefined}
              avatarUrl={m.avatarUrl}
              size={20}
            />
            <span className="min-w-0 flex-1 truncate">
              {memberDisplayName(m) ?? t.memberUnknown}
            </span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/** Due cell — quiet button revealing a date input; clearing commits null. */
export function DueCell({
  value,
  onCommit,
  disabled,
}: {
  /** ISO timestamp or null. */
  value: string | null;
  onCommit: CellCommit<string | null>;
  disabled?: boolean;
}) {
  const t = useT().tasksPage;
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const dateValue = value ? localIsoDay(value) : "";

  function commit(next: string) {
    setEditing(false);
    if (next === dateValue) return;
    setBusy(true);
    void onCommit(next.length > 0 ? next : null).finally(() => setBusy(false));
  }

  if (editing) {
    return (
      <input
        type="date"
        autoFocus
        defaultValue={dateValue}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit((e.target as HTMLInputElement).value);
          }
          if (e.key === "Escape") {
            e.stopPropagation();
            setEditing(false);
          }
        }}
        className="h-7 rounded-md bg-muted/50 px-1.5 text-[13px] outline-none ring-1 ring-ring/40"
      />
    );
  }

  const overdue =
    value !== null && new Date(value).getTime() < Date.now() ? true : false;
  return (
    <button
      type="button"
      disabled={disabled || busy}
      aria-label={t.filterDue}
      onClick={() => setEditing(true)}
      className={cn(
        CELL_TRIGGER,
        "tabular-nums",
        value === null && "text-muted-foreground/60",
        overdue && "text-red-500",
        busy && "opacity-60",
      )}
    >
      <CalendarDays className="size-3.5 shrink-0 opacity-60" aria-hidden />
      <span className="whitespace-nowrap">
        {value
          ? new Date(value).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            })
          : t.noDate}
      </span>
    </button>
  );
}

/**
 * Project cell — popover over the workspace's existing `project:` facets
 * plus a "no project" row and a new-project input (a project is born by
 * naming it — it's a tag namespace, not a primitive; §5).
 */
export function ProjectCell({
  value,
  projects,
  onCommit,
  disabled,
}: {
  value: string | null;
  /** Existing project names across the workspace's tasks. */
  projects: string[];
  onCommit: CellCommit<string | null>;
  disabled?: boolean;
}) {
  const t = useT().tasksPage;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");

  function commit(next: string | null) {
    setOpen(false);
    setDraft("");
    if (next === value) return;
    setBusy(true);
    void onCommit(next).finally(() => setBusy(false));
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled || busy}
        aria-label={t.filterProject}
        className={cn(CELL_TRIGGER, busy && "opacity-60")}
      >
        {value ? (
          <span className="truncate rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground border border-border">
            {value}
          </span>
        ) : (
          <span className="text-muted-foreground/60">{t.noProject}</span>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-72 w-56 overflow-y-auto p-1">
        <button
          type="button"
          onClick={() => commit(null)}
          className={cn(
            "flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted",
            !value && "bg-muted/60",
          )}
        >
          {t.noProject}
        </button>
        {projects.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => commit(p)}
            className={cn(
              "flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted",
              value === p && "bg-muted/60",
            )}
          >
            <span className="truncate">{p}</span>
          </button>
        ))}
        <div className="mt-1 border-t border-border p-1">
          <input
            type="text"
            value={draft}
            placeholder={t.newProjectPlaceholder}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                const name = draft.trim();
                if (name.length > 0) commit(name);
              }
            }}
            className="h-7 w-full rounded-md border border-border bg-background px-2 text-[13px] outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
