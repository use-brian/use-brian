/**
 * Tiny event bus telling the Workflow sidebar panel to re-fetch its list
 * (app-web).
 *
 * Mirrors `brain-events.ts` / `approvals-events.ts`: the workflow list
 * page, the create modal, and the board view fire this after a successful
 * create / update / enable-toggle / delete; the `WorkflowSidebarPanel`
 * subscribes, re-fetches, and re-ranks. Load-bearing because the panel
 * otherwise only fetches on `workspaceId` change, so a mutation followed by
 * a `router.push` (create -> board, delete -> list) leaves the sidebar
 * showing the pre-mutation set until a full reload.
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
};

export function requestWorkflowRefresh(workspaceId: string | null): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<WorkflowRefreshDetail>(WORKFLOW_REFRESH_EVENT, {
      detail: { workspaceId },
    }),
  );
}
