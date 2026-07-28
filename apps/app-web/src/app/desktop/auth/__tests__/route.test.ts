import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../route";
import { parseLastCookie } from "@/lib/auth-cookies";
import { primaryAuthUrl } from "@/lib/primary-auth";

vi.mock("@/lib/auth-cookies", () => ({ parseLastCookie: vi.fn() }));
vi.mock("@/lib/desktop-loopback", () => ({
  loopbackRedirectBase: (value: string | null) => value,
}));
vi.mock("@/lib/primary-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/primary-auth")>();
  return { ...actual, primaryAuthUrl: vi.fn() };
});
vi.mock("@/lib/internal-api-url", () => ({
  INTERNAL_API_URL: "https://api.usebrian.ai",
}));

const mockedParseLastCookie = vi.mocked(parseLastCookie);
const mockedPrimaryAuthUrl = vi.mocked(primaryAuthUrl);

beforeEach(() => {
  mockedParseLastCookie.mockReset();
  mockedParseLastCookie.mockReturnValue(null);
  mockedPrimaryAuthUrl.mockReset();
  mockedPrimaryAuthUrl.mockReturnValue("https://usebrian.ai");
  vi.unstubAllGlobals();
});

describe("[COMP:app-web/desktop-auth-bridge] GET /desktop/auth", () => {
  it("delegates a signed-out hosted user directly to the canonical login", async () => {
    const source =
      "https://app.usebrian.ai/desktop/auth?challenge=abcdefghijklmnop&redirect=http%3A%2F%2F127.0.0.1%3A49152%2Fcb&state=abcdefgh";
    const res = await GET(new Request(source));
    const target = new URL(res.headers.get("location")!);

    expect(res.status).toBe(307);
    expect(target.origin).toBe("https://usebrian.ai");
    expect(target.pathname).toBe("/login");
    expect(target.searchParams.get("next")).toBe(source);
    expect(target.searchParams.has("addAccount")).toBe(false);
  });

  it("delegates add-account directly and strips the flag from the bridge return", async () => {
    const source =
      "https://app.usebrian.ai/desktop/auth?challenge=abcdefghijklmnop&state=abcdefgh&addAccount=1";
    const res = await GET(new Request(source));
    const target = new URL(res.headers.get("location")!);
    const returnUrl = new URL(target.searchParams.get("next")!);

    expect(target.origin).toBe("https://usebrian.ai");
    expect(target.searchParams.get("addAccount")).toBe("1");
    expect(returnUrl.origin).toBe("https://app.usebrian.ai");
    expect(returnUrl.pathname).toBe("/desktop/auth");
    expect(returnUrl.searchParams.has("addAccount")).toBe(false);
    expect(returnUrl.searchParams.get("challenge")).toBe("abcdefghijklmnop");
  });

  it("delegates an API-rejected access token directly to canonical re-auth", async () => {
    mockedParseLastCookie.mockReturnValue("expired-access");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
    );
    const source =
      "https://app.usebrian.ai/desktop/auth?challenge=abcdefghijklmnop&state=abcdefgh";

    const res = await GET(
      new Request(source, { headers: { cookie: "access_token=expired-access" } }),
    );
    const target = new URL(res.headers.get("location")!);

    expect(target.origin).toBe("https://usebrian.ai");
    expect(target.searchParams.get("next")).toBe(source);
  });

  it("keeps the local compatibility entry when no auth primary exists", async () => {
    mockedPrimaryAuthUrl.mockReturnValue(null);
    const source =
      "http://localhost:3003/desktop/auth?challenge=abcdefghijklmnop&state=abcdefgh";
    const res = await GET(new Request(source));
    const target = new URL(res.headers.get("location")!);

    expect(target.origin).toBe("http://localhost:3003");
    expect(target.pathname).toBe("/login");
    expect(target.searchParams.get("next")).toBe(
      "/desktop/auth?challenge=abcdefghijklmnop&state=abcdefgh",
    );
  });
});
