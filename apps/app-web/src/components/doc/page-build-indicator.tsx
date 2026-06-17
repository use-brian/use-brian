"use client";

/**
 * Page-body "drafting" indicator — shown inside the editor (under the page
 * comment composer, above the content) on a freshly-created draft while the
 * assistant builds it after a default-viewer landing prompt.
 *
 * It renders the build's **live detail** so the user can follow along without
 * opening the corner chat:
 *
 *   1. **Tool timeline** — each SSE `tool_start`/`tool_result` as a row with
 *      a running/done/failed status. `patchPage` expands into per-op sub-rows
 *      ("Adding heading 'Overview'", "Inserting a data table") so the list
 *      reads like a live build log.
 *   2. **Reasoning stream** — verbatim model thinking (from the `reasoning`
 *      SSE event), rendered muted/smaller in a distinct section so the user
 *      can watch the model think without it competing with the reply text.
 *   3. **Streaming reply text** — the assistant's partial reply as it arrives.
 *
 * Data comes off the `build-activity` bus (published by `floating-chat`), so
 * this subtree re-paints per token without dragging the heavy shell tree with
 * it. The shell owns *visibility* (mounts this only while its page is the one
 * building); the bus owns *content*.
 *
 * Tone matches the landing — neutral surface, the cyan brand only as a small
 * accent (the sparkle + status), motion via `.animate-*`.
 *
 * [COMP:app-web/page-build-indicator]
 */

import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Sparkles, X } from "lucide-react";
import type { ToolUsed } from "@sidanclaw/chat-ui";
import type { ToolUsedWithOps } from "@/components/chrome/floating-chat";
import {
  subscribeBuildActivity,
  type BuildActivity,
} from "@/lib/build-activity";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

const EMPTY: BuildActivity = {
  isStreaming: false,
  tools: [],
  text: "",
  reasoning: "",
  events: [],
};

export function PageBuildIndicator() {
  const dict = useT();
  const t = dict.docPage.landing;
  const workingLabel = dict.chat.toolNarration.working;

  const [activity, setActivity] = useState<BuildActivity>(EMPTY);
  useEffect(() => subscribeBuildActivity(setActivity), []);

  // Auto-scroll the reasoning + reply text sections as they grow.
  const reasoningRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = reasoningRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activity.reasoning]);
  useEffect(() => {
    const el = textRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activity.text]);

  const { tools, text, reasoning } = activity;
  const idle = tools.length === 0 && text.length === 0 && reasoning.length === 0;

  return (
    <div
      role="status"
      aria-live="polite"
      className="animate-rise-in my-4 overflow-hidden rounded-xl border border-border bg-card/70 shadow-sm"
    >
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="relative inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-primary">
          <span
            aria-hidden
            className="animate-pulse-soft absolute inset-0 rounded-lg ring-1 ring-primary/20"
          />
          <Sparkles className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm font-medium text-foreground">
            {t.building}
            <Loader2
              className="size-3.5 shrink-0 animate-spin text-primary/70"
              aria-hidden
            />
          </p>
          {idle ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{t.buildingThinking}</p>
          ) : null}
        </div>
        <span className="hidden shrink-0 text-[11px] text-muted-foreground/80 sm:block">
          {t.buildingHint}
        </span>
      </div>

      {/* Detail — reasoning + tool timeline + streaming reply. */}
      {!idle ? (
        <div className="space-y-2.5 border-t border-border/70 bg-muted/20 px-4 py-3">

          {/* Reasoning section — verbatim model thinking, muted + smaller.
              Shown only when the model emits `reasoning` events. Visually
              distinct from the reply text so the two don't compete. */}
          {reasoning ? (
            <div className="space-y-1">
              <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
                {t.buildingReasoning}
              </p>
              <div
                ref={reasoningRef}
                className="max-h-24 overflow-y-auto whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground/70 italic"
              >
                {reasoning}
              </div>
            </div>
          ) : null}

          {/* Tool timeline — one row per tool, patchPage expands to per-op sub-rows. */}
          {tools.length > 0 ? (
            <ol className="space-y-1">
              {(tools as ToolUsedWithOps[]).map((tool) => (
                <TimelineStep key={tool.id} tool={tool} fallback={workingLabel} />
              ))}
            </ol>
          ) : null}

          {/* Streaming reply text — the assistant's partial reply. */}
          {text ? (
            <div
              ref={textRef}
              className="max-h-32 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground"
            >
              {text}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function TimelineStep({ tool, fallback }: { tool: ToolUsedWithOps; fallback: string }) {
  const label = tool.description ?? fallback;
  return (
    <li>
      <div className="flex items-center gap-2 text-xs">
        <StatusIcon status={tool.status} />
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            // Active brand colour while running; muted/disabled once the step
            // is done or a failed/retried attempt (struck through). Mirrors the
            // floating chat's ToolTimelineSlim so both doc tool-call
            // timelines read identically.
            tool.status === "running"
              ? "text-primary font-medium"
              : "text-muted-foreground",
            tool.status === "retried" && "line-through",
          )}
        >
          {label}
        </span>
      </div>
      {/* Per-op sub-rows for patchPage: a live build log of what's being written. */}
      {tool.opLines && tool.opLines.length > 0 ? (
        <ol className="ml-6 mt-0.5 space-y-0.5">
          {tool.opLines.map((line, i) => (
            <li
              // eslint-disable-next-line react/no-array-index-key
              key={i}
              className="text-[11px] leading-relaxed text-muted-foreground/80 truncate"
            >
              {line}
            </li>
          ))}
        </ol>
      ) : null}
    </li>
  );
}

function StatusIcon({ status }: { status: ToolUsed["status"] }) {
  // Done + failed/retried both settle to the muted/disabled colour; only the
  // in-progress spinner carries the active brand colour.
  if (status === "done") {
    return <Check className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />;
  }
  if (status === "retried") {
    return <X className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />;
  }
  return (
    <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden />
  );
}
