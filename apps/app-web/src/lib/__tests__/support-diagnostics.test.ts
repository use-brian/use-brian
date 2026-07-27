import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();
vi.mock("@/lib/auth-fetch", () => ({
  authFetch: (...args: unknown[]) => mockFetch(...args),
}));

import {
  getSupportDiagnosticStatus,
  previewSupportDiagnosticCapsule,
  startSupportDiagnosticCapture,
  stopSupportDiagnosticCapture,
} from "../support-diagnostics";

describe("[COMP:app-web/support-diagnostics] support diagnostics SDK", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ active: false, capture: null }),
    });
  });

  it("uses only the authenticated local support-diagnostics surface", async () => {
    await getSupportDiagnosticStatus("workspace-1");
    await previewSupportDiagnosticCapsule("workspace-1");

    expect(String(mockFetch.mock.calls[0][0])).toContain(
      "/api/support-diagnostics/status?workspaceId=workspace-1",
    );
    expect(String(mockFetch.mock.calls[1][0])).toContain(
      "/api/support-diagnostics/capsule/preview",
    );
    expect(JSON.parse(String(mockFetch.mock.calls[1][1]?.body))).toEqual({
      workspaceId: "workspace-1",
    });
  });

  it("sends the bounded duration and explicit content consent", async () => {
    await startSupportDiagnosticCapture({
      workspaceId: "workspace-1",
      durationHours: 24,
      includeContent: true,
    });
    await stopSupportDiagnosticCapture("workspace-1");

    expect(JSON.parse(String(mockFetch.mock.calls[0][1]?.body))).toEqual({
      workspaceId: "workspace-1",
      durationHours: 24,
      includeContent: true,
    });
    expect(mockFetch.mock.calls[1][1]?.method).toBe("DELETE");
  });

  it("fails closed with the API error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: "A support capture is already active" }),
    });

    await expect(
      startSupportDiagnosticCapture({
        workspaceId: "workspace-1",
        durationHours: 24,
        includeContent: false,
      }),
    ).rejects.toThrow("A support capture is already active");
  });
});
