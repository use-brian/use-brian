/**
 * Tiny event bus telling the brain page to re-fetch its row list
 * (app-web).
 *
 * Ported verbatim from `apps/web/src/lib/brain-events.ts` as part of the
 * brain surface migration (docs/plans/doc-web-app-consolidation.md
 * §5a). The brain detail-drawer / unverified-nudge fire this after a
 * successful brain-write (verify / adjust / delete / alias); the brain
 * page subscribes, re-fetches, and fades in any rows it hadn't seen
 * before. The brain stream client (`brain-stream.ts`) also dispatches it
 * for cross-process writes.
 *
 * Mirrors the chat-seed.ts pattern — a one-shot CustomEvent keeps the
 * surfaces decoupled.
 */

export const BRAIN_REFRESH_EVENT = "sidan:brain-refresh";

export type BrainRefreshDetail = {
  /**
   * Scopes the refresh to a specific workspace. The brain page ignores
   * events whose workspaceId doesn't match its current view.
   */
  workspaceId: string | null;
};

/**
 * Tool names whose successful `tool_result` should refresh the brain
 * page. Source: packages/core/src/{memory,tasks,crm,workflows,
 * workspace-files}/tools.ts. Keep in sync when adding a write tool to
 * any primitive that surfaces in /brain. Read tools are excluded.
 */
export const BRAIN_WRITE_TOOLS = new Set<string>([
  "saveMemory",
  "deleteMemory",
  "saveTask",
  "updateTask",
  "closeTask",
  "reopenTask",
  "saveContact",
  "updateContact",
  "saveCompany",
  "updateCompany",
  "saveDeal",
  "updateDeal",
  "updateSelfProfile",
  "createEntity",
  "fileWrite",
  "fileAppend",
  "fileSetMeta",
  "fileDelete",
]);

export function requestBrainRefresh(workspaceId: string | null): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<BrainRefreshDetail>(BRAIN_REFRESH_EVENT, {
      detail: { workspaceId },
    }),
  );
}
