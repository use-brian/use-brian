// @vitest-environment jsdom
/**
 * [COMP:app-web/inbox-panel] The Inbox flyout on the surface cache
 * (instant-navigation contract N1 / N3 / N4, report E "Inbox (flyout)" row).
 *
 * Before: `fetchInbox` on every open and three pulsing rows each time. Now an
 * open paints the cached rows with the revalidation still pending, a spine
 * mark-stale (`inbox:<wid>`) repaints without a blank frame, the panel costs
 * no request before its first open, and opening a row drops it from the
 * cached payload so the slide-out and the next open never show it again.
 */

import { act, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxPayload } from "@/lib/api/inbox";
import {
  loadSurfaceCache,
  markSurfaceCacheStale,
  readSurfaceCache,
  resetSurfaceCache,
} from "@/lib/surface-cache";
import { inboxCacheKey } from "@/lib/surface-prefetch";
import { en } from "@/lib/i18n/dictionaries/en";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

vi.mock("@/lib/user", () => ({
  getUserInfo: () => ({ id: "u1", name: "n", email: "e" }),
}));
vi.mock("@/lib/i18n/client", () => ({ useT: () => en }));

const fetchInbox = vi.fn<(workspaceId: string) => Promise<InboxPayload>>();
const markInboxRead = vi.fn(async () => {});
const dismissInboxReply = vi.fn(async () => {});
vi.mock("@/lib/api/inbox", () => ({
  fetchInbox: (...a: [string]) => fetchInbox(...a),
  markInboxRead: (...a: unknown[]) => markInboxRead(...(a as [])),
  dismissInboxReply: (...a: unknown[]) => dismissInboxReply(...(a as [])),
}));

// The avatar and markdown preview pull the comment tree; the panel's contract
// here is which ROWS it paints and when.
vi.mock("@/components/doc/comment-thread-body", () => ({
  Avatar: ({ name }: { name: string }) => <span data-avatar>{name}</span>,
}));
vi.mock("@/components/doc/preview-markdown", () => ({
  PreviewMarkdown: ({ text }: { text: string }) => <span>{text}</span>,
}));

import { InboxPanel } from "../inbox-panel";

function payload(overrides: Partial<InboxPayload> = {}): InboxPayload {
  return {
    pending: [
      {
        threadId: "thread-1",
        pageId: "page-1",
        pageTitle: "Pricing doc",
        quote: "Can we ship this?",
      } as unknown as InboxPayload["pending"][number],
    ],
    mentions: [
      {
        kind: "mention",
        id: "mention-1",
        pageId: "page-2",
        pageTitle: "Roadmap",
        actorUserId: "user-2",
        actorName: "Sam",
        preview: "please look",
        createdAt: "2026-09-01T00:00:00.000Z",
        readAt: null,
      } as unknown as InboxPayload["mentions"][number],
    ],
    pendingCount: 1,
    unreadMentionCount: 1,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

let root: Root | null = null;
let container: HTMLDivElement;
const onOpenPage = vi.fn();
const onOpenRoom = vi.fn();
const onClose = vi.fn();

function panel(open: boolean) {
  return (
    <InboxPanel
      open={open}
      workspaceId="w1"
      sidebarCollapsed={false}
      onClose={onClose}
      onOpenPage={onOpenPage}
      onOpenRoom={onOpenRoom}
    />
  );
}

async function renderNode(node: React.ReactNode) {
  if (!root) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () => {
    root!.render(node);
  });
}

async function render(open: boolean) { await renderNode(panel(open)); }

const skeleton = () => container.querySelector("[data-inbox-skeleton]");

beforeEach(() => {
  resetSurfaceCache();
  fetchInbox.mockReset();
  onOpenPage.mockReset();
  onOpenRoom.mockReset();
  onClose.mockReset();
  markInboxRead.mockClear();
  dismissInboxReply.mockClear();
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  container?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("[COMP:app-web/inbox-panel] Inbox flyout on the surface cache", () => {
  it("paints the cached rows on open with the revalidation still pending (no skeleton)", async () => {
    await loadSurfaceCache(inboxCacheKey("w1"), async () => payload());
    fetchInbox.mockReturnValue(new Promise(() => {}));
    await render(true);
    expect(container.textContent).toContain("Pricing doc");
    expect(container.textContent).toContain("Roadmap");
    expect(skeleton()).toBeNull();
    // An open always revalidates behind the paint.
    expect(fetchInbox).toHaveBeenCalledTimes(1);
  });

  it("a spine mark-stale (`inbox:<wid>`) repaints without a blank frame, then adopts the new payload", async () => {
    await loadSurfaceCache(inboxCacheKey("w1"), async () => payload());
    const first = deferred<InboxPayload>();
    fetchInbox.mockReturnValueOnce(first.promise);
    await render(true);
    await act(async () => {
      first.resolve(payload());
      await settle();
    });

    const next = deferred<InboxPayload>();
    fetchInbox.mockReturnValueOnce(next.promise);
    await act(async () => {
      markSurfaceCacheStale("inbox:w1");
      await settle();
    });
    expect(fetchInbox).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Pricing doc");
    expect(skeleton()).toBeNull();

    await act(async () => {
      next.resolve(
        payload({
          pending: [],
          pendingCount: 0,
          mentions: [
            {
              kind: "mention",
              id: "mention-2",
              pageId: "page-3",
              pageTitle: "Launch plan",
              actorUserId: "user-3",
              actorName: "Ada",
              preview: null,
              createdAt: "2026-09-02T00:00:00.000Z",
              readAt: null,
            } as unknown as InboxPayload["mentions"][number],
          ],
        }),
      );
      await settle();
    });
    expect(container.textContent).not.toContain("Pricing doc");
    expect(container.textContent).toContain("Launch plan");
  });

  it("costs no request before its first open, one on open, and paints a skeleton only when cold", async () => {
    const first = deferred<InboxPayload>();
    fetchInbox.mockReturnValue(first.promise);
    await render(false);
    expect(fetchInbox).not.toHaveBeenCalled();

    await render(true);
    expect(fetchInbox).toHaveBeenCalledTimes(1);
    expect(skeleton()).not.toBeNull();

    await act(async () => {
      first.resolve(payload());
      await settle();
    });
    expect(skeleton()).toBeNull();
    expect(container.textContent).toContain("Pricing doc");
  });

  it("opening a row drops it from the cached payload, so the slide-out and the next open never show it", async () => {
    await loadSurfaceCache(inboxCacheKey("w1"), async () => payload());
    fetchInbox.mockReturnValue(new Promise(() => {}));
    await render(true);
    const row = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Pricing doc"),
    );
    expect(row).toBeTruthy();
    await act(async () => {
      row!.click();
      await settle();
    });
    expect(onOpenPage).toHaveBeenCalledWith("page-1");
    expect(dismissInboxReply).toHaveBeenCalledWith("w1", "thread-1");
    expect(container.textContent).not.toContain("Pricing doc");
    const cached = readSurfaceCache<InboxPayload>(inboxCacheKey("w1")).data;
    expect(cached?.pending).toEqual([]);
    expect(cached?.pendingCount).toBe(0);
  });

  it("shows a true empty state without marking or dismissing any items on open", async () => {
    await loadSurfaceCache(inboxCacheKey("w1"), async () => payload({ pending: [], mentions: [], pendingCount: 0, unreadMentionCount: 0 }));
    fetchInbox.mockReturnValue(new Promise(() => {}));
    await render(true);
    expect(container.querySelector('[role=dialog]')?.getAttribute('aria-labelledby')).toBeTruthy();
    expect(container.querySelector('[data-inbox-empty]')?.textContent).toContain(en.docPage.inboxEmptyTitle);
    expect(markInboxRead).not.toHaveBeenCalled();
    expect(dismissInboxReply).not.toHaveBeenCalled();
  });

  it("shows a cold error instead of claiming an unavailable Inbox is empty", async () => {
    fetchInbox.mockRejectedValue(new Error('Unavailable'));
    await render(true);
    await act(async () => { await settle(); });
    expect(container.querySelector('[role=alert]')?.textContent).toBe(en.docPage.inboxError);
    expect(container.querySelector('[data-inbox-empty]')).toBeNull();
    expect(markInboxRead).not.toHaveBeenCalled();
  });

  it("opens a page mention and clears only that notification", async () => {
    await loadSurfaceCache(inboxCacheKey("w1"), async () => payload());
    fetchInbox.mockReturnValue(new Promise(() => {}));
    await render(true);
    const row = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Roadmap'))!;
    await act(async () => { row.click(); await settle(); });
    expect(onOpenPage).toHaveBeenCalledExactlyOnceWith('page-2');
    expect(markInboxRead).toHaveBeenCalledExactlyOnceWith('w1', ['mention-1']);
    expect(readSurfaceCache<InboxPayload>(inboxCacheKey('w1')).data?.pending).toHaveLength(1);
    expect(readSurfaceCache<InboxPayload>(inboxCacheKey('w1')).data?.mentions).toEqual([]);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("names and opens a room mention through the room callback and clears its unread cache", async () => {
    const room = { kind: 'room_mention', id: 'mention-room', sessionId: 'room-a', sessionMessageId: 'message-a', roomTitle: 'Planning room', actorUserId: 'member-two', actorName: 'A teammate', preview: 'Review the draft.', createdAt: '2026-10-01T00:00:00Z', readAt: null } as InboxPayload['mentions'][number];
    await loadSurfaceCache(inboxCacheKey('w1'), async () => payload({ pending: [], pendingCount: 0, mentions: [room] }));
    fetchInbox.mockReturnValue(new Promise(() => {}));
    await render(true);
    const row = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Planning room'))!;
    expect(row.textContent).toContain(en.docPage.inboxMentionByActorInRoom.replace('{actor}', 'A teammate').replace('{room}', 'Planning room'));
    await act(async () => { row.click(); await settle(); });
    expect(onOpenRoom).toHaveBeenCalledExactlyOnceWith('room-a');
    expect(onOpenPage).not.toHaveBeenCalled();
    expect(markInboxRead).toHaveBeenCalledExactlyOnceWith('w1', ['mention-room']);
    expect(readSurfaceCache<InboxPayload>(inboxCacheKey('w1')).data?.unreadMentionCount).toBe(0);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each([false, true])("dismisses via Escape and restores a visible focus target (phone=%s)", async (phone) => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: phone && query.includes('max-width'), media: query, addEventListener() {}, removeEventListener() {} }));
    await loadSurfaceCache(inboxCacheKey('w1'), async () => payload({ pending: [], mentions: [] }));
    fetchInbox.mockReturnValue(new Promise(() => {}));
    function Host() {
      const [open, setOpen] = useState(false), [drawer, setDrawer] = useState(true);
      return <><button data-inbox-trigger aria-expanded={open} style={{ visibility: phone && !drawer ? 'hidden' : 'visible' }} onClick={() => { setDrawer(false); setOpen(true); }}>Open Inbox</button><button data-doc-mobile-menu>Navigation</button><InboxPanel open={open} workspaceId="w1" sidebarCollapsed={false} onClose={() => { onClose(); setOpen(false); }} onOpenPage={onOpenPage} onOpenRoom={onOpenRoom} /></>;
    }
    // The real shell owns a closed file-import Dialog around its children.
    await renderNode(<Dialog.Root open={false}><Host /></Dialog.Root>);
    const trigger = container.querySelector<HTMLButtonElement>('[data-inbox-trigger]')!, navigation = container.querySelector<HTMLButtonElement>('[data-doc-mobile-menu]')!;
    for (const button of [trigger, navigation]) button.getClientRects = () => [new DOMRect(0, 0, 44, 44)] as unknown as DOMRectList;
    trigger.focus();
    await act(async () => { trigger.click(); await settle(); });
    const close = container.querySelector<HTMLButtonElement>(`[aria-label="${en.docPage.inboxCloseAria}"]`)!;
    await vi.waitFor(() => expect(document.activeElement).toBe(close));
    expect(container.querySelector('[data-inbox-backdrop]')).not.toBeNull();
    expect(container.querySelector('[data-inbox-panel]')?.getAttribute('aria-modal')).toBe(phone ? 'true' : null);
    await act(async () => { close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle(); });
    expect(onClose).toHaveBeenCalledOnce();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await vi.waitFor(() => expect(document.activeElement).toBe(phone ? navigation : trigger));
    if (!phone) {
      await act(async () => { trigger.click(); await settle(); });
      await vi.waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe(en.docPage.inboxCloseAria));
      const closeAgain = container.querySelector<HTMLButtonElement>(`[aria-label="${en.docPage.inboxCloseAria}"]`)!;
      await act(async () => { navigation.focus(); await settle(); });
      // Nonmodal Inbox permits focus outside. A later controlled dismissal
      // must preserve that target rather than restoring over the user's choice.
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      await act(async () => { closeAgain.click(); await settle(); });
      await vi.waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'));
      expect(document.activeElement).toBe(navigation);
    }
  });

});
