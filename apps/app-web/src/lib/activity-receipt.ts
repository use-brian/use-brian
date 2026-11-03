/**
 * The post-turn activity receipt's pure logic: restore a run's steps and
 * notes from persisted rows, summarize the run by kind for the one-line
 * header, and lay the expanded feed out as notes / groups / steps.
 *
 * IO-free (no React, no DOM) so app-web's node-only vitest can exercise it
 * directly; `chat-activity.tsx` renders what this module returns, and both
 * history restores (the dock's `mapSessionRows`, the Chat app's
 * `mapTranscriptRows`) build their `toolsUsed` / `activityNotes` here so
 * the two surfaces cannot drift.
 *
 * Spec: docs/architecture/engine/live-streaming.md → "Chat: the activity
 * feed" → Completed. [COMP:app-web/activity-receipt]
 */

import type { ActivityNote, ToolUsed } from "@use-brian/chat-ui";
import { parseHostObservation } from "@use-brian/shared";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { format } from "@/lib/i18n/format";
import { describeToolFromInput, type NarrationDict } from "@/lib/tool-narration";

export type ActivityDict = Dictionary["chat"]["activity"];

/** A persisted call outcome, read from the paired `tool_result` row. */
export type ToolOutcome = {
  isError: boolean;
  /** One-line error excerpt (failed calls). */
  excerpt: string;
  /** Display excerpt of the result, newlines kept (all calls). */
  output: string;
};

/** How much of a failed result the receipt quotes (matches the server's SSE excerpt). */
const ERROR_EXCERPT_MAX = 200;
/** How much of a stored result the Output disclosure shows (matches the stream's cap). */
const OUTPUT_EXCERPT_MAX = 2_000;

/** Same shape as the server's `toolOutputExcerpt`, applied to the stored row. */
export function outputExcerptOf(content: string): string {
  const tidy = content.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!tidy) return "";
  return tidy.length > OUTPUT_EXCERPT_MAX ? `${tidy.slice(0, OUTPUT_EXCERPT_MAX)}\n…` : tidy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Index every `tool_result` block in a session's rows by its `toolUseId`.
 * The result rows are user-role carriers the transcript never renders, so
 * this is the only place their outcome reaches the UI.
 */
export function collectToolResults(
  rows: ReadonlyArray<{ content: unknown }>,
): Map<string, ToolOutcome> {
  const outcomes = new Map<string, ToolOutcome>();
  for (const row of rows) {
    if (!Array.isArray(row.content)) continue;
    for (const block of row.content) {
      if (!isRecord(block)) continue;
      const observation = parseHostObservation(block);
      if (block.type !== "tool_result" && !observation) continue;
      const id = observation?.id ?? (typeof block.toolUseId === "string" ? block.toolUseId : "");
      if (!id) continue;
      const content = typeof block.content === "string" ? block.content : "";
      const flat = content.replace(/\s+/g, " ").trim();
      outcomes.set(id, {
        isError: block.isError === true,
        excerpt:
          flat.length > ERROR_EXCERPT_MAX
            ? `${flat.slice(0, ERROR_EXCERPT_MAX - 3)}…`
            : flat,
        output: outputExcerptOf(content),
      });
    }
  }
  return outcomes;
}

export type RestoredActivity = {
  toolsUsed: ToolUsed[];
  /**
   * Notes in row order. The last entry may carry no `beforeToolId` when the
   * row ended in text after its last tool call — `coalesceAssistantRunMessages`
   * attaches it to the next row's first tool, or drops it.
   */
  activityNotes: ActivityNote[];
};

/**
 * Rebuild one persisted assistant row's receipt: each `tool_use` block
 * becomes a step (re-narrated from its input, `input` kept for the
 * expandable row, outcome read from `outcomes`), and the text blocks
 * between calls become notes attached to the call they precede.
 */
export function restoreAssistantActivity(
  content: unknown,
  outcomes: ReadonlyMap<string, ToolOutcome>,
  narration: NarrationDict,
  rowId: string,
): RestoredActivity {
  const toolsUsed: ToolUsed[] = [];
  const activityNotes: ActivityNote[] = [];
  if (!Array.isArray(content)) return { toolsUsed, activityNotes };

  let pendingText: string[] = [];
  let toolIndex = 0;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      const text = block.text.trim();
      if (text) pendingText.push(text);
      continue;
    }
    if ((block.type !== "tool_use" && !parseHostObservation(block)) || typeof block.name !== "string") continue;
    const id = typeof block.id === "string" ? block.id : `${rowId}_tool_${toolIndex}`;
    const input = isRecord(block.input) ? block.input : {};
    const described = describeToolFromInput(block.name, input, narration);
    const outcome = outcomes.get(id);
    toolsUsed.push({
      id,
      name: block.name,
      status: outcome?.isError ? "retried" : "done",
      description: described.description,
      ...(described.url ? { url: described.url } : {}),
      ...(described.detail ? { detail: described.detail } : {}),
      ...(Object.keys(input).length > 0 ? { input } : {}),
      ...(outcome?.isError && outcome.excerpt ? { errorMessage: outcome.excerpt } : {}),
      ...(outcome?.output ? { output: outcome.output } : {}),
    });
    if (pendingText.length > 0) {
      activityNotes.push({
        id: `${rowId}_note_${toolIndex}`,
        text: pendingText.join("\n\n"),
        beforeToolId: id,
      });
      pendingText = [];
    }
    toolIndex += 1;
  }
  // Text after the last call: not this row's note, maybe the next row's.
  if (toolsUsed.length > 0 && pendingText.length > 0) {
    activityNotes.push({
      id: `${rowId}_note_${toolIndex}`,
      text: pendingText.join("\n\n"),
    });
  }
  return { toolsUsed, activityNotes };
}

/**
 * Final pass over a coalesced run's notes: a note must precede a tool
 * (trailing text with nothing after it is a stray segment), and a note
 * whose text is the answer itself (answer-then-bookkeeping-tool turn) would
 * render the reply twice.
 */
export function finalizeActivityNotes(
  notes: ReadonlyArray<ActivityNote> | undefined,
  finalText: string,
): ActivityNote[] | undefined {
  if (!notes?.length) return undefined;
  const answer = finalText.trim();
  const kept = notes.filter(
    (note) => !!note.beforeToolId && note.text.trim().length > 0 && note.text.trim() !== answer,
  );
  return kept.length > 0 ? kept : undefined;
}

// ── Summary ─────────────────────────────────────────────────────────────

type Bucket =
  | { kind: "search"; count: number }
  | { kind: "read"; count: number }
  | { kind: "server"; server: string; count: number }
  | { kind: "other"; count: number };

const READ_NAMES = new Set(["urlReader", "fileRead", "readFileContent", "retrieveCachedResults"]);

function bucketKeyOf(tool: Pick<ToolUsed, "name" | "input">): string {
  const name = tool.name;
  if (name === "mcp_call") {
    const server = tool.input && typeof tool.input.server === "string" ? tool.input.server.trim() : "";
    return server ? `server:${server}` : "other";
  }
  const prefixed = name.match(/^mcp_([^_]+)_(.+)$/);
  if (prefixed) return `server:${prefixed[1]}`;
  if (name === "mcp_search" || /search/i.test(name)) return "search";
  if (READ_NAMES.has(name) || /^(get|list|read|fetch|browse)[A-Z]/.test(name)) return "read";
  return "other";
}

/** "shopify" → "Shopify"; a no-op on names with no ASCII initial. */
function displayServer(server: string): string {
  return server.charAt(0).toUpperCase() + server.slice(1);
}

function bucketLabel(bucket: Bucket, dict: ActivityDict): string {
  const one = bucket.count === 1;
  switch (bucket.kind) {
    case "search":
      return one ? dict.summarySearchOne : format(dict.summarySearch, { count: bucket.count });
    case "read":
      return one ? dict.summaryReadOne : format(dict.summaryRead, { count: bucket.count });
    case "server":
      return format(one ? dict.summaryServerOne : dict.summaryServer, {
        count: bucket.count,
        server: displayServer(bucket.server),
      });
    default:
      return one ? dict.summaryOtherOne : format(dict.summaryOther, { count: bucket.count });
  }
}

/**
 * The receipt's one-line label, by kind: "Searched once and ran 9 Shopify
 * calls". The two largest buckets are named; everything else collapses to
 * "N more". Sentence-cased so the joined phrase reads as a line, which is a
 * no-op for CJK copy.
 */
export function summarizeActivity(
  tools: ReadonlyArray<Pick<ToolUsed, "name" | "input">>,
  dict: ActivityDict,
): string {
  const buckets = new Map<string, Bucket>();
  for (const tool of tools) {
    const key = bucketKeyOf(tool);
    const existing = buckets.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    if (key.startsWith("server:")) {
      buckets.set(key, { kind: "server", server: key.slice("server:".length), count: 1 });
    } else {
      buckets.set(key, { kind: key as "search" | "read" | "other", count: 1 });
    }
  }
  // Largest first; ties keep first-seen order (Map iteration is insertion order).
  const ordered = [...buckets.values()].sort((a, b) => b.count - a.count);
  if (ordered.length === 0) return "";
  const [first, second, ...rest] = ordered;
  const more = rest.reduce((sum, bucket) => sum + bucket.count, 0);
  let summary: string;
  if (!second) {
    summary = bucketLabel(first!, dict);
  } else if (more === 0) {
    summary = format(dict.summaryJoin, {
      a: bucketLabel(first!, dict),
      b: bucketLabel(second, dict),
    });
  } else {
    summary = format(dict.summaryJoinMore, {
      a: bucketLabel(first!, dict),
      b: bucketLabel(second, dict),
      more: format(dict.summaryMore, { count: more }),
    });
  }
  return summary.charAt(0).toUpperCase() + summary.slice(1);
}

// ── Expanded feed layout ─────────────────────────────────────────────────

export type ReceiptItem =
  | { kind: "note"; note: ActivityNote }
  | { kind: "step"; tool: ToolUsed }
  | { kind: "group"; key: string; label: string; tools: ToolUsed[] };

/**
 * Errored calls that nothing followed. Every errored call is `retried` in the
 * data; the label is derived here: a later call of the same tool means the
 * model tried again ("Retried"), no later call means the turn moved on
 * without it ("Failed").
 */
export function terminalFailureIds(tools: ReadonlyArray<ToolUsed>): Set<string> {
  const lastIndexByKey = new Map<string, number>();
  tools.forEach((tool, index) => lastIndexByKey.set(groupKeyOf(tool), index));
  const failed = new Set<string>();
  tools.forEach((tool, index) => {
    if (tool.status === "retried" && lastIndexByKey.get(groupKeyOf(tool)) === index) {
      failed.add(tool.id);
    }
  });
  return failed;
}

/** Consecutive calls fold together only when they are the same tool. */
function groupKeyOf(tool: ToolUsed): string {
  if (tool.name === "mcp_call" && tool.input) {
    const server = typeof tool.input.server === "string" ? tool.input.server : "";
    const name = typeof tool.input.tool === "string" ? tool.input.tool : "";
    if (server && name) return `mcp_call:${server}/${name}`;
  }
  return tool.name;
}

/** The label a group shows — the first call's narration, which for a same-tool run is shared. */
function groupLabelOf(tool: ToolUsed): string {
  return tool.description ?? tool.name;
}

/**
 * Lay a run out for the expanded receipt: notes before the tool they
 * preceded, consecutive same-tool calls folded into a group (a note is a
 * group boundary), everything else a step. Notes whose tool is not in
 * `tools` (a dropped call) are skipped.
 */
export function buildReceiptItems(
  tools: ReadonlyArray<ToolUsed>,
  notes: ReadonlyArray<ActivityNote> | undefined,
): ReceiptItem[] {
  const notesByTool = new Map<string, ActivityNote[]>();
  for (const note of notes ?? []) {
    if (!note.beforeToolId) continue;
    const list = notesByTool.get(note.beforeToolId) ?? [];
    list.push(note);
    notesByTool.set(note.beforeToolId, list);
  }

  const items: ReceiptItem[] = [];
  let run: ToolUsed[] = [];
  const flushRun = () => {
    if (run.length === 0) return;
    if (run.length === 1) {
      items.push({ kind: "step", tool: run[0]! });
    } else {
      items.push({
        kind: "group",
        key: `${groupKeyOf(run[0]!)}:${run[0]!.id}`,
        label: groupLabelOf(run[0]!),
        tools: run,
      });
    }
    run = [];
  };

  for (const tool of tools) {
    const preceding = notesByTool.get(tool.id);
    if (preceding?.length) {
      flushRun();
      for (const note of preceding) items.push({ kind: "note", note });
    }
    if (run.length > 0 && groupKeyOf(run[0]!) !== groupKeyOf(tool)) flushRun();
    run.push(tool);
  }
  flushRun();
  return items;
}
