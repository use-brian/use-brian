import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, resolveAppLoginReturn } from "../route";
import { webAppUrl } from "@/lib/primary-auth";
import { ossSignedOutRedirect } from "@/lib/oss-entry";

vi.mock("@/lib/primary-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/primary-auth")>();
  return { ...actual, webAppUrl: vi.fn() };
});
vi.mock("@/lib/oss-entry", () => ({ ossSignedOutRedirect: vi.fn() }));

const mockedWebAppUrl = vi.mocked(webAppUrl);
const mockedOssEntry = vi.mocked(ossSignedOutRedirect);

beforeEach(() => {
  mockedWebAppUrl.mockReset();
  mockedWebAppUrl.mockReturnValue("https://usebrian.ai");
  mockedOssEntry.mockReset();
  mockedOssEntry.mockReturnValue(null);
});

describe("[COMP:app-web/login-delegation] GET /login", () => {
  it("server-redirects hosted users to the canonical login without rendering HTML", () => {
    const res = GET(new Request("https://app.usebrian.ai/login"));
    const target = new URL(res.headers.get("location")!);

    expect(res.status).toBe(307);
    expect(target.origin).toBe("https://usebrian.ai");
    expect(target.pathname).toBe("/login");
    expect(target.searchParams.get("next")).toBe("https://app.usebrian.ai/");
  });

  it("preserves a same-origin return, add-account intent, and a safe error", () => {
    const source = new URL("https://app.usebrian.ai/login");
    source.searchParams.set("next", "/desktop/auth?challenge=abcdefghijklmnop");
    source.searchParams.set("addAccount", "1");
    source.searchParams.set("error", "auth_failed");

    const res = GET(new Request(source));
    const target = new URL(res.headers.get("location")!);

    expect(target.searchParams.get("next")).toBe(
      "https://app.usebrian.ai/desktop/auth?challenge=abcdefghijklmnop",
    );
    expect(target.searchParams.get("addAccount")).toBe("1");
    expect(target.searchParams.get("error")).toBe("auth_failed");
  });

  it("collapses an off-origin or protocol-relative return to the app root", () => {
    const requestUrl = new URL("https://app.usebrian.ai/login");
    expect(
      resolveAppLoginReturn(requestUrl, "https://evil.example/phish").toString(),
    ).toBe("https://app.usebrian.ai/");
    expect(resolveAppLoginReturn(requestUrl, "//evil.example/phish").toString()).toBe(
      "https://app.usebrian.ai/",
    );
  });

  it("routes the OSS edition to its local-owner session", () => {
    mockedOssEntry.mockReturnValue(
      "/api/auth/local-session?next=%2Fw%2Fabc%2Fp",
    );

    const res = GET(
      new Request("http://localhost:3003/login?next=%2Fw%2Fabc%2Fp"),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "http://localhost:3003/api/auth/local-session?next=%2Fw%2Fabc%2Fp",
    );
    expect(mockedWebAppUrl).not.toHaveBeenCalled();
  });
});
