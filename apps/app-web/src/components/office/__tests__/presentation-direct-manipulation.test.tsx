import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import {
  moveOrResizePresentationGeometry,
  nudgePresentationGeometry,
  PresentationGeometryToolbar,
  PresentationObjectFrame,
  rotatePresentationGeometry,
  updatePresentationRunsText,
} from "../presentation-object-frame";
import { presentationFixture } from "./editor-fixtures";

describe("[COMP:app-web/office-presentation-editor] Presentation direct manipulation", () => {
  const start = { xPt: 100, yPt: 80, widthPt: 240, heightPt: 120, rotationDeg: 0 };

  it("moves, resizes, rotates, and nudges canonical point geometry", () => {
    expect(moveOrResizePresentationGeometry(start, "move", 25.26, -10.04)).toEqual({ ...start, xPt: 125.3, yPt: 70 });
    expect(moveOrResizePresentationGeometry(start, "nw", 20, 10)).toEqual({ ...start, xPt: 120, yPt: 90, widthPt: 220, heightPt: 110 });
    expect(moveOrResizePresentationGeometry(start, "w", 500, 0)).toEqual({ ...start, xPt: 328, widthPt: 12 });
    expect(rotatePresentationGeometry(start, 340, 140, false).rotationDeg).toBe(90);
    expect(rotatePresentationGeometry(start, 300, 80, true).rotationDeg).toBe(60);
    expect(nudgePresentationGeometry(start, "ArrowRight", false).xPt).toBe(101);
    expect(nudgePresentationGeometry(start, "ArrowUp", true).yPt).toBe(70);
  });

  it("preserves unaffected rich-text runs and applies edits to the active run", () => {
    const snapshot = presentationFixture();
    const object = snapshot.slides[0].objects[0];
    if (object.kind !== "text") throw new Error("text fixture required");
    const white = { ...object.runs[0], text: "Use Brian\n", style: { ...object.runs[0].style, bold: true, color: "#EAF8FF" } };
    const cyan = { ...object.runs[0], id: "00000000-0000-4000-8000-000000000099", text: "Brand presentation template", style: { ...object.runs[0].style, bold: true, color: "#34D3FF" } };
    const appended = updatePresentationRunsText([white, cyan], "Use Brian\nBrand presentation template!");
    expect(appended).toEqual([white, { ...cyan, text: "Brand presentation template!" }]);
    const replaced = updatePresentationRunsText([white, cyan], "Use Brian\nBrand deck template");
    expect(replaced[0]).toBe(white);
    expect(replaced[1]).toMatchObject({ id: cyan.id, text: "Brand deck template", style: cyan.style });
    const cleared = updatePresentationRunsText([white, cyan], "");
    expect(cleared).toEqual([{ ...white, text: "" }]);
    expect(updatePresentationRunsText(cleared, "Replacement")).toEqual([{ ...white, text: "Replacement" }]);
  });

  it("renders eight resize handles, rotation, and the in-flow numeric toolbar", () => {
    const snapshot = presentationFixture();
    const object = snapshot.slides[0].objects[0];
    const html = renderToStaticMarkup(<I18nProvider locale="en" dict={en as unknown as Dictionary}>
      <PresentationObjectFrame artifactId={snapshot.artifactId} object={object} selected primary canChange slideSize={snapshot.slideSize} onSelect={vi.fn()} onText={vi.fn()} onGeometryPreview={vi.fn()} onGeometry={vi.fn()} />
      <PresentationGeometryToolbar object={object} disabled={false} onProperty={vi.fn()} onDelete={vi.fn()} />
    </I18nProvider>);
    expect(html).toContain('data-direct-manipulation="true"');
    expect(html.match(/data-resize-handle=/g)).toHaveLength(8);
    expect(html).toContain('data-rotate-handle="true"');
    expect(html).toContain('data-properties-toolbar="true"');
    expect(html).not.toContain("<aside");
  });
});
