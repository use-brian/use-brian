"use client";

/**
 * The action items a recording produced — and the only place they are ever
 * reviewed.
 *
 * This is the per-recording **extraction queue**. Every task synthesis captures
 * is written `source='extracted'` and UNVERIFIED, and the brain inbox
 * deliberately excludes extracted rows (`brain-inbox-store.ts`: one transcript
 * naming 30 people "would otherwise flood the inbox overnight"), naming a
 * "separate Extraction queue surface tuned for higher signal-to-noise" as the
 * follow-up. This is it: scoped to ONE meeting, where the signal-to-noise is
 * high and the user has the context to judge.
 *
 * So an item has two lives:
 *   - **Unconfirmed** — the model heard it; nobody has agreed. Confirm (verify)
 *     or Dismiss (soft-delete) it.
 *   - **Confirmed** — a real task like any other: tick it to close, open it in
 *     the brain.
 *
 * The task EXISTS in the brain either way, deliberately: capture has to work
 * for the meeting you never revisit, so "nothing is written until you press a
 * button" would silently lose every action item from an unopened recording.
 * Unverified is the honest state for "extracted but unconfirmed" and it is the
 * axis the rest of the brain already uses.
 *
 * Fathom's lesson underneath it: an action item is a POINTER INTO the
 * recording, not a detached string. The pointer is `tasks.source_start_ms`
 * (migration 334); `source_episode_id` already answered *which* recording.
 *
 * **Why not read the brief's `action-items` prose field?** That is a snapshot of
 * what the model thought at synthesis time. These are the real rows: they
 * close, reopen, get reassigned, and show up in every other task surface.
 *
 * **Chrome, never a doc block** — see `recording-player-bar.tsx`.
 *
 * Owner chips are best-effort: `assigneeId` is a `workspace_members` row id, so
 * an item the model attributed to a name it could not bind to a member
 * ("Priya", or an unresolved diarization label like "Speaker 2") renders
 * without a chip rather than guessing.
 *
 * [COMP:app-web/recording-chrome]
 */

import { useCallback, useEffect, useState } from "react";
import { formatStamp } from "@use-brian/shared";
import { useT } from "@/lib/i18n/client";
import { useRecordingPlayer } from "@/lib/recordings/recording-player-context";
import { listRecordingTasks, type RecordingTask } from "@/lib/api/recordings";
import {
  adjustBrainRow,
  verifyBrainRow,
  deleteBrainRow,
  fetchBrainRow,
} from "@/lib/api/brain-inbox";
import { projectInboxRowToBrainRow, type BrainRow } from "@/lib/api/brain";
import { BrainDetailDrawer } from "@/components/brain/detail-drawer";
import { loadWorkspaceRoster } from "@/lib/api/workspace-roster";
import type { FeedWorkspaceMember } from "@/lib/api/feed";

/** Done and archived both read as "not outstanding" to the checkbox. */
function isClosed(status: RecordingTask["status"]): boolean {
  return status === "done" || status === "archived";
}

function OwnerChip({ member }: { member: FeedWorkspaceMember }) {
  const label = member.userName ?? member.email ?? "";
  if (!label) return null;
  return (
    <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
      {label}
    </span>
  );
}

export function ActionItemsRail({
  recordingId,
  workspaceId,
  className = "",
}: {
  recordingId: string;
  workspaceId: string;
  className?: string;
}) {
  const t = useT();
  const { seekTo } = useRecordingPlayer();
  const [tasks, setTasks] = useState<RecordingTask[]>([]);
  const [roster, setRoster] = useState<FeedWorkspaceMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  /**
   * The task open in the brain drawer, or null. Opened IN PLACE rather than
   * navigating to `/brain?row=<id>`: the point of this rail is to triage a
   * meeting without leaving the meeting — routing away loses the player's
   * position and the page you were reading. The drawer is context-free (it
   * takes only `row` + `workspaceId`), so it mounts here exactly as it does on
   * the brain page.
   */
  const [openRow, setOpenRow] = useState<BrainRow | null>(null);

  /** Fetch the full brain row for a task and open the drawer on it. */
  const open = useCallback(
    async (taskId: string) => {
      setBusy(taskId);
      const detail = await fetchBrainRow(workspaceId, "task", taskId).catch(() => null);
      if (detail) {
        setOpenRow({
          ...projectInboxRowToBrainRow(detail),
          // The projection hardcodes `hasPending` for the inbox, which only
          // ever holds unverified rows. This rail addresses ANY live task, so
          // the row's real verified state decides whether the drawer offers
          // the confirm affordance.
          hasPending: detail.verifiedAt == null,
        });
      }
      setBusy(null);
    },
    [workspaceId],
  );

  /** Re-read the list. Called on mount and after the drawer closes, since the
   *  drawer can rename, retitle, verify or delete the task behind our back. */
  const reload = useCallback(async () => {
    try {
      setTasks(await listRecordingTasks(recordingId));
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [recordingId]);

  useEffect(() => {
    void reload();
    // A roster failure only costs the owner chips - never the list.
    let live = true;
    loadWorkspaceRoster(workspaceId)
      .then((r) => live && setRoster(r))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [reload, workspaceId]);

  /** Confirm: the model heard this right. Marks the row verified. */
  const confirm = useCallback(
    async (task: RecordingTask) => {
      setBusy(task.id);
      setTasks((rows) =>
        rows.map((r) => (r.id === task.id ? { ...r, verified: true } : r)),
      );
      const res = await verifyBrainRow(workspaceId, "task", task.id).catch(() => ({
        ok: false as const,
        error: "failed",
      }));
      if (!res.ok) {
        setTasks((rows) =>
          rows.map((r) => (r.id === task.id ? { ...r, verified: false } : r)),
        );
      }
      setBusy(null);
    },
    [workspaceId],
  );

  /** Dismiss: the model misheard, or it is not a task. Soft-deletes the row. */
  const dismiss = useCallback(
    async (task: RecordingTask) => {
      setBusy(task.id);
      const prev = tasks;
      setTasks((rows) => rows.filter((r) => r.id !== task.id));
      const res = await deleteBrainRow(workspaceId, "task", task.id).catch(() => ({
        ok: false as const,
        error: "failed",
      }));
      if (!res.ok) setTasks(prev);
      setBusy(null);
    },
    [workspaceId, tasks],
  );

  /** Tick: close or reopen a confirmed task. */
  const toggle = useCallback(
    async (task: RecordingTask) => {
      const next = isClosed(task.status) ? "todo" : "done";
      const prev = task.status;
      setBusy(task.id);
      setTasks((rows) =>
        rows.map((r) => (r.id === task.id ? { ...r, status: next } : r)),
      );
      const res = await adjustBrainRow(workspaceId, "task", task.id, {
        status: next,
      }).catch(() => ({ ok: false as const, error: "failed" }));
      if (!res.ok) {
        setTasks((rows) =>
          rows.map((r) => (r.id === task.id ? { ...r, status: prev } : r)),
        );
      }
      setBusy(null);
    },
    [workspaceId],
  );

  if (loading) {
    return <p className="text-sm text-muted-foreground">{t.recordings.actionItemsLoading}</p>;
  }
  if (error) {
    return <p className="text-sm text-muted-foreground">{t.recordings.actionItemsError}</p>;
  }
  if (tasks.length === 0) {
    return <p className="text-sm text-muted-foreground">{t.recordings.actionItemsEmpty}</p>;
  }

  return (
    <>
      {/* The brain's own detail card, mounted here. On close we re-read the
          list: the drawer can retitle, verify or delete the task, and a rail
          still showing the pre-edit row would quietly disagree with the brain. */}
      {openRow ? (
        <BrainDetailDrawer
          row={openRow}
          workspaceId={workspaceId}
          onClose={() => {
            setOpenRow(null);
            void reload();
          }}
        />
      ) : null}
    <ul className={`space-y-1 ${className}`}>
      {tasks.map((task) => {
        const closed = isClosed(task.status);
        const owner = task.assigneeId
          ? roster.find((m) => m.id === task.assigneeId)
          : undefined;
        const disabled = busy === task.id;
        return (
          <li
            key={task.id}
            className={`flex items-start gap-2 rounded px-2 py-1.5 ${
              task.verified ? "hover:bg-muted/40" : "border border-dashed border-border bg-background"
            }`}
          >
            {task.verified ? (
              <input
                type="checkbox"
                checked={closed}
                disabled={disabled}
                onChange={() => void toggle(task)}
                aria-label={task.title}
                className="mt-0.5 shrink-0 cursor-pointer"
              />
            ) : (
              <span
                aria-hidden
                className="mt-1 size-1.5 shrink-0 rounded-full bg-muted-foreground/50"
                title={t.recordings.actionItemsUnconfirmed}
              />
            )}

            <span className="min-w-0 flex-1">
              {/* Opens the brain's detail drawer IN PLACE — the same card the
                  brain list shows. Not a link: navigating to /brain would drop
                  the player's position and the brief you are reading, and the
                  whole point of triaging here is not leaving the meeting. */}
              <button
                type="button"
                disabled={disabled}
                onClick={() => void open(task.id)}
                className={`text-left text-sm hover:underline disabled:opacity-50 ${
                  closed ? "text-muted-foreground line-through" : ""
                }`}
              >
                {task.title}
              </button>
              <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
                {task.sourceStartMs !== null ? (
                  <button
                    type="button"
                    onClick={() => seekTo(task.sourceStartMs as number)}
                    className="shrink-0 tabular-nums text-xs text-muted-foreground hover:underline"
                    aria-label={`${t.recordings.actionItemsSeek} ${formatStamp(task.sourceStartMs)}`}
                  >
                    @ {formatStamp(task.sourceStartMs)}
                  </button>
                ) : null}
                {owner ? <OwnerChip member={owner} /> : null}
                {!task.verified ? (
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {t.recordings.actionItemsUnconfirmed}
                  </span>
                ) : null}
              </span>
            </span>

            {!task.verified ? (
              <span className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => void confirm(task)}
                  className="rounded border border-border px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-50"
                >
                  {t.recordings.actionItemsConfirm}
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => void dismiss(task)}
                  className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
                >
                  {t.recordings.actionItemsDismiss}
                </button>
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
    </>
  );
}
