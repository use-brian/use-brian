import type { PdfPage, PdfRect } from "@use-brian/office-model";

export type CssRect = { left: number; top: number; width: number; height: number };

/** Convert bottom-left PDF points into the rotated, top-left DOM overlay plane. */
export function pdfRectToCss(page: Pick<PdfPage, "cropBox" | "rotation">, rect: PdfRect): CssRect {
  const width = page.cropBox.width;
  const height = page.cropBox.height;
  if (page.rotation === 90) return { left: rect.y / height, top: rect.x / width, width: rect.height / height, height: rect.width / width };
  if (page.rotation === 180) return { left: (width - rect.x - rect.width) / width, top: rect.y / height, width: rect.width / width, height: rect.height / height };
  if (page.rotation === 270) return { left: (height - rect.y - rect.height) / height, top: (width - rect.x - rect.width) / width, width: rect.height / height, height: rect.width / width };
  return { left: rect.x / width, top: (height - rect.y - rect.height) / height, width: rect.width / width, height: rect.height / height };
}

/** Convert a pointer delta in rendered CSS pixels back to canonical PDF points. */
export function cssDeltaToPdf(page: Pick<PdfPage, "cropBox" | "rotation">, dx: number, dy: number, renderedWidth: number, renderedHeight: number): { x: number; y: number } {
  const sx = dx / Math.max(1, renderedWidth);
  const sy = dy / Math.max(1, renderedHeight);
  const width = page.cropBox.width;
  const height = page.cropBox.height;
  if (page.rotation === 90) return { x: sy * width, y: sx * height };
  if (page.rotation === 180) return { x: -sx * width, y: sy * height };
  if (page.rotation === 270) return { x: -sy * width, y: -sx * height };
  return { x: sx * width, y: -sy * height };
}

export function clampPdfRect(page: Pick<PdfPage, "cropBox">, rect: PdfRect): PdfRect {
  const width = Math.max(1, Math.min(rect.width, page.cropBox.width));
  const height = Math.max(1, Math.min(rect.height, page.cropBox.height));
  return {
    x: Math.max(0, Math.min(rect.x, page.cropBox.width - width)),
    y: Math.max(0, Math.min(rect.y, page.cropBox.height - height)),
    width,
    height,
  };
}
