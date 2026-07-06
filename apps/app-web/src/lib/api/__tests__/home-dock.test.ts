/**
 * [COMP:app-web/home-dock] Home dock SDK (app-web) — the shared resolved-dock
 * fetch + the sidebar badge count. Spec: docs/architecture/features/home-dock.md.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));

import { authFetch } from "@/lib/auth-fetch";
import { fetchHomeDock, needsYouTotal, type ResolvedDock } from "../home-dock";

const mockAuthFetch = vi.mocked(authFetch);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
});

function dockWith(needsYou: ResolvedDock["needsYou"]): ResolvedDock {
  return {
    source: "default",
    generatedAt: null,
    note: null,
    needsYou,
    pickUp: [],
    comingUp: [],
    brain: { entryCount: 0, growth7d: 0, hasConnector: false },
  };
}

describe("[COMP:app-web/home-dock] needsYouTotal", () => {
  it("is 0 for a null dock (unresolved / failed fetch → badge hidden)", () => {
    expect(needsYouTotal(null)).toBe(0);
  });

  it("is 0 when no cards survived the merge", () => {
    expect(needsYouTotal(dockWith([]))).toBe(0);
  });

  it("sums the live card counts into one inbox-style number", () => {
    expect(
      needsYouTotal(
        dockWith([
          { kind: "approvals", count: 2, caption: null },
          { kind: "brain_review", count: 5, caption: "New facts" },
          { kind: "autopilot", count: 1, caption: null },
        ]),
      ),
    ).toBe(8);
  });

  it("clamps a (buggy) negative count instead of eating the others", () => {
    expect(
      needsYouTotal(
        dockWith([
          { kind: "approvals", count: -3, caption: null },
          { kind: "brain_review", count: 4, caption: null },
        ]),
      ),
    ).toBe(4);
  });
});

describe("[COMP:app-web/home-dock] fetchHomeDock", () => {
  it("returns the resolved dock from GET /api/home-dock", async () => {
    const dock = dockWith([{ kind: "approvals", count: 2, caption: null }]);
    mockAuthFetch.mockResolvedValueOnce(json({ dock }));
    const got = await fetchHomeDock("ws-1");
    expect(got).toEqual(dock);
    expect(mockAuthFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/home-dock?workspaceId=ws-1"),
    );
  });

  it("returns null on a non-OK response (caller renders the quiet fallback)", async () => {
    mockAuthFetch.mockResolvedValueOnce(json({ error: "nope" }, 500));
    expect(await fetchHomeDock("ws-1")).toBeNull();
  });

  it("returns null when the request throws (offline)", async () => {
    mockAuthFetch.mockRejectedValueOnce(new Error("network down"));
    expect(await fetchHomeDock("ws-1")).toBeNull();
  });
});
