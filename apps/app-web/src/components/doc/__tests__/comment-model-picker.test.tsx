// @vitest-environment jsdom
/**
 * Regression guard for the page-comment model-picker bug: on a COLLAPSED running
 * page thread, clicking the `standard | pro | max` tier picker flickered the
 * thread open and then failed to switch the model.
 *
 * Two interacting causes, one per describe below:
 *
 *   1. [COMP:app-web/comment-thread-body] — the composer footer expanded the
 *      collapsed inline thread on ANY focus inside it (`onFocusCapture`), so
 *      focusing the picker trigger re-rendered the thread above mid-click and
 *      tore the just-opened base-ui Select popup down before the tier committed.
 *      The fix scopes the expand to the reply textarea only.
 *   2. [COMP:app-web/page-comments] — the band's outside-click collapse handler
 *      treated a click on the picker's `<body>`-portaled popup as "outside" the
 *      thread card and collapsed it (the same re-render killing the pick). The
 *      fix excludes the base-ui Select popup (`[data-slot="select-content"]`),
 *      alongside the already-excluded mention popup.
 *
 * Driven for real in jsdom (`createRoot` + `act`, no `@testing-library/react`),
 * matching `page-comments.test.tsx` / `comment-thread-body-seed.test.tsx`.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import type { CommentThread } from "@/lib/api/comments";
import type { DocSessionMessage } from "@/lib/api/sessions";

// Override only fetchSessionMessages so the running thread renders against the
// real content-flattening; keep the rest of the sessions module intact.
const { mockFetchMessages } = vi.hoisted(() => ({ mockFetchMessages: vi.fn() }));
vi.mock("@/lib/api/sessions", async (orig) => ({
  ...(await orig<typeof import("@/lib/api/sessions")>()),
  fetchSessionMessages: mockFetchMessages,
}));
// authFetch backs useComposerControls' model-tier probe; a not-ok response keeps
// the tier at the default (`standard`) and touches no network.
vi.mock("@/lib/auth-fetch", () => ({
  authFetch: vi.fn(() =>
    Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
  ),
}));

import { CommentThreadBody } from "../comment-thread-body";
import { PageComments } from "../page-comments";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dict = en as unknown as Dictionary;

const thread: CommentThread = {
  id: "th_band",
  pageId: "p1",
  workspaceId: "ws1",
  sessionId: "s_band",
  anchorKind: "human_range",
  anchorBlockId: null,
  quote: null,
  resolvedAt: null,
  resolvedBy: null,
  createdBy: "u1",
  createdAt: "2026-06-01T00:00:00.000Z",
};

// Three messages so the collapsed preview (first + "Show 1 reply" + last) HIDES
// the middle one — its text is the collapsed/expanded signal.
const MIDDLE = "Middle assistant reply only the expanded thread shows";
const messages: DocSessionMessage[] = [
  { id: "m1", role: "user", content: "First human message", timestamp: "2026-06-01T00:00:00.000Z", senderUserId: "u1", senderName: "Ada" },
  { id: "m2", role: "assistant", content: MIDDLE, timestamp: "2026-06-01T00:01:00.000Z", senderUserId: null, senderName: null },
  { id: "m3", role: "user", content: "Last human message", timestamp: "2026-06-01T00:02:00.000Z", senderUserId: "u1", senderName: "Ada" },
];

const noop = () => {};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mount(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<I18nProvider locale="en" dict={dict}>{node}</I18nProvider>));
  await act(async () => {});
}

beforeEach(() => {
  mockFetchMessages.mockReset().mockResolvedValue(messages);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("[COMP:app-web/comment-thread-body] collapsed inline thread expands on textarea focus only", () => {
  it("focusing the model-tier picker does NOT expand, but focusing the reply textarea does", async () => {
    const onExpand = vi.fn();
    await mount(
      <CommentThreadBody
        thread={thread}
        pageId="p1"
        workspaceId="ws1"
        assistantId="a1"
        currentUser={{ id: "u1", name: "Ada" }}
        assistant={{ id: "a1", name: "Doc", iconSeed: 7 }}
        onChanged={noop}
        onResolved={noop}
        onExpand={onExpand}
        inline
        collapsed
      />,
    );

    const trigger = container!.querySelector<HTMLElement>('[data-slot="select-trigger"]');
    const textarea = container!.querySelector<HTMLTextAreaElement>("textarea");
    expect(trigger).toBeTruthy();
    expect(textarea).toBeTruthy();

    // Focus the picker trigger — this used to expand the thread (the flicker) and
    // kill the dropdown. It must be a no-op now.
    act(() => {
      trigger!.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    expect(onExpand).not.toHaveBeenCalled();

    // Focusing the reply textarea still opens the discussion (Notion behavior).
    act(() => {
      textarea!.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    expect(onExpand).toHaveBeenCalledTimes(1);
  });
});

describe("[COMP:app-web/page-comments] model-picker popup click keeps the running thread open", () => {
  // Expand the collapsed running thread by clicking its preview (the whole
  // preview is one button wired to onExpand), then flush the band's deferred
  // outside-click listener (installed via setTimeout(0) once expanded).
  async function expandRunningThread() {
    const preview = [...container!.querySelectorAll("button")].find((b) =>
      b.textContent?.includes(dict.comments.showRepliesOne),
    );
    expect(preview).toBeTruthy();
    await act(async () => {
      preview!.click();
    });
    // Let the expanded-state effect's setTimeout(0) attach the document listener.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }

  function band() {
    return (
      <PageComments
        pageId="p1"
        workspaceId="ws1"
        assistantId="a1"
        currentUser={{ id: "u1", name: "Ada" }}
        assistant={{ id: "a1", name: "Doc", iconSeed: 7 }}
        threads={[thread]}
        onPick={noop}
        onSubmitted={noop}
      />
    );
  }

  it("a click inside the portaled model-tier popup does not collapse the thread", async () => {
    await mount(band());
    // Collapsed at rest: the middle message is hidden.
    expect(container!.textContent).not.toContain(MIDDLE);
    await expandRunningThread();
    expect(container!.textContent).toContain(MIDDLE);

    // The base-ui Select popup portals to <body> (data-slot="select-content"),
    // and the real mousedown target is a CHILD label span of a role=option row,
    // not the popup div itself — exercise that nesting through the shared
    // `isInsideComposerPopup` seam. It's technically outside the thread card but
    // must NOT collapse the running thread.
    const popup = document.createElement("div");
    popup.setAttribute("data-slot", "select-content");
    const item = document.createElement("div");
    item.setAttribute("role", "option");
    const label = document.createElement("span");
    label.textContent = "Pro";
    item.appendChild(label);
    popup.appendChild(item);
    document.body.appendChild(popup);
    await act(async () => {
      label.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(container!.textContent).toContain(MIDDLE); // still expanded
    popup.remove();
  });

  it("a genuine outside click still collapses the thread (handler is live)", async () => {
    await mount(band());
    await expandRunningThread();
    expect(container!.textContent).toContain(MIDDLE);

    // A plain element outside the card + outside any popup collapses as before —
    // proving the exclusion above is scoped, not a blanket disable.
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    await act(async () => {
      outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(container!.textContent).not.toContain(MIDDLE); // collapsed again
    outside.remove();
  });
});
