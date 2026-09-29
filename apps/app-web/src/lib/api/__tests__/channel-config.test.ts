import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));
import { authFetch } from "@/lib/auth-fetch";
import { ChannelConfigUpdateError, updateChannelConfig } from "../channels";
import { listChannelDestinations, listWorkspaceMemberOptions } from "../workflow";

beforeEach(() => vi.resetAllMocks());
describe("[COMP:app-web/channel-delivery-audiences] config error contract", () => {
  it("keeps approval payloads on the canonical encoded config route", async () => {
    const channel = { id: "channel_1" };
    vi.mocked(authFetch).mockResolvedValue(new Response(JSON.stringify({ channel })));
    const patch = { deliveryAudienceBindings: [] };
    await expect(updateChannelConfig("ws/one", "channel/two", patch)).resolves.toEqual(channel);
    expect(authFetch).toHaveBeenCalledWith(expect.stringContaining("/api/workspaces/ws%2Fone/channels/channel%2Ftwo/config"), {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
    });
  });
  it.each([401, 403, 404, 500])("preserves status %s and a machine code without exposing backend prose", async (status) => {
    vi.mocked(authFetch).mockResolvedValue(new Response(JSON.stringify({ error: "delivery_audience_binding_requires_admin", detail: "private server context" }), { status }));
    const error = await updateChannelConfig("ws", "channel", {}).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ChannelConfigUpdateError);
    expect(error).toMatchObject({ status, code: "delivery_audience_binding_requires_admin", fields: [] });
    expect(String(error)).not.toContain("private server context");
  });
  it("extracts validation field identifiers but not rejected values or messages", async () => {
    vi.mocked(authFetch).mockResolvedValue(new Response(JSON.stringify({ error: "Invalid config", detail: JSON.stringify([
      { path: ["deliveryAudienceBindings", 0, "projectIds", 0], message: "private invalid value" },
      { path: ["deliveryAudienceBindings", 1, "projectIds", 1] },
    ]) }), { status: 400 }));
    await expect(updateChannelConfig("ws", "channel", {})).rejects.toMatchObject({ status: 400, fields: ["deliveryAudienceBindings", "projectIds"] });
  });
  it.each([listChannelDestinations, listWorkspaceMemberOptions])("allows audience option loaders to distinguish a failed request from no options", async (load) => {
    vi.mocked(authFetch).mockImplementation(async () => new Response("unavailable", { status: 403 }));
    await expect(load("ws", { throwOnError: true })).rejects.toThrow("403");
    // Existing workflow pickers retain their tolerant fallback contract.
    await expect(load("ws")).resolves.toEqual([]);
  });
  it("handles non-JSON error responses", async () => {
    vi.mocked(authFetch).mockResolvedValue(new Response("upstream proxy error", { status: 502 }));
    await expect(updateChannelConfig("ws", "channel", {})).rejects.toMatchObject({ status: 502, code: null, fields: [] });
  });
});
