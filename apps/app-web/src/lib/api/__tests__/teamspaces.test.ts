/**
 * [COMP:app-web/teamspaces-sdk] Teamspaces SDK (app-web).
 * Spec: docs/architecture/features/teamspaces.md.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));

import { authFetch } from "@/lib/auth-fetch";
import {
  listTeamspaces,
  createTeamspace,
  updateTeamspace,
  deleteTeamspace,
  listTeamspaceMembers,
  addTeamspaceMember,
  removeTeamspaceMember,
  TeamspaceApiError,
  type Teamspace,
} from "../teamspaces";

const mockAuthFetch = vi.mocked(authFetch);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
});

const TS: Teamspace = {
  id: "ts-1",
  workspaceId: "w-1",
  name: "Engineering",
  icon: null,
  description: null,
  sensitivity: "internal",
  isDefault: false,
  position: 0,
  memberCount: 3,
  canManage: true,
  createdAt: "2026-07-09T00:00:00Z",
  updatedAt: "2026-07-09T00:00:00Z",
};

describe("[COMP:app-web/teamspaces-sdk] list + create", () => {
  it("lists the caller's teamspaces and unwraps the envelope", async () => {
    mockAuthFetch.mockResolvedValueOnce(json({ teamspaces: [TS] }));
    const out = await listTeamspaces("w-1");
    expect(out).toEqual([TS]);
    expect(mockAuthFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/workspaces/w-1/teamspaces"),
    );
  });

  it("tolerates a missing `teamspaces` array (older/empty body)", async () => {
    mockAuthFetch.mockResolvedValueOnce(json({}));
    await expect(listTeamspaces("w-1")).resolves.toEqual([]);
  });

  it("POSTs create with the body and returns the row", async () => {
    mockAuthFetch.mockResolvedValueOnce(json(TS, 201));
    const out = await createTeamspace("w-1", { name: "Eng", sensitivity: "internal" });
    expect(out.id).toBe("ts-1");
    const [, init] = mockAuthFetch.mock.calls[0];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ name: "Eng", sensitivity: "internal" });
  });
});

describe("[COMP:app-web/teamspaces-sdk] patch + delete", () => {
  it("PATCHes only the provided fields", async () => {
    mockAuthFetch.mockResolvedValueOnce(json({ ...TS, name: "Renamed" }));
    await updateTeamspace("ts-1", { name: "Renamed" });
    const [url, init] = mockAuthFetch.mock.calls[0];
    expect(String(url)).toContain("/api/teamspaces/ts-1");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ name: "Renamed" });
  });

  it("DELETEs a teamspace", async () => {
    mockAuthFetch.mockResolvedValueOnce(json({ ok: true }));
    await deleteTeamspace("ts-1");
    const [url, init] = mockAuthFetch.mock.calls[0];
    expect(String(url)).toContain("/api/teamspaces/ts-1");
    expect(init?.method).toBe("DELETE");
  });
});

describe("[COMP:app-web/teamspaces-sdk] members", () => {
  it("lists members and unwraps the envelope", async () => {
    mockAuthFetch.mockResolvedValueOnce(
      json({ members: [{ userId: "u-2", name: "Dana", email: "d@x.io", role: "member", clearance: "internal", addedAt: "2026-07-09T00:00:00Z" }] }),
    );
    const out = await listTeamspaceMembers("ts-1");
    expect(out[0].userId).toBe("u-2");
  });

  it("adds a member (POST userId)", async () => {
    mockAuthFetch.mockResolvedValueOnce(json({ ok: true }, 201));
    await addTeamspaceMember("ts-1", "u-2");
    const [url, init] = mockAuthFetch.mock.calls[0];
    expect(String(url)).toContain("/api/teamspaces/ts-1/members");
    expect(JSON.parse(String(init?.body))).toEqual({ userId: "u-2" });
  });

  it("removes a member by id in the path", async () => {
    mockAuthFetch.mockResolvedValueOnce(json({ ok: true }));
    await removeTeamspaceMember("ts-1", "u-2");
    const [url, init] = mockAuthFetch.mock.calls[0];
    expect(String(url)).toContain("/api/teamspaces/ts-1/members/u-2");
    expect(init?.method).toBe("DELETE");
  });
});

describe("[COMP:app-web/teamspaces-sdk] error mapping", () => {
  it("surfaces the server `{error}` code on a TeamspaceApiError so the modal can map it", async () => {
    mockAuthFetch.mockResolvedValueOnce(json({ error: "member_below_sensitivity" }, 409));
    await expect(updateTeamspace("ts-1", { sensitivity: "confidential" })).rejects.toMatchObject({
      status: 409,
      code: "member_below_sensitivity",
    });
  });

  it("add-member 409 carries `target_clearance_below_sensitivity`", async () => {
    mockAuthFetch.mockResolvedValueOnce(json({ error: "target_clearance_below_sensitivity" }, 409));
    const err = await addTeamspaceMember("ts-1", "u-2").catch((e) => e);
    expect(err).toBeInstanceOf(TeamspaceApiError);
    expect(err.code).toBe("target_clearance_below_sensitivity");
  });

  it("a non-JSON error body yields a null code but still throws", async () => {
    mockAuthFetch.mockResolvedValueOnce(new Response("gateway timeout", { status: 504 }));
    const err = await deleteTeamspace("ts-1").catch((e) => e);
    expect(err).toBeInstanceOf(TeamspaceApiError);
    expect(err.status).toBe(504);
    expect(err.code).toBeNull();
  });
});
