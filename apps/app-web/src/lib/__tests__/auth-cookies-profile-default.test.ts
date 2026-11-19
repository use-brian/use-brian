import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROFILE_DEFAULT_COOKIE_DOMAIN,
  resolveCookieDomain,
} from "@/lib/auth-cookies";

// The auth-cookie domain is resolved once at module load from NODE_ENV,
// COOKIE_DOMAIN and the deployment profile, so the issued-cookie cases reload
// the module (and the route that imports it) under each environment shape.
type Shape = {
  edition?: string;
  cookieDomain?: string;
  nodeEnv?: string;
};

function stubShape({ edition, cookieDomain, nodeEnv = "production" }: Shape) {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", nodeEnv);
  vi.stubEnv("USEBRIAN_EDITION", edition);
  vi.stubEnv("NEXT_PUBLIC_USEBRIAN_EDITION", undefined);
  vi.stubEnv("COOKIE_DOMAIN", cookieDomain);
}

async function loadCookies(shape: Shape) {
  stubShape(shape);
  return import("@/lib/auth-cookies");
}

function setCookieLines(headers: Headers): string[] {
  return headers.getSetCookie();
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("[COMP:app-web/auth-cookies] profile default cookie domain", () => {
  it("only the hosted profile carries a shared parent", () => {
    expect(PROFILE_DEFAULT_COOKIE_DOMAIN).toEqual({
      hosted: ".usebrian.ai",
      oss: undefined,
      outpost: undefined,
    });
  });

  it.each([
    // [profile, COOKIE_DOMAIN, production, expected]
    ["oss", undefined, true, undefined],
    ["oss", "", true, undefined],
    ["oss", "   ", true, undefined],
    ["oss", ".brian.customer.example", true, ".brian.customer.example"],
    ["oss", undefined, false, undefined],
    ["outpost", undefined, true, undefined],
    ["outpost", "", true, undefined],
    ["outpost", ".brian.customer.example", true, ".brian.customer.example"],
    ["hosted", undefined, true, ".usebrian.ai"],
    ["hosted", "", true, undefined],
    ["hosted", ".staging.example.com", true, ".staging.example.com"],
    ["hosted", undefined, false, undefined],
  ] as const)(
    "%s with COOKIE_DOMAIN=%j (production %s) resolves %j",
    (profile, configured, secure, expected) => {
      expect(resolveCookieDomain(configured, secure, profile)).toBe(expected);
    },
  );

  it("treats an omitted profile as hosted, like an unset edition", () => {
    expect(resolveCookieDomain(undefined, true)).toBe(".usebrian.ai");
  });
});

describe("[COMP:app-web/auth-cookies] issued cookies per edition", () => {
  it.each([
    // [edition, COOKIE_DOMAIN, expected Domain]
    ["oss", undefined, undefined],
    ["oss", "", undefined],
    ["oss", ".brian.customer.example", ".brian.customer.example"],
    ["outpost", undefined, undefined],
    [undefined, undefined, ".usebrian.ai"],
    ["hosted", undefined, ".usebrian.ai"],
    ["hosted", "", undefined],
    ["hosted", ".staging.example.com", ".staging.example.com"],
  ] as const)(
    "production edition=%s COOKIE_DOMAIN=%j issues Domain %j on every auth cookie",
    async (edition, cookieDomain, expected) => {
      const mod = await loadCookies({ edition, cookieDomain });
      for (const cookie of [
        mod.accessTokenCookie("access"),
        mod.refreshTokenCookie("refresh"),
        mod.userCookie("{}"),
      ]) {
        expect(cookie.secure).toBe(true);
        if (expected === undefined) expect(cookie).not.toHaveProperty("domain");
        else expect(cookie.domain).toBe(expected);
      }

      const cleared = new Headers();
      mod.applyClearedCookies({ headers: cleared });
      const clears = setCookieLines(cleared);
      const scoped = clears.filter((line) => /;\s*Domain=/i.test(line));
      expect(clears.length - scoped.length).toBe(3);
      expect(scoped).toHaveLength(expected === undefined ? 0 : 3);
      for (const line of scoped) expect(line).toContain(`Domain=${expected}`);

      const legacy = new Headers();
      mod.appendLegacyHostOnlyClears({ headers: legacy });
      expect(setCookieLines(legacy)).toHaveLength(expected === undefined ? 0 : 3);
    },
  );

  it("development stays host-only in the hosted profile", async () => {
    const mod = await loadCookies({ nodeEnv: "development" });
    expect(mod.accessTokenCookie("access")).not.toHaveProperty("domain");
  });
});

describe("[COMP:app-web/auth-cookies] local-session sign-in boundary", () => {
  async function signIn(shape: Shape) {
    stubShape(shape);
    vi.stubEnv("PUBLIC_PRIMARY_AUTH_URL", undefined);
    vi.stubEnv("NEXT_PUBLIC_PRIMARY_AUTH_URL", undefined);
    vi.stubEnv("CLOUDFLARE_ACCESS_TEAM_DOMAIN", undefined);
    vi.stubEnv("CLOUDFLARE_ACCESS_AUD", undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          accessToken: "invented-access",
          refreshToken: "invented-refresh",
          user: { id: "owner-1", email: null, name: "Local Owner" },
        }),
      ),
    );
    const { GET } = await import("@/app/api/auth/local-session/route");
    return GET(new Request("http://localhost:3003/api/auth/local-session"));
  }

  it("a production OSS build on localhost issues host-only auth cookies with COOKIE_DOMAIN unset", async () => {
    const res = await signIn({ edition: "oss" });
    expect(res.status).toBe(307);
    const lines = setCookieLines(res.headers);
    for (const name of ["access_token", "refresh_token", "user"]) {
      const line = lines.find((l) => l.startsWith(`${name}=`) && !/Max-Age=0/i.test(l));
      expect(line, name).toBeDefined();
      expect(line).not.toMatch(/;\s*Domain=/i);
    }
    // No legacy clears either: they would expire the host-only cookies just set.
    expect(lines.filter((l) => /Max-Age=0/i.test(l))).toHaveLength(0);
  });

  it("an explicit COOKIE_DOMAIN still scopes the OSS sign-in cookies", async () => {
    const res = await signIn({ edition: "oss", cookieDomain: ".brian.customer.example" });
    const issued = setCookieLines(res.headers).filter((l) => !/Max-Age=0/i.test(l));
    expect(issued).toHaveLength(3);
    for (const line of issued) expect(line).toMatch(/Domain=\.brian\.customer\.example/i);
  });
});
