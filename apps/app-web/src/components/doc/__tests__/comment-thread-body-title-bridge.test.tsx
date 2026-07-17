// @vitest-environment jsdom
/**
 * [COMP:app-web/comment-thread-body] `doc_title_update` SSE → window bridge.
 *
 * Regression guard for the "assistant sets a page icon from a comment thread
 * and every surface stays stale" bug: `patchPage`'s `setIcon`/`setTitle` emits
 * a `doc_title_update` SSE on the `/api/chat` stream (chat.ts streams it the
 * instant the patch commits), floating-chat bridges it to the shell as a
 * `doc:title-updated` window event (→ `applyAutoTitle` → `reloadSidebar`) —
 * but the comment-thread reply consumes the SAME stream and used to drop the
 * event, so an icon set from the page comment band persisted to
 * `saved_views.icon` without the header / tabs / sidebar ever hearing about
 * it (prod report 2026-07-16, theground.io client page).
 *
 * This test seeds a thread (the auto-send runs through the real streaming
 * reply path), feeds the mocked `/api/chat` response an SSE stream carrying a
 * `doc_title_update`, and asserts the `doc:title-updated` CustomEvent reaches
 * the window with the authoritative payload (overwrite semantics intact).
 *
 * Driven for real in jsdom (`createRoot` + `act`, no `@testing-library/react`),
 * matching `comment-thread-body-seed.test.tsx`.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import type { CommentThread } from "@/lib/api/comments";

const { mockFetchMessages, mockAuthFetch } = vi.hoisted(() => ({
  mockFetchMessages: vi.fn(),
  mockAuthFetch: vi.fn(),
}));
vi.mock("@/lib/api/sessions", async (orig) => ({
  ...(await orig<typeof import("@/lib/api/sessions")>()),
  fetchSessionMessages: mockFetchMessages,
}));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: mockAuthFetch }));

import { CommentThreadBody, type CommentSeed } from "../comment-thread-body";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dict = en as unknown as Dictionary;

// Unique thread id — `sentSeedThreadIds` is module-level, shared across tests.
const thread: CommentThread = {
  id: "th_title_bridge",
  pageId: "p_icon",
  workspaceId: "ws1",
  sessionId: "s_title_bridge",
  anchorKind: "human_range",
  anchorBlockId: null,
  quote: null,
  resolvedAt: null,
  resolvedBy: null,
  createdBy: "u1",
  createdAt: "2026-06-01T00:00:00.000Z",
};

const seed: CommentSeed = {
  message: "can you set the page icon to the seedling",
  fileIds: [],
  model: "standard",
  researchMode: false,
  aiReply: true,
};

/** An SSE `/api/chat` response whose stream carries the given raw text. */
function sseResponse(raw: string) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(raw));
      controller.close();
    },
  });
  return { ok: true, body: stream, json: () => Promise.resolve({}) };
}

const noop = () => {};

describe("[COMP:app-web/comment-thread-body] doc_title_update stream bridge", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    mockFetchMessages.mockReset().mockResolvedValue([]);
    mockAuthFetch.mockReset();
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    container?.remove();
    container = null;
  });

  it("relays a doc_title_update SSE as a doc:title-updated window event", async () => {
    const events: Array<Record<string, unknown>> = [];
    const listener = (e: Event) => {
      events.push((e as CustomEvent<Record<string, unknown>>).detail);
    };
    window.addEventListener("doc:title-updated", listener);

    const payload = {
      pageId: "p_icon",
      title: "theground.io",
      icon: "🌱",
      nameOrigin: "auto",
      overwrite: true,
    };
    mockAuthFetch.mockImplementation((url: string) =>
      String(url).includes("/api/chat")
        ? Promise.resolve(
            sseResponse(
              `event: doc_title_update\ndata: ${JSON.stringify(payload)}\n\n` +
                `event: text_delta\ndata: {"text":"Done."}\n\n`,
            ),
          )
        : Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
    );

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <I18nProvider locale="en" dict={dict}>
          <CommentThreadBody
            thread={thread}
            pageId="p_icon"
            workspaceId="ws1"
            assistantId="a1"
            currentUser={{ id: "u1", name: "Ada" }}
            assistant={{ id: "a1", name: "Doc", iconSeed: 7 }}
            seed={seed}
            onChanged={noop}
            onResolved={noop}
            inline
            collapsed={false}
          />
        </I18nProvider>,
      ),
    );
    // Let the seed auto-send's stream read + dispatch settle.
    await act(async () => {});
    await act(async () => {});

    window.removeEventListener("doc:title-updated", listener);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      pageId: "p_icon",
      title: "theground.io",
      icon: "🌱",
      nameOrigin: "auto",
      overwrite: true,
    });
  });
});
