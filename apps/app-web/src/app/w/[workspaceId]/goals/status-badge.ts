/**
 * Goal status → badge classes. Shared by the goals board (`page.tsx`) and the
 * goal detail page (`[goalId]/page.tsx`) so the status chip reads identically on
 * both. Keyed on the closed `GoalStatus` union, so adding a status is a compile
 * error here until a colour is chosen.
 *
 * [COMP:app-web/goals-board]
 */
import type { GoalStatus } from "@/lib/api/goals";

export const STATUS_BADGE: Record<GoalStatus, string> = {
  active: "bg-primary/15 text-primary",
  running: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  awaiting_approval: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  blocked: "bg-red-500/15 text-red-600 dark:text-red-400",
  done: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  abandoned: "bg-muted text-muted-foreground",
};
