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
 * Two sections for the current workspace member:
 *   1. **Replies from your assistant** — open comment threads you started
 *      whose latest comment is the AI's (derived server-side; clears when you
 *      reply or resolve). Each row opens the page so you can act on the thread.
 *   2. **Mentions** — when a teammate @-tagged you in a page body or a
 *      comment (`kind: 'mention'`), OR tagged you with `@Jane Doe` in a
 *      workspace chat room (`kind: 'room_mention'`, migration 448 —
 *      docs/plans/room-human-mentions.md). Both share one unread-only list,
 *      newest first; a room row names the room instead of a page and opens
 *      the room instead of a page (T-H7 — positioned at latest; scroll-to-
 *      message is explicitly deferred).
 *
 * **Opening a row clears it.** Clicking hands the target back to the shell
 * (`onOpenPage` for a page mention, `onOpenRoom` for a room mention) for a
 * soft in-shell navigation, and in the same gesture files the read: a
 * mention is marked read, a pending reply gets a dismissal (it has no
 * `read_at` of its own — see migration 426). The row is removed from local
 * state immediately so the panel doesn't flash stale content on its way out,
 * then `doc:inbox-changed` refreshes the sidebar badge.
 *
 * Note what this component deliberately no longer does: mark EVERY mention
 * read on open. That was fine when read rows still rendered in a muted state,
 * but now that reading removes a row it would empty the whole list the instant
 * the panel appeared. Clearing is per-row and user-initiated.
 *
 * Old items age out server-side via the workspace retention window; the panel
 * needs no logic for it, it simply receives fewer rows.
 *
 * Live refresh (T-H8): this component only refetches when it OPENS (see the
 * effect below) — while it's closed, a room mention recorded from another
 * tab, device, or teammate is caught by the sidebar badge listening for
 * `INBOX_REFRESH_EVENT` (`doc-sidebar.tsx`), and the next open reads current
 * truth. No listener is needed here for the closed state.
 *
 * Spec: `docs/architecture/features/doc-inbox.md`.
 */

import * as React from "react";
import { AtSign, Bot, Inbox as InboxIcon, MessageSquare, X } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import {
  dismissInboxReply,
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
  /** Open a room (soft nav to the Chat surface, positioned at latest — T-H7)
   *  — the panel closes itself after, same as `onOpenPage`. */
  onOpenRoom: (sessionId: string) => void;
};

export function InboxPanel({
  open,
  workspaceId,
  sidebarCollapsed,
  onClose,
  onOpenPage,
  onOpenRoom,
}: Props) {
  const t = useT().docPage;
  const [pending, setPending] = React.useState<InboxPendingReply[]>([]);
  const [mentions, setMentions] = React.useState<InboxMention[]>([]);
  const [state, setState] = React.useState<"loading" | "ready" | "error">("loading");

  // Fetch each time the panel OPENS (not on mount — it stays mounted for the
  // slide animation). Opening only READS now; clearing is per-row, so the badge
  // nudge here just re-syncs it with what the server actually returned.
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
        window.dispatchEvent(new Event(INBOX_CHANGED_EVENT));
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

  const openRoom = (sessionId: string) => {
    onOpenRoom(sessionId);
    onClose();
  };

  // Opening a pending reply clears it. The optimistic local drop matters
  // because the panel is closing: without it the row is still on screen for the
  // slide-out, and it would be back on the next open if the request is slow.
  // The write is fire-and-forget for the same reason — navigation must not wait
  // on it, and a failure simply leaves the row for next time.
  const openPendingReply = (row: InboxPendingReply) => {
    setPending((rows) => rows.filter((r) => r.threadId !== row.threadId));
    void dismissInboxReply(workspaceId, row.threadId).then(() => {
      window.dispatchEvent(new Event(INBOX_CHANGED_EVENT));
    });
    openPage(row.pageId);
  };

  // Same gesture for a mention, except the read state already exists — marking
  // it read IS the dismissal, and the list is unread-only. A room mention
  // opens the room (T-H7) instead of a page.
  const openMention = (m: InboxMention) => {
    setMentions((rows) => rows.filter((r) => r.id !== m.id));
    void markInboxRead(workspaceId, [m.id]).then(() => {
      window.dispatchEvent(new Event(INBOX_CHANGED_EVENT));
    });
    if (m.kind === "room_mention") {
      openRoom(m.sessionId);
    } else {
      openPage(m.pageId);
    }
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
                          onClick={() => openPendingReply(row)}
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
                    {mentions.map((m) => {
                      const isRoom = m.kind === "room_mention";
                      // A room mention reads "{actor} mentioned you in
                      // {room}" instead of "{actor} mentioned you · {page}" —
                      // the wording itself is what makes the row read as
                      // coming from a room rather than a page (no icon
                      // dependency, so it stays legible to a screen reader).
                      const label = isRoom
                        ? m.actorName
                          ? t.inboxMentionByActorInRoom
                              .replace("{actor}", m.actorName)
                              .replace("{room}", m.roomTitle || t.inboxRoomFallback)
                          : t.inboxMentionAnonInRoom.replace(
                              "{room}",
                              m.roomTitle || t.inboxRoomFallback,
                            )
                        : m.actorName
                          ? t.inboxMentionByActor.replace("{actor}", m.actorName)
                          : t.inboxMentionAnon;
                      return (
                        <li key={m.id}>
                          <button
                            type="button"
                            onClick={() => openMention(m)}
                            // No unread tint any more: the list is unread-only,
                            // so tinting every row would say nothing.
                            className="flex w-full items-start gap-3 rounded-lg border border-transparent px-2.5 py-2 text-left hover:border-border hover:bg-accent"
                          >
                            {m.actorName ? (
                              <span className="mt-0.5">
                                <Avatar id={m.actorUserId} name={m.actorName} size={28} />
                              </span>
                            ) : (
                              <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                                {isRoom ? (
                                  <MessageSquare className="size-4" />
                                ) : (
                                  <AtSign className="size-4" />
                                )}
                              </span>
                            )}
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[14px] text-foreground">
                                {label}
                                {!isRoom ? (
                                  <span className="text-muted-foreground">
                                    {" "}
                                    · {m.pageTitle || t.inboxTitle}
                                  </span>
                                ) : null}
                              </span>
                              {m.preview ? (
                                <span className="block truncate text-[13px] text-muted-foreground">
                                  <PreviewMarkdown text={m.preview} />
                                </span>
                              ) : null}
                            </span>
                          </button>
                        </li>
                      );
                    })}
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
