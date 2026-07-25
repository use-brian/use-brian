import { describe, expect, it, vi } from "vitest";

import {
  isAllowedGatewayNavigation,
  isHealthyDocument,
  probeExpectedJson,
  type GatewayProbeFetch,
} from "../gateway-auth.js";

function response(status: number, body: string, contentType = "application/json") {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "Content-Type": contentType }),
    text: async () => body,
  };
}

describe("[COMP:app-desktop/gateway-auth] probeExpectedJson", () => {
  it.each([301, 302, 303, 307, 308])("classifies HTTP %s redirects as authentication", async (status) => {
    const result = await probeExpectedJson("https://brain.example/api/desktop-config", {
      fetchImpl: async () => response(status, ""),
    });
    expect(result).toEqual({ kind: "authentication-required" });
  });

  it.each([401, 403, 407])("classifies HTTP %s challenges as authentication", async (status) => {
    const result = await probeExpectedJson("https://brain.example/api/desktop-config", {
      fetchImpl: async () => response(status, "denied", "text/plain"),
    });
    expect(result).toEqual({ kind: "authentication-required" });
  });

  it.each([401, 407])("rejects unsupported HTTP-auth challenge status %s", async (status) => {
    const result = await probeExpectedJson("https://brain.example/api/desktop-config", {
      fetchImpl: async () => ({
        ...response(status, "denied", "text/plain"),
        headers: new Headers({
          [status === 407 ? "Proxy-Authenticate" : "WWW-Authenticate"]: 'Basic realm="brain"',
        }),
      }),
    });
    expect(result).toEqual({ kind: "failed" });
  });

  it("classifies a successful HTML login page as authentication", async () => {
    const result = await probeExpectedJson("https://brain.example/api/desktop-config", {
      fetchImpl: async () => response(200, "<!doctype html><title>Sign in</title>", "text/html"),
    });
    expect(result).toEqual({ kind: "authentication-required" });
  });

  it("recognizes HTML even when the gateway omits its content type", async () => {
    const result = await probeExpectedJson("https://brain.example/api/desktop-config", {
      fetchImpl: async () => response(200, "  <html>login</html>", "application/octet-stream"),
    });
    expect(result).toEqual({ kind: "authentication-required" });
  });

  it("returns parsed JSON without requiring an exact content type", async () => {
    const result = await probeExpectedJson("https://brain.example/api/desktop-config", {
      fetchImpl: async () => response(200, '{"apiUrl":"https://api.example"}', "text/plain"),
    });
    expect(result).toEqual({ kind: "ok", body: { apiUrl: "https://api.example" } });
  });

  it("preserves the older-server desktop-config 404 fallback", async () => {
    const result = await probeExpectedJson("https://brain.example/api/desktop-config", {
      allowNotFound: true,
      fetchImpl: async () => response(404, "<html>Not found</html>", "text/html"),
    });
    expect(result).toEqual({ kind: "missing" });
  });

  it("rejects malformed non-HTML success responses", async () => {
    const result = await probeExpectedJson("https://brain.example/health", {
      fetchImpl: async () => response(200, "not-json", "text/plain"),
    });
    expect(result).toEqual({ kind: "failed" });
  });

  it("returns failed when the request throws", async () => {
    const result = await probeExpectedJson("https://brain.example/health", {
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    expect(result).toEqual({ kind: "failed" });
  });

  it("sends credentials while refusing redirects and cache", async () => {
    const fetchImpl = vi.fn<GatewayProbeFetch>(async () => response(200, '{"status":"ok"}'));
    await probeExpectedJson("https://brain.example/health", { fetchImpl, timeoutMs: 1234 });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      redirect: "manual",
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    expect(fetchImpl.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
  });
});

describe("[COMP:app-desktop/gateway-auth] isHealthyDocument", () => {
  it("accepts only the API health contract", () => {
    expect(isHealthyDocument({ status: "ok", timestamp: "now" })).toBe(true);
    expect(isHealthyDocument({ status: "error" })).toBe(false);
    expect(isHealthyDocument({ ok: true })).toBe(false);
    expect(isHealthyDocument(null)).toBe(false);
    expect(isHealthyDocument([])).toBe(false);
  });
});

describe("[COMP:app-desktop/gateway-auth] isAllowedGatewayNavigation", () => {
  it("allows HTTP(S) identity redirects without downgrading HTTPS", () => {
    expect(
      isAllowedGatewayNavigation(
        "https://login.example/authorize",
        "https://brain.example/api/desktop-config",
      ),
    ).toBe(true);
    expect(
      isAllowedGatewayNavigation(
        "http://login.example/authorize",
        "http://brain.internal/api/desktop-config",
      ),
    ).toBe(true);
    expect(
      isAllowedGatewayNavigation(
        "http://login.example/authorize",
        "https://brain.example/api/desktop-config",
      ),
    ).toBe(false);
  });

  it("rejects custom protocols and malformed URLs", () => {
    expect(isAllowedGatewayNavigation("file:///tmp/login", "https://brain.example")).toBe(false);
    expect(isAllowedGatewayNavigation("javascript:alert(1)", "https://brain.example")).toBe(false);
    expect(isAllowedGatewayNavigation("not a url", "https://brain.example")).toBe(false);
  });
});
