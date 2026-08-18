/**
 * [COMP:app-web/views-sdk] Format-conversion SDK helpers (the pure parts).
 * Spec: docs/architecture/features/doc-conversion.md.
 */

import { describe, it, expect } from "vitest";
import { exportUrl, exportFilename } from "../views";

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
