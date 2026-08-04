/** One command vocabulary for every adaptive Office input surface. */
import { APP_LEVEL_ASSISTANT_ID } from "@use-brian/shared";
import type { OfficeCommand, OfficeRichTextRun, PresentationObject } from "@use-brian/office-model";

const actor = { type: "user" as const, id: APP_LEVEL_ASSISTANT_ID };
const base = (artifactId: string, baseVersion: number) => ({ commandId: crypto.randomUUID(), artifactId, baseVersion, actor, origin: "manual" as const });

export function textCommand(artifactId: string, baseVersion: number, targetId: string, runs: OfficeRichTextRun[]): OfficeCommand {
  return { ...base(artifactId, baseVersion), kind: "updateText", targetId, runs };
}

export function propertyCommand(artifactId: string, baseVersion: number, targetId: string, path: string[], value: unknown): OfficeCommand {
  return { ...base(artifactId, baseVersion), kind: "setObjectProperty", targetId, path, value };
}

export function deleteCommand(artifactId: string, baseVersion: number, targetId: string): OfficeCommand {
  return { ...base(artifactId, baseVersion), kind: "deleteObject", targetId };
}

export function insertDocumentCommand(artifactId: string, baseVersion: number, sectionId: string, index: number, node: Extract<OfficeCommand, { kind: "insertDocumentNode" }>["node"]): OfficeCommand {
  return { ...base(artifactId, baseVersion), kind: "insertDocumentNode", sectionId, index, node };
}

export function insertSlideObjectCommand(artifactId: string, baseVersion: number, slideId: string, index: number, object: PresentationObject): OfficeCommand {
  return { ...base(artifactId, baseVersion), kind: "insertSlideObject", slideId, index, object };
}

export function addSlideCommand(artifactId: string, baseVersion: number, index: number, slide: Extract<OfficeCommand, { kind: "addSlide" }>["slide"]): OfficeCommand {
  return { ...base(artifactId, baseVersion), kind: "addSlide", index, slide };
}

export function reorderSlideCommand(artifactId: string, baseVersion: number, slideId: string, index: number): OfficeCommand {
  return { ...base(artifactId, baseVersion), kind: "reorderSlide", slideId, index };
}

export function defaultRun(text = ""): OfficeRichTextRun {
  return { id: crypto.randomUUID(), text, style: { fontFamily: "Arial", fontSizePt: 11, bold: false, italic: false, underline: false, strike: false, color: "#111111" } };
}
