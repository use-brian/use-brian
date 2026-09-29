/**
 * [COMP:app-web/feed-surface-cache] A failed or timed-out profiles read keeps
 * the last-known connections. Before this, the loader swallowed the failure
 * into `[]`, so a slow API painted a real, just-made X connection as "not
 * connected" (docs/architecture/feed/twitter.md -> "Return landing").
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const disk = vi.hoisted(() => ({ record: null as unknown }));
const profiles = vi.hoisted(() => ({ next: vi.fn() }));

vi.mock("@/lib/offline/feed-cache", () => ({
  feedCachedJson: async () => ({ id: "ws-1", name: "Team", role: "owner", me: { id: "u1" } }),
  feedOwner: () => "u1",
  feedPaintFirst: async (_k: string, _disk: unknown, network: () => Promise<unknown>) => network(),
  isAuthoritativeFeedDenial: () => false,
  readFeedCachedJson: async () => disk.record,
  writeFeedCachedJson: async (_p: string, value: unknown) => {
    disk.record = value;
  },
  deleteFeedCachedJson: async () => {},
}));
vi.mock("@/lib/offline/feed-offline", () => ({ mergeLocalFeedSessions: (x: unknown) => x }));
vi.mock("@/lib/api/brand", () => ({ fetchWorkspaceBrand: async () => null }));
vi.mock("@/lib/edition", () => ({
  deploymentCapabilities: () => ({ managedInfrastructure: true, hostedUpgradePrompts: false }),
}));
vi.mock("@/lib/api/feed", () => ({
  fetchFeedTeamProfiles: () => profiles.next(),
  fetchFeedDistributionAssistants: async () => [],
  fetchFeedCloudLink: async () => ({ state: "native" }),
  fetchFeedDraftSessions: async () => [],
  fetchFeedIdeas: async () => [],
  fetchPlanBrief: async () => null,
  fetchPlanSlots: async () => [],
}));

import { forgetFeedProfile, loadFeedWorkspaceRecord } from "@/lib/feed-surface-cache";

const X = { platform: "twitter", platformHandle: "example_handle", assistantId: "a-1" };

describe("[COMP:app-web/feed-surface-cache] profiles read failure", () => {
  beforeEach(() => {
    disk.record = null;
    profiles.next.mockReset();
  });

  it("keeps the last-known profiles when the read fails", async () => {
    profiles.next.mockResolvedValueOnce([X]);
    expect((await loadFeedWorkspaceRecord("ws-1", "k-1")).profiles).toEqual([X]);

    profiles.next.mockRejectedValueOnce(new Error("timeout"));
    expect((await loadFeedWorkspaceRecord("ws-1", "k-1")).profiles).toEqual([X]);
  });

  it("still reports no profiles when nothing was ever known", async () => {
    profiles.next.mockRejectedValueOnce(new Error("timeout"));
    expect((await loadFeedWorkspaceRecord("ws-1", "k-2")).profiles).toEqual([]);
  });

  it("adopts an authoritative empty list (a real disconnect)", async () => {
    profiles.next.mockResolvedValueOnce([X]);
    await loadFeedWorkspaceRecord("ws-1", "k-3");
    profiles.next.mockResolvedValueOnce([]);
    expect((await loadFeedWorkspaceRecord("ws-1", "k-3")).profiles).toEqual([]);
  });

  it("does not resurrect a disconnected profile when the next read fails", async () => {
    profiles.next.mockResolvedValueOnce([X]);
    await loadFeedWorkspaceRecord("ws-1", "k-4");
    await forgetFeedProfile({ workspaceId: "ws-1", key: "k-4", assistantId: "a-1", platform: "twitter" });
    profiles.next.mockRejectedValueOnce(new Error("timeout"));
    expect((await loadFeedWorkspaceRecord("ws-1", "k-4")).profiles).toEqual([]);
  });
});
