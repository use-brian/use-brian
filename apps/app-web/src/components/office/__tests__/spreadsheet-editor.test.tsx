import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { officeCapabilityManifest } from "@use-brian/office-model";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { SpreadsheetEditor, gridAxisOffset } from "../spreadsheet-editor";
import { spreadsheetFixture } from "./editor-fixtures";

const coveredCapabilities = ["worksheet", "cellValue", "cellFormula", "cellStyle", "mergedCell", "rowColumnDimensions", "freezePane", "dataValidation", "conditionalFormatting", "worksheetImage", "spreadsheetPrintSetup", "spreadsheetPdf"].sort();

describe("[COMP:app-web/office-spreadsheet-editor] Spreadsheet editor", () => {
  it("renders native worksheet geometry, styling, formulas, merges, and sheet tabs", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="en" dict={en as unknown as Dictionary}><SpreadsheetEditor snapshot={spreadsheetFixture()} baseVersion={1} role="edit" suggestMode={false} onCommand={vi.fn()} /></I18nProvider>);
    expect(html).toContain('data-office-editor="spreadsheet"');
    expect(html).toContain('data-worksheet="Invoice"');
    expect(html).toContain('role="grid"');
    expect(html).toContain('role="tablist"');
    expect(html).toContain("Use Brian");
    expect(html).toContain("4.00");
    expect(html).toContain("font-family:Courier New");
    expect(html).toContain("background-color:#10202C");
    expect(html).toContain("grid-column:2 / span 2");
    expect(html).toContain('aria-label="Cell value or formula"');
    expect(html).toContain('aria-label="Add worksheet"');
    expect(html).toContain('aria-label="Duplicate worksheet"');
    expect(html).toContain('aria-label="Move worksheet left"');
    expect(html).toContain('aria-label="Move worksheet right"');
    expect(html).toContain('aria-label="Rename worksheet"');
    expect(html).toContain('aria-label="Delete worksheet"');
  });

  it("keeps an explicit editor fixture for every editable Spreadsheet capability", () => {
    const expected = officeCapabilityManifest.capabilities.filter((capability) => capability.disposition === "editable" && capability.family === "spreadsheet").map((capability) => capability.id).sort();
    expect(coveredCapabilities).toEqual(expected);
  });

  it("interpolates fractional image anchors within worksheet rows and columns", () => {
    expect(gridAxisOffset([26, 100], 0.5)).toBe(13);
    expect(gridAxisOffset([26, 100], 1.25)).toBe(51);
  });
});
