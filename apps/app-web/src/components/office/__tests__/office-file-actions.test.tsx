/** @vitest-environment jsdom */

import { act } from "react";
import { describe, expect, it } from "vitest";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { OfficeArtifact } from "@/lib/office/api";
import { OfficeReview, officeReleaseIssueMessage } from "../office-review";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function artifact(family: OfficeArtifact["family"], lifecycleState: OfficeArtifact["lifecycleState"] = "active", title = "Quarterly update"): OfficeArtifact {
  return { artifactId: "artifact-1", family, title, version: 2, lifecycleState, role: "edit" };
}

function review(subject: OfficeArtifact) {
  return <I18nProvider locale="en" dict={en}>
    <OfficeReview
      artifact={subject}
      artifactId="artifact-1"
      workspaceId="workspace-1"
      selectedObjectIds={[]}
      onLifecycle={() => undefined}
    />
  </I18nProvider>;
}

function render(family: OfficeArtifact["family"]) {
  return renderToStaticMarkup(
    review(artifact(family)),
  );
}

describe("[COMP:app-web/office-iteration-panel] Office file actions", () => {
  it("keeps the normal document path focused on download and Trash", () => {
    const html = render("document");
    expect(html).toContain("Download");
    expect(html).toContain("Move to Trash");
    expect(html).toContain("Preview document PDF");
    expect(html).not.toContain(">Present<");
    expect(html).not.toContain(">Share<");
    expect(html).not.toContain(">Publish<");
    expect(html).not.toContain("Create derivative");
    expect(html).toContain("Make available offline");
    expect(html).not.toContain(">Archive<");
  });

  it("adds Present for presentations without exposing a generic release selector", () => {
    const html = render("presentation");
    expect(html).toContain(">Present<");
    expect(html).toContain("Download");
    expect(html).toContain("Preview presentation PDF");
    expect(html).not.toContain('aria-label="Release action"');
    expect(html).not.toContain('aria-label="Destination sensitivity"');
  });

  it("localizes every owned Presentation PDF failure code", () => {
    expect([
      "presentation.converter_unavailable",
      "presentation.timeout",
      "presentation.invalid_pdf",
      "presentation.page_count_mismatch",
    ].map((code) => officeReleaseIssueMessage({ code, message: "vendor text" }, en.office))).toEqual([
      en.office.presentationPdfConverterUnavailable,
      en.office.presentationPdfTimeout,
      en.office.presentationPdfInvalid,
      en.office.presentationPdfPageCountMismatch,
    ]);
  });

  it("localizes every owned Document PDF failure code", () => {
    expect([
      "document.converter_unavailable",
      "document.timeout",
      "document.invalid_pdf",
      "document.page_count_mismatch",
    ].map((code) => officeReleaseIssueMessage({ code, message: "vendor text" }, en.office))).toEqual([
      en.office.documentPdfConverterUnavailable,
      en.office.documentPdfTimeout,
      en.office.documentPdfInvalid,
      en.office.documentPdfPageCountMismatch,
    ]);
  });

  it("adds native XLSX download and explicit PDF preview for spreadsheets", () => {
    const html = render("spreadsheet");
    expect(html).toContain("Download XLSX");
    expect(html).toContain("Preview invoice PDF");
    expect(html).not.toContain(">Present<");
  });

  it("keeps the full deletion title visible while the member types", () => {
    const title = "Generate a 10 pages presentation with the complete quarterly launch plan";
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(review(artifact("presentation", "trash", title))));

    const input = host.querySelector<HTMLInputElement>("input")!;
    const referenceId = input.getAttribute("aria-describedby")!;
    const reference = host.querySelector<HTMLElement>(`[id="${referenceId}"]`)!;
    const deleteButton = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Delete permanently")!;
    expect(reference.textContent).toBe(title);
    expect(reference.className).toContain("break-words");
    expect(input.placeholder).toBe("Enter the title shown above");

    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setValue.call(input, title[0]);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(input.value).toBe(title[0]);
    expect(reference.textContent).toBe(title);
    expect(deleteButton.disabled).toBe(true);

    act(() => {
      setValue.call(input, title);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(deleteButton.disabled).toBe(false);

    act(() => root.unmount());
  });
});
