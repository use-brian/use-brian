import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));

import { authFetch } from "@/lib/auth-fetch";
import {
  clearCustomLlmTierDefault,
  createCustomLlmEndpoint,
  createCustomLlmProfile,
  CustomLlmEndpointsUnavailableError,
  deleteCustomLlmProfile,
  deleteCustomLlmEndpoint,
  listCustomLlmEndpoints,
  setCustomLlmTierDefault,
} from "../custom-llm-endpoints";

const mockFetch = vi.mocked(authFetch);
const ok = (body: unknown = {}) => new Response(JSON.stringify(body), { status: 200 });

beforeEach(() => mockFetch.mockReset());

describe("[COMP:app-web/custom-llm-endpoints] custom endpoint SDK", () => {
  it("lists and creates endpoint profiles", async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ endpoints: [{ id: "endpoint-1" }], tierDefaults: [] }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ endpoint: { id: "endpoint-1" } }), { status: 201 }));
    await expect(listCustomLlmEndpoints("workspace-1")).resolves.toEqual([{ id: "endpoint-1" }]);
    await createCustomLlmEndpoint("workspace-1", {
      name: "Local", baseUrl: "http://localhost:11434/v1", modelId: "llama",
      contextWindow: 32768, maxOutputTokens: 4096,
    });
    const [, init] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toMatchObject({ modelId: "llama", contextWindow: 32768 });
  });

  it("creates profiles and drives independent tier assignment routes", async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ profile: { id: "profile-1" } }), { status: 201 }))
      .mockResolvedValueOnce(ok({ tierDefault: { tier: "max", profileId: "profile-1" } }))
      .mockResolvedValue(ok());
    await createCustomLlmProfile("workspace-1", "endpoint-1", {
      name: "Max", modelId: "sol-max", contextWindow: 200000, maxOutputTokens: 32768,
    });
    await setCustomLlmTierDefault("workspace-1", "max", "profile-1");
    await clearCustomLlmTierDefault("workspace-1", "max");
    await deleteCustomLlmProfile("workspace-1", "endpoint-1", "profile-1");
    await deleteCustomLlmEndpoint("workspace-1", "endpoint-1");
    expect(String(mockFetch.mock.calls[0][0])).toContain("/endpoint-1/profiles");
    expect(String(mockFetch.mock.calls[1][0])).toMatch(/custom-llm-endpoints\/tiers\/max$/);
    expect((mockFetch.mock.calls[2][1] as RequestInit).method).toBe("DELETE");
    expect(String(mockFetch.mock.calls[3][0])).toContain("/endpoint-1/profiles/profile-1");
  });

  it("treats a 404 list as an unavailable OSS-only surface", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 404 }));
    await expect(listCustomLlmEndpoints("workspace-1")).rejects.toBeInstanceOf(CustomLlmEndpointsUnavailableError);
  });
});
