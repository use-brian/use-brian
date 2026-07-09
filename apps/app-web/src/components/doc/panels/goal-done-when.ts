/**
 * Human summary of a goal's `done_when` acceptance tree. Shared by the Autopilot
 * board's detail pane (`autopilot-panel.tsx`) and the goal-detail sub-route
 * (`app/w/[workspaceId]/goals/[goalId]/page.tsx`) so "what done means" reads
 * identically on both surfaces. Never evaluates the tree — the engine does that
 * (see packages/core/src/goals/done-when.ts); this only renders it.
 *
 * [COMP:app-web/goals-board]
 */
import { format } from "@/lib/i18n/format";
import type { DoneWhenNode } from "@/lib/api/goals";

export type AcceptanceLabels = {
  subtasks: string;
  query: string;
  tool: string;
  verify: string;
  all: string;
  any: string;
  not: string;
};

/** Prefers the author's own description on a query / tool leaf (e.g. "task
 *  complete"), falling back to a generic i18n label; combinators recurse. */
export function summariseDoneWhen(node: DoneWhenNode, L: AcceptanceLabels): string {
  if ("all" in node) {
    return format(L.all, { items: node.all.map((n) => summariseDoneWhen(n, L)).join(", ") });
  }
  if ("any" in node) {
    return format(L.any, { items: node.any.map((n) => summariseDoneWhen(n, L)).join(", ") });
  }
  if ("not" in node) {
    return format(L.not, { item: summariseDoneWhen(node.not, L) });
  }
  if (node.kind === "subtasks") return L.subtasks;
  if (node.kind === "query") return node.query.description?.trim() || L.query;
  if (node.kind === "tool") return node.tool.description?.trim() || node.tool.tool || L.tool;
  return L.verify; // node.kind === "verify"
}
