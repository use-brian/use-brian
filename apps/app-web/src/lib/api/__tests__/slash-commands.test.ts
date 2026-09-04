/** [COMP:app-web/slash-command-autocomplete] Canonical command catalog client. */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));

import { authFetch } from "@/lib/auth-fetch";
import { listSlashCommands } from "../slash-commands";

const mockAuthFetch = vi.mocked(authFetch);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("[COMP:app-web/slash-command-autocomplete] API", () => {
  it("maps canonical skills to direct slugs and workflows to generated names", async () => {
    mockAuthFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      commands: [
        {
          name: "doc_architect",
          description: "Skill: Doc architect - Build documents",
          target: {
            kind: "skill",
            slug: "doc-architect",
            name: "Doc architect",
            description: "Build documents",
          },
        },
        {
          name: "workflow_daily_digest",
          description: "Workflow: Daily Digest - Send a digest",
          target: {
            kind: "workflow",
            workflowId: "workflow-1",
            name: "Daily Digest",
            description: "Send a digest",
          },
        },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(listSlashCommands("workspace / one")).resolves.toEqual([
      expect.objectContaining({
        slug: "doc-architect",
        name: "Doc architect",
        kind: "skill",
      }),
      expect.objectContaining({
        slug: "workflow_daily_digest",
        name: "Daily Digest",
        kind: "workflow",
        target: expect.objectContaining({ workflowId: "workflow-1" }),
      }),
    ]);
    expect(mockAuthFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/workspaces/workspace%20%2F%20one/slash-commands"),
    );
  });

  it("does not request a workspace-scoped catalog without a workspace", async () => {
    await expect(listSlashCommands(null)).resolves.toEqual([]);
    expect(mockAuthFetch).not.toHaveBeenCalled();
  });
});
