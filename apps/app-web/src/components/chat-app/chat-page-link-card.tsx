"use client";

/**
 * "Open page" card under a Chat reply, one per Page the assistant created or
 * edited that turn (ids from `lib/chat-page-links.ts`). The id is all the
 * transcript knows, so the card resolves the title through `getView` (cached
 * per page) and opens the Page in the Pages app. A Page the viewer can no
 * longer read (deleted, moved, above clearance) renders as unavailable rather
 * than a link that dead-ends.
 *
 * Spec: docs/architecture/features/chat-app.md -> "Pages created from Chat".
 * [COMP:app-web/chat-page-links]
 */

import { useEffect, useState } from "react";
import { ChevronRight, FileText } from "lucide-react";
import { getView } from "@/lib/api/views";
import { format, useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

type PageState =
  | { status: "loading" }
  | { status: "ready"; title: string; icon: string | null }
  | { status: "unavailable" };

export function ChatPageLinkCard({
  pageId,
  onOpen,
}: {
  pageId: string;
  onOpen: (pageId: string) => void;
}) {
  const t = useT().chatApp.pageLink;
  const [page, setPage] = useState<PageState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setPage({ status: "loading" });
    getView(pageId)
      .then((view) => {
        if (cancelled) return;
        setPage({
          status: "ready",
          title: view.name.trim(),
          icon: typeof view.icon === "string" && view.icon ? view.icon : null,
        });
      })
      .catch(() => {
        if (!cancelled) setPage({ status: "unavailable" });
      });
    return () => {
      cancelled = true;
    };
  }, [pageId]);

  const unavailable = page.status === "unavailable";
  const title =
    page.status === "ready" && page.title ? page.title : t.untitled;

  return (
    <button
      type="button"
      disabled={unavailable}
      onClick={() => onOpen(pageId)}
      aria-label={format(t.openAria, { title })}
      className={cn(
        "flex w-full max-w-md items-center gap-3 rounded-xl border border-border bg-muted/30 px-3 py-2.5 text-left",
        "transition-colors hover:border-primary/30 hover:bg-muted/55 focus-visible:shadow-none",
        "disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-border disabled:hover:bg-muted/30",
      )}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground ring-1 ring-border">
        {page.status === "ready" && page.icon ? (
          <span className="text-base leading-none" aria-hidden>
            {page.icon}
          </span>
        ) : (
          <FileText className="size-4" aria-hidden />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate text-sm font-medium text-foreground",
            page.status === "loading" && "text-muted-foreground",
          )}
        >
          {unavailable ? t.unavailable : title}
        </span>
        {unavailable ? null : (
          <span className="block truncate text-xs text-muted-foreground">
            {t.open}
          </span>
        )}
      </span>
      {unavailable ? null : (
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      )}
    </button>
  );
}
