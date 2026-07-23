/** [COMP:api/account-avatar] app-web account avatar wire contract. */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));

import { authFetch } from "@/lib/auth-fetch";
import { uploadAvatar } from "../account";

const mockAuthFetch = vi.mocked(authFetch);

beforeEach(() => {
  vi.resetAllMocks();
  mockAuthFetch.mockResolvedValue(new Response(null, { status: 200 }));
});

describe("[COMP:api/account-avatar] app-web account API", () => {
  it("sends the active workspaceId with the avatar multipart upload", async () => {
    const file = new File([new Uint8Array([0x89, 0x50])], "me.png", { type: "image/png" });

    expect(await uploadAvatar(file, "ws-active")).toBe(true);

    const init = mockAuthFetch.mock.calls[0][1];
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeInstanceOf(FormData);
    const form = init?.body as FormData;
    expect(form.get("workspaceId")).toBe("ws-active");
    expect(form.get("file")).toBe(file);
  });
});
