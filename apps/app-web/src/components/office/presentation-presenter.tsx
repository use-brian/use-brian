"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import type { PresentationSnapshot } from "@use-brian/office-model";
import { useT } from "@/lib/i18n/client";
import { PresentationSlideVisual } from "./presentation-slide-visual";

export function nextPresentationSlideIndex(current: number, key: string, total: number): number {
  if (total <= 0) return 0;
  if (key === "ArrowLeft" || key === "PageUp") return Math.max(0, current - 1);
  if (key === "ArrowRight" || key === "PageDown" || key === " " || key === "Enter") return Math.min(total - 1, current + 1);
  if (key === "Home") return 0;
  if (key === "End") return total - 1;
  return current;
}

export function PresentationPresenter({ snapshot, onClose }: { snapshot: PresentationSnapshot; onClose(): void }) {
  const t = useT().office;
  const [slideIndex, setSlideIndex] = useState(0);
  const presenterRef = useRef<HTMLDivElement | null>(null);
  const slide = snapshot.slides[slideIndex] ?? snapshot.slides[0];

  useEffect(() => {
    presenterRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      const next = nextPresentationSlideIndex(slideIndex, event.key, snapshot.slides.length);
      if (next === slideIndex) return;
      event.preventDefault();
      setSlideIndex(next);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, slideIndex, snapshot.slides.length]);

  if (!slide) return null;
  const position = t.slidePosition.replace("{current}", String(slideIndex + 1)).replace("{total}", String(snapshot.slides.length));
  return (
    <div ref={presenterRef} tabIndex={-1} data-office-presenter="true" role="dialog" aria-modal="true" aria-label={t.presentationPreview} className="fixed inset-0 z-[100] flex bg-black text-white outline-none">
      <PresentationSlideVisual artifactId={snapshot.artifactId} slide={slide} slideSize={snapshot.slideSize} className="h-full w-full" />
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between bg-gradient-to-b from-black/70 to-transparent p-4">
        <span className="rounded bg-black/55 px-3 py-1.5 text-sm font-medium">{position}</span>
        <button type="button" onClick={onClose} aria-label={t.exitPresentation} title={t.exitPresentation} className="pointer-events-auto rounded-full bg-black/55 p-2 hover:bg-black/75"><X className="size-5" /></button>
      </div>
      <button type="button" disabled={slideIndex === 0} onClick={() => setSlideIndex((current) => Math.max(0, current - 1))} aria-label={t.previousSlide} title={t.previousSlide} className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full bg-black/55 p-3 hover:bg-black/75 disabled:invisible"><ChevronLeft className="size-6" /></button>
      <button type="button" disabled={slideIndex === snapshot.slides.length - 1} onClick={() => setSlideIndex((current) => Math.min(snapshot.slides.length - 1, current + 1))} aria-label={t.nextSlide} title={t.nextSlide} className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full bg-black/55 p-3 hover:bg-black/75 disabled:invisible"><ChevronRight className="size-6" /></button>
    </div>
  );
}
