/** [COMP:app-web/context-scope] Stable Team/Project context SDK. */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));

import { authFetch } from "@/lib/auth-fetch";
import {
  getContextExplanation,
  updateConnectorContext,
  updateContextProject,
  updateContextTeam,
} from "../context-scopes";

const mockAuthFetch = vi.mocked(authFetch);

function json(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => vi.resetAllMocks());

describe("[COMP:app-web/context-scope] registry and binding SDK", () => {
  it("updates Team metadata through stable Team ids", async () => {
    mockAuthFetch.mockResolvedValueOnce(json({ group: { id: "team-1", name: "Finance" } }));
    await expect(updateContextTeam("workspace-1", "team-1", {
      name: "Finance",
      description: "Close and reporting",
    })).resolves.toMatchObject({ id: "team-1", name: "Finance" });
    const [url, init] = mockAuthFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/workspaces/workspace-1/groups/team-1");
    expect(init.method).toBe("PATCH");
  });

  it("updates Project metadata through stable Project ids", async () => {
    mockAuthFetch.mockResolvedValueOnce(json({ project: { id: "project-1", name: "Atlas" } }));
    await updateContextProject("workspace-1", "project-1", { name: "Atlas" });
    const [url, init] = mockAuthFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/workspaces/workspace-1/projects/project-1");
    expect(init.method).toBe("PATCH");
  });

  it("requests an explainable access path for a selected Team", async () => {
    mockAuthFetch.mockResolvedValueOnce(json({
      memberTeams: [],
      assistant: null,
      activeTeam: { id: "team-1", name: "Finance" },
      activeProject: null,
      effective: { teamIds: ["team-1"], projectIds: [], teamUniverse: false, projectUniverse: true },
      rule: "intersection",
    }));
    const result = await getContextExplanation("workspace-1", { groupId: "team-1" });
    expect(result.activeTeam?.name).toBe("Finance");
    expect(mockAuthFetch.mock.calls[0][0]).toContain("context/explain?groupId=team-1");
  });

  it("binds a connector exposure without sending raw compartment keys", async () => {
    mockAuthFetch.mockResolvedValueOnce(json({}, 204));
    await updateConnectorContext("workspace-1", "connector-1", {
      contextGroupId: "team-1",
      contextProjectId: "project-1",
    });
    const [, init] = mockAuthFetch.mock.calls[0] as [string, RequestInit];
    expect(String(init.body)).toBe(JSON.stringify({
      contextGroupId: "team-1",
      contextProjectId: "project-1",
    }));
    expect(String(init.body)).not.toContain("team:team-1");
  });
});
