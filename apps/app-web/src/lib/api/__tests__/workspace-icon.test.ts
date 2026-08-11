/** [COMP:app-web/workspace-icon] Workspace icon SDK wire contract. */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));

import { authFetch } from "@/lib/auth-fetch";
import { removeWorkspaceIcon, uploadWorkspaceIcon } from "../workspaces";

const mockAuthFetch = vi.mocked(authFetch);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("[COMP:app-web/workspace-icon] API", () => {
  it("uploads one multipart file to the workspace icon path", async () => {
    mockAuthFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ iconUrl: "https://api.example/api/workspace-icons/ws-1?v=a" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const file = new File([new Uint8Array([0x89, 0x50])], "team.png", {
      type: "image/png",
    });

    const result = await uploadWorkspaceIcon("ws-1", file);
    expect(result.iconUrl).toContain("/api/workspace-icons/ws-1");
    expect(mockAuthFetch.mock.calls[0][0]).toContain(
      "/api/workspaces/ws-1/icon",
    );
    const init = mockAuthFetch.mock.calls[0][1];
    expect(init?.method).toBe("POST");
    expect((init?.body as FormData).get("file")).toBe(file);
  });

  it("removes the custom picture with DELETE", async () => {
    mockAuthFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ iconUrl: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(await removeWorkspaceIcon("ws-1")).toEqual({ iconUrl: null });
    expect(mockAuthFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/workspaces/ws-1/icon"),
      { method: "DELETE" },
    );
  });
});
