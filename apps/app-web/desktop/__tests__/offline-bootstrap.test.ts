import { describe, expect, it } from "vitest";

import {
  DESKTOP_WORKSPACES_CACHE_KEY,
  desktopWorkspaceCacheKey,
  parseDesktopWorkspaceContext,
  parseDesktopWorkspaceRows,
  resolveDesktopWorkspaceBootstrap,
} from "../offline-bootstrap";

describe("[COMP:app-web/desktop-spa] offline workspace bootstrap", () => {
  it("normalizes both workspace API shapes and drops unusable rows", () => {
    const rows = parseDesktopWorkspaceRows({
      workspaces: [
        {
          id: "ws-1",
          name: "Local workspace",
          role: "owner",
          iconSeed: 4,
          pickerPinnedAt: "2026-08-01T00:00:00.000Z",
        },
        { name: "missing id" },
      ],
    });

    expect(rows).toEqual([
      {
        id: "ws-1",
        name: "Local workspace",
        role: "owner",
        iconSeed: 4,
        iconUrl: null,
        plan: null,
        pickerPinnedAt: "2026-08-01T00:00:00.000Z",
        pickerHiddenAt: null,
        pickerLastOpenedAt: null,
      },
    ]);
    expect(parseDesktopWorkspaceRows(rows)).toEqual(rows);
  });

  it("normalizes cached workspace identity with safe authority defaults", () => {
    expect(
      parseDesktopWorkspaceContext("ws-1", {
        name: "Local workspace",
        role: "admin",
        clearance: "confidential",
        me: { id: "viewer-1" },
      }),
    ).toEqual({
      workspaceId: "ws-1",
      name: "Local workspace",
      iconSeed: null,
      iconUrl: null,
      role: "admin",
      clearance: "confidential",
      me: { id: "viewer-1" },
    });

    expect(parseDesktopWorkspaceContext("ws-1", null)).toBeNull();
    expect(parseDesktopWorkspaceContext("ws-1", { role: "superuser" })).toMatchObject({
      role: "member",
      clearance: "internal",
    });
  });

  it("scopes cache keys by purpose and workspace", () => {
    expect(DESKTOP_WORKSPACES_CACHE_KEY).toBe("desktop:workspaces:v1");
    expect(desktopWorkspaceCacheKey("ws-1")).toBe("desktop:workspace:v1:ws-1");
    expect(desktopWorkspaceCacheKey("ws-2")).not.toBe(desktopWorkspaceCacheKey("ws-1"));
  });

  it("waits for live authentication instead of immediately exposing cached workspaces", async () => {
    let finishProbe!: (value: { status: number; data: unknown }) => void;
    const liveProbe = new Promise<{ status: number; data: unknown }>((resolve) => {
      finishProbe = resolve;
    });
    const pending = resolveDesktopWorkspaceBootstrap({
      cached: [{ id: "cached", name: "Cached workspace" }],
      hasStoredSession: true,
      authenticate: async () => "access-token",
      loadLive: () => liveProbe,
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    finishProbe({
      status: 200,
      data: { workspaces: [{ id: "live", name: "Live workspace" }] },
    });
    await expect(pending).resolves.toMatchObject({
      kind: "ready",
      source: "live",
      workspaces: [{ id: "live" }],
    });
  });

  it("uses cache only for a transient live failure", async () => {
    await expect(
      resolveDesktopWorkspaceBootstrap({
        cached: [{ id: "cached", name: "Cached workspace" }],
        hasStoredSession: true,
        authenticate: async () => "access-token",
        loadLive: async () => {
          throw new TypeError("network unavailable");
        },
      }),
    ).resolves.toMatchObject({
      kind: "ready",
      source: "cache",
      workspaces: [{ id: "cached" }],
    });
  });

  it("never uses cached workspace identity after a 401", async () => {
    await expect(
      resolveDesktopWorkspaceBootstrap({
        cached: [{ id: "cached", name: "Cached workspace" }],
        hasStoredSession: true,
        authenticate: async () => "rejected-token",
        loadLive: async () => ({ status: 401 }),
      }),
    ).resolves.toEqual({ kind: "unauthenticated" });
  });

  it("does not probe or use cache without a token", async () => {
    let probed = false;
    await expect(
      resolveDesktopWorkspaceBootstrap({
        cached: [{ id: "cached", name: "Cached workspace" }],
        hasStoredSession: true,
        authenticate: async () => null,
        loadLive: async () => {
          probed = true;
          return { status: 200 };
        },
      }),
    ).resolves.toEqual({ kind: "unauthenticated" });
    expect(probed).toBe(false);
  });
});
