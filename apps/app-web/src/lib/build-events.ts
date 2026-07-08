/**
 * Pure core for the inline "Generating…" rolling event feed.
 *
 * The doc inline Space-for-AI turn streams over the same `/api/chat` SSE the
 * corner chat consumes; `floating-chat` folds that stream into a
 * **chronological** `BuildEvent[]` — the model's reasoning runs and each build
 * step (`Adding heading "…"`, `Inserting a data table`, `Searching the web…`)
 * in arrival order — and publishes it on the `build-activity` bus. The in-flow
 * generating widget (`ai-generating-decoration.ts`) paints the *tail* of that
 * log as a height-capped, masked rolling feed.
 *
 * These helpers are the IO-free core (no DOM, no React) so app-web's node-only
 * vitest can exercise the ordering + windowing directly. The DOM rendering +
 * the SSE wiring are thin shells over this.
 *
 * Reasoning coalescing: a reasoning *run* is one event whose visible text
 * advances to the run's latest non-empty line as tokens arrive — so the feed
 * shows the model thinking without spawning a row per token. A build step
 * **closes** the open run, so a later reasoning burst opens a fresh row, and
 * the two interleave in true stream order.
 *
 * [COMP:app-web/build-events]
 */

type BuildEventKind = "reasoning" | "step";

export type BuildEvent = {
  /**
   * Stable, deterministic id (a per-turn monotonic counter — never
   * `Date.now()`/`Math.random()`, which would break SSR + replay). The feed
   * keys its DOM rows by this so a re-render diffs (animate the new line in,
   * drop the line that rolled off) instead of rebuilding the list.
   */
  id: string;
  kind: BuildEventKind;
  /** One-line, human-readable text — already localized at the producer. */
  text: string;
};

/**
 * The chronological log plus a pointer to the currently-open reasoning run.
 * `openReasoningId` is the id of the trailing reasoning event still receiving
 * tokens, or `null` once a step has closed the run (the next reasoning delta
 * then opens a new event).
 */
export type EventLog = {
  events: BuildEvent[];
  openReasoningId: string | null;
};

export const EMPTY_LOG: EventLog = { events: [], openReasoningId: null };

/**
 * The last non-empty line of a (possibly multi-line, still-streaming) run.
 * Used to collapse a reasoning run to the single line the feed shows — as the
 * model writes, the visible line advances to whatever it's writing now.
 */
export function lastNonEmptyLine(run: string): string {
  const lines = run.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i]!.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

/**
 * Fold the current reasoning run (the full accumulated reasoning text so far)
 * into the log. Updates the open reasoning event in place, or opens a fresh
 * one when a step closed the previous run. A run whose latest line is empty is
 * a no-op (never paint a blank "thinking" row). Returns the same object when
 * nothing changed, so callers can skip a publish.
 */
export function appendReasoning(
  log: EventLog,
  run: string,
  mintId: () => string,
): EventLog {
  const line = lastNonEmptyLine(run);
  if (!line) return log;
  if (log.openReasoningId) {
    const open = log.events.find((e) => e.id === log.openReasoningId);
    if (open && open.text === line) return log; // unchanged trailing line
    return {
      openReasoningId: log.openReasoningId,
      events: log.events.map((e) =>
        e.id === log.openReasoningId ? { ...e, text: line } : e,
      ),
    };
  }
  const id = mintId();
  return {
    openReasoningId: id,
    events: [...log.events, { id, kind: "reasoning", text: line }],
  };
}

/**
 * Append one build-step line (a tool / op narration) and **close** any open
 * reasoning run, so a later reasoning burst starts its own row and the feed
 * reads in true stream order. Blank lines are ignored.
 */
export function appendStep(
  log: EventLog,
  text: string,
  mintId: () => string,
): EventLog {
  const trimmed = text.trim();
  if (!trimmed) return log;
  const id = mintId();
  return {
    openReasoningId: null,
    events: [...log.events, { id, kind: "step", text: trimmed }],
  };
}

/**
 * The tail window the feed paints — at most `max` newest events, in render
 * order (oldest first, newest last). Returns a fresh array.
 */
export function windowEvents(events: BuildEvent[], max: number): BuildEvent[] {
  if (max <= 0 || events.length === 0) return [];
  return events.length <= max
    ? events.slice()
    : events.slice(events.length - max);
}
