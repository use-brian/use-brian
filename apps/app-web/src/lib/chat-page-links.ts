/**
 * Which Pages a Chat turn wrote, so the transcript can link them.
 *
 * Full Chat can create a Page (or edit a pinned one) through the isolated
 * Doc editor gateway (`delegateDocEdit`), and older turns may carry a direct
 * `renderPage`. Neither leaves a visible trace in the Chat transcript beyond
 * the model's own prose, so a user who asked for a page had to go hunting for
 * it. The Chat app renders an "Open page" card per written Page instead.
 *
 * Two sources, one per lifecycle:
 * - **Live**: the `page_created` SSE event (fired the moment a new Page
 *   persists) and the `tool_result` of a page-writing tool, parsed here.
 * - **History**: the persisted `tool_use` + `tool_result` rows. A result row
 *   is a user-role carrier the transcript never renders, so the ids are
 *   indexed once across the thread, then read per assistant row.
 *
 * History is untrusted JSON: every field is narrowed, and a failed receipt
 * links nothing (a failed edit applied no mutation).
 *
 * Spec: docs/architecture/features/chat-app.md -> "Pages created from Chat".
 * [COMP:app-web/chat-page-links]
 */

/** Tools whose result names the Page(s) they wrote. */
export const PAGE_WRITING_TOOLS: ReadonlySet<string> = new Set([
  "delegateDocEdit",
  "renderPage",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function uniqueIds(ids: Iterable<unknown>): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id === "string" && id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * The Page ids one page-writing tool result names. `delegateDocEdit` returns
 * a receipt (`{ status, pageIds }`); `renderPage` returns `{ pageId }`. A
 * truncated result can lose its closing brace, so an unparsable string falls
 * back to reading the `pageIds` array / `pageId` field textually.
 */
export function pageIdsFromToolResult(
  content: unknown,
  isError = false,
): string[] {
  if (isError) return [];
  let parsed: unknown = content;
  if (typeof content === "string") {
    try {
      parsed = JSON.parse(content);
    } catch {
      return pageIdsFromText(content);
    }
  }
  if (!isRecord(parsed)) return [];
  if (parsed.status === "failed") return [];
  if (Array.isArray(parsed.pageIds)) return uniqueIds(parsed.pageIds);
  if (typeof parsed.pageId === "string") return uniqueIds([parsed.pageId]);
  return [];
}

function pageIdsFromText(text: string): string[] {
  if (/"status"\s*:\s*"failed"/.test(text)) return [];
  const list = /"pageIds"\s*:\s*\[([^\]]*)\]/.exec(text);
  if (list) {
    return uniqueIds(
      [...list[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]),
    );
  }
  const single = /"pageId"\s*:\s*"([^"]+)"/.exec(text);
  return single ? [single[1]] : [];
}

/**
 * Index every page-writing tool call in a thread's persisted rows:
 * `toolUseId -> Page ids`. Calls with no result, a failed result, or no ids
 * are absent.
 */
export function collectPageWrites(
  rows: ReadonlyArray<{ content: unknown }>,
): Map<string, string[]> {
  const pageToolUseIds = new Set<string>();
  for (const row of rows) {
    if (!Array.isArray(row.content)) continue;
    for (const block of row.content) {
      if (
        isRecord(block) &&
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string" &&
        PAGE_WRITING_TOOLS.has(block.name)
      ) {
        pageToolUseIds.add(block.id);
      }
    }
  }
  const writes = new Map<string, string[]>();
  if (pageToolUseIds.size === 0) return writes;
  for (const row of rows) {
    if (!Array.isArray(row.content)) continue;
    for (const block of row.content) {
      if (!isRecord(block) || block.type !== "tool_result") continue;
      const id = typeof block.toolUseId === "string" ? block.toolUseId : "";
      if (!pageToolUseIds.has(id)) continue;
      const ids = pageIdsFromToolResult(block.content, block.isError === true);
      if (ids.length > 0) writes.set(id, ids);
    }
  }
  return writes;
}

/** The Page ids one persisted assistant row wrote, in call order. */
export function pageLinksForRow(
  content: unknown,
  writes: ReadonlyMap<string, string[]>,
): string[] {
  if (!Array.isArray(content) || writes.size === 0) return [];
  const ids: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "tool_use") continue;
    const written = typeof block.id === "string" ? writes.get(block.id) : undefined;
    if (written) ids.push(...written);
  }
  return uniqueIds(ids);
}

/** Append ids to a live turn's list, keeping order and dropping repeats. */
export function addPageLinks(current: readonly string[], ids: readonly string[]): string[] {
  return uniqueIds([...current, ...ids]);
}
