/**
 * [COMP:app-web/models-sdk] Model-menu SDK — wire contracts against the
 * `model-menu.ts` routes (mocked authFetch; node-only vitest).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));

import { authFetch } from "@/lib/auth-fetch";
import {
  clearWorkspaceModelDefault,
  clearWorkspaceModelRoute,
  createMeteredProfile,
  fetchMeteredEstimate,
  fetchModelMenu,
  setWorkspaceModelDefault,
  setWorkspaceDecisionRouting,
  setWorkspaceModelRoute,
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

  it.each([undefined, null, { operationIds: null }, { operationIds: ["research.intent", "chat.route"] }])(
    "preserves optional deployment capability from the menu: %j", async (classifierFirst) => {
      const model = {
        alias: "typesafe-jev-1.13", displayName: "Jev 1.13", provider: "typesafe", adapterId: "typesafe",
        hybridOperations: [], ...(classifierFirst === undefined ? {} : { classifierFirst }),
      };
      const decisionRouting = {
        mode: "hybrid", modelAlias: model.alias, updatedAt: "now", operatorOverride: !!classifierFirst,
        shadowSampleRate: 0.1, models: [model],
      };
      mockFetch.mockResolvedValueOnce(ok({ decisionRouting }));
      const menu = await fetchModelMenu("ws-1");
      expect(menu.decisionRouting).toEqual(decisionRouting);
      expect(menu.decisionRouting.models[0].classifierFirst).toEqual(classifierFirst);
      expect(menu.decisionRouting.models[0].hybridOperations).toEqual([]);
    },
  );

  it("preserves model-local grants and the selected OpenAI decision alias in a two-backend menu", async () => {
    const openaiAlias = "openai-decisions-gpt-6-luna";
    const models = [
      {
        alias: "typesafe-jev-1.13", displayName: "Jev 1.13", provider: "typesafe", adapterId: "typesafe",
        hybridOperations: [], classifierFirst: null,
      },
      {
        alias: openaiAlias, displayName: "GPT-6 Luna Decisions",
        provider: "openai-decisions", adapterId: "openai-decisions",
        hybridOperations: [], classifierFirst: { operationIds: ["research.intent"] },
      },
    ];
    mockFetch.mockResolvedValueOnce(ok({ decisionRouting: {
      mode: "hybrid", modelAlias: openaiAlias, updatedAt: "now", operatorOverride: true,
      shadowSampleRate: 0.1, models,
    } }));
    const menu = await fetchModelMenu("ws-1");
    expect(menu.decisionRouting.modelAlias).toBe(openaiAlias);
    expect(menu.decisionRouting.models).toEqual(models);
    expect(menu.decisionRouting.models.filter(model => model.classifierFirst).map(model => model.alias)).toEqual([openaiAlias]);

    mockFetch.mockResolvedValueOnce(ok({ decisionRouting: {
      mode: "hybrid", modelAlias: openaiAlias, updatedAt: "now",
    } }));
    const setting = await setWorkspaceDecisionRouting("ws-1", { mode: "hybrid", modelAlias: openaiAlias });
    const [, init] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ mode: "hybrid", modelAlias: openaiAlias });
    expect(setting.modelAlias).toBe(openaiAlias);
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
    await expect(createMeteredProfile("ws-1", { name: "x", modelAlias: "gemini-3.8-flash", toolRounds: 10 }))
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
    await expect(setWorkspaceModelDefault("ws-1", "max", { modelAlias: "gemini-3.8-flash" }))
      .rejects.toThrow("Owner or admin role required");
  });

  it("sets an exact tier route and clears it back to Auto", async () => {
    mockFetch.mockImplementation(async () => ok({
      route: {
        workspaceId: "ws-1",
        tier: "max",
        modelAlias: "gpt-5.6-sol",
        profileId: null,
        updatedAt: "now",
      },
    }));
    const route = await setWorkspaceModelRoute("ws-1", "max", { modelAlias: "gpt-5.6-sol" });
    await clearWorkspaceModelRoute("ws-1", "max");
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/workspaces/ws-1/model-routes/max");
    expect(JSON.parse(init.body as string)).toEqual({ modelAlias: "gpt-5.6-sol" });
    expect(route.modelAlias).toBe("gpt-5.6-sol");
    expect((mockFetch.mock.calls[1][1] as RequestInit).method).toBe("DELETE");
  });

  it("sets a workspace decision classifier in shadow mode", async () => {
    mockFetch.mockResolvedValueOnce(ok({
      decisionRouting: {
        mode: "shadow",
        modelAlias: "typesafe-jev-1.13",
        updatedAt: "now",
      },
    }));
    const setting = await setWorkspaceDecisionRouting("ws-1", {
      mode: "shadow",
      modelAlias: "typesafe-jev-1.13",
    });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/workspaces/ws-1/decision-routing");
    expect(JSON.parse(init.body as string)).toEqual({ mode: "shadow", modelAlias: "typesafe-jev-1.13" });
    expect(setting.mode).toBe("shadow");
  });

  it.each(["typesafe-jev-1.13", "openai-decisions-gpt-6-luna"])("preserves explicit shadow rates for %s", async (modelAlias) => {
    for (const shadowSampleRate of [0.1, 1] as const) {
      const decisionRouting = { mode: "shadow" as const, modelAlias, shadowSampleRate, updatedAt: "now" };
      mockFetch.mockResolvedValueOnce(ok({ decisionRouting }));
      const setting = await setWorkspaceDecisionRouting("ws-1", { mode: "shadow", modelAlias, shadowSampleRate });
      const [url, init] = mockFetch.mock.calls.at(-1)!;
      expect(String(url)).toContain("/api/workspaces/ws-1/decision-routing");
      expect(JSON.parse(init!.body as string)).toEqual({ mode: "shadow", modelAlias, shadowSampleRate });
      expect(setting.shadowSampleRate).toBe(shadowSampleRate);
      expect(setting).toEqual(decisionRouting);
    }
  });

  it("selects hybrid with the same wire request for approvals or deployment-granted full routing", async () => {
    mockFetch.mockResolvedValueOnce(ok({
      decisionRouting: {
        mode: "hybrid",
        modelAlias: "typesafe-jev-1.13",
        updatedAt: "now",
      },
    }));
    const setting = await setWorkspaceDecisionRouting("ws-1", {
      mode: "hybrid",
      modelAlias: "typesafe-jev-1.13",
    });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      mode: "hybrid",
      modelAlias: "typesafe-jev-1.13",
    });
    expect(setting.mode).toBe("hybrid");
  });
});
