"use client";

// [COMP:app-web/inbox-panel]
/**
 * Inbox: a compact sidebar popover on desktop and a full-width phone sheet.
 *
 * The sidebar **Inbox** row toggles this panel instead of navigating to a
 * standalone `/w/[id]/inbox` page: it opens immediately to the right of
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
 * Data (instant-navigation contract, Phase 3): the payload lives in the
 * surface cache under `inboxCacheKey(wid)` (`inbox:<wid>:<viewer>`). An open
 * paints the cached rows on the first frame and revalidates behind them;
 * only the FIRST open of a session shows the three skeleton rows. The key is
 * armed on that first open and stays armed, so the rows survive the slide-out
 * and a server signal while the panel is closed (`INBOX_REFRESH_EVENT` ->
 * `inbox:<wid>` in the one spine map, `lib/surface-cache-invalidation.ts`)
 * revalidates behind the closed panel instead of through a listener here.
 * Before the first open the panel costs no request: the sidebar badge covers
 * the closed state (`doc-sidebar.tsx`).
 *
 * Spec: `docs/architecture/features/doc-inbox.md`.
 */

import * as React from "react";
import { Dialog } from "@base-ui/react/dialog";
import { AtSign, Bot, Inbox as InboxIcon, MessageSquare, X } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import {
  dismissInboxReply,
  fetchInbox,
  markInboxRead,
  type InboxMention,
  type InboxPayload,
  type InboxPendingReply,
} from "@/lib/api/inbox";
import { INBOX_CHANGED_EVENT } from "@/lib/inbox-events";
import { mutateSurfaceCache } from "@/lib/surface-cache";
import { inboxCacheKey } from "@/lib/surface-prefetch";
import { Avatar } from "@/components/doc/comment-thread-body";
import { PreviewMarkdown } from "@/components/doc/preview-markdown";
import { useLeasedResource } from "@/lib/offline/surface-content-cache";
import { isPhoneViewport } from "@/lib/viewport";
import { subscribeAppViewport } from "@/lib/app-viewport";

const EMPTY_PENDING: InboxPendingReply[] = [];
const EMPTY_MENTIONS: InboxMention[] = [];

type Props = {
  open: boolean;
  workspaceId: string;
  /** Mirrors the shell's sidebar-collapse so the panel anchors flush against
   *  the left bar whether it's expanded (rail + contextual width) or collapsed (56px). */
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
  const phone = React.useSyncExternalStore(subscribeAppViewport, isPhoneViewport, () => false);
  const closeRef = React.useRef<HTMLButtonElement>(null);
  const portalHost = React.useRef<HTMLDivElement>(null);
  const opener = React.useRef<HTMLElement | null>(null);
  const navigated = React.useRef(false);
  React.useLayoutEffect(() => {
    if (!open) return;
    navigated.current = false;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && !active.closest("[data-inbox-panel]")) opener.current = active;
  }, [open]);
  // The key is armed on the first open and never disarmed: a `null` key while
  // closed would blank the rows mid slide-out, and an always-on key would
  // fetch on mount for a panel that may never open.
  const [armed, setArmed] = React.useState(open);
  React.useEffect(() => {
    if (open) setArmed(true);
  }, [open]);
  const key = armed ? inboxCacheKey(workspaceId) : null;
  const inbox = useLeasedResource<InboxPayload>(key, () => fetchInbox(workspaceId));
  const refresh = inbox.refresh;

  // Revalidate on every OPEN (the store dedupes it into the cold load when
  // there is one). Opening only READS; clearing is per-row, so the badge nudge
  // here just re-syncs it with what the server actually returned.
  React.useEffect(() => {
    if (!open || !key) return;
    let live = true;
    void refresh().then((payload) => {
      if (live && payload) window.dispatchEvent(new Event(INBOX_CHANGED_EVENT));
    });
    return () => {
      live = false;
    };
  }, [open, key, refresh]);

  const pending = inbox.data?.pending ?? EMPTY_PENDING;
  const mentions = inbox.data?.mentions ?? EMPTY_MENTIONS;
  // A failed REVALIDATION keeps the cached rows (the store holds the last
  // good payload); only a failure with nothing cached shows the error line.
  const state: "loading" | "ready" | "error" =
    inbox.data !== undefined ? "ready" : inbox.error !== undefined ? "error" : "loading";

  const openPage = (pageId: string) => {
    navigated.current = true;
    onOpenPage(pageId);
    onClose();
  };

  const openRoom = (sessionId: string) => {
    navigated.current = true;
    onOpenRoom(sessionId);
    onClose();
  };

  // Opening a pending reply clears it. The optimistic drop is written to the
  // CACHE (the optimistic-update seam): the panel is closing, so without it
  // the row is still on screen for the slide-out, and it would be back on the
  // next open if the request is slow. The write is fire-and-forget for the
  // same reason - navigation must not wait on it, and a failure simply leaves
  // the row for the next revalidation.
  const openPendingReply = (row: InboxPendingReply) => {
    mutateSurfaceCache<InboxPayload>(key, (prev) => ({
      ...prev,
      pending: prev.pending.filter((r) => r.threadId !== row.threadId),
      pendingCount: Math.max(0, prev.pendingCount - 1),
    }));
    void dismissInboxReply(workspaceId, row.threadId).then(() => {
      window.dispatchEvent(new Event(INBOX_CHANGED_EVENT));
    });
    openPage(row.pageId);
  };

  // Same gesture for a mention, except the read state already exists — marking
  // it read IS the dismissal, and the list is unread-only. A room mention
  // opens the room (T-H7) instead of a page.
  const openMention = (m: InboxMention) => {
    mutateSurfaceCache<InboxPayload>(key, (prev) => ({
      ...prev,
      mentions: prev.mentions.filter((r) => r.id !== m.id),
      unreadMentionCount: Math.max(0, prev.unreadMentionCount - 1),
    }));
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
    <div ref={portalHost} className="contents" />
    <Dialog.Root open={open} modal={phone} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal container={portalHost}>
      {/* The shell has a persistent, usually closed file-import Dialog root.
          Keep Inbox's own backdrop when Base UI classifies it as nested. */}
      <Dialog.Backdrop forceRender data-inbox-backdrop className="fixed inset-0 z-40 bg-black/20 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 md:bg-transparent motion-reduce:transition-none" />
      {/* Inline in the shell: its app-width and sidebar-size variables also
          bound the panel correctly while a native browser pane is docked. */}
      <Dialog.Popup
        id="workspace-inbox"
        data-inbox-panel
        aria-modal={phone || undefined}
        initialFocus={closeRef}
        finalFocus={() => {
          if (navigated.current) return false;
          // A nonmodal exit may already have focused the next control. Do not
          // steal that focus when the closing animation finishes.
          const active = document.activeElement;
          const visible = (element: HTMLElement | null) => element?.isConnected && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
          if (active instanceof HTMLElement && active !== document.body && active !== opener.current &&
            !active.closest("[data-inbox-panel]") && !active.hasAttribute("data-base-ui-focus-guard") && visible(active)) return false;
          return [
            opener.current,
            ...document.querySelectorAll<HTMLElement>("[data-inbox-trigger]"),
            document.querySelector<HTMLElement>("[data-doc-mobile-menu]"),
          ].find(visible) ?? false;
        }}
        style={{ "--inbox-offset": sidebarCollapsed ? "4rem" : "calc(3.5rem + var(--workspace-sidebar-width, 14rem) + 0.5rem)" } as React.CSSProperties}
        className="fixed bottom-0 left-0 z-50 flex max-h-[min(80dvh,40rem)] w-[var(--native-app-width,100%)] min-w-0 flex-col overflow-hidden rounded-t-2xl border border-border bg-popover pb-[env(safe-area-inset-bottom)] text-popover-foreground shadow-lg outline-none transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 md:absolute md:bottom-auto md:left-[var(--inbox-offset)] md:top-5 md:max-h-[min(80dvh,40rem,calc(100%-1.75rem))] md:w-[380px] md:max-w-[calc(100%-var(--inbox-offset)-0.5rem)] md:rounded-2xl md:pb-0 motion-reduce:transition-none"
      >
        <header className="flex h-13 shrink-0 items-center justify-between border-b border-border pl-4 pr-2 md:h-12">
          <Dialog.Title className="text-sm font-semibold">{t.inboxTitle}</Dialog.Title>
          <Dialog.Close ref={closeRef} aria-label={t.inboxCloseAria} className="flex size-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground md:size-8">
            <X className="size-4" aria-hidden />
          </Dialog.Close>
        </header>
        <Dialog.Description className="sr-only">{t.inboxDescription}</Dialog.Description>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
          {state === "loading" ? (
            <div className="space-y-2" aria-busy data-inbox-skeleton>
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-14 animate-pulse rounded-lg bg-muted/60" />
              ))}
            </div>
          ) : state === "error" ? (
            <p role="alert" className="px-2 py-4 text-sm text-destructive">{t.inboxError}</p>
          ) : isEmpty ? (
            <div data-inbox-empty role="status" className="flex min-h-48 flex-col items-center justify-center gap-2 px-5 py-8 text-center">
              <InboxIcon className="mb-1 size-6 text-muted-foreground/70" aria-hidden />
              <p className="text-sm font-medium text-foreground">{t.inboxEmptyTitle}</p>
              <p className="max-w-60 text-xs leading-5 text-muted-foreground">{t.inboxEmptyHint}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3 pb-1">
              {pending.length > 0 ? (
                <section className="flex flex-col gap-2">
                  <SectionHeading>{t.inboxPendingHeading}</SectionHeading>
                  <ul className="flex flex-col gap-1">
                    {pending.map((row) => (
                      <li key={row.threadId}>
                        <button
                          type="button"
                          onClick={() => openPendingReply(row)}
                          className="flex min-h-8 max-md:min-h-14 w-full items-start gap-2.5 rounded-lg px-2 py-2.5 text-left hover:bg-accent"
                        >
                          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                            <Bot className="size-4" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block line-clamp-2 text-sm font-medium text-foreground">
                              {row.pageTitle || t.inboxTitle}
                            </span>
                            <span className="block line-clamp-2 text-xs leading-5 text-muted-foreground">
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
                            className="flex min-h-8 max-md:min-h-14 w-full items-start gap-2.5 rounded-lg px-2 py-2.5 text-left hover:bg-accent"
                          >
                            {m.actorName ? (
                              <span className="mt-0.5">
                                <Avatar id={m.actorUserId} name={m.actorName} size={28} />
                              </span>
                            ) : (
                              <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                                {isRoom ? (
                                  <MessageSquare className="size-4" />
                                ) : (
                                  <AtSign className="size-4" />
                                )}
                              </span>
                            )}
                            <span className="min-w-0 flex-1">
                              <span className="block line-clamp-2 text-sm text-foreground">
                                {label}
                                {!isRoom ? (
                                  <span className="text-muted-foreground">
                                    {" "}
                                    · {m.pageTitle || t.inboxTitle}
                                  </span>
                                ) : null}
                              </span>
                              {m.preview ? (
                                <span className="block line-clamp-2 text-xs leading-5 text-muted-foreground">
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
      </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
    </>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="px-2 pt-2 text-xs font-medium text-muted-foreground">
      {children}
    </h3>
  );
}
