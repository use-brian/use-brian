import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  owner: "viewer-a" as string | null,
  beforeWrite: null as (() => Promise<void>) | null,
}));
vi.mock("../idb", async importOriginal => ({
  ...await importOriginal<typeof import("../idb")>(),
  idbGet: async (key: string) => structuredClone(state.data.get(key) ?? null),
  idbSet: async (key: string, value: unknown) => { state.data.set(key, structuredClone(value)); },
  idbDelete: async (key: string) => { state.data.delete(key); },
  idbUpdate: async (key: string, update: (value: unknown) => unknown) => {
    await state.beforeWrite?.();
    const next = update(structuredClone(state.data.get(key) ?? null));
    state.data.set(key, structuredClone(next));
    return next;
  },
}));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));

import { authFetch } from "@/lib/auth-fetch";
import type { FeedDraftSessionSummary } from "@/lib/api/feed";
import { setUserInfoCache } from "@/lib/user";
import { feedOwner } from "../feed-cache";
import { blankFeedContent, createLocalFeedPost, ensureFeedComposition, loadFeedWorkingCopy, readLocalFeedPost, readLocalFeedPosts } from "../feed-offline";

const assistantId = "assistant-1";
const session: FeedDraftSessionSummary = {
  id: "session-1", platform: "threads", title: "[threads] Sample post",
  startedBy: { id: "viewer-a", name: null }, createdAt: "2026-01-01T00:00:00.000Z",
  lastActiveAt: "2026-01-01T00:00:00.000Z", preview: null, replyTarget: null,
  draftText: "Keep the draft", selectedDraft: null, seedKind: "freeform",
  draftCounts: { pending: 0, ready: 0, posted: 0, rejected: 0, deleted: 0 },
};
const content = () => ({ ...blankFeedContent(), text: "Keep the draft", textEdited: true });
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

beforeEach(() => {
  state.data.clear(); state.owner = "viewer-a"; state.beforeWrite = null;
  setUserInfoCache(null);
  vi.mocked(authFetch).mockReset();
  vi.stubGlobal("document", { cookie: "" });
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("window", {
    dispatchEvent: vi.fn(),
    usebrianDesktop: { signIn: vi.fn(), getAccessToken: () => "test-access", getUserId: () => state.owner },
  });
});
afterEach(() => { setUserInfoCache(null); vi.unstubAllGlobals(); });

describe("[COMP:app-web/feed-offline] bundled desktop owner", () => {
  it("creates and reloads a local post without a browser user cookie", async () => {
    const post = await createLocalFeedPost(assistantId, "threads", content());
    expect(feedOwner()).toBe("viewer-a");
    expect(state.data.has("feed:working:viewer-a")).toBe(true);
    expect(await readLocalFeedPost(assistantId, post.session.id)).toMatchObject({ content: { text: "Keep the draft" } });
    expect(authFetch).not.toHaveBeenCalled();
  });

  it("restores and upgrades a remote legacy draft with the real cookie-free owner path", async () => {
    vi.mocked(authFetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith("/commands")) {
        const request = JSON.parse(init!.body as string);
        return reply({ receipt: { mutationId: request.mutationId, revision: request.expectedRevision + 1, sequence: 0, threadIds: [], suggestionIds: [] } });
      }
      return reply({ copy: { revision: 3, mutationId: "remote-mutation", content: content() } });
    });
    const restored = await loadFeedWorkingCopy(assistantId, session, blankFeedContent());
    await ensureFeedComposition(assistantId, session.id, { mutationId: restored.mutationId, text: restored.content.text });
    expect(await readLocalFeedPost(assistantId, session.id)).toMatchObject({
      revision: 4, dirty: false, content: { schemaVersion: 2, text: "Keep the draft" },
    });
    expect(vi.mocked(authFetch).mock.calls.filter(([url]) => String(url).endsWith("/commands"))).toHaveLength(1);
  });

  it.each(["missing getter", "missing identity", "cleared identity"].flatMap(condition =>
    ["cookie", "profile cache"].map(source => ({ condition, source })),
  ))("refuses a stale $source with $condition in the native session", async ({ condition, source }) => {
    const stale = { id: "stale-viewer", name: "Sample Viewer", email: "stale@example.com" };
    if (source === "cookie") document.cookie = `user=${encodeURIComponent(JSON.stringify(stale))}`;
    else setUserInfoCache(stale);
    if (condition === "missing getter") delete window.usebrianDesktop!.getUserId;
    else {
      if (condition === "cleared identity") {
        expect(feedOwner()).toBe("viewer-a");
        await createLocalFeedPost(assistantId, "threads", content());
      }
      state.owner = null;
    }
    expect(feedOwner()).toBe("");
    expect(await readLocalFeedPosts()).toEqual([]);
    await expect(createLocalFeedPost(assistantId, "threads", content())).rejects.toThrow("No local identity");
    expect(state.data.has("feed:working:stale-viewer")).toBe(false);
  });

  it("refuses a queued local write when the native account switches before commit", async () => {
    document.cookie = `user=${encodeURIComponent(JSON.stringify({ id: "viewer-a", name: "Sample Viewer", email: "viewer@example.com" }))}`;
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    state.beforeWrite = async () => { enter(); await blocked; };
    const pending = createLocalFeedPost(assistantId, "threads", content()).then(() => null, error => error);
    await entered;
    state.owner = "viewer-b";
    release();
    expect(await pending).toEqual(new Error("Local identity changed"));
    expect(state.data.size).toBe(0);
    expect(feedOwner()).toBe("viewer-b");
  });

  it("keeps web and thin-shell ownership on the browser user cookie", () => {
    window.usebrianDesktop = { signIn: vi.fn() };
    document.cookie = `user=${encodeURIComponent(JSON.stringify({ id: "browser-viewer", name: "Sample Viewer", email: "viewer@example.com" }))}`;
    expect(feedOwner()).toBe("browser-viewer");
  });
});
