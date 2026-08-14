import type { Editor } from "@tiptap/core";

export type DocumentHeaderImage = {
  resourceId: string;
  altText: string;
  decorative: boolean;
  widthPt: number;
  heightPt: number;
};

function positivePointValue(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function readDocumentHeaderImage(value: unknown): DocumentHeaderImage | null {
  if (!value || typeof value !== "object") return null;
  const image = value as Record<string, unknown>;
  if (typeof image.resourceId !== "string") return null;
  return {
    resourceId: image.resourceId,
    altText: image.decorative ? "" : String(image.altText ?? ""),
    decorative: image.decorative === true,
    widthPt: positivePointValue(image.widthPt, 96),
    heightPt: positivePointValue(image.heightPt, 48),
  };
}

export function findDocumentHeaderImage(editor: Editor, sectionId: string): DocumentHeaderImage | null {
  let image: DocumentHeaderImage | null = null;
  editor.state.doc.descendants((node) => {
    if (node.type.name !== "officeSection" || node.attrs.id !== sectionId) return;
    image = readDocumentHeaderImage(node.attrs.headerImage);
    return false;
  });
  return image;
}
