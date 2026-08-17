import { beforeEach, describe, expect, it, vi } from "vitest";
import { authFetch } from "@/lib/auth-fetch";
import { releaseOfficeArtifact } from "../api";

vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));

const input = {
  expectedVersion: 3,
  action: "export" as const,
  destination: { sensitivity: "internal" as const, external: false },
  format: "pdf" as const,
};

describe("[COMP:app-web/office-iteration-panel] Office release client", () => {
  beforeEach(() => vi.mocked(authFetch).mockReset());

  it("returns a typed blocking receipt from a release 409", async () => {
    vi.mocked(authFetch).mockResolvedValue(new Response(JSON.stringify({
      receipt: {
        status: "blocked",
        version: 3,
        action: "export",
        blocks: [{ code: "presentation.timeout", message: "owned" }],
        warnings: [],
        acknowledgedCodes: [],
      },
    }), { status: 409, headers: { "Content-Type": "application/json" } }));

    const result = await releaseOfficeArtifact("artifact-1", input);
    expect(result).toMatchObject({ receipt: { status: "blocked", blocks: [{ code: "presentation.timeout" }] } });
    expect(result.fileId).toBeUndefined();
  });

  it("returns the persisted file for a ready release", async () => {
    vi.mocked(authFetch).mockResolvedValue(new Response(JSON.stringify({
      releaseId: "release-1",
      fileId: "file-1",
      receipt: { status: "ready", version: 3, action: "export", blocks: [], warnings: [], acknowledgedCodes: [] },
    }), { status: 201, headers: { "Content-Type": "application/json" } }));

    await expect(releaseOfficeArtifact("artifact-1", input)).resolves.toMatchObject({ releaseId: "release-1", fileId: "file-1", receipt: { status: "ready" } });
  });
});
