import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const session = {
  accessToken: "fresh-access",
  refreshToken: "fresh-refresh",
  user: { id: "user-1", name: "Invitee", email: "invitee@example.com" },
};

function request(cookie: string) {
  return new Request("http://localhost:3005/api/invitations/accept", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ token: "invite-token" }),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("[COMP:app/outpost-auth] invitation acceptance session refresh", () => {
  it("refreshes a missing access token and accepts with the rotated session", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(session), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ workspaceId: "workspace-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request("user=%7B%7D; refresh_token=stale-refresh"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ workspaceId: "workspace-1", appUrl: "http://localhost:3003" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:4000/auth/refresh");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ headers: expect.objectContaining({ Authorization: "Bearer fresh-access" }) });
    expect(response.headers.get("set-cookie")).toContain("access_token=fresh-access");
    expect(response.headers.get("set-cookie")).toContain("refresh_token=fresh-refresh");
  });

  it("retries once after the API rejects an expired access token", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(session), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ workspaceId: "workspace-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request("access_token=expired; refresh_token=stale-refresh"));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ headers: expect.objectContaining({ Authorization: "Bearer fresh-access" }) });
  });

  it("clears stale cookies when refresh is rejected", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "invalid" }), { status: 401 })));

    const response = await POST(request("user=%7B%7D; refresh_token=invalid"));

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toContain("user=; Path=/; Max-Age=0");
  });
});
