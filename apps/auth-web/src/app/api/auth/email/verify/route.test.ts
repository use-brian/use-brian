import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";

afterEach(() => vi.unstubAllGlobals());

describe("[COMP:app/outpost-auth] magic-link confirmation", () => {
  it("keeps GET non-consuming and forwards the token to the confirm page", () => {
    const response = GET(new Request("https://auth.example.test/api/auth/email/verify?token=secret&lang=ja"));
    const location = new URL(response.headers.get("location")!);
    expect(response.status).toBe(307);
    expect(location.pathname).toBe("/login/verify");
    expect(location.searchParams.get("token")).toBe("secret");
    expect(location.searchParams.get("lang")).toBe("ja");
  });

  it("uses the configured portal and preserves invite continuation after expiry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));
    const form = new FormData();
    form.set("token", "expired");
    form.set("next", "/invite?token=workspace-invite");

    const response = await POST(new Request("http://127.0.0.1:3095/api/auth/email/verify", { method: "POST", body: form }));
    const location = new URL(response.headers.get("location")!);

    expect(location.origin).toBe("http://localhost:3005");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error")).toBe("link_expired");
    expect(location.searchParams.get("next")).toBe("http://localhost:3005/invite?token=workspace-invite");
  });
});
