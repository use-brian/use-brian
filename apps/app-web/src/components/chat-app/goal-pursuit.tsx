"use client";

/**
 * In-chat goal pursuit — the transcript-native rendering of a goal that
 * originated in the open chat session (docs/architecture/features/goals.md →
 * "In-chat pursuit").
 *
 *   GoalPursuitCard    — an inline transcript block anchored where the goal
 *                        was created: outcome, status, the live execution
 *                        activity feed (the same SSE lane the composer
 *                        receipt follows), and the goal-page link. A terminal
 *                        goal renders its final status, so history keeps the
 *                        record without holding a stream.
 *   GoalPursuitSticky  — the slim always-visible strip pinned to the top of
 *                        the transcript while any session goal is still being
 *                        pursued; click jumps to the inline card.
 *   interleaveSessionGoals — pure placement: each goal anchors after the last
 *                        message at-or-before its creation time, so the card
 *                        sits exactly where the arming turn happened.
 *
 * The card renders STRUCTURED activity events (reasoning/tool frames from the
 * goal activity lane), never the background worker's turn text as chat prose:
 * a turn that calls tools is mid-reasoning, not a reply (turn-text-assembly).
 *
 * [COMP:app-web/goal-pursuit]
 */
import Link from "next/link";
import { ArrowUpRight, LoaderCircle, Target } from "lucide-react";
import { GoalExecutionActivity } from "@/components/chat-app/goal-execution-activity";
import type { GoalRow } from "@/lib/api/goals";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "done",
  "blocked",
  "abandoned",
]);

export function isGoalPursuitTerminal(status: string | null | undefined): boolean {
  return status != null && TERMINAL_STATUSES.has(status);
}

export type GoalPursuitPlacement = {
  /** goalIds anchored after each message id, in creation order. */
  afterMessage: Map<string, GoalRow[]>;
  /** Goals newer than the last message (a turn still streaming, or an empty
   *  transcript edge) — rendered at the end of the thread. */
  trailing: GoalRow[];
};

/**
 * Anchor each goal after the LAST message created at or before the goal —
 * the turn whose tool call armed it. A goal older than every message (a
 * truncated transcript) anchors after the first message rather than
 * disappearing; with no messages at all everything trails.
 */
export function interleaveSessionGoals(
  messages: ReadonlyArray<{ id: string; timestamp: Date }>,
  goals: ReadonlyArray<GoalRow>,
): GoalPursuitPlacement {
  const afterMessage = new Map<string, GoalRow[]>();
  const trailing: GoalRow[] = [];
  const sorted = [...goals].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
  for (const goal of sorted) {
    const created = Date.parse(goal.createdAt);
    let anchor: string | null = null;
    for (const message of messages) {
      const at = message.timestamp.getTime();
      if (Number.isNaN(at) || at <= created) anchor = message.id;
      else break;
    }
    if (anchor === null) {
      if (messages.length > 0) anchor = messages[0].id;
      else {
        trailing.push(goal);
        continue;
      }
    }
    const existing = afterMessage.get(anchor);
    if (existing) existing.push(goal);
    else afterMessage.set(anchor, [goal]);
  }
  return { afterMessage, trailing };
}

export function GoalPursuitCard({
  goal,
  workspaceId,
  liveStatus,
  onStatusChange,
  className,
}: {
  goal: GoalRow;
  workspaceId: string;
  /** Live status override fed back from this card's own activity stream via
   *  `onStatusChange` (lifted so the sticky strip shares one subscription). */
  liveStatus?: string | null;
  onStatusChange?: (goalId: string, status: string) => void;
  className?: string;
}) {
  const t = useT();
  const tApp = t.chatApp;
  const status = liveStatus ?? goal.status;
  const terminal = isGoalPursuitTerminal(status);
  const statusLabel =
    t.goalsPage.status[status as keyof typeof t.goalsPage.status] ?? status;

  return (
    <section
      data-testid="goal-pursuit-card"
      data-goal-pursuit-id={goal.id}
      className={cn(
        "relative w-full max-w-[92%] overflow-hidden rounded-xl border border-primary/20 bg-primary/[0.04] px-3.5 py-3",
        "before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary/70",
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <Target className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-primary">
              {tApp.goalPursuitHeading}
            </span>
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
              {!terminal ? (
                <LoaderCircle className="size-3 animate-spin" aria-hidden />
              ) : null}
              {statusLabel}
            </span>
            <Link
              href={`/w/${encodeURIComponent(workspaceId)}/goals/${encodeURIComponent(goal.id)}`}
              className="ml-auto inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
            >
              {tApp.goalAcceptedOpen}
              <ArrowUpRight className="size-3" aria-hidden />
            </Link>
          </div>
          <p className="mt-1 text-[13px] font-medium leading-relaxed text-foreground">
            {goal.outcome}
          </p>
          <GoalExecutionActivity
            goalId={goal.id}
            initialStatus={goal.status}
            onStatusChange={(next) => onStatusChange?.(goal.id, next)}
            className="mt-2 border-t border-primary/10 pt-1.5"
          />
        </div>
      </div>
    </section>
  );
}

export function GoalPursuitSticky({
  goals,
  statuses,
  onJump,
  className,
}: {
  /** The session's goals; the strip renders only the non-terminal ones. */
  goals: ReadonlyArray<GoalRow>;
  /** Live status overrides keyed by goal id (from the cards' streams). */
  statuses: Readonly<Record<string, string>>;
  onJump?: (goalId: string) => void;
  className?: string;
}) {
  const t = useT();
  const tApp = t.chatApp;
  const pursuing = goals.filter(
    (goal) => !isGoalPursuitTerminal(statuses[goal.id] ?? goal.status),
  );
  if (pursuing.length === 0) return null;

  return (
    <div
      data-testid="goal-pursuit-sticky"
      className={cn(
        "sticky top-0 z-10 flex flex-col gap-1 rounded-lg border border-primary/20 bg-background/95 px-3 py-1.5 shadow-sm backdrop-blur",
        className,
      )}
    >
      {pursuing.map((goal) => {
        const status = statuses[goal.id] ?? goal.status;
        const statusLabel =
          t.goalsPage.status[status as keyof typeof t.goalsPage.status] ?? status;
        return (
          <button
            key={goal.id}
            type="button"
            onClick={() => onJump?.(goal.id)}
            aria-label={tApp.goalPursuitJump}
            title={tApp.goalPursuitJump}
            className="flex min-w-0 items-center gap-2 text-left"
          >
            <LoaderCircle
              className="size-3 shrink-0 animate-spin text-primary"
              aria-hidden
            />
            <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.12em] text-primary">
              {tApp.goalPursuitSticky}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs text-foreground">
              {goal.outcome}
            </span>
            <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
              {statusLabel}
            </span>
          </button>
        );
      })}
    </div>
  );
}
