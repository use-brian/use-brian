import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));

import { authFetch } from "@/lib/auth-fetch";
import {
  clearCustomLlmEndpointDefault,
  createCustomLlmEndpoint,
  CustomLlmEndpointsUnavailableError,
  deleteCustomLlmEndpoint,
  listCustomLlmEndpoints,
  setCustomLlmEndpointDefault,
} from "../custom-llm-endpoints";

const mockFetch = vi.mocked(authFetch);
const ok = (body: unknown = {}) => new Response(JSON.stringify(body), { status: 200 });

beforeEach(() => mockFetch.mockReset());

describe("[COMP:app-web/custom-llm-endpoints] custom endpoint SDK", () => {
  it("lists and creates endpoint profiles", async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ endpoints: [{ id: "endpoint-1" }] }))
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

  it("drives default and delete routes", async () => {
    mockFetch.mockResolvedValue(ok());
    await setCustomLlmEndpointDefault("workspace-1", "endpoint-1");
    await clearCustomLlmEndpointDefault("workspace-1");
    await deleteCustomLlmEndpoint("workspace-1", "endpoint-1");
    expect(String(mockFetch.mock.calls[0][0])).toContain("/endpoint-1/default");
    expect(String(mockFetch.mock.calls[1][0])).toMatch(/custom-llm-endpoints\/default$/);
    expect((mockFetch.mock.calls[2][1] as RequestInit).method).toBe("DELETE");
  });

  it("treats a 404 list as an unavailable OSS-only surface", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 404 }));
    await expect(listCustomLlmEndpoints("workspace-1")).rejects.toBeInstanceOf(CustomLlmEndpointsUnavailableError);
  });
});
