import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();
vi.mock("@/lib/auth-fetch", () => ({
  authFetch: (...args: unknown[]) => mockFetch(...args),
}));

import {
  cancelCodexLogin,
  disconnectCodex,
  getCodexProviderStatus,
  startCodexBrowserLogin,
  startCodexDeviceLogin,
  setPreferredProvider,
} from "../codex-provider";

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true }),
  });
});

describe("[COMP:app-web/codex-provider] local ChatGPT provider SDK", () => {
  it("uses the authenticated local-only status and login routes", async () => {
    await getCodexProviderStatus();
    await startCodexBrowserLogin();
    await startCodexDeviceLogin();

    expect(String(mockFetch.mock.calls[0][0])).toContain("/api/local/codex/status");
    expect(String(mockFetch.mock.calls[1][0])).toContain("/api/local/codex/login/browser");
    expect(mockFetch.mock.calls[1][1]).toMatchObject({ method: "POST" });
    expect(String(mockFetch.mock.calls[2][0])).toContain("/api/local/codex/login/device");
  });

  it("sends only a bounded login id for cancel and no credential for logout", async () => {
    await cancelCodexLogin("login-1");
    await disconnectCodex();
    await setPreferredProvider("openai-codex");

    expect(JSON.parse(String(mockFetch.mock.calls[0][1]?.body))).toEqual({
      loginId: "login-1",
    });
    expect(mockFetch.mock.calls[1][1]).toEqual({ method: "POST" });
    expect(JSON.parse(String(mockFetch.mock.calls[2][1]?.body))).toEqual({
      preferredProvider: "openai-codex",
    });
  });

  it("fails closed on a non-success response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
    await expect(getCodexProviderStatus()).rejects.toThrow(
      "ChatGPT provider request failed (503)",
    );
  });
});
