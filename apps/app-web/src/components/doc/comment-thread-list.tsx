"use client";

/**
 * Page-level comment index — a top-bar button (unresolved count) that opens
 * a panel listing every thread on the page, grouped Open / Resolved /
 * "no longer anchored" (orphaned — its anchor block was deleted, so it has
 * no gutter badge and would otherwise be unreachable). Picking a thread
 * opens its popover via the editor's `onPick`.
 *
 * Hidden entirely on a page with no comments at all — a bare comment glyph on
 * every fresh page is noise. The editor passes `hasOpenThreads` so the button
 * appears in sync with the gutter badges; this component's own resolved-
 * inclusive fetch keeps it visible for a resolved-only page too.
 *
 * Self-contained: fetches its own threads (incl. resolved) when opened.
 *
 * [COMP:app-web/comment-thread-list]
 */

import * as React from "react";
import { MessageSquare } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { listPageThreads, type CommentThread } from "@/lib/api/comments";

/** The thread's one-line label in the index: the anchor `quote` (where on the
 *  page) when it has one, else a `title` derived from its first comment (what
 *  it's about — server-computed for page-level / quote-less threads), else the
 *  generic fallback. Exported pure so the precedence is unit-tested without
 *  mounting the popover. */
export function commentThreadLabel(
  th: Pick<CommentThread, "quote" | "title">,
  fallback: string,
): string {
  return th.quote?.trim() || th.title?.trim() || fallback;
}

type Props = {
  pageId: string;
  /** Block ids currently present in the doc — a thread whose `anchorBlockId`
   *  isn't here (and isn't a live human mark) is orphaned. */
  liveAnchorIds: Set<string>;
  /** Open a thread's popover. The editor resolves the anchor element. */
  onPick: (thread: CommentThread) => void;
  /** Bumped by the editor whenever threads change, to refetch. */
  refreshKey: number;
  /** The editor already knows the page's OPEN threads (it fetches them for the
   *  gutter); pass `length > 0` so the button shows in sync with the gutter
   *  badges instead of waiting for this component's own resolved-inclusive
   *  fetch. The button still appears for a resolved-only page once that fetch
   *  lands. */
  hasOpenThreads?: boolean;
};

export function CommentThreadList({ pageId, liveAnchorIds, onPick, refreshKey, hasOpenThreads }: Props) {
  const t = useT().comments;
  const [open, setOpen] = React.useState(false);
  const [threads, setThreads] = React.useState<CommentThread[]>([]);

  React.useEffect(() => {
    if (!open && refreshKey === 0) return;
    if (!pageId) return;
    void listPageThreads(pageId, { includeResolved: true }).then(setThreads);
  }, [pageId, open, refreshKey]);

  const openThreads = threads.filter((th) => !th.resolvedAt);
  const resolved = threads.filter((th) => th.resolvedAt);
  // Only flag orphans once we actually know which blocks are live — an empty
  // set means the editor hasn't reported yet, NOT that every anchor is gone.
  const canDetectOrphans = liveAnchorIds.size > 0;
  const isOrphan = (th: CommentThread) =>
    canDetectOrphans &&
    !th.resolvedAt &&
    !!th.anchorBlockId &&
    !liveAnchorIds.has(th.anchorBlockId);
  const anchored = openThreads.filter((th) => !isOrphan(th));
  const orphaned = openThreads.filter(isOrphan);

  const unresolvedCount = openThreads.length;

  // No comments on the page at all (open OR resolved) → render nothing. The
  // editor's `hasOpenThreads` shows the button in sync with the gutter; the
  // local resolved-inclusive fetch keeps it up for a resolved-only page.
  const hasAnyComment = hasOpenThreads || threads.length > 0;

  function row(th: CommentThread, dim?: boolean) {
    return (
      <li key={th.id}>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            onPick(th);
          }}
          className={`w-full truncate rounded px-2 py-1.5 text-left text-sm hover:bg-accent ${
            dim ? "text-muted-foreground" : "text-foreground"
          }`}
        >
          {commentThreadLabel(th, t.popoverTitle)}
        </button>
      </li>
    );
  }

  function group(label: string, items: CommentThread[], dim?: boolean) {
    if (items.length === 0) return null;
    return (
      <div className="mb-1">
        <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </div>
        <ul>{items.map((th) => row(th, dim))}</ul>
      </div>
    );
  }

  if (!hasAnyComment) return null;

  return (
    // Right-aligned row in normal flow above the composer band (flow placement,
    // not `absolute`, so it never overlaps the PageComments composer's send
    // button — both occupy the editor's top-right).
    <div className="mb-1 flex justify-end">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={format(t.badgeAria, { count: unresolvedCount })}
        >
          <MessageSquare className="size-4" />
          {unresolvedCount > 0 ? unresolvedCount : null}
        </PopoverTrigger>
        <PopoverContent side="bottom" align="end" className="max-h-[60vh] w-[280px] overflow-y-auto p-1">
          <div className="px-2 py-1 text-sm font-medium">{t.listTitle}</div>
          {threads.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">
              {t.listEmpty}
            </p>
          ) : (
            <>
              {group("", anchored)}
              {group(t.listOrphanedGroup, orphaned, true)}
              {group(t.listResolvedGroup, resolved, true)}
            </>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
