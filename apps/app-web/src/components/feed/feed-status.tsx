"use client";

/**
 * The Feed surface's one status vocabulary.
 *
 * Before the revamp every surface invented its own status colour inline, so
 * "ready" was emerald on one page, amber on another, and a raw
 * a raw dark-only tint on a third (75 raw-colour hits across the surface).
 * The operator-app spec allows semantic STATUS colour and nothing else, so it
 * has to be defined exactly once and imported, not retyped.
 *
 * The palette is deliberately quiet: a small filled dot carries the state and
 * the label carries the meaning. No filled pills, no glow, no saturated chrome
 * (the locked app-web design language). Dark and light both go through
 * Tailwind's own dark variants rather than hard-coded hex.
 *
 * Spec: docs/architecture/feed/operator-app.md → "Visual language".
 * [COMP:app-web/feed-status]
 */

import { cn } from "@/lib/utils";
import type { PlanSlotStatus } from "@/lib/feed-plan";
import type { PostQueueStatus } from "@/lib/feed-posts";

/** Every state either surface can render. */
export type FeedStatus = PlanSlotStatus | PostQueueStatus;

/**
 * Dot fills. `planned` is deliberately hollow-grey: an empty day is a plan,
 * not a problem, and colouring it would make an ordinary calendar look alarmed.
 */
const DOT: Record<FeedStatus, string> = {
  planned: "bg-muted-foreground/40",
  drafting: "bg-amber-500/80 dark:bg-amber-400/80",
  review: "bg-amber-500/80 dark:bg-amber-400/80",
  ready: "bg-emerald-600/80 dark:bg-emerald-400/80",
  posted: "bg-foreground/35",
  skipped: "bg-muted-foreground/25",
};

/** Text tints, for the one place a status names itself in prose. */
const TEXT: Record<FeedStatus, string> = {
  planned: "text-muted-foreground",
  drafting: "text-amber-700 dark:text-amber-300",
  review: "text-amber-700 dark:text-amber-300",
  ready: "text-emerald-700 dark:text-emerald-300",
  posted: "text-muted-foreground",
  skipped: "text-muted-foreground",
};

/**
 * The status pip. Always `aria-hidden` - the adjacent label names the state,
 * so a screen reader never has to decode a colour.
 */
export function StatusDot({
  status,
  className,
}: {
  status: FeedStatus;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        DOT[status],
        className,
      )}
    />
  );
}

/** A dot plus its label, the standard way a status appears in a list row. */
export function StatusLabel({
  status,
  label,
  className,
}: {
  status: FeedStatus;
  label: string;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <StatusDot status={status} />
      <span className={cn("text-[11px]", TEXT[status])}>{label}</span>
    </span>
  );
}
