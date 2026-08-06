import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { OfficeArtifact } from "@/lib/office/api";
import { OfficeReview } from "../office-review";

function render(family: OfficeArtifact["family"]) {
  return renderToStaticMarkup(
    <I18nProvider locale="en" dict={en}>
      <OfficeReview
        artifact={{ artifactId: "artifact-1", family, title: "Quarterly update", version: 2, lifecycleState: "active", role: "edit" }}
        artifactId="artifact-1"
        workspaceId="workspace-1"
        selectedObjectIds={[]}
        onLifecycle={() => undefined}
      />
    </I18nProvider>,
  );
}

describe("[COMP:app-web/office-iteration-panel] Office file actions", () => {
  it("keeps the normal document path focused on download and Trash", () => {
    const html = render("document");
    expect(html).toContain("Download");
    expect(html).toContain("Move to Trash");
    expect(html).not.toContain(">Present<");
    expect(html).not.toContain(">Share<");
    expect(html).not.toContain(">Publish<");
    expect(html).not.toContain("Create derivative");
    expect(html).not.toContain("Available offline");
    expect(html).not.toContain(">Archive<");
  });

  it("adds Present for presentations without exposing a generic release selector", () => {
    const html = render("presentation");
    expect(html).toContain(">Present<");
    expect(html).toContain("Download");
    expect(html).not.toContain('aria-label="Release action"');
    expect(html).not.toContain('aria-label="Destination sensitivity"');
  });

  it("adds native XLSX download and explicit PDF preview for spreadsheets", () => {
    const html = render("spreadsheet");
    expect(html).toContain("Download XLSX");
    expect(html).toContain("Preview invoice PDF");
    expect(html).not.toContain(">Present<");
  });
});
