"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";

export function PdfPageCanvas({ document, sourcePageIndex, rotation, width, className }: {
  document: PDFDocumentProxy;
  sourcePageIndex: number;
  rotation: 0 | 90 | 180 | 270;
  width: number;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ratio, setRatio] = useState(1.294);

  useEffect(() => {
    let active = true;
    let renderTask: { cancel(): void; promise: Promise<unknown> } | null = null;
    void document.getPage(sourcePageIndex + 1).then((page) => {
      if (!active || !canvasRef.current) return;
      const unit = page.getViewport({ scale: 1, rotation });
      const scale = width / unit.width;
      const viewport = page.getViewport({ scale, rotation });
      const canvas = canvasRef.current;
      const density = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.ceil(viewport.width * density);
      canvas.height = Math.ceil(viewport.height * density);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      setRatio(viewport.height / viewport.width);
      const context = canvas.getContext("2d");
      if (!context) return;
      renderTask = page.render({ canvas, canvasContext: context, viewport, transform: density === 1 ? undefined : [density, 0, 0, density, 0, 0] });
      return renderTask.promise;
    }).catch(() => undefined);
    return () => { active = false; renderTask?.cancel(); };
  }, [document, rotation, sourcePageIndex, width]);

  return <canvas ref={canvasRef} className={className} style={{ aspectRatio: `1 / ${ratio}` }} data-pdf-page-canvas={sourcePageIndex + 1} />;
}
