import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildConnectorState } from "../connector-oauth-state";
import { en } from "@/lib/i18n/dictionaries/en";
import { GET } from "@/app/api/auth/callback/google-connector/route";

const nonce = "abcdefghijklmnopqrstuv";
const sessionId = "11111111-1111-4111-8111-111111111111";
const approvalId = "22222222-2222-4222-8222-222222222222";
const cookie = vi.hoisted(() => ({ nonce: "abcdefghijklmnopqrstuv" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (key: string) => ({ value: key === "access_token" ? "fictional-token" : cookie.nonce }) }) }));
vi.mock("@/lib/i18n/server", () => ({ getServerDictionary: async () => ({ dict: en, locale: "en" }) }));
vi.mock("@/lib/edition", () => ({ isOssEdition: () => false }));
function request(popup = true, error?: string) {
  const state = buildConnectorState({ connector: "gcal", workspaceId: "workspace", nonce, continuation: { sessionId, approvalId }, popup });
  return new Request(`https://app.example/api/auth/callback/google-connector?${new URLSearchParams({ state, ...(error ? { error } : { code: "fictional-code" }) })}`);
}
beforeEach(() => { cookie.nonce = nonce; vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function successfulFetch(complete = true) {
  const fetch = vi.fn()
    .mockResolvedValueOnce(Response.json({ refresh_token: "fictional-refresh" }))
    .mockResolvedValueOnce(Response.json({ connectorInstanceId: "33333333-3333-4333-8333-333333333333" }))
    .mockResolvedValueOnce(Response.json({}, { status: complete ? 200 : 403 }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
describe("[COMP:app-web/connector-authorization] Google popup callback", () => {
  it("signals success only after storing credentials and verified checkpoint completion", async () => {
    const fetch = successfulFetch();
    const response = await GET(request()); const html = await response.text();
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("script-src 'nonce-");
    expect(html).toContain('"ok":true');
    expect(html).toContain(sessionId);
    expect(html).not.toContain("fictional-refresh");
    expect(html).not.toContain("fictional-code");
    expect(fetch.mock.calls[2][0]).toContain(`/connector-authorization/${approvalId}/complete`);
  });
  it("reports a completion rejection without redirecting to Studio or claiming success", async () => {
    successfulFetch(false); const response = await GET(request());
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toContain('"ok":false');
  });
  it("reports consent denial without exchanging or storing credentials", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const response = await GET(request(true, "access_denied"));
    expect(await response.text()).toContain('"ok":false');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["exchange", "store"])("reports %s failure inline", async (stage) => {
    const fetch = vi.fn();
    if (stage === "store") fetch.mockResolvedValueOnce(Response.json({ refresh_token: "fictional-refresh" }));
    fetch.mockResolvedValueOnce(new Response("failed", { status: 500 }));
    vi.stubGlobal("fetch", fetch);
    expect(await (await GET(request())).text()).toContain('"ok":false');
    expect(fetch).toHaveBeenCalledTimes(stage === "store" ? 2 : 1);
  });
  it("rejects an invalid state before any exchange or popup success signal", async () => {
    cookie.nonce = "wrong_nonce_abcdefghijkl";
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const response = await GET(request());
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toContain('"ok":false');
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves the non-popup chat redirect", async () => {
    successfulFetch(); const response = await GET(request(false));
    expect(response.headers.get("location")).toBe(`https://app.example/w/workspace/chat?s=${sessionId}`);
  });
});
