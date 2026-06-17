// @vitest-environment jsdom
/**
 * [COMP:app-web/comment-thread-list] Page-level comment index button.
 *
 * The behaviour under test is the **visibility gate**: a page with no comments
 * at all shows no comment glyph (a bare icon on every fresh page is noise), but
 * the button must still appear when there are open threads (immediately, via
 * the editor's `hasOpenThreads` hint) or only resolved threads (after the
 * component's own resolved-inclusive fetch lands). Driven in jsdom — SSR
 * (`renderToString`) for the hint paths, `createRoot` + `act` with
 * `listPageThreads` mocked for the fetch path.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import type { CommentThread } from "@/lib/api/comments";

// The component fetches its own resolved-inclusive thread list; mock it so the
// fetch path is deterministic and offline.
const { mockList } = vi.hoisted(() => ({ mockList: vi.fn() }));
vi.mock("@/lib/api/comments", () => ({ listPageThreads: mockList }));

import { CommentThreadList, commentThreadLabel } from "../comment-thread-list";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dict = en as unknown as Dictionary;

function wrap(node: React.ReactNode): string {
  return renderToString(<I18nProvider locale="en" dict={dict}>{node}</I18nProvider>);
}

const noop = () => {};
const thread = (over: Partial<CommentThread> = {}): CommentThread => ({
  id: "t1",
  pageId: "p1",
  workspaceId: "ws1",
  sessionId: "s1",
  anchorKind: "human_range",
  anchorBlockId: null,
  quote: null,
  title: null,
  resolvedAt: null,
  resolvedBy: null,
  createdBy: "u1",
  createdAt: "2026-05-31T00:00:00.000Z",
  ...over,
});

describe("[COMP:app-web/comment-thread-list] row label precedence", () => {
  const FALLBACK = en.comments.popoverTitle;

  it("prefers the anchor quote when the thread has one", () => {
    expect(
      commentThreadLabel(thread({ quote: "Q3 revenue grew 14%", title: "is this right" }), FALLBACK),
    ).toBe("Q3 revenue grew 14%");
  });

  it("falls back to the first-comment title for a quote-less (page-level) thread", () => {
    expect(
      commentThreadLabel(thread({ quote: null, title: "Group by owner instead" }), FALLBACK),
    ).toBe("Group by owner instead");
  });

  it("ignores a whitespace-only quote", () => {
    expect(commentThreadLabel(thread({ quote: "   ", title: "real title" }), FALLBACK)).toBe(
      "real title",
    );
  });

  it("uses the generic fallback when neither quote nor title is set", () => {
    expect(commentThreadLabel(thread({ quote: null, title: null }), FALLBACK)).toBe(FALLBACK);
  });
});

describe("[COMP:app-web/comment-thread-list] visibility gate (static)", () => {
  beforeEach(() => mockList.mockReset().mockResolvedValue([]));

  it("renders nothing on a page with no comments", () => {
    // No open threads reported, nothing fetched yet (refreshKey 0 → no fetch).
    const html = wrap(
      <CommentThreadList
        pageId="p1"
        liveAnchorIds={new Set()}
        onPick={noop}
        refreshKey={0}
        hasOpenThreads={false}
      />,
    );
    expect(html).toBe("");
  });

  it("shows the comment button immediately when the editor reports open threads", () => {
    const html = wrap(
      <CommentThreadList
        pageId="p1"
        liveAnchorIds={new Set()}
        onPick={noop}
        refreshKey={0}
        hasOpenThreads
      />,
    );
    // Trigger carries the comment-count aria-label (count 0, nothing fetched)
    // + the glyph.
    expect(html).toMatch(/aria-label="0 comments?"/);
    expect(html).toContain("<svg");
  });
});

describe("[COMP:app-web/comment-thread-list] visibility gate (fetch path)", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    mockList.mockReset();
  });
  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    container?.remove();
    container = null;
  });

  function mount(node: React.ReactNode) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(<I18nProvider locale="en" dict={dict}>{node}</I18nProvider>));
  }

  it("reveals the button for a resolved-only page once its own fetch lands", async () => {
    // Editor reports no OPEN threads, but the resolved-inclusive fetch finds one.
    mockList.mockResolvedValue([thread({ resolvedAt: "2026-05-31T01:00:00.000Z" })]);
    mount(
      <CommentThreadList
        pageId="p1"
        liveAnchorIds={new Set()}
        onPick={noop}
        refreshKey={1}
        hasOpenThreads={false}
      />,
    );
    // Effect fetch (refreshKey !== 0) resolves → threads populated → button shows.
    await act(async () => {});
    expect(container!.querySelector("button[aria-label]")).toBeTruthy();
  });

  it("stays hidden when even the resolved-inclusive fetch is empty", async () => {
    mockList.mockResolvedValue([]);
    mount(
      <CommentThreadList
        pageId="p1"
        liveAnchorIds={new Set()}
        onPick={noop}
        refreshKey={1}
        hasOpenThreads={false}
      />,
    );
    await act(async () => {});
    expect(container!.querySelector("button[aria-label]")).toBeNull();
  });
});
