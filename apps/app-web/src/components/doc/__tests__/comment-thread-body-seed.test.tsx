// @vitest-environment jsdom
/**
 * [COMP:app-web/comment-thread-body] Seed is a one-shot across navigation.
 *
 * Regression guard for the "post a page comment → navigate away → come back →
 * the running thread shows 'No comments yet' while the count badge reads 1" bug.
 *
 * Root cause: `CollabPageEditor` + `PageComments` mount with no React key, so
 * they persist across page navigation, and `PageComments` only clears its `seed`
 * on resolve. After navigating back, the band re-passes the STALE seed to the
 * freshly remounted `<CommentThreadBody>`. The body skips its mount fetch while a
 * seed is present (so the empty fetch can't clobber the optimistic row) and skips
 * the re-send because the module-level `sentSeedThreadIds` already has the id — so
 * a naive remount did NEITHER and stranded the thread on "No comments yet".
 *
 * The fix: the body resolves its seed to `null` when `sentSeedThreadIds.has(
 * thread.id)` at mount, so an already-seeded thread is treated as seedless and
 * its mount fetch loads the persisted comments. This test mounts the SAME thread
 * twice (the post, then the navigate-back remount) against the same module-level
 * set and asserts the second mount fetches + renders the comment.
 *
 * Driven for real in jsdom (`createRoot` + `act`, no `@testing-library/react`),
 * matching `page-comments.test.tsx`.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import type { CommentThread } from "@/lib/api/comments";
import type { DocSessionMessage } from "@/lib/api/sessions";

// Override only fetchSessionMessages — keep the real extractMessageText /
// parseMessageAttachments / stripCommentThreadReplyTag so visibleComments runs
// against the real content-flattening (the seam this bug rendered empty).
const { mockFetchMessages } = vi.hoisted(() => ({ mockFetchMessages: vi.fn() }));
vi.mock("@/lib/api/sessions", async (orig) => ({
  ...(await orig<typeof import("@/lib/api/sessions")>()),
  fetchSessionMessages: mockFetchMessages,
}));
// authFetch backs both useComposerControls' model-tier probe (stays default on a
// not-ok response) AND the first mount's seed `/api/chat` send (throws before the
// stream reader, which is fine — all we need from mount 1 is that it registers
// the thread id in `sentSeedThreadIds`).
vi.mock("@/lib/auth-fetch", () => ({
  authFetch: vi.fn(() =>
    Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
  ),
}));

import { CommentThreadBody, type CommentSeed } from "../comment-thread-body";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dict = en as unknown as Dictionary;

// A page-level (unanchored) running thread, the band's case.
const thread: CommentThread = {
  id: "th_nav",
  pageId: "p1",
  workspaceId: "ws1",
  sessionId: "s_nav",
  anchorKind: "human_range",
  anchorBlockId: null,
  quote: null,
  resolvedAt: null,
  resolvedBy: null,
  createdBy: "u1",
  createdAt: "2026-06-01T00:00:00.000Z",
};

const seed: CommentSeed = {
  message: "Help me to format current page properties",
  fileIds: [],
  model: "standard",
  researchMode: false,
  aiReply: true,
};

const persisted: DocSessionMessage[] = [
  {
    id: "m1",
    role: "user",
    content: "Help me to format current page properties",
    timestamp: "2026-06-01T00:00:00.000Z",
    senderUserId: "u1",
    senderName: "Ada",
  },
];

const noop = () => {};

function body(withSeed: boolean) {
  return (
    <I18nProvider locale="en" dict={dict}>
      <CommentThreadBody
        thread={thread}
        pageId="p1"
        workspaceId="ws1"
        assistantId="a1"
        currentUser={{ id: "u1", name: "Ada" }}
        assistant={{ id: "a1", name: "Doc", iconSeed: 7 }}
        seed={withSeed ? seed : undefined}
        onChanged={noop}
        onResolved={noop}
        inline
        collapsed={false}
      />
    </I18nProvider>
  );
}

describe("[COMP:app-web/comment-thread-body] seed one-shot across navigation", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    mockFetchMessages.mockReset().mockResolvedValue(persisted);
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    container?.remove();
    container = null;
  });

  async function mount(node: React.ReactNode) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(node));
    await act(async () => {});
  }

  it("a remount with a stale already-sent seed fetches the persisted comment instead of 'No comments yet'", async () => {
    // ── Mount 1: the post. The seed is brand-new, so the body auto-sends it
    //    (registering the thread id in the module-level sentSeedThreadIds) and
    //    skips the mount fetch — the optimistic row carries the comment.
    await mount(body(true));
    // The send path skips the mount fetch (seed present), so no fetch yet.
    expect(mockFetchMessages).not.toHaveBeenCalled();
    // Simulate navigating to another page: the running-thread body unmounts.
    act(() => root!.unmount());
    container!.remove();

    // ── Mount 2: navigate back. PageComments still holds the stale seed and
    //    re-passes it, but the thread's seed was already sent. The body must
    //    treat it as seedless and FETCH the persisted comments.
    await mount(body(true));

    expect(mockFetchMessages).toHaveBeenCalledWith(
      thread.sessionId,
      expect.anything(),
    );
    const text = container!.textContent ?? "";
    expect(text).toContain("Help me to format current page properties");
    expect(text).not.toContain(dict.comments.emptyThread);
  });
});
