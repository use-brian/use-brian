/**
 * Pure tool → human narration for the chat surfaces.
 *
 * Lifted out of `floating-chat.tsx` so every chat surface (dock, comment
 * threads, brain entry thread) and the activity feed share ONE describer.
 * Resolution order for a tool call:
 *
 *   1. input-aware template — the most specific line we can build from the
 *      tool's parsed arguments ("Searching \"middle mile\"", "Reading
 *      {owner}/{repo}#12", "Using searchDreps (cgov)")
 *   2. static label map — the per-tool labels in `chat.toolNarration`
 *      ("Checking your calendar", "Sending email")
 *   3. generic fallback — "Running {name}"
 *
 * Before this module, the chat describer skipped tier 2 entirely, so any
 * tool without an input-aware case rendered as "Running getWorkflow" even
 * though a friendly label sat unused in the dictionary.
 *
 * IO-free (no React, no DOM) so app-web's node-only vitest can exercise it
 * directly. [COMP:app-web/tool-narration]
 */

import type { Dictionary } from "@/lib/i18n/dictionaries";
import { format } from "@/lib/i18n/format";

export type NarrationDict = Dictionary["chat"]["toolNarration"];

export type ToolNarration = {
  description: string;
  url?: string;
  /** Per-op narration lines for patchPage — rendered as sub-rows. */
  opLines?: string[];
};

/** First string-valued input field among `keys`, trimmed, or undefined. */
function strField(
  input: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const v = input[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function clip(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max - 3)}…` : text;
}

/**
 * The static per-tool label from the dictionary map, or undefined. Template
 * entries (values with `{placeholders}`) never resolve here — they need
 * `format()` args a bare name lookup can't supply.
 */
export function staticToolLabel(
  dict: NarrationDict,
  name: string,
): string | undefined {
  const value = (dict as Record<string, unknown>)[name];
  if (typeof value !== "string" || value.includes("{")) return undefined;
  return value;
}

/**
 * Build a short human-readable description for a tool from its input.
 * Always returns a narration — worst case the generic "Running {name}".
 * For `patchPage`, also returns per-op narration lines so the build
 * indicator / activity feed can show a live log of what's being written.
 */
export function describeToolFromInput(
  name: string,
  input: Record<string, unknown>,
  dict: NarrationDict,
): ToolNarration {
  if (name === "renderView") {
    return { description: dict.renderView };
  }
  if (name === "renderPage") {
    return { description: dict.renderPage };
  }
  if (name === "patchPage") {
    const ops = Array.isArray(input.ops) ? (input.ops as Array<Record<string, unknown>>) : [];
    const opLines = derivePatchPageOpLines(ops, dict);
    return {
      description: opLines.length > 0 ? dict.patchPageActive : dict.patchPage,
      ...(opLines.length > 0 ? { opLines } : {}),
    };
  }
  if (name === "createSubPage") {
    return { description: dict.createSubPage };
  }
  if (name === "webSearch") {
    const query = strField(input, "query");
    return query
      ? { description: format(dict.webSearchQuery, { query: clip(query) }) }
      : { description: dict.webSearch };
  }
  if (name === "urlReader") {
    const url = strField(input, "url");
    if (url) {
      try {
        const host = new URL(url).hostname.replace(/^www\./, "");
        return { description: format(dict.readingHost, { host }), url };
      } catch {
        return { description: dict.urlReader, url };
      }
    }
    return { description: dict.urlReader };
  }
  if (name === "mcp_search") {
    const query = strField(input, "query");
    return query
      ? { description: format(dict.searchingToolsQuery, { query: clip(query) }) }
      : { description: dict.searchingTools };
  }
  if (name === "mcp_call") {
    const tool = strField(input, "tool", "name");
    const server = strField(input, "server");
    if (tool && server) {
      return { description: format(dict.usingMcp, { tool, server }) };
    }
    if (tool) {
      return { description: format(dict.callingTool, { name: tool }) };
    }
    return { description: dict.mcp_call };
  }
  if (name === "spawnWorker") {
    const description = strField(input, "description");
    return description
      ? { description: clip(description, 80) }
      : { description: dict.worker };
  }
  if (name === "useSkill") {
    const skill = strField(input, "skill", "name");
    if (skill) {
      const title = skill
        .split("-")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
      return { description: format(dict.usingSkill, { skill: title }) };
    }
    return { description: dict.useSkill };
  }
  if (name === "notionSearch") {
    const query = strField(input, "query");
    if (query) {
      return {
        description: format(dict.searchingNotionQuery, { query: clip(query) }),
      };
    }
  }
  if (name === "githubSearchRepositories") {
    const query = strField(input, "query", "q");
    if (query) {
      return {
        description: format(dict.searchingGithubQuery, { query: clip(query) }),
      };
    }
  }
  if (name === "githubGetRepository" || name === "githubGetFileContents") {
    const owner = strField(input, "owner");
    const repo = strField(input, "repo");
    const path = strField(input, "path");
    if (name === "githubGetFileContents" && path) {
      return { description: format(dict.readingPath, { path: clip(path) }) };
    }
    if (owner && repo) {
      return { description: format(dict.readingRepo, { owner, repo }) };
    }
  }
  if (name === "githubGetIssue" || name === "githubGetPullRequest") {
    const owner = strField(input, "owner");
    const repo = strField(input, "repo");
    const num = input.issue_number ?? input.pull_number ?? input.number;
    if (owner && repo && (typeof num === "number" || typeof num === "string")) {
      const template =
        name === "githubGetIssue" ? dict.readingIssue : dict.readingPr;
      return { description: format(template, { owner, repo, num: String(num) }) };
    }
  }
  if (name === "githubListIssues" || name === "githubListPullRequests") {
    const owner = strField(input, "owner");
    const repo = strField(input, "repo");
    if (owner && repo) {
      const template =
        name === "githubListIssues" ? dict.listingIssuesIn : dict.listingPrsIn;
      return { description: format(template, { owner, repo }) };
    }
  }
  if (
    name === "fileRead" ||
    name === "readFileContent" ||
    name === "fileWrite" ||
    name === "fileAppend"
  ) {
    const path = strField(input, "path", "name", "fileName");
    if (path && (name === "fileRead" || name === "readFileContent")) {
      return { description: format(dict.readingPath, { path: clip(path) }) };
    }
  }
  if (name === "fileSearch" || name === "searchFileContent") {
    const query = strField(input, "query");
    if (query) {
      return { description: format(dict.searchingQuery, { query: clip(query) }) };
    }
  }
  if (
    name === "createTask" ||
    name === "notionCreatePage" ||
    name === "githubCreateIssue" ||
    name === "googleCalendarCreateEvent"
  ) {
    const title = strField(input, "title", "summary");
    if (title) {
      return { description: format(dict.creatingTitled, { title: clip(title, 40) }) };
    }
  }

  // Static per-tool label ("Checking your calendar", "Sending email", …).
  const staticLabel = staticToolLabel(dict, name);
  if (staticLabel) return { description: staticLabel };

  // Server-prefixed MCP tool (`mcp_<server>_<tool>`) → "Using {tool} ({server})".
  const mcpMatch = name.match(/^mcp_([^_]+)_(.+)$/);
  if (mcpMatch) {
    return {
      description: format(dict.usingMcp, { tool: mcpMatch[2]!, server: mcpMatch[1]! }),
    };
  }

  return { description: format(dict.generic, { name }) };
}

/**
 * Derive one human-readable narration line per op in a `patchPage` ops array.
 * The build indicator renders these as a live "what's being written" log,
 * expanding the single timeline row into a per-op sub-list.
 *
 * Only `add` ops are narrated (the interesting ones from the user's POV).
 * `edit` / `delete` / `move` / `setTitle` keep a short summary. Falls back to
 * the generic patchPage label when nothing useful can be derived.
 */
function derivePatchPageOpLines(
  ops: Array<Record<string, unknown>>,
  dict: NarrationDict,
): string[] {
  const lines: string[] = [];
  for (const op of ops) {
    const opKind = typeof op.op === "string" ? op.op : "";
    if (opKind === "add") {
      const block = op.block && typeof op.block === "object" ? (op.block as Record<string, unknown>) : {};
      const kind = typeof block.kind === "string" ? block.kind : "";
      // Extract a short title / text excerpt to make the line concrete.
      const title = extractBlockTitle(block);
      lines.push(narratePatchOp(kind, title, dict));
    } else if (opKind === "edit") {
      lines.push(dict.patchOpEdit);
    } else if (opKind === "delete") {
      lines.push(dict.patchOpDelete);
    } else if (opKind === "move") {
      lines.push(dict.patchOpMove);
    } else if (opKind === "setTitle") {
      const title = typeof op.title === "string" ? op.title.trim().slice(0, 40) : "";
      lines.push(title ? format(dict.patchOpSetTitle, { title }) : dict.patchOpSetTitleGeneric);
    }
  }
  return lines;
}

/**
 * Pull a short human-friendly label out of a block's content fields.
 * Tries `text` (rich-text), `heading` level, table title, etc.
 * Returns empty string when nothing useful is found.
 */
function extractBlockTitle(block: Record<string, unknown>): string {
  // Rich-text content — first segment's `text` field.
  if (Array.isArray(block.content)) {
    for (const seg of block.content as Array<Record<string, unknown>>) {
      const t = typeof seg.text === "string" ? seg.text.trim() : "";
      if (t) return t.slice(0, 40);
    }
  }
  // Direct text string (some block kinds use this).
  if (typeof block.text === "string" && block.text.trim()) {
    return block.text.trim().slice(0, 40);
  }
  return "";
}

/**
 * Build one narration line for a single `add` op block.
 */
function narratePatchOp(kind: string, title: string, dict: NarrationDict): string {
  const label = title ? `"${title}${title.length >= 40 ? "…" : ""}"` : "";
  switch (kind) {
    case "heading":
      return label ? format(dict.patchOpAddHeading, { title: label }) : dict.patchOpAddHeadingGeneric;
    case "text":
      return label ? format(dict.patchOpAddParagraph, { text: label }) : dict.patchOpAddParagraphGeneric;
    case "data":
      return dict.patchOpAddTable;
    case "chart":
      return dict.patchOpAddChart;
    case "to_do":
      return label ? format(dict.patchOpAddTodo, { text: label }) : dict.patchOpAddTodoGeneric;
    case "bulleted_list_item":
      return label ? format(dict.patchOpAddBullet, { text: label }) : dict.patchOpAddBulletGeneric;
    case "numbered_list_item":
      return label ? format(dict.patchOpAddBullet, { text: label }) : dict.patchOpAddBulletGeneric;
    case "callout":
      return dict.patchOpAddCallout;
    case "code":
      return dict.patchOpAddCode;
    case "toggle":
      return label ? format(dict.patchOpAddToggle, { text: label }) : dict.patchOpAddToggleGeneric;
    case "image":
      return dict.patchOpAddImage;
    case "divider":
      return dict.patchOpAddDivider;
    case "quote":
      return label ? format(dict.patchOpAddQuote, { text: label }) : dict.patchOpAddQuoteGeneric;
    case "child_page":
      return dict.patchOpAddChildPage;
    default:
      return dict.patchOpAddGeneric;
  }
}
