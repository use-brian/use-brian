import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OfficeCardPreviewCanvas } from "../office-card-preview";
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
});
