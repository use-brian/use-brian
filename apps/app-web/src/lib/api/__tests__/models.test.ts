/**
 * [COMP:app-web/models-sdk] Model-menu SDK — wire contracts against the
 * `model-menu.ts` routes (mocked authFetch; node-only vitest).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));

import { authFetch } from "@/lib/auth-fetch";
import {
  clearWorkspaceModelDefault,
  createMeteredProfile,
  fetchMeteredEstimate,
  fetchModelMenu,
  setWorkspaceModelDefault,
  updateMeteredProfile,
  deleteMeteredProfile,
} from "../models";

const mockFetch = vi.mocked(authFetch);

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

beforeEach(() => mockFetch.mockReset());

describe("[COMP:app-web/models-sdk] model menu SDK", () => {
  it("fetches the per-class menu for a workspace", async () => {
    mockFetch.mockResolvedValueOnce(ok({ classes: { metered: [] }, profiles: [], meteredBillingAvailable: true }));
    const menu = await fetchModelMenu("ws-1");
    expect(String(mockFetch.mock.calls[0][0])).toContain("/api/models/menu?workspaceId=ws-1");
    expect(menu.meteredBillingAvailable).toBe(true);
  });

  it("posts estimate requests at the chosen budget", async () => {
    mockFetch.mockResolvedValueOnce(ok({ estimate: { modelAlias: "qwen3.7-max", toolRounds: 100, minCredits: 9, maxCredits: 120 } }));
    const est = await fetchMeteredEstimate("ws-1", "qwen3.7-max", 100);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain("/api/models/metered-estimate");
    expect(JSON.parse(init.body as string)).toEqual({ workspaceId: "ws-1", modelAlias: "qwen3.7-max", toolRounds: 100 });
    expect(est?.maxCredits).toBe(120);
  });

  it("drives the profile CRUD routes", async () => {
    mockFetch.mockImplementation(async () => ok({ profile: { id: "p1" }, profiles: [] }));
    await createMeteredProfile("ws-1", { name: "deep", modelAlias: "deepseek-v4-pro", toolRounds: 100 });
    await updateMeteredProfile("ws-1", "p1", { toolRounds: 50 });
    await deleteMeteredProfile("ws-1", "p1");
    const urls = mockFetch.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toContain("/api/workspaces/ws-1/metered-profiles");
    expect(urls[1]).toContain("/api/workspaces/ws-1/metered-profiles/p1");
    expect((mockFetch.mock.calls[2][1] as RequestInit).method).toBe("DELETE");
  });

  it("surfaces the server's error body on a failed create", async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Not a metered model" }), { status: 400 }));
    await expect(createMeteredProfile("ws-1", { name: "x", modelAlias: "gemini-3.5-flash", toolRounds: 10 }))
      .rejects.toThrow("Not a metered model");
  });

  it("sets and clears workspace class defaults through the model-defaults routes", async () => {
    mockFetch.mockImplementation(async () =>
      ok({ default: { workspaceId: "ws-1", modelClass: "max", modelAlias: null, meteredProfileId: "p1", updatedAt: "now" } }),
    );
    const set = await setWorkspaceModelDefault("ws-1", "max", { meteredProfileId: "p1" });
    await clearWorkspaceModelDefault("ws-1", "max");
    const [setUrl, setInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(String(setUrl)).toContain("/api/workspaces/ws-1/model-defaults/max");
    expect(setInit.method).toBe("PUT");
    expect(JSON.parse(setInit.body as string)).toEqual({ meteredProfileId: "p1" });
    expect(set.meteredProfileId).toBe("p1");
    expect((mockFetch.mock.calls[1][1] as RequestInit).method).toBe("DELETE");
  });

  it("surfaces the role error on a member's default write", async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Owner or admin role required" }), { status: 403 }));
    await expect(setWorkspaceModelDefault("ws-1", "max", { modelAlias: "gemini-3.5-flash" }))
      .rejects.toThrow("Owner or admin role required");
  });
});
