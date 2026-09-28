/**
 * [COMP:app-web/connector-authorization]
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { completeConnectorAuthorizationAfterOAuth } from "@/lib/connector-authorization-completion";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("[COMP:app-web/connector-authorization] OAuth completion", () => {
  it("posts the verified instance and returns the original chat path", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });

    const result = await completeConnectorAuthorizationAfterOAuth({
      accessToken: "access-token",
      workspaceId: "workspace id",
      continuation: {
        sessionId: "11111111-1111-4111-8111-111111111111",
        approvalId: "22222222-2222-4222-8222-222222222222",
      },
      provider: "gcal",
      connectorInstanceId: "33333333-3333-4333-8333-333333333333",
    });

    expect(result).toBe(
      "/w/workspace%20id/chat?s=11111111-1111-4111-8111-111111111111",
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining(
        "/api/sessions/11111111-1111-4111-8111-111111111111/connector-authorization/22222222-2222-4222-8222-222222222222/complete",
      ),
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer access-token",
        },
        body: JSON.stringify({
          provider: "gcal",
          connectorInstanceId: "33333333-3333-4333-8333-333333333333",
        }),
      }),
    );
  });

  it("does not call the API without a complete continuation", async () => {
    globalThis.fetch = vi.fn();
    expect(
      await completeConnectorAuthorizationAfterOAuth({
        accessToken: "access-token",
        workspaceId: "workspace",
        continuation: undefined,
        provider: "gcal",
        connectorInstanceId: "33333333-3333-4333-8333-333333333333",
      }),
    ).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("keeps the normal Studio redirect available when completion is rejected", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      text: vi.fn(async () => "conflict"),
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(
      await completeConnectorAuthorizationAfterOAuth({
        accessToken: "access-token",
        workspaceId: "workspace",
        continuation: {
          sessionId: "11111111-1111-4111-8111-111111111111",
          approvalId: "22222222-2222-4222-8222-222222222222",
        },
        provider: "gcal",
        connectorInstanceId: "33333333-3333-4333-8333-333333333333",
      }),
    ).toBeNull();
  });

  it.each(["google-connector", "notion", "fathom", "msgraph"])(
    "%s callback attempts the durable completion and retains its Studio fallback",
    (provider) => {
      const source = readFileSync(
        resolve(process.cwd(), `src/app/api/auth/callback/${provider}/route.ts`),
        "utf8",
      );
      expect(source).toContain("completeConnectorAuthorizationAfterOAuth({");
      expect(source).toContain("if (resumedPath) return NextResponse.redirect");
      expect(source).toContain("connectorsPath(workspaceId, {");
    },
  );
});
