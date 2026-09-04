import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));

import { authFetch } from "@/lib/auth-fetch";
import { syncChannelSlashCommands } from "../channels";

const mockAuthFetch = vi.mocked(authFetch);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("syncChannelSlashCommands", () => {
  it("POSTs to the encoded channel route and parses the receipt", async () => {
    mockAuthFetch.mockResolvedValue(
      new Response(JSON.stringify({ commandCount: 7, omittedCount: 2 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      syncChannelSlashCommands("workspace/one", "channel/two"),
    ).resolves.toEqual({ commandCount: 7, omittedCount: 2 });
    expect(mockAuthFetch).toHaveBeenCalledWith(
      "http://localhost:4000/api/workspaces/workspace%2Fone/channels/channel%2Ftwo/slash-commands/sync",
      { method: "POST" },
    );
  });

  it("surfaces the API detail and falls back to the response status", async () => {
    mockAuthFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "provider_rejected_commands",
          detail: "Telegram rejected the command list",
        }),
        { status: 502, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(syncChannelSlashCommands("ws", "channel")).rejects.toThrow(
      "Telegram rejected the command list",
    );

    mockAuthFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(null), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(syncChannelSlashCommands("ws", "channel")).rejects.toThrow(
      "Slash command sync failed (503)",
    );
  });

  it("rejects a malformed success receipt", async () => {
    mockAuthFetch.mockResolvedValue(
      new Response(JSON.stringify({ commandCount: 3, omittedCount: -1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(syncChannelSlashCommands("ws", "channel")).rejects.toThrow(
      "Slash command sync returned an invalid response",
    );
  });
});
