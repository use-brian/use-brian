/** DOM-free browser selection helpers for the Presentation editor. [COMP:app-web/office-presentation-editor] */
import type { PresentationObject } from "@use-brian/office-model";

export type PresentationMarquee = { xPt: number; yPt: number; widthPt: number; heightPt: number };

export function repairPresentationSelection(selectedIds: string[], objects: readonly PresentationObject[]): string[] {
  const present = new Set(objects.map((object) => object.id));
  return selectedIds.filter((id, index) => present.has(id) && selectedIds.indexOf(id) === index);
}

export function togglePresentationSelection(selectedIds: string[], objectId: string, additive: boolean): string[] {
  if (!additive) return selectedIds.includes(objectId) ? selectedIds : [objectId];
  return selectedIds.includes(objectId) ? selectedIds.filter((id) => id !== objectId) : [...selectedIds, objectId];
}

export function objectsIntersectingPresentationMarquee(objects: readonly PresentationObject[], marquee: PresentationMarquee): string[] {
  const right = marquee.xPt + marquee.widthPt;
  const bottom = marquee.yPt + marquee.heightPt;
  return objects.filter((object) => {
    const geometry = object.geometry;
    return geometry.xPt < right && geometry.xPt + geometry.widthPt > marquee.xPt && geometry.yPt < bottom && geometry.yPt + geometry.heightPt > marquee.yPt;
  }).map((object) => object.id);
}

export function reorderedPresentationObjectIds(ids: string[], selectedIds: string[], action: "bringForward" | "bringToFront" | "sendBackward" | "sendToBack"): string[] {
  const selected = new Set(selectedIds);
  if (action === "bringToFront") return [...ids.filter((id) => !selected.has(id)), ...ids.filter((id) => selected.has(id))];
  if (action === "sendToBack") return [...ids.filter((id) => selected.has(id)), ...ids.filter((id) => !selected.has(id))];
  const next = [...ids];
  if (action === "bringForward") {
    for (let index = next.length - 2; index >= 0; index -= 1) if (selected.has(next[index]) && !selected.has(next[index + 1])) [next[index], next[index + 1]] = [next[index + 1], next[index]];
  } else {
    for (let index = 1; index < next.length; index += 1) if (selected.has(next[index]) && !selected.has(next[index - 1])) [next[index], next[index - 1]] = [next[index - 1], next[index]];
  }
  return next;
}
