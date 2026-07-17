import { describe, it, expect, vi, afterEach } from "vitest";
import { POST } from "../route";

function setCookies(res: Response): string[] {
  const h = res.headers;
  return (h.getSetCookie ? h.getSetCookie() : [h.get("set-cookie") ?? ""]).filter(
    Boolean,
  );
}

describe("[COMP:app-web/auth-logout] logout route", () => {
  afterEach(() => vi.unstubAllEnvs());

  // NODE_ENV is 'test' and NEXT_PUBLIC_PRIMARY_AUTH_URL is unset, so
  // primaryAuthUrl() is null → the route takes the dev (local-clear) path.
  it("dev: returns ok and clears all three auth cookies", async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const joined = setCookies(res).join("\n");
    for (const name of ["access_token", "refresh_token", "user"]) {
      // Each cleared with Max-Age=0 (host-only; no Domain in dev).
      expect(joined).toMatch(new RegExp(`${name}=;[^\\n]*Max-Age=0`, "i"));
    }
  });

  // The load-bearing invariant: a sub-app must NOT write the shared
  // `.usebrian.ai` cookies. With a primary configured (prod), the route
  // refuses (410) and writes no Set-Cookie — the client bounces to the
  // primary's logout instead.
  it("prod: returns 410 and writes no cookies", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await POST();
    expect(res.status).toBe(410);
    expect(setCookies(res)).toHaveLength(0);
  });
});
