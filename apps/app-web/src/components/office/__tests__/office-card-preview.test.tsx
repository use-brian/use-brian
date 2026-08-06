import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { canLoadOfficeCardPreview, OfficeCardPreview, OfficeCardPreviewCanvas } from "../office-card-preview";
import { documentFixture, presentationFixture, spreadsheetFixture } from "./editor-fixtures";

describe("[COMP:app-web/office-card-preview] Office card preview", () => {
  it("renders the first Document page through the shared display-list renderer", () => {
    const html = renderToStaticMarkup(<OfficeCardPreviewCanvas snapshot={documentFixture()} />);
    expect(html).toContain('data-office-card-preview="document"');
    expect(html).toContain('data-office-card-preview-fit="width"');
    expect(html).toContain("Summary");
    expect(html).toContain("Body copy");
  });

  it("fills Document cards by width and crops page one from the top", () => {
    const html = renderToStaticMarkup(<OfficeCardPreview artifact={{
      artifactId: "artifact-1",
      family: "document",
      title: "Letter",
      version: 1,
      lifecycleState: "active",
      role: "edit",
    }} />);

    expect(html).toContain('data-office-card-preview-crop="top"');
    expect(html).toContain("aspect-[16/10] items-start");
    expect(html).toContain("w-full flex-none aspect-[612/792]");
  });

  it("fills Spreadsheet cards by width and crops the active worksheet from the top", () => {
    const shell = renderToStaticMarkup(<OfficeCardPreview artifact={{
      artifactId: "artifact-1",
      family: "spreadsheet",
      title: "Invoice",
      version: 1,
      lifecycleState: "active",
      role: "edit",
    }} />);
    const canvas = renderToStaticMarkup(<OfficeCardPreviewCanvas snapshot={spreadsheetFixture()} />);

    expect(shell).toContain('data-office-card-preview-crop="top"');
    expect(shell).toContain("w-full flex-none aspect-[595/842]");
    expect(canvas).toContain('data-office-card-preview-fit="width"');
    expect(canvas).toContain("background-color:#10202C");
    expect(canvas).toContain("font-family:Courier New,sans-serif");
    expect(canvas).toContain("font-weight:700");
    expect(canvas).toContain("align-items:center");
    expect(canvas.match(/Use Brian/g)).toHaveLength(1);
  });

  it("renders the first Presentation slide through the shared canonical slide projection", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="en" dict={en as unknown as Dictionary}><OfficeCardPreviewCanvas snapshot={presentationFixture()} /></I18nProvider>);
    expect(html).toContain('data-office-card-preview="presentation"');
    expect(html).toContain('data-presentation-slide-visual="true"');
    expect(html).toContain('data-presentation-object-visual="text"');
    expect(html).toContain("font-size:12px");
    expect(html).toContain("Title");
    expect(html).toContain("Revenue");
  });

  it("loads initialized version-zero template drafts but not empty artifact shells", () => {
    const base = { artifactId: "artifact-1", family: "document" as const, title: "Letterhead", version: 0, lifecycleState: "active" as const, role: "edit" as const };
    expect(canLoadOfficeCardPreview(base)).toBe(false);
    expect(canLoadOfficeCardPreview({ ...base, mode: "template" })).toBe(true);
    expect(canLoadOfficeCardPreview({ ...base, artifactId: "", mode: "template" })).toBe(false);
  });
});
