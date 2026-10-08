// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: mocks.fetch }));

import { fetchAssistantDetail, fetchAssistantSettings } from "../assistant-detail";
import { readSurfaceCache, resetSurfaceCache } from "@/lib/surface-cache";
import { assistantDetailCacheKey, assistantSettingsCacheKey } from "@/lib/surface-prefetch";

const ROWS = [
  { id: "a-1", name: "First", role: "owner", workspaceId: "w-1", clearance: "internal" },
  { id: "a-2", name: "Second", role: "admin", workspaceId: "w-1", clearance: "confidential" },
  { id: "a-3", name: "Elsewhere", role: "owner", workspaceId: "w-2", clearance: "internal" },
];

function route(url: string): Response {
  if (url.endsWith("/api/assistants")) return Response.json({ assistants: ROWS });
  if (url.endsWith("/api/workspaces/w-1")) return Response.json({ name: "Fixture Co", role: "admin" });
  if (url.endsWith("/api/assistants/a-1/playbook")) return Response.json({ rules: [] });
  if (url.endsWith("/api/assistants/a-1")) {
    return Response.json({ name: "First", workspaceId: "w-1", defaultModelAlias: "max", charter: { mission: "Ship it" } });
  }
  return new Response(null, { status: 404 });
}

beforeEach(() => {
  resetSurfaceCache();
  mocks.fetch.mockImplementation(async (url: string) => route(url));
});
afterEach(() => vi.clearAllMocks());

describe("[COMP:app-web/assistant-detail] row-switch stability", () => {
  it("seeds every sibling in the rail workspace from the one roster read", async () => {
    const snap = await fetchAssistantDetail("a-1", "w-1");
    expect(snap.workspaceRole).toBe("admin");

    const sibling = readSurfaceCache<{ assistant: { id: string; role: string }; workspaceName: string | null; workspaceRole: string | null }>(
      assistantDetailCacheKey("w-1", "a-2"),
    ).data;
    // The full header (role, workspace badge, role-gated clearance picker)
    // paints on the first frame of a row switch.
    expect(sibling?.assistant.role).toBe("admin");
    expect(sibling?.workspaceName).toBe("Fixture Co");
    expect(sibling?.workspaceRole).toBe("admin");

    // Rows from another workspace never land under this rail's keys.
    expect(readSurfaceCache(assistantDetailCacheKey("w-1", "a-3")).data).toBeUndefined();
  });

  it("does not seed siblings when no rail workspace is given", async () => {
    await fetchAssistantDetail("a-1");
    expect(readSurfaceCache(assistantDetailCacheKey("w-1", "a-2")).data).toBeUndefined();
  });

  it("reads Settings as one snapshot under the assistant key family", async () => {
    const snap = await fetchAssistantSettings("a-1");
    expect(snap).toMatchObject({
      name: "First",
      workspaceId: "w-1",
      workspaceName: "Fixture Co",
      defaultModelAlias: "max",
      charter: { mission: "Ship it", audience: "", success: "", instructions: "" },
      playbook: [],
    });
    // ASSISTANT_REFRESH_EVENT marks `assistant:<wid>:` stale; the Settings
    // read must ride that family to revalidate with the header.
    expect(assistantSettingsCacheKey("w-1", "a-1").startsWith("assistant:w-1")).toBe(true);
  });
});
