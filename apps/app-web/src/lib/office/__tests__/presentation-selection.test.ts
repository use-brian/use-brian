import { describe, expect, it } from "vitest";
import type { PresentationObject } from "@use-brian/office-model";
import {
  objectsIntersectingPresentationMarquee,
  repairPresentationSelection,
  reorderedPresentationObjectIds,
  togglePresentationSelection,
} from "../presentation-selection";

const objects = [
  { id: "a", kind: "shape", geometry: { xPt: 0, yPt: 0, widthPt: 10, heightPt: 10, rotationDeg: 0 }, locked: false, shape: "rectangle", fill: "#fff", stroke: "#000", strokeWidthPt: 1, text: [], altText: "A" },
  { id: "b", kind: "shape", geometry: { xPt: 20, yPt: 20, widthPt: 10, heightPt: 10, rotationDeg: 0 }, locked: false, shape: "rectangle", fill: "#fff", stroke: "#000", strokeWidthPt: 1, text: [], altText: "B" },
] as PresentationObject[];

describe("[COMP:app-web/office-presentation-editor] Presentation selection helpers", () => {
  it("repairs ordered selection and supports additive toggles", () => {
    expect(repairPresentationSelection(["b", "missing", "b", "a"], objects)).toEqual(["b", "a"]);
    expect(togglePresentationSelection(["a"], "b", true)).toEqual(["a", "b"]);
    expect(togglePresentationSelection(["a", "b"], "a", true)).toEqual(["b"]);
  });

  it("finds intersecting objects and preserves deterministic multi-object z-order", () => {
    expect(objectsIntersectingPresentationMarquee(objects, { xPt: 5, yPt: 5, widthPt: 18, heightPt: 18 })).toEqual(["a", "b"]);
    expect(reorderedPresentationObjectIds(["a", "b", "c", "d"], ["a", "c"], "bringForward")).toEqual(["b", "a", "d", "c"]);
    expect(reorderedPresentationObjectIds(["a", "b", "c", "d"], ["b", "d"], "sendBackward")).toEqual(["b", "a", "d", "c"]);
    expect(reorderedPresentationObjectIds(["a", "b", "c", "d"], ["a", "c"], "bringToFront")).toEqual(["b", "d", "a", "c"]);
  });
});
