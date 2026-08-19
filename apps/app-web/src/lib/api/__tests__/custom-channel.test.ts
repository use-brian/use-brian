/** [COMP:app-web/studio-custom-channel] custom channel state wire contract. */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));

import { authFetch } from "@/lib/auth-fetch";
import { getCustomChannelState } from "../channels";

const mockAuthFetch = vi.mocked(authFetch);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("[COMP:app-web/studio-custom-channel] getCustomChannelState", () => {
  it("unwraps the { state } envelope the route returns", async () => {
    mockAuthFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          state: {
            status: "needs_action",
            online: true,
            lastSeenAt: "2026-08-19T11:39:19.732Z",
            bridgeVersion: "abc123",
            action: { kind: "qr", imageDataUrl: "data:image/png;base64,AAA" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const s = await getCustomChannelState("ws-1", "chan-1");
    expect(s.status).toBe("needs_action");
    expect(s.online).toBe(true);
    expect(s.lastSeenAt).toBe("2026-08-19T11:39:19.732Z");
    expect(s.action).toEqual({ kind: "qr", imageDataUrl: "data:image/png;base64,AAA" });
  });

  it("treats { state: null } (bridge never reported) as connecting + offline", async () => {
    mockAuthFetch.mockResolvedValue(
      new Response(JSON.stringify({ state: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const s = await getCustomChannelState("ws-1", "chan-1");
    expect(s.status).toBe("connecting");
    expect(s.online).toBe(false);
    expect(s.lastSeenAt).toBeNull();
    expect(s.action).toBeNull();
  });
});
