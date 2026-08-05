import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { canLoadOfficeCardPreview, OfficeCardPreviewCanvas } from "../office-card-preview";
import { documentFixture, presentationFixture } from "./editor-fixtures";

describe("[COMP:app-web/office-card-preview] Office card preview", () => {
  it("renders the first Document page through the shared display-list renderer", () => {
    const html = renderToStaticMarkup(<OfficeCardPreviewCanvas snapshot={documentFixture()} />);
    expect(html).toContain('data-office-card-preview="document"');
    expect(html).toContain("Summary");
    expect(html).toContain("Body copy");
  });

  it("renders the first Presentation slide through the shared display-list renderer", () => {
    const html = renderToStaticMarkup(<OfficeCardPreviewCanvas snapshot={presentationFixture()} />);
    expect(html).toContain('data-office-card-preview="presentation"');
    expect(html).toContain("Title");
    expect(html).toContain("Chart: Revenue");
  });

  it("loads initialized version-zero template drafts but not empty artifact shells", () => {
    const base = { artifactId: "artifact-1", family: "document" as const, title: "Letterhead", version: 0, lifecycleState: "active" as const, role: "edit" as const };
    expect(canLoadOfficeCardPreview(base)).toBe(false);
    expect(canLoadOfficeCardPreview({ ...base, mode: "template" })).toBe(true);
    expect(canLoadOfficeCardPreview({ ...base, artifactId: "", mode: "template" })).toBe(false);
  });
});
