// @vitest-environment jsdom
/**
 * [COMP:app-web/page-comments] Overall-comments band under the page title.
 *
 * Two surfaces under test:
 *   1. **Static markup** — the band's structure (starter composer presence,
 *      read-only collapse, the specific-comment nudge, the inline running
 *      thread). Asserted via `renderToString` (the SSR pass); effects don't run
 *      there, so the running thread renders its at-rest shell (the body + its
 *      reply composer) which is what we assert.
 *   2. **The post() contract** — posting the first page comment opens an empty
 *      unanchored thread, then HANDS THE FIRST MESSAGE OFF to that thread's body
 *      as a `seed` (`onSubmitted`) — the body owns the `/api/chat` turn, so the
 *      typed comment shows immediately (optimistic) and the reply streams in
 *      place, instead of the old fire-and-wait that left the band blank until the
 *      whole turn finished. Driven for real in jsdom (`createRoot` + `act`, no
 *      `@testing-library/react`) with the comments API mocked, so the regression
 *      guard is the call shape: `createCommentThread` seeds NO body, and the seed
 *      carries the composer's model tier + research flag.
 *
 * The band is now Notion's **one running thread**: an open unanchored thread
 * renders inline (`<CommentThreadBody inline>`), and the starter composer shows
 * only while none is open. Page-level threads never open the floating popover.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import type { CommentThread } from "@/lib/api/comments";

// The composer's post() calls createCommentThread then hands off via onSubmitted
// (a spy); mock the comments module so the test asserts the call shape without a
// network. vi.hoisted lets the factory reference the spy despite vi.mock being
// hoisted above the imports.
const { mockCreateThread } = vi.hoisted(() => ({ mockCreateThread: vi.fn() }));
vi.mock("@/lib/api/comments", () => ({ createCommentThread: mockCreateThread }));
// The composer carries <ComposerControls>, whose useComposerControls →
// useChatModelTier resolves the workspace plan via authFetch on mount; stub it
// to a not-ok response so the model tier stays the default (`standard`) and no
// network is touched.
vi.mock("@/lib/auth-fetch", () => ({
  authFetch: vi.fn(() =>
    Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
  ),
}));

import { PageComments } from "../page-comments";

// Tell React this is an act() environment so state flushes deterministically
// (matches toggle-collapse / area-select-noderview-ring).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dict = en as unknown as Dictionary;

function wrap(node: React.ReactNode): string {
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      {node}
    </I18nProvider>,
  );
}

const base: CommentThread = {
  id: "th_base",
  pageId: "p1",
  workspaceId: "ws1",
  sessionId: "s1",
  anchorKind: "human_range",
  anchorBlockId: null,
  quote: null,
  resolvedAt: null,
  resolvedBy: null,
  createdBy: "u1",
  createdAt: "2026-05-30T00:00:00.000Z",
};
const overall = (id: string): CommentThread => ({ ...base, id, sessionId: id });
const specific = (id: string): CommentThread => ({
  ...base,
  id,
  sessionId: id,
  anchorBlockId: `blk_${id}`,
});

const noop = () => {};

describe("[COMP:app-web/page-comments] overall comments band", () => {
  it("renders the composer when an assistant backs the page (can comment)", () => {
    const html = wrap(
      <PageComments
        pageId="p1"
        workspaceId="ws1"
        assistantId="a1"
        currentUser={{ id: "u1", name: "Ada" }}
        threads={[]}
        onPick={noop}
        onSubmitted={noop}
      />,
    );
    // The composer carries the page-scoped aria-label + the shared placeholder.
    expect(html).toMatch(/aria-label="Add a comment on this page"/);
    expect(html).toMatch(/placeholder="Add a comment/);
    // Section landmark is present so the band is discoverable.
    expect(html).toMatch(/aria-label="Page comments"/);
  });

  it("hides the composer and renders nothing when read-only with no threads", () => {
    // No assistantId → read-only; no threads of either kind → the whole band
    // collapses to null (no empty bordered section above the doc).
    const html = wrap(
      <PageComments
        pageId="p1"
        workspaceId="ws1"
        threads={[]}
        onPick={noop}
        onSubmitted={noop}
      />,
    );
    expect(html).toBe("");
  });

  it("surfaces the specific-comment nudge with a pluralized count", () => {
    const many = wrap(
      <PageComments
        pageId="p1"
        workspaceId="ws1"
        assistantId="a1"
        threads={[specific("a"), specific("b"), specific("c")]}
        onPick={noop}
        onSubmitted={noop}
      />,
    );
    expect(many).toMatch(/3 comments on specific text/);

    const one = wrap(
      <PageComments
        pageId="p1"
        workspaceId="ws1"
        assistantId="a1"
        threads={[specific("a")]}
        onPick={noop}
        onSubmitted={noop}
      />,
    );
    expect(one).toMatch(/1 comment on specific text/);
  });

  it("omits the nudge when no comments are anchored to specific text", () => {
    const html = wrap(
      <PageComments
        pageId="p1"
        workspaceId="ws1"
        assistantId="a1"
        threads={[overall("x")]}
        onPick={noop}
        onSubmitted={noop}
      />,
    );
    expect(html).not.toMatch(/on specific text/);
  });

  it("renders an open page thread inline as the running discussion, hiding the starter composer", () => {
    const html = wrap(
      <PageComments
        pageId="p1"
        workspaceId="ws1"
        assistantId="a1"
        currentUser={{ id: "u1", name: "Ada" }}
        threads={[overall("th_overall")]}
        onPick={noop}
        onSubmitted={noop}
      />,
    );
    // The running thread renders INLINE (its container carries the thread id) —
    // never a floating popover.
    expect(html).toMatch(/data-thread-id="th_overall"/);
    // It carries its own reply composer…
    expect(html).toMatch(/placeholder="Add a comment/);
    // …and the page-level starter composer is hidden: one running thread, one
    // composer (Notion).
    expect(html).not.toMatch(/aria-label="Add a comment on this page"/);
  });

  it("shows the starter composer (not a thread) when no page thread is open", () => {
    const html = wrap(
      <PageComments
        pageId="p1"
        workspaceId="ws1"
        assistantId="a1"
        threads={[specific("anchored")]}
        onPick={noop}
        onSubmitted={noop}
      />,
    );
    // Only an anchored (specific) thread is open → no running page thread, so the
    // starter composer is the way in.
    expect(html).toMatch(/aria-label="Add a comment on this page"/);
  });

  it("renders page threads even when read-only (composer absent)", () => {
    const html = wrap(
      <PageComments
        pageId="p1"
        workspaceId="ws1"
        threads={[specific("a")]}
        onPick={noop}
        onSubmitted={noop}
      />,
    );
    // Nudge shows…
    expect(html).toMatch(/1 comment on specific text/);
    // …but the composer does not (no assistant to back a new thread).
    expect(html).not.toMatch(/aria-label="Add a comment on this page"/);
  });
});

describe("[COMP:app-web/page-comments] posting hands the comment to the thread body", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  const newThread: CommentThread = {
    ...base,
    id: "th_new",
    sessionId: "s_new",
    createdAt: "2026-05-31T00:00:00.000Z",
  };

  beforeEach(() => {
    mockCreateThread.mockReset().mockResolvedValue(newThread);
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

  // Set a controlled <textarea>'s value the way React's onChange expects: the
  // native value setter + a bubbling `input` event (React listens on `input`).
  function typeInto(el: HTMLTextAreaElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("opens an empty thread and hands off the first message as a seed (model + research carried)", async () => {
    const onPick = vi.fn();
    const onSubmitted = vi.fn();
    mount(
      <PageComments
        pageId="p1"
        workspaceId="ws1"
        assistantId="a1"
        currentUser={{ id: "u1", name: "Ada" }}
        threads={[]}
        onPick={onPick}
        onSubmitted={onSubmitted}
      />,
    );

    const textarea = container!.querySelector<HTMLTextAreaElement>(
      '[aria-label="Add a comment on this page"]',
    )!;
    expect(textarea).toBeTruthy();
    act(() => typeInto(textarea, "make it shorter, in bullets"));

    // The send button is enabled once the draft is non-empty.
    const send = container!.querySelector<HTMLButtonElement>(
      `[aria-label="${dict.comments.send}"]`,
    )!;
    expect(send).toBeTruthy();
    expect(send.disabled).toBe(false);

    await act(async () => {
      send.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // post() awaits createCommentThread, then calls onSubmitted; flush once more.
    await act(async () => {});

    // The thread is opened WITHOUT a seeded body…
    expect(mockCreateThread).toHaveBeenCalledTimes(1);
    const createArg = mockCreateThread.mock.calls[0][0];
    expect(createArg).toMatchObject({ pageId: "p1", assistantId: "a1", workspaceId: "ws1" });
    expect(createArg.body).toBeUndefined();

    // …and the first message rides the seed into the new thread's body, which
    // owns the /api/chat turn. The seed carries the composer's model tier +
    // research flag (defaults: the persisted `standard` tier, research off) so a
    // page comment honours the same picker the floating chat does.
    expect(onSubmitted).toHaveBeenCalledTimes(1);
    const [submittedThread, seed] = onSubmitted.mock.calls[0];
    expect(submittedThread).toBe(newThread);
    expect(seed).toMatchObject({
      message: "make it shorter, in bullets",
      fileIds: [],
      model: "standard",
      researchMode: false,
      // AI reply on by default → the body runs the /api/chat turn.
      aiReply: true,
    });

    // onPick is for opening EXISTING threads (preview rows / the nudge); a fresh
    // post goes through onSubmitted instead, so it must not fire here.
    expect(onPick).not.toHaveBeenCalled();
  });

  it("with AI reply toggled off, seeds a teammate comment (aiReply false, research forced off)", async () => {
    const onSubmitted = vi.fn();
    mount(
      <PageComments
        pageId="p1"
        workspaceId="ws1"
        assistantId="a1"
        currentUser={{ id: "u1", name: "Ada" }}
        threads={[]}
        onPick={noop}
        onSubmitted={onSubmitted}
      />,
    );

    // Flip the AI-reply toggle off (aria-label switches to the "Team only" copy
    // once pressed — assert via the on-label before clicking).
    const aiToggle = container!.querySelector<HTMLButtonElement>(
      `[aria-label="${dict.comments.aiReply}"]`,
    )!;
    expect(aiToggle).toBeTruthy();
    act(() => aiToggle.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const textarea = container!.querySelector<HTMLTextAreaElement>(
      '[aria-label="Add a comment on this page"]',
    )!;
    act(() => typeInto(textarea, "FYI for the team"));

    const send = container!.querySelector<HTMLButtonElement>(
      `[aria-label="${dict.comments.send}"]`,
    )!;
    await act(async () => {
      send.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {});

    expect(onSubmitted).toHaveBeenCalledTimes(1);
    const [, seed] = onSubmitted.mock.calls[0];
    // The seed tells the thread body to post a plain comment, no AI turn —
    // research is forced off on the no-AI path (it only shapes an AI turn).
    expect(seed).toMatchObject({
      message: "FYI for the team",
      aiReply: false,
      researchMode: false,
    });
  });

  it("does not post an empty comment (send disabled with no draft, no files)", () => {
    const onSubmitted = vi.fn();
    mount(
      <PageComments
        pageId="p1"
        workspaceId="ws1"
        assistantId="a1"
        threads={[]}
        onPick={noop}
        onSubmitted={onSubmitted}
      />,
    );
    const send = container!.querySelector<HTMLButtonElement>(
      `[aria-label="${dict.comments.send}"]`,
    )!;
    expect(send.disabled).toBe(true);
    expect(mockCreateThread).not.toHaveBeenCalled();
    expect(onSubmitted).not.toHaveBeenCalled();
  });
});
