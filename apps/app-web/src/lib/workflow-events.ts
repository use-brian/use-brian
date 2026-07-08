/**
 * Tiny event bus telling the workflow surfaces to re-fetch (app-web).
 *
 * Mirrors `brain-events.ts` / `approvals-events.ts`: the workflow list
 * page, the create modal, and the board view fire this after a successful
 * create / update / enable-toggle / delete; the `WorkflowSidebarPanel`,
 * list page, detail page, and run-activity surfaces subscribe, re-fetch,
 * and re-rank. Load-bearing because those surfaces otherwise only fetch on
 * `workspaceId` change, so a mutation followed by a `router.push`
 * (create -> board, delete -> list) leaves them showing the pre-mutation
 * set until a full reload.
 *
 * Since the realtime-sync generalization this bus also has a SERVER leg:
 * the shell-level workspace stream (`workspace-events.ts`) dispatches it
 * for `workflow` / `workflow_run` change signals from ANY lane — assistant
 * chat, workers, MCP, another tab — carrying the optional `primitive` /
 * `rowId` fields below. Same-tab firers keep calling
 * `requestWorkflowRefresh` with just the workspaceId.
 *
 * A one-shot CustomEvent keeps the mutating surfaces decoupled from the
 * chrome panel.
 */

export const WORKFLOW_REFRESH_EVENT = "sidan:workflow-refresh";

export type WorkflowRefreshDetail = {
  /**
   * Scopes the refresh to a specific workspace. The panel ignores events
   * whose workspaceId doesn't match its current view.
   */
  workspaceId: string | null;
  /**
   * Which primitive changed: 'workflow' (definition / lifecycle) or
   * 'workflow_run' (run activity). Omitted or null — same-tab firers and
   * the reconnect catch-up — means "treat as both".
   */
  primitive?: "workflow" | "workflow_run" | null;
  /** The changed row (workflow id, or the RUN id for 'workflow_run'). */
  rowId?: string;
};

export function requestWorkflowRefresh(workspaceId: string | null): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<WorkflowRefreshDetail>(WORKFLOW_REFRESH_EVENT, {
      detail: { workspaceId },
    }),
  );
}
