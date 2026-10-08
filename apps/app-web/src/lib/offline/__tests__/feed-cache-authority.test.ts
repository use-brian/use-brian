import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ data: new Map<string, unknown>() }));
vi.mock("../idb", () => ({
  idbGet: async (key: string) => structuredClone(state.data.get(key) ?? null),
  idbSet: async (key: string, value: unknown) => { state.data.set(key, structuredClone(value)); },
  idbDelete: async (key: string) => { state.data.delete(key); },
}));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));

import { authFetch } from "@/lib/auth-fetch";
import { setUserInfoCache } from "@/lib/user";
import { FEED_OFFLINE_AUTHORITY_MS, feedCachedJson, readFeedCachedJson, writeFeedCachedJson } from "../feed-cache";

const path = "/api/feed/fictional";
const key = `feed:cache:viewer-a:${path}`;

describe("[COMP:app-web/feed-offline] Durable copy authority window", () => {
  beforeEach(() => {
    state.data.clear();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T00:00:00Z"));
    setUserInfoCache({ id: "viewer-a", email: "viewer@example.com" } as never);
  });
  afterEach(() => { vi.useRealTimers(); vi.mocked(authFetch).mockReset(); setUserInfoCache(null); });

  it("shows a confirmed copy only within the authority window, then never as current", async () => {
    await writeFeedCachedJson(path, { title: "Fictional protected draft" });
    expect(await readFeedCachedJson(path)).toEqual({ title: "Fictional protected draft" });
    vi.setSystemTime(Date.now() + FEED_OFFLINE_AUTHORITY_MS + 1);
    expect(await readFeedCachedJson(path)).toBeNull();
  });

  it("ignores pre-envelope copies and keeps the original confirmation on a local rewrite", async () => {
    state.data.set(key, { title: "Fictional legacy copy" });
    expect(await readFeedCachedJson(path)).toBeNull();
    await writeFeedCachedJson(path, { title: "Fictional draft" });
    vi.setSystemTime(Date.now() + FEED_OFFLINE_AUTHORITY_MS - 1_000);
    await writeFeedCachedJson(path, { title: "Fictional narrowed draft" }, true);
    vi.setSystemTime(Date.now() + 2_000);
    expect(await readFeedCachedJson(path)).toBeNull();
  });

  it("serves an expired copy neither offline nor after a transient failure", async () => {
    await writeFeedCachedJson(path, { title: "Fictional protected draft" });
    vi.setSystemTime(Date.now() + FEED_OFFLINE_AUTHORITY_MS + 1);
    vi.mocked(authFetch).mockRejectedValue(new TypeError("network down"));
    await expect(feedCachedJson(path)).rejects.toBeTruthy();
  });
});
