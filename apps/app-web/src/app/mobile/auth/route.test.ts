import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { GET, POST } from "./route";

vi.mock("@/lib/internal-api-url", () => ({ INTERNAL_API_URL: "https://api.example" }));
vi.mock("@/lib/primary-auth", () => ({
  primaryAuthUrl: () => "https://portal.example",
  publicAppUrl: (url: string) => new URL(url),
  buildDelegatedLoginUrl: (origin: string, next: string) => `${origin}/login?${new URLSearchParams({ next })}`,
}));
const origin = "https://app.example";
const tx = { challenge: createHash("sha256").update("v".repeat(64)).digest("base64url"), state: "s".repeat(32), clientId: "brian-ios" };
const url = `${origin}/mobile/auth?${new URLSearchParams(tx)}`;
const fetchMock = vi.fn();
const account = () => Response.json({ user: { id: "u1", email: "person@example.com", name: "Person" } });
beforeEach(() => { vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); fetchMock.mockImplementation(async () => account()); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
async function confirmation() {
  const response = await GET(new Request(url, { headers: { cookie: "access_token=browser-secret" } }));
  const html = await response.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1];
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  fetchMock.mockClear();
  return { response, html, csrf, cookie };
}
function post(csrf: string, cookie: string, changes: Record<string, string> = {}, headers: Record<string, string> = {}) {
  return POST(new Request(`${origin}/mobile/auth`, {
    method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded", cookie: `access_token=browser-secret; ${cookie}`, ...headers },
    body: new URLSearchParams({ ...tx, csrf, decision: "allow", ...changes }),
  }));
}
function appCallback(response: Response) {
  expect(response.status).toBe(303);
  const callback = new URL(response.headers.get("location")!);
  expect(`${callback.protocol}//${callback.host}`).toBe("usebrian-mobile://auth");
  expect(callback.searchParams.has("code")).toBe(false);
  return callback.searchParams;
}

describe("[COMP:app-web/mobile-auth-bridge] explicit native sign-in", () => {
  it("requires state/client/challenge before even sending the user to login", async () => {
    for (const key of Object.keys(tx)) {
      const params = new URLSearchParams(tx); params.delete(key);
      expect((await GET(new Request(`${origin}/mobile/auth?${params}`))).status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("delegates unauthenticated browsers to the normal portal preserving the transaction", async () => {
    const response = await GET(new Request(url));
    const target = new URL(response.headers.get("location")!);
    expect(target.origin).toBe("https://portal.example");
    expect(target.searchParams.get("next")).toBe(url);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("shows the API-verified account and device without minting on GET", async () => {
    const { response, html } = await confirmation();
    expect(html).toContain("person@example.com");
    expect(html).toContain("Brian for iPhone");
    expect(html).toContain('method="post"');
    expect(html).not.toContain("browser-secret");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    // `no-referrer` makes browsers send `Origin: null` on the consent POST,
    // which fails the origin check and breaks every confirmation.
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
    expect(response.headers.get("set-cookie")).toContain("__Host-mobile_auth=");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
  });
  it("only mints after confirmation, sends fixed bindings, and echoes state in the fixed callback", async () => {
    const { csrf, cookie } = await confirmation();
    fetchMock.mockResolvedValueOnce(Response.json({ code: "a".repeat(43) }));
    const response = await post(csrf, cookie);
    expect(fetchMock).toHaveBeenCalledWith("https://api.example/auth/mobile/code", expect.objectContaining({
      method: "POST", body: JSON.stringify({ challenge: tx.challenge, clientId: tx.clientId, redirectUri: "usebrian-mobile://auth" }),
      headers: { "Content-Type": "application/json", Authorization: "Bearer browser-secret" },
    }));
    const callback = new URL(response.headers.get("location")!);
    expect(`${callback.protocol}//${callback.host}`).toBe("usebrian-mobile://auth");
    expect(callback.searchParams.get("state")).toBe(tx.state);
    expect(callback.searchParams.get("code")).toBe("a".repeat(43));
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
  it.each<{ headers?: Record<string, string>; fields?: Record<string, string> }>([
    { headers: { origin: "https://evil.example" } },
    { headers: { origin: "" } },
    { headers: { origin: "null" } },
    { headers: { "sec-fetch-site": "cross-site" } },
    { headers: { cookie: "access_token=another-account" } },
    { fields: { csrf: "forged" } },
    { fields: { state: "t".repeat(32) } },
    { fields: { clientId: "brian-android" } },
    { fields: { challenge: "A".repeat(43) } },
    { fields: { decision: "maybe" } },
  ])("blocks CSRF or transaction substitution %j without minting", async ({ headers, fields }) => {
    const { csrf, cookie } = await confirmation();
    const result = appCallback(await post(csrf, cookie, fields, headers));
    expect(result.get("error")).toBe("invalid_request");
    expect(result.get("state")).toBe(fields?.state ?? tx.state);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects confirmation after 10 minutes", async () => {
    vi.useFakeTimers();
    const { csrf, cookie } = await confirmation();
    vi.advanceTimersByTime(601_000);
    expect(appCallback(await post(csrf, cookie)).get("error")).toBe("invalid_request");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("returns to the app when the browser session is gone at confirmation", async () => {
    const { csrf, cookie } = await confirmation();
    const result = appCallback(await post(csrf, cookie, {}, { cookie }));
    expect(result.get("error")).toBe("login_required");
    expect(result.get("state")).toBe(tx.state);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("keeps the error page only when there is no transaction to answer", async () => {
    const { csrf, cookie } = await confirmation();
    const response = await post(csrf, cookie, { state: "bad" });
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("returns to the app when the account cannot be verified", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    const result = appCallback(await GET(new Request(url, { headers: { cookie: "access_token=browser-secret" } })));
    expect(result.get("error")).toBe("server_error");
    expect(result.get("state")).toBe(tx.state);
  });
  it("cancel echoes state without issuing credentials", async () => {
    const { csrf, cookie } = await confirmation();
    const response = await post(csrf, cookie, { decision: "deny" });
    const callback = new URL(response.headers.get("location")!);
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(callback.searchParams.get("state")).toBe(tx.state);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("escapes account identity and localizes the consent screen", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ user: { id: "u", email: '<script>alert("x")</script>', name: null } }));
    const response = await GET(new Request(url, { headers: { cookie: "access_token=browser-secret", "accept-language": "ja" } }));
    const html = await response.text();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("ログインを確認");
  });
});
