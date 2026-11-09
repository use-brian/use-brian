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
 * the re-send because the browser-realm seed registry already has the id — so
 * a naive remount did NEITHER and stranded the thread on "No comments yet".
 *
 * The fix: the body resolves its seed to `null` when the browser-realm registry
 * already claims `thread.id` at mount, so an already-seeded thread is treated as seedless and
 * its mount fetch loads the persisted comments. This test mounts the SAME thread
 * twice (the post, then the navigate-back remount) against the same realm-wide
 * registry and asserts the second mount fetches + renders the comment.
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
import { authFetch } from "@/lib/auth-fetch";

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
// the thread id in the realm-wide seed registry).
vi.mock("@/lib/auth-fetch", () => ({
  authFetch: vi.fn(() =>
    Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
  ),
}));

vi.mock("@/lib/offline/application-write-authority", () => ({
  currentOfflineWriteAuthority: () => ({ apiOrigin: "https://api.example", viewerId: "u1", workspaceId: "ws1" }),
}));

import {
  CommentThreadBody,
  claimCommentSeed,
  hasClaimedCommentSeed,
  hasPersistedInterruptedComment,
  type CommentSeed,
} from "../comment-thread-body";

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

function body(withSeed: boolean, overrides: Partial<CommentThread> = {}) {
  return (
    <I18nProvider locale="en" dict={dict}>
      <CommentThreadBody
        thread={{ ...thread, ...overrides }}
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
    expect(dict.comments.replyFailed).toBeTypeOf("string");
    expect(dict.comments.replyAccessUnavailable).toBeTypeOf("string");
    expect(dict.comments.replyPageUnavailable).toBeTypeOf("string");
    expect(dict.comments.sendUnconfirmed).toBeTypeOf("string");
    mockFetchMessages.mockReset().mockResolvedValue(persisted);
    vi.mocked(authFetch).mockReset().mockRejectedValue(new TypeError("Connection interrupted"));
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

  it.each(["delivery_audience_unverified", "authority_changed", "unknown"])(
    "keeps an explicit %s failure visible after reconciling a saved comment", async code => {
      vi.mocked(authFetch).mockImplementation(async url => {
        if (!String(url).endsWith("/api/chat")) return { ok: false, json: async () => ({}) } as Response;
        return { ok: true, body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`event: error\ndata: ${JSON.stringify({ code, error: "INTERNAL DETAIL MUST NOT APPEAR" })}\n\n`));
            controller.close();
          },
        }) } as Response;
      });
      const id = `terminal_${code}`;
      await mount(body(true, { id }));
      const alert = container!.querySelector('[role="alert"]');
      expect(alert?.textContent).toBe(code === "unknown" ? dict.comments.replyFailed : dict.comments.replyAccessUnavailable);
      expect(container!.textContent).toContain(persisted[0].content);
      expect(container!.textContent).not.toContain("INTERNAL DETAIL");
      expect(container!.textContent).not.toContain(dict.comments.streamingReply);
      expect(hasClaimedCommentSeed(id)).toBe(true);
      expect(vi.mocked(authFetch).mock.calls.filter(([url]) => String(url).endsWith("/api/chat"))).toHaveLength(1);
    },
  );

  it("retains an unsent reply through thread history loading and a process remount", async () => {
    const key = "brian:unsent:v1:" + ["https://api.example", "u1", "ws1", `thread:${thread.id}`].map(encodeURIComponent).join(":");
    localStorage.setItem(key, "Unsent offline reply");
    await mount(body(false));
    expect(container!.querySelector("textarea")?.value).toBe("Unsent offline reply");
    act(() => root!.unmount()); container!.remove(); root = null;
    await mount(body(false));
    expect(container!.querySelector("textarea")?.value).toBe("Unsent offline reply");
    expect(localStorage.getItem(key)).toBe("Unsent offline reply"); localStorage.removeItem(key);
  });

  it("keeps an acknowledged comment and terminal failure when history cannot be read", async () => {
    mockFetchMessages.mockRejectedValue(new Error("History unavailable"));
    vi.mocked(authFetch).mockImplementation(async url => {
      if (!String(url).endsWith("/api/chat")) throw new TypeError("Connection interrupted");
      return { ok:true,body:new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode('event: user_message_saved\ndata: {"id":"saved-comment"}\n\nevent: error\ndata: {"code":"page_context_unavailable"}\n\n'));
        controller.close();
      } }) } as Response;
    });
    await mount(body(true, { id:"acknowledged_failed_history" }));
    expect(container!.querySelector('[role="alert"]')?.textContent).toBe(dict.comments.replyPageUnavailable);
    expect(container!.textContent).toContain(seed.message);
    expect(vi.mocked(authFetch).mock.calls.filter(([url]) => String(url).endsWith("/api/chat"))).toHaveLength(1);
  });

  it("shows an unavailable history as a load failure", async () => {
    mockFetchMessages.mockRejectedValue(new Error("History unavailable"));
    await mount(body(false, { id:"unreadable_history" }));
    expect(container!.querySelector('[role="alert"]')?.textContent).toBe(dict.comments.loadError);
    expect(container!.textContent).not.toContain(dict.comments.emptyThread);
  });

  it("shows a persisted failed turn when the thread is reopened", async () => {
    await mount(body(false, { id: "reopened_failure", sessionStatus: "failed" }));
    expect(container!.querySelector('[role="alert"]')?.textContent).toBe(dict.comments.replyFailed);
    expect(container!.textContent).toContain(persisted[0].content);
    expect(vi.mocked(authFetch).mock.calls.some(([url]) => String(url).endsWith("/api/chat"))).toBe(false);
  });

  it("a remount with a stale already-sent seed fetches the persisted comment instead of 'No comments yet'", async () => {
    // ── Mount 1: the post. The seed is brand-new, so the body auto-sends it
    //    (registering the thread id in the browser-realm seed claims) and
    //    skips the mount fetch — the optimistic row carries the comment.
    await mount(body(true));
    // The send path skips the MOUNT fetch. Our mocked `/api/chat` rejection is
    // an ambiguous send, so the recovery path performs one canonical fetch and
    // finds the persisted row without surfacing the misleading load error.
    expect(mockFetchMessages).toHaveBeenCalledTimes(1);
    expect(container!.textContent).not.toContain(dict.comments.loadError);
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
    expect(mockFetchMessages).toHaveBeenCalledTimes(2);
    const text = container!.textContent ?? "";
    expect(text).toContain("Help me to format current page properties");
    expect(text).not.toContain(dict.comments.emptyThread);
    // Reopening an AI-backed thread must not opt the next manual reply into AI.
    expect(container!.querySelector(`[aria-label="${dict.comments.aiReply}"]`)?.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("[COMP:app-web/comment-thread-body] interrupted seed idempotency", () => {
  it("claims a seed once in the browser-realm registry", () => {
    const id = "th_realm_claim";
    expect(hasClaimedCommentSeed(id)).toBe(false);
    expect(claimCommentSeed(id)).toBe(true);
    expect(hasClaimedCommentSeed(id)).toBe(true);
    expect(claimCommentSeed(id)).toBe(false);
  });

  it("reconciles only a new persisted user row with the exact optimistic body", () => {
    const older = { ...persisted[0], id: "old-same-body" };
    const newer = { ...persisted[0], id: "new-same-body" };
    const known = new Set([older.id]);

    expect(
      hasPersistedInterruptedComment([older], known, seed.message),
    ).toBe(false);
    expect(
      hasPersistedInterruptedComment([older, newer], known, seed.message),
    ).toBe(true);
    expect(
      hasPersistedInterruptedComment(
        [{ ...newer, content: "A different reply" }],
        known,
        seed.message,
      ),
    ).toBe(false);
  });
});
