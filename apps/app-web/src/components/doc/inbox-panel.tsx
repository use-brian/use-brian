"use client";

// [COMP:app-web/inbox-panel]
/**
 * Inbox panel — a Notion-style flyout anchored to the **left bar**.
 *
 * The sidebar **Inbox** row toggles this panel instead of navigating to a
 * standalone `/w/[id]/inbox` page: it slides out immediately to the right of
 * the sidebar, overlays the page (never tears down the editor), and dismisses
 * on outside-click or Escape. The user stays on whatever page they were on.
 *
 * Two sections for the current workspace member (same sources as before):
 *   1. **Replies from your assistant** — open comment threads you started
 *      whose latest comment is the AI's (derived server-side; clears when you
 *      reply or resolve). Each row opens the page so you can act on the thread.
 *   2. **Mentions** — when a teammate @-tagged you in a page body or a comment.
 *
 * Opening the panel marks all mentions read (the badge clears) and broadcasts
 * `doc:inbox-changed` so the sidebar badge refreshes. A row click hands the
 * page id back to the shell (`onOpenPage`) for a soft in-shell navigation and
 * closes the panel. Spec: `docs/architecture/features/doc-inbox.md`.
 */

import * as React from "react";
import { AtSign, Bot, Inbox as InboxIcon, X } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import {
  fetchInbox,
  markInboxRead,
  type InboxMention,
  type InboxPendingReply,
} from "@/lib/api/inbox";
import { INBOX_CHANGED_EVENT } from "@/lib/inbox-events";
import { Avatar } from "@/components/doc/comment-thread-body";
import { PreviewMarkdown } from "@/components/doc/preview-markdown";

type Props = {
  open: boolean;
  workspaceId: string;
  /** Mirrors the shell's sidebar-collapse so the panel anchors flush against
   *  the left bar whether it's expanded (w-64) or collapsed (w-0). */
  sidebarCollapsed: boolean;
  onClose: () => void;
  /** Open a page in the shell (soft nav) — the panel closes itself after. */
  onOpenPage: (pageId: string) => void;
};

export function InboxPanel({
  open,
  workspaceId,
  sidebarCollapsed,
  onClose,
  onOpenPage,
}: Props) {
  const t = useT().docPage;
  const [pending, setPending] = React.useState<InboxPendingReply[]>([]);
  const [mentions, setMentions] = React.useState<InboxMention[]>([]);
  const [state, setState] = React.useState<"loading" | "ready" | "error">("loading");

  // Fetch each time the panel OPENS (not on mount — it stays mounted for the
  // slide animation). Opening clears unread mentions, then nudges the sidebar
  // badge to refresh. Mirrors the old full-page view's load effect.
  React.useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setState("loading");
    fetchInbox(workspaceId, { signal: controller.signal })
      .then((payload) => {
        if (controller.signal.aborted) return;
        setPending(payload.pending);
        setMentions(payload.mentions);
        setState("ready");
        if (payload.unreadMentionCount > 0) {
          void markInboxRead(workspaceId).then(() => {
            window.dispatchEvent(new Event(INBOX_CHANGED_EVENT));
          });
        } else {
          window.dispatchEvent(new Event(INBOX_CHANGED_EVENT));
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setState("error");
      });
    return () => controller.abort();
  }, [open, workspaceId]);

  // Escape closes the panel (only while open).
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const openPage = (pageId: string) => {
    onOpenPage(pageId);
    onClose();
  };
  const isEmpty = pending.length === 0 && mentions.length === 0;

  return (
    <>
      {/* Click-catcher — dismiss on outside click. Transparent on desktop
          (Notion-style; no scrim over the page), a subtle scrim on mobile
          where the panel reads as a drawer. */}
      <button
        type="button"
        aria-label={t.inboxCloseAria}
        tabIndex={-1}
        onClick={onClose}
        className={[
          "fixed inset-0 z-30 bg-foreground/20 backdrop-blur-[1px] transition-opacity duration-200 md:bg-transparent md:backdrop-blur-none",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        ].join(" ")}
      />

      {/* Panel — anchored flush to the right edge of the left bar. Slides in
          from the left; on mobile it sits at the screen edge (the sidebar
          drawer is closed when this opens). */}
      <aside
        aria-hidden={!open}
        aria-label={t.inboxTitle}
        className={[
          "absolute inset-y-0 left-0 z-40 flex w-[min(380px,86vw)] flex-col",
          "border-r border-sidebar-border bg-background text-foreground shadow-xl",
          "transition-[transform,opacity] duration-200 ease-out",
          sidebarCollapsed ? "md:left-0" : "md:left-64",
          open ? "translate-x-0 opacity-100" : "pointer-events-none -translate-x-4 opacity-0",
        ].join(" ")}
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <InboxIcon className="size-[18px] text-foreground/70" />
            <h2 className="text-[15px] font-semibold text-foreground">{t.inboxTitle}</h2>
          </div>
          <button
            type="button"
            aria-label={t.inboxCloseAria}
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {state === "loading" ? (
            <div className="space-y-2" aria-busy>
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-14 animate-pulse rounded-lg bg-muted/60" />
              ))}
            </div>
          ) : state === "error" ? (
            <p className="px-1 text-sm text-destructive">{t.inboxError}</p>
          ) : isEmpty ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-border/60 bg-muted/20 px-6 py-12 text-center">
              <InboxIcon className="size-7 text-muted-foreground/60" />
              <p className="text-sm font-medium text-foreground">{t.inboxEmptyTitle}</p>
              <p className="max-w-xs text-[13px] text-muted-foreground">{t.inboxEmptyHint}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-6">
              {pending.length > 0 ? (
                <section className="flex flex-col gap-2">
                  <SectionHeading>{t.inboxPendingHeading}</SectionHeading>
                  <ul className="flex flex-col gap-1">
                    {pending.map((row) => (
                      <li key={row.threadId}>
                        <button
                          type="button"
                          onClick={() => openPage(row.pageId)}
                          className="flex w-full items-start gap-3 rounded-lg border border-transparent px-2.5 py-2 text-left hover:border-border hover:bg-accent"
                        >
                          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                            <Bot className="size-4" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[14px] font-medium text-foreground">
                              {row.pageTitle || t.inboxTitle}
                            </span>
                            <span className="block truncate text-[13px] text-muted-foreground">
                              {row.quote?.trim() ? (
                                <PreviewMarkdown text={row.quote.trim()} />
                              ) : (
                                t.inboxPendingSubtitle
                              )}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {mentions.length > 0 ? (
                <section className="flex flex-col gap-2">
                  <SectionHeading>{t.inboxMentionsHeading}</SectionHeading>
                  <ul className="flex flex-col gap-1">
                    {mentions.map((m) => (
                      <li key={m.id}>
                        <button
                          type="button"
                          onClick={() => openPage(m.pageId)}
                          className={
                            "flex w-full items-start gap-3 rounded-lg border border-transparent px-2.5 py-2 text-left hover:border-border hover:bg-accent " +
                            (m.readAt === null ? "bg-primary/[0.04]" : "")
                          }
                        >
                          {m.actorName ? (
                            <span className="mt-0.5">
                              <Avatar id={m.actorUserId} name={m.actorName} size={28} />
                            </span>
                          ) : (
                            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                              <AtSign className="size-4" />
                            </span>
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[14px] text-foreground">
                              {m.actorName
                                ? t.inboxMentionByActor.replace("{actor}", m.actorName)
                                : t.inboxMentionAnon}
                              <span className="text-muted-foreground"> · {m.pageTitle || t.inboxTitle}</span>
                            </span>
                            {m.preview ? (
                              <span className="block truncate text-[13px] text-muted-foreground">
                                <PreviewMarkdown text={m.preview} />
                              </span>
                            ) : null}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
      {children}
    </h3>
  );
}
