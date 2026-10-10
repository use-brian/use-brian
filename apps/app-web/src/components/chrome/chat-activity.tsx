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
 * bubble: a one-line label summarized by kind ("Searched once and ran 9
 * Shopify calls · 48s", `summarizeActivity` in `lib/activity-receipt.ts`),
 * expandable to the run laid out by `buildReceiptItems` — the model's
 * intermediate prose as muted notes, consecutive same-tool calls folded
 * into "×N" groups with per-call argument sub-rows, and steps that expand
 * to their input JSON. History-restored turns have no timings, so the
 * duration is dropped from the label.
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
import { PaneUrlAnchor } from "@/components/chat-app/chat-link-routing";
import { ChatMarkdown, type ActivityNote, type CitationSource, type ToolUsed } from "@use-brian/chat-ui";
import type { BuildEvent } from "@/lib/build-events";
import {
  buildReceiptItems,
  summarizeActivity,
  terminalFailureIds,
  type ReceiptItem,
} from "@/lib/activity-receipt";
import { cn } from "@/lib/utils";
import { useT, format } from "@/lib/i18n/client";

export type ResearchPhase = "detected" | "starting" | "parallel";

/**
 * Shared source chips for every chat transcript. Kept beside the other
 * response chrome so the floating dock and the full-page Chat app cannot
 * drift into different citation affordances.
 */
export function ChatCitationList({
  citations,
  label,
}: {
  citations: CitationSource[];
  label: string;
}) {
  const VISIBLE = 4;
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? citations : citations.slice(0, VISIBLE);
  const hidden = citations.length - VISIBLE;

  if (citations.length === 0) return null;
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
        {label}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {visible.map((citation) => (
          // In the full Chat app a citation opens as a `url` tab of the side
          // pane (chat-parity D9); in the dock, a new browser tab as before.
          <PaneUrlAnchor
            key={citation.url}
            url={citation.url}
            tabTitle={citation.title}
            iconFirst
            className="inline-flex max-w-[220px] items-center gap-1 truncate rounded-md bg-muted/60 px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <span className="truncate">{citation.title}</span>
          </PaneUrlAnchor>
        ))}
        {!expanded && hidden > 0 ? (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="inline-flex items-center rounded-md bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
          >
            +{hidden}
          </button>
        ) : null}
      </div>
    </div>
  );
}

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
/** The disclosure wiring a step row needs to open its Input / Output block. */
type StepDisclosure = {
  open: boolean;
  onToggle: () => void;
  inputLabel: string;
  outputLabel: string;
  showLabel: string;
  hideLabel: string;
};

function StepRow({
  text,
  detail,
  url,
  tool,
  live,
  showError,
  retriedLabel,
  failedLabel,
  terminalFailure = false,
  expandable,
}: {
  text: string;
  /** Argument summary shown muted after the narration ("· query: name:#1042"). */
  detail?: string;
  url?: string;
  tool?: Pick<ToolUsed, "status" | "durationMs" | "errorMessage" | "input" | "output">;
  live: boolean;
  showError: boolean;
  retriedLabel: string;
  failedLabel: string;
  /** An errored call nothing followed — reads "Failed" instead of "Retried". */
  terminalFailure?: boolean;
  /**
   * Rows with a known `input` or `output` toggle a block showing the
   * pretty-printed input JSON and the output excerpt. Live rows and receipt
   * rows share this; a row with neither stays static.
   */
  expandable?: StepDisclosure;
}) {
  const status = tool?.status ?? "done";
  const duration =
    tool?.durationMs != null && status !== "running"
      ? formatDuration(tool.durationMs)
      : "";
  const hasInput = !!tool?.input && Object.keys(tool.input).length > 0;
  const hasOutput = !!tool?.output;
  const canExpand = !!expandable && (hasInput || hasOutput);
  const label = (
    <>
      <span className="truncate">{text}</span>
      {detail ? (
        <span className="truncate text-muted-foreground/60"> · {detail}</span>
      ) : null}
    </>
  );
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
        <span className="flex min-w-0 flex-1 items-center truncate">
          {url ? (
            <PaneUrlAnchor
              url={url}
              className="hover:underline inline-flex max-w-full items-center gap-1"
            >
              {label}
              <ExternalLink className="size-2.5 shrink-0" aria-hidden />
            </PaneUrlAnchor>
          ) : canExpand ? (
            <button
              type="button"
              onClick={expandable.onToggle}
              aria-expanded={expandable.open}
              aria-label={expandable.open ? expandable.hideLabel : expandable.showLabel}
              className="inline-flex min-w-0 max-w-full items-center gap-1 text-left hover:text-foreground"
            >
              {label}
              <ChevronRight
                aria-hidden
                className={cn(
                  "size-2.5 shrink-0 text-muted-foreground/40 transition-transform duration-200",
                  expandable.open && "rotate-90",
                )}
              />
            </button>
          ) : (
            label
          )}
        </span>
        {status === "retried" ? (
          <span
            className={cn(
              "shrink-0 rounded px-1 py-px text-[9.5px] font-medium uppercase tracking-wide",
              terminalFailure
                ? "bg-destructive/10 text-destructive/80"
                : "bg-muted text-muted-foreground/70",
            )}
          >
            {terminalFailure ? failedLabel : retriedLabel}
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
      {canExpand && expandable.open ? (
        <div className="flex flex-col gap-1.5 pl-[22px] pt-1">
          {hasInput ? (
            <div>
              <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
                {expandable.inputLabel}
              </div>
              <pre className="mt-0.5 max-h-48 overflow-auto rounded-md bg-muted/50 px-2 py-1.5 text-[11px] leading-snug text-muted-foreground whitespace-pre-wrap break-words">
                {JSON.stringify(tool!.input, null, 2)}
              </pre>
            </div>
          ) : null}
          {hasOutput ? (
            <div>
              <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
                {expandable.outputLabel}
              </div>
              <pre className="mt-0.5 max-h-64 overflow-auto rounded-md bg-muted/50 px-2 py-1.5 text-[11px] leading-snug text-muted-foreground whitespace-pre-wrap break-words">
                {tool!.output}
              </pre>
            </div>
          ) : null}
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
  // Live rows open to their Input / Output like receipt rows do.
  const [openSteps, setOpenSteps] = useState<Set<string>>(() => new Set());
  const elapsed = useElapsed(startedAt);
  const logRef = useRef<HTMLDivElement | null>(null);

  const toolById = new Map(tools.map((tool) => [tool.id, tool]));
  const runningTool = tools.find((tool) => tool.status === "running");
  const failedIds = terminalFailureIds(tools);
  const disclosureFor = (toolId: string): StepDisclosure => ({
    open: openSteps.has(toolId),
    onToggle: () =>
      setOpenSteps((prev) => {
        const next = new Set(prev);
        if (next.has(toolId)) next.delete(toolId);
        else next.add(toolId);
        return next;
      }),
    inputLabel: t.chat.activity.inputLabel,
    outputLabel: t.chat.activity.outputLabel,
    showLabel: t.chat.activity.showDetails,
    hideLabel: t.chat.activity.hideDetails,
  });
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
  const runningLabel = runningTool
    ? `${runningTool.description ?? format(t.chat.toolNarration.generic, { name: runningTool.name })}${
        runningTool.detail ? ` · ${runningTool.detail}` : ""
      }`
    : null;
  const headerLabel = replyStreaming
    ? t.chat.activity.writing
    : (runningLabel ??
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
                  detail={event.toolId ? toolById.get(event.toolId)?.detail : undefined}
                  url={event.url}
                  tool={event.toolId ? toolById.get(event.toolId) : undefined}
                  live
                  showError={expanded}
                  retriedLabel={t.chat.activity.retried}
                  failedLabel={t.chat.activity.failed}
                  terminalFailure={!!event.toolId && failedIds.has(event.toolId)}
                  expandable={event.toolId ? disclosureFor(event.toolId) : undefined}
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
 * Post-turn receipt on a committed assistant message: one muted line
 * summarized by kind, expandable to the run's notes, groups and steps.
 * `durationMs` is absent for history-restored turns (timings are live-only).
 */
export function ChatActivitySummary({
  tools,
  notes,
  reasoning,
  durationMs,
  defaultExpanded = false,
}: {
  tools: ToolUsed[];
  /** Intermediate prose rows, each attached to the tool it preceded. */
  notes?: ActivityNote[];
  /** The turn's verbatim reasoning — live turns only, never restored. */
  reasoning?: string;
  durationMs?: number;
  defaultExpanded?: boolean;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(defaultExpanded);
  // Per-row disclosure: open groups (closed by default), open step
  // details, and the Thinking block.
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set());
  const [openInputs, setOpenInputs] = useState<Set<string>>(() => new Set());
  const [thinkingOpen, setThinkingOpen] = useState(false);
  if (tools.length === 0) return null;
  const failedIds = terminalFailureIds(tools);

  const summary = summarizeActivity(tools, t.chat.activity);
  const label =
    durationMs != null
      ? format(t.chat.activity.receipt, {
          summary,
          duration: formatDuration(durationMs),
        })
      : summary;
  const items = buildReceiptItems(tools, notes);

  const toggleIn = (
    set: (update: (prev: Set<string>) => Set<string>) => void,
    key: string,
  ) =>
    set((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const stepRow = (tool: ToolUsed, textOverride?: string) => (
    <StepRow
      key={tool.id}
      text={textOverride ?? tool.description ?? tool.name}
      detail={textOverride ? undefined : tool.detail}
      url={tool.url}
      tool={tool}
      live={false}
      showError
      retriedLabel={t.chat.activity.retried}
      failedLabel={t.chat.activity.failed}
      terminalFailure={failedIds.has(tool.id)}
      expandable={{
        open: openInputs.has(tool.id),
        onToggle: () => toggleIn(setOpenInputs, tool.id),
        inputLabel: t.chat.activity.inputLabel,
        outputLabel: t.chat.activity.outputLabel,
        showLabel: t.chat.activity.showDetails,
        hideLabel: t.chat.activity.hideDetails,
      }}
    />
  );

  const renderItem = (item: ReceiptItem) => {
    if (item.kind === "note") {
      // The model narrates in markdown ("**Step 2:** listing…"), so render it
      // rather than showing the asterisks; muted + italic marks it as prose
      // that was not the answer.
      return (
        <div
          key={item.note.id}
          className="chat-markdown prose prose-sm dark:prose-invert min-w-0 max-w-none break-words text-xs italic leading-snug text-muted-foreground/70 [&_p]:my-0.5 [&_strong]:font-medium [&_strong]:text-muted-foreground"
        >
          <ChatMarkdown text={item.note.text} />
        </div>
      );
    }
    if (item.kind === "step") return stepRow(item.tool);
    const open = openGroups.has(item.key);
    const failures = item.tools.filter((tool) => tool.status === "retried").length;
    const failed = failures > 0;
    return (
      <div key={item.key} className="min-w-0">
        <button
          type="button"
          onClick={() => toggleIn(setOpenGroups, item.key)}
          aria-expanded={open}
          className={cn(
            "flex w-full min-w-0 items-center gap-2 text-left text-xs leading-snug hover:text-foreground",
            failed ? "text-muted-foreground/60" : "text-muted-foreground",
          )}
        >
          <StepIcon status={failed ? "retried" : "done"} live={false} />
          <span className="truncate">{item.label}</span>
          <span className="shrink-0 rounded bg-muted px-1 py-px text-[10px] font-medium tabular-nums text-muted-foreground/70">
            {format(t.chat.activity.groupCount, { count: item.tools.length })}
          </span>
          {failed ? (
            <span className="shrink-0 rounded bg-destructive/10 px-1 py-px text-[10px] font-medium tabular-nums text-destructive/80">
              {format(t.chat.activity.groupFailed, { count: failures })}
            </span>
          ) : null}
          <ChevronRight
            aria-hidden
            className={cn(
              "size-2.5 shrink-0 text-muted-foreground/40 transition-transform duration-200",
              open && "rotate-90",
            )}
          />
        </button>
        {open ? (
          <div className="mt-1 flex flex-col gap-1 border-l border-border/60 pl-3">
            {item.tools.map((tool) =>
              stepRow(tool, tool.detail ?? tool.description ?? tool.name),
            )}
          </div>
        ) : null}
      </div>
    );
  };

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
          expanded ? "mt-1 max-h-[4000px] opacity-100" : "max-h-0 opacity-0",
        )}
      >
        <div className="flex flex-col gap-1 border-l-2 border-border/60 pl-3">
          {reasoning ? (
            <div className="min-w-0">
              <button
                type="button"
                onClick={() => setThinkingOpen((v) => !v)}
                aria-expanded={thinkingOpen}
                className="flex items-center gap-1 text-xs italic leading-snug text-muted-foreground/70 hover:text-foreground"
              >
                <span>{t.chat.activity.thinking}</span>
                <ChevronRight
                  aria-hidden
                  className={cn(
                    "size-2.5 shrink-0 text-muted-foreground/40 transition-transform duration-200",
                    thinkingOpen && "rotate-90",
                  )}
                />
              </button>
              {thinkingOpen ? (
                <pre className="mt-0.5 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 px-2 py-1.5 font-sans text-[11px] italic leading-snug text-muted-foreground/70">
                  {reasoning}
                </pre>
              ) : null}
            </div>
          ) : null}
          {items.map(renderItem)}
        </div>
      </div>
    </div>
  );
}
