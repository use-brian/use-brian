import { describe, expect, it } from "vitest";
import { buildDelegatedLoginUrl, resolvePrimaryAuthUrl } from "@/lib/primary-auth";

describe("[COMP:app-web/login-delegation] buildDelegatedLoginUrl", () => {
  it("targets the canonical login and preserves the absolute return URL", () => {
    const result = new URL(
      buildDelegatedLoginUrl(
        "https://usebrian.ai",
        "https://app.usebrian.ai/desktop/auth?challenge=abc&state=def",
      ),
    );

    expect(result.origin).toBe("https://usebrian.ai");
    expect(result.pathname).toBe("/login");
    expect(result.searchParams.get("next")).toBe(
      "https://app.usebrian.ai/desktop/auth?challenge=abc&state=def",
    );
    expect(result.searchParams.has("addAccount")).toBe(false);
    expect(result.searchParams.has("error")).toBe(false);
  });

  it("carries add-account and error intent without changing the return URL", () => {
    const result = new URL(
      buildDelegatedLoginUrl(
        "https://auth.example.test/base",
        "https://app.example.test/w/one",
        { addAccount: true, error: "auth_failed" },
      ),
    );

    expect(result.toString()).toBe(
      "https://auth.example.test/login?next=https%3A%2F%2Fapp.example.test%2Fw%2Fone&addAccount=1&error=auth_failed",
    );
  });
});

describe("[COMP:app-web/login-delegation] deployment auth primary", () => {
  it("keeps the hosted production default", () => {
    expect(resolvePrimaryAuthUrl("hosted", undefined, "production")).toBe(
      "https://usebrian.ai",
    );
  });

  it("requires an explicit Outpost auth primary", () => {
    expect(resolvePrimaryAuthUrl("outpost", undefined, "production")).toBeNull();
    expect(
      resolvePrimaryAuthUrl(
        "outpost",
        "https://auth.private.example",
        "production",
      ),
    ).toBe("https://auth.private.example");
  });

  it("never delegates OSS local-owner auth", () => {
    expect(resolvePrimaryAuthUrl("oss", "https://auth.example", "production")).toBeNull();
  });
});
