/**
 * [COMP:app-web/views-sdk] View SDK request and conversion contracts.
 * Specs: docs/architecture/features/doc-conversion.md and
 * docs/architecture/features/teamspaces.md.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));

import { authFetch } from "@/lib/auth-fetch";
import { exportUrl, exportFilename, reparentView } from "../views";

const mockAuthFetch = vi.mocked(authFetch);

beforeEach(() => {
  mockAuthFetch.mockReset();
});

describe("[COMP:app-web/views-sdk] export SDK helpers", () => {
  it("builds the export endpoint URL with the format query", () => {
    expect(exportUrl("page-1", "md")).toMatch(
      /\/api\/views\/page-1\/export\?format=md$/,
    );
    expect(exportUrl("page-1", "docx")).toMatch(/format=docx$/);
    expect(exportUrl("page-1", "pdf")).toMatch(/format=pdf$/);
  });

  it("encodes a page id with unsafe characters", () => {
    expect(exportUrl("a/b id", "md")).toContain("a%2Fb%20id");
  });

  it("derives a safe download filename from a title", () => {
    expect(exportFilename("Q3 Report", "md")).toBe("Q3 Report.md");
    expect(exportFilename("Q3 Report", "docx")).toBe("Q3 Report.docx");
    expect(exportFilename("Q3 Report", "pdf")).toBe("Q3 Report.pdf");
  });

  it("strips path-hostile characters and falls back to 'document'", () => {
    expect(exportFilename('a/b:c*?"<>|', "md")).toBe("abc.md");
    expect(exportFilename("", "docx")).toBe("document.docx");
    expect(exportFilename("///", "md")).toBe("document.md");
  });

  it("caps an absurdly long title", () => {
    const name = exportFilename("x".repeat(500), "md");
    expect(name.length).toBeLessThanOrEqual(103); // 100 + ".md"
  });
});

describe("[COMP:app-web/views-sdk] reparent request", () => {
  it("sends the explicit confirmation accepted by a context-changing drag", async () => {
    mockAuthFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "page-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await reparentView("page-1", {
      nestParentId: null,
      position: 0,
      teamspaceId: "teamspace-2",
      contextMoveConfirmed: true,
    });

    expect(mockAuthFetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/views\/page-1\/reparent$/),
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          nestParentId: null,
          position: 0,
          teamspaceId: "teamspace-2",
          contextMoveConfirmed: true,
        }),
      }),
    );
  });
});
