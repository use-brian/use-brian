"use client";

/**
 * The chat streaming activity feed + the post-turn receipt.
 *
 * `<ChatActivityFeed>` replaces the old flat tool list + bouncing-dots
 * "Working…" row in `floating-chat`. It renders the turn's chronological
 * `BuildEvent[]` (reasoning runs interleaved with tool steps in true stream
 * order — `[COMP:app-web/build-events]`) behind a shimmer status header:
 *
 *   ┌ header ──────────────────────────────────────────────┐
 *   │ Searching "middle mile"   12s                      ⌄ │  ← shimmer label + elapsed
 *   ├ body (left rail) ────────────────────────────────────┤
 *   │ ┆ deciding which workflow to load…       (reasoning) │
 *   │ ┆ ● Reading the workflow                        0.8s │
 *   │ ┆ ◌ Searching "middle mile"                          │  ← running spinner
 *   └──────────────────────────────────────────────────────┘
 *
 * Collapsed (default) the body is a rolling tail — the last few events under
 * a top fade mask. Expanding shows the full scrollable log. Once reply text
 * starts streaming the body auto-hides (the reply is the show) and the
 * header settles into a one-line receipt; an explicit user toggle always
 * wins over the auto behavior.
 *
 * `<ChatActivitySummary>` is the completed-turn receipt on the message
 * bubble: "Worked for 42s · 6 steps", expandable to the full step list with
 * durations and error excerpts. History-restored turns have no timings, so
 * the label degrades to "6 steps".
 *
 * Retried (failed-then-recovered) steps are muted with a retry glyph and
 * the error excerpt beneath — never struck through: strikethrough reads as
 * "cancelled", and these steps did run.
 *
 * Spec: docs/architecture/engine/live-streaming.md → "Chat: the activity
 * feed". [COMP:app-web/chat-activity]
 */

import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight, ExternalLink, RotateCcw } from "lucide-react";
import type { ToolUsed } from "@sidanclaw/chat-ui";
import type { BuildEvent } from "@/lib/build-events";
import { cn } from "@/lib/utils";
import { useT, format } from "@/lib/i18n/client";

export type ResearchPhase = "detected" | "starting" | "parallel";

/** Wall-clock duration → compact human form: 0.8s · 3.4s · 42s · 1m 12s. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = ms / 1000;
  if (s < 10) return `${Math.max(0.1, Math.round(s * 10) / 10).toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

/** Live elapsed readout — whole seconds, minutes past 60s. */
function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 1) return "";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s - m * 60}s`;
}

/** 1s ticker for the live elapsed readout. Returns "" until 1s has passed. */
function useElapsed(startedAt: number | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt == null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  if (startedAt == null) return "";
  return formatElapsed(now - startedAt);
}

function StepIcon({
  status,
  live,
}: {
  status: ToolUsed["status"];
  live: boolean;
}) {
  if (status === "running") {
    return (
      <span
        aria-hidden
        className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center"
      >
        <span className="inline-block h-2.5 w-2.5 rounded-full border-[1.5px] border-primary/30 border-t-primary animate-spin motion-reduce:animate-none" />
      </span>
    );
  }
  if (status === "retried") {
    return (
      <span
        aria-hidden
        className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center text-muted-foreground/50"
      >
        <RotateCcw className="size-2.5" />
      </span>
    );
  }
  // Done: a subtle dot mid-stream ("more is coming"), a soft check once the
  // turn is over ("this ran").
  if (live) {
    return (
      <span
        aria-hidden
        className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary"
    >
      <Check className="size-2" strokeWidth={3} />
    </span>
  );
}

/**
 * One step row: status icon + narration + optional link + duration, with the
 * error excerpt beneath retried steps when `showError`.
 */
function StepRow({
  text,
  url,
  tool,
  live,
  showError,
  retriedLabel,
}: {
  text: string;
  url?: string;
  tool?: Pick<ToolUsed, "status" | "durationMs" | "errorMessage">;
  live: boolean;
  showError: boolean;
  retriedLabel: string;
}) {
  const status = tool?.status ?? "done";
  const duration =
    tool?.durationMs != null && status !== "running"
      ? formatDuration(tool.durationMs)
      : "";
  return (
    <div className="min-w-0">
      <div
        className={cn(
          "flex items-center gap-2 min-w-0 text-xs leading-snug",
          status === "running"
            ? "text-foreground/90 font-medium"
            : status === "retried"
              ? "text-muted-foreground/60"
              : "text-muted-foreground",
        )}
      >
        <StepIcon status={status} live={live} />
        <span className="truncate min-w-0">
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              title={url}
              className="hover:underline inline-flex max-w-full items-center gap-1"
            >
              <span className="truncate">{text}</span>
              <ExternalLink className="size-2.5 shrink-0" aria-hidden />
            </a>
          ) : (
            text
          )}
        </span>
        {status === "retried" ? (
          <span className="shrink-0 rounded bg-muted px-1 py-px text-[9.5px] font-medium uppercase tracking-wide text-muted-foreground/70">
            {retriedLabel}
          </span>
        ) : null}
        {duration ? (
          <span className="ml-auto shrink-0 pl-2 text-[10px] tabular-nums text-muted-foreground/50">
            {duration}
          </span>
        ) : null}
      </div>
      {showError && status === "retried" && tool?.errorMessage ? (
        <div className="pl-[22px] pt-0.5 text-[11px] leading-snug text-muted-foreground/60 break-words">
          {tool.errorMessage}
        </div>
      ) : null}
    </div>
  );
}

/** How many trailing events the collapsed rolling tail shows. */
const TAIL_SIZE = 3;

/**
 * Live activity block for the streaming turn. Renders nothing once the reply
 * is streaming and there is no activity to receipt (pure-text turns).
 */
export function ChatActivityFeed({
  events,
  tools,
  replyStreaming,
  researchPhase,
  startedAt,
  defaultExpanded = false,
}: {
  /** Chronological reasoning + step feed (per-turn `EventLog.events`). */
  events: BuildEvent[];
  /** Tool timeline — joined to step events by `toolId` for status/duration. */
  tools: ToolUsed[];
  /** Reply text has started streaming — auto-collapse to the header. */
  replyStreaming: boolean;
  researchPhase?: ResearchPhase | null;
  /** Epoch ms when the turn started; drives the elapsed readout. */
  startedAt: number | null;
  /** Test/SSR hook — start with the full log open. */
  defaultExpanded?: boolean;
}) {
  const t = useT();
  // Tri-state: null = auto (tail while working, header-only once the reply
  // streams); boolean = the user's explicit choice, which always wins.
  const [userExpanded, setUserExpanded] = useState<boolean | null>(
    defaultExpanded ? true : null,
  );
  const elapsed = useElapsed(startedAt);
  const logRef = useRef<HTMLDivElement | null>(null);

  const toolById = new Map(tools.map((tool) => [tool.id, tool]));
  const runningTool = tools.find((tool) => tool.status === "running");
  const hasActivity = events.length > 0 || tools.length > 0;

  const expanded = userExpanded === true;
  const showTail = userExpanded == null ? !replyStreaming : expanded;

  // Auto-scroll the expanded log as events arrive.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length, expanded]);

  // Pure-text turn with the reply already streaming: nothing to show.
  if (replyStreaming && !hasActivity) return null;

  // The most specific "what is happening right now" line.
  const headerLabel = replyStreaming
    ? t.chat.activity.writing
    : (runningTool?.description ??
      (runningTool
        ? format(t.chat.toolNarration.generic, { name: runningTool.name })
        : null) ??
      (researchPhase ? t.chat.researchStatus[researchPhase] : null) ??
      (tools.length > 0 ? t.chat.toolNarration.working : t.chat.thinking));

  const visible = expanded ? events : events.slice(-TAIL_SIZE);

  return (
    <div role="status" aria-live="polite" className="min-w-0 text-xs">
      <button
        type="button"
        onClick={() => setUserExpanded(userExpanded === true ? false : true)}
        aria-expanded={expanded || showTail}
        aria-label={expanded ? t.chat.activity.hide : t.chat.activity.show}
        className="group flex w-full min-w-0 items-center gap-2 py-0.5 text-left"
      >
        <span className="chat-shimmer-text min-w-0 truncate text-xs font-medium">
          {headerLabel}
        </span>
        {elapsed ? (
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/50">
            {elapsed}
          </span>
        ) : null}
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-muted-foreground/40 transition-transform duration-200 group-hover:text-muted-foreground",
            (expanded || (showTail && userExpanded == null && events.length > 0)) &&
              "rotate-90",
          )}
        />
      </button>

      {showTail && visible.length > 0 ? (
        <div
          ref={logRef}
          className={cn(
            "mt-1 flex flex-col gap-1 border-l-2 border-border/60 pl-3",
            expanded
              ? "max-h-64 overflow-y-auto pr-1"
              : "[mask-image:linear-gradient(to_bottom,transparent_0,black_18px)]",
          )}
        >
          {visible.map((event) =>
            event.kind === "reasoning" ? (
              <div
                key={event.id}
                className="min-w-0 truncate text-xs italic leading-snug text-muted-foreground/70 animate-in fade-in slide-in-from-bottom-1 duration-300 motion-reduce:animate-none"
              >
                {event.text}
              </div>
            ) : (
              <div
                key={event.id}
                className="animate-in fade-in slide-in-from-bottom-1 duration-300 motion-reduce:animate-none"
              >
                <StepRow
                  text={event.text}
                  url={event.url}
                  tool={event.toolId ? toolById.get(event.toolId) : undefined}
                  live
                  showError={expanded}
                  retriedLabel={t.chat.activity.retried}
                />
              </div>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Post-turn receipt on a committed assistant message: one muted line,
 * expandable to the full step list. `durationMs` is absent for
 * history-restored turns (timings are live-only).
 */
export function ChatActivitySummary({
  tools,
  durationMs,
  defaultExpanded = false,
}: {
  tools: ToolUsed[];
  durationMs?: number;
  defaultExpanded?: boolean;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(defaultExpanded);
  if (tools.length === 0) return null;

  const count = tools.length;
  const label =
    durationMs != null
      ? count === 1
        ? format(t.chat.activity.workedForWithStep, {
            duration: formatDuration(durationMs),
          })
        : format(t.chat.activity.workedForWithSteps, {
            duration: formatDuration(durationMs),
            count,
          })
      : count === 1
        ? t.chat.activity.stepOnly
        : format(t.chat.activity.stepsOnly, { count });

  return (
    <div className="min-w-0 text-xs">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="group flex items-center gap-1.5 py-0.5 text-left text-[11px] text-muted-foreground/60 transition-colors hover:text-muted-foreground"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3 shrink-0 transition-transform duration-200",
            expanded && "rotate-90",
          )}
        />
        <span className="truncate">{label}</span>
      </button>
      <div
        className={cn(
          "overflow-hidden transition-all duration-300 ease-in-out",
          expanded ? "mt-1 max-h-[2000px] opacity-100" : "max-h-0 opacity-0",
        )}
      >
        <div className="flex flex-col gap-1 border-l-2 border-border/60 pl-3">
          {tools.map((tool) => (
            <StepRow
              key={tool.id}
              text={tool.description ?? tool.name}
              url={tool.url}
              tool={tool}
              live={false}
              showError
              retriedLabel={t.chat.activity.retried}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
