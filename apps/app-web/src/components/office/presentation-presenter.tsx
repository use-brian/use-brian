"use client";

/** Local, model-free Presentation delivery surface. [COMP:app-web/office-presentation-editor] */
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Expand, MousePointer2, Pause, Play, RotateCcw, X } from "lucide-react";
import type { PresentationSnapshot } from "@use-brian/office-model";
import { useT } from "@/lib/i18n/client";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PresentationSlideVisual } from "./presentation-slide-visual";

export function nextPresentationSlideIndex(current: number, key: string, total: number): number {
  if (total <= 0) return 0;
  if (key === "ArrowLeft" || key === "PageUp") return Math.max(0, current - 1);
  if (key === "ArrowRight" || key === "PageDown" || key === " " || key === "Enter") return Math.min(total - 1, current + 1);
  if (key === "Home") return 0;
  if (key === "End") return total - 1;
  return current;
}

export function formatPresentationElapsed(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const remainder = seconds % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}` : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

export const PRESENTATION_AUTO_ADVANCE_SECONDS = [5, 10, 15, 30] as const;

export function PresentationPresenter({ snapshot, onClose }: { snapshot: PresentationSnapshot; onClose(): void }) {
  const t = useT().office;
  const [slideIndex, setSlideIndex] = useState(0);
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [autoSeconds, setAutoSeconds] = useState<0 | 5 | 10 | 15 | 30>(0);
  const [autoPaused, setAutoPaused] = useState(false);
  const [laserEnabled, setLaserEnabled] = useState(false);
  const [laser, setLaser] = useState<{ x: number; y: number } | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);
  const presenterRef = useRef<HTMLDivElement | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const controlsFocusedRef = useRef(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const slide = snapshot.slides[slideIndex] ?? snapshot.slides[0];

  const showControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => { if (!controlsFocusedRef.current) setControlsVisible(false); }, 2_500);
  }, []);

  const goTo = useCallback((index: number, manual = true) => {
    setSlideIndex(Math.max(0, Math.min(snapshot.slides.length - 1, index)));
    if (manual && autoSeconds > 0) setAutoPaused(true);
  }, [autoSeconds, snapshot.slides.length]);

  useEffect(() => {
    presenterRef.current?.focus();
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(Boolean(media?.matches));
    update();
    media?.addEventListener?.("change", update);
    return () => media?.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1_000)), 250);
    return () => clearInterval(timer);
  }, [startedAt]);

  useEffect(() => {
    if (!autoSeconds || autoPaused) return;
    const timer = setInterval(() => setSlideIndex((current) => {
      if (current >= snapshot.slides.length - 1) { setAutoPaused(true); return current; }
      return current + 1;
    }), autoSeconds * 1_000);
    return () => clearInterval(timer);
  }, [autoPaused, autoSeconds, snapshot.slides.length]);

  useEffect(() => {
    showControls();
    return () => { if (hideTimerRef.current) clearTimeout(hideTimerRef.current); };
  }, [showControls]);

  useEffect(() => {
    const onFullscreen = () => setFullscreen(document.fullscreenElement === presenterRef.current);
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => document.removeEventListener("fullscreenchange", onFullscreen);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.target instanceof Node && controlsRef.current?.contains(event.target)) return;
      if (event.key.toLocaleLowerCase() === "l") { event.preventDefault(); setLaserEnabled((value) => !value); return; }
      if (event.key.toLocaleLowerCase() === "p" && autoSeconds) { event.preventDefault(); setAutoPaused((value) => !value); return; }
      if (event.key.toLocaleLowerCase() === "r") { event.preventDefault(); setStartedAt(Date.now()); setElapsedSeconds(0); return; }
      if (event.key.toLocaleLowerCase() === "f") { event.preventDefault(); void toggleFullscreen(); return; }
      const next = nextPresentationSlideIndex(slideIndex, event.key, snapshot.slides.length);
      if (next === slideIndex) return;
      event.preventDefault();
      goTo(next);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [autoSeconds, goTo, onClose, slideIndex, snapshot.slides.length]);

  async function toggleFullscreen() {
    if (document.fullscreenElement) await document.exitFullscreen?.();
    else await presenterRef.current?.requestFullscreen?.();
    setFullscreen(Boolean(document.fullscreenElement));
  }

  function pointerMove(event: React.PointerEvent<HTMLDivElement>) {
    showControls();
    if (!laserEnabled) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const width = rect.width || 1;
    const height = rect.height || 1;
    setLaser({ x: (event.clientX - rect.left) / width * 100, y: (event.clientY - rect.top) / height * 100 });
  }

  if (!slide) return null;
  const position = t.slidePosition.replace("{current}", String(slideIndex + 1)).replace("{total}", String(snapshot.slides.length));
  return (
    <div ref={presenterRef} tabIndex={-1} data-office-presenter="true" data-reduced-motion={reducedMotion ? "true" : "false"} role="dialog" aria-modal="true" aria-label={t.presentationPreview} onPointerMove={pointerMove} className="fixed inset-0 z-[100] flex bg-black text-white outline-none">
      <div className="relative flex min-w-0 flex-1 items-center justify-center overflow-hidden">
        <PresentationSlideVisual artifactId={snapshot.artifactId} slide={slide} slideSize={snapshot.slideSize} className="h-full w-full" />
        {laserEnabled && laser ? <span data-presentation-laser="true" className="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-red-500 shadow-[0_0_18px_6px_rgba(239,68,68,0.7)] motion-safe:animate-pulse motion-reduce:animate-none" style={{ left: `${laser.x}%`, top: `${laser.y}%` }} /> : null}
        <button type="button" onClick={onClose} aria-label={t.exitPresentation} title={t.exitPresentation} className="absolute right-4 top-4 rounded-full bg-black/65 p-2 hover:bg-black/85"><X className="size-5" /></button>
        <button type="button" disabled={slideIndex === 0} onClick={() => goTo(slideIndex - 1)} aria-label={t.previousSlide} title={t.previousSlide} className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full bg-black/55 p-3 hover:bg-black/75 disabled:invisible"><ChevronLeft className="size-6" /></button>
        <button type="button" disabled={slideIndex === snapshot.slides.length - 1} onClick={() => goTo(slideIndex + 1)} aria-label={t.nextSlide} title={t.nextSlide} className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full bg-black/55 p-3 hover:bg-black/75 disabled:invisible"><ChevronRight className="size-6" /></button>
      </div>
      <div ref={controlsRef} data-presenter-controls-visible={controlsVisible ? "true" : "false"} onFocusCapture={() => { controlsFocusedRef.current = true; setControlsVisible(true); }} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { controlsFocusedRef.current = false; showControls(); } }} className={`absolute inset-x-0 bottom-0 z-20 flex flex-wrap items-center gap-2 bg-black/80 p-3 transition-opacity ${controlsVisible ? "opacity-100" : "pointer-events-none opacity-0"}`}>
        <span className="rounded bg-white/10 px-2 py-1 text-sm font-medium" aria-live="polite">{position}</span>
        <span aria-label={t.elapsedTime} className="min-w-14 font-mono text-sm">{formatPresentationElapsed(elapsedSeconds)}</span>
        <button type="button" aria-label={t.resetTimer} title={t.resetTimer} onClick={() => { setStartedAt(Date.now()); setElapsedSeconds(0); }} className="rounded p-2 hover:bg-white/10"><RotateCcw className="size-4" /></button>
        <Select value={String(slideIndex)} onValueChange={(value) => value !== null && goTo(Number(value))}>
          <SelectTrigger size="sm" className="w-44 border-white/30 bg-black text-white" aria-label={t.slidePicker}><SelectValue /></SelectTrigger>
          <SelectContent>{snapshot.slides.map((item, index) => <SelectItem key={item.id} value={String(index)}>{index + 1}. {item.title}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={String(autoSeconds)} onValueChange={(value) => { const seconds = Number(value) as 0 | 5 | 10 | 15 | 30; setAutoSeconds(seconds); setAutoPaused(false); }}>
          <SelectTrigger size="sm" className="w-44 border-white/30 bg-black text-white" aria-label={t.autoAdvance}><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="0">{t.autoAdvanceOff}</SelectItem>{PRESENTATION_AUTO_ADVANCE_SECONDS.map((seconds) => <SelectItem key={seconds} value={String(seconds)}>{t.autoAdvanceSeconds.replace("{seconds}", String(seconds))}</SelectItem>)}</SelectContent>
        </Select>
        {autoSeconds ? <button type="button" onClick={() => setAutoPaused((value) => !value)} className="inline-flex items-center gap-1 rounded px-2 py-1.5 text-xs hover:bg-white/10">{autoPaused ? <Play className="size-4" /> : <Pause className="size-4" />}{autoPaused ? t.resumeAutoAdvance : t.pauseAutoAdvance}</button> : null}
        <button type="button" aria-pressed={laserEnabled} onClick={() => { setLaserEnabled((value) => !value); setLaser(null); }} className="inline-flex items-center gap-1 rounded px-2 py-1.5 text-xs hover:bg-white/10"><MousePointer2 className="size-4" />{t.laserPointer}</button>
        <button type="button" aria-pressed={fullscreen} onClick={() => void toggleFullscreen()} className="ml-auto inline-flex items-center gap-1 rounded px-2 py-1.5 text-xs hover:bg-white/10"><Expand className="size-4" />{t.fullscreen}</button>
        <div className="basis-full rounded bg-white/10 px-3 py-2 text-xs"><strong>{t.speakerNotes}</strong><p className="mt-1 whitespace-pre-wrap text-white/80">{slide.notes.map((run) => run.text).join("") || t.noSpeakerNotes}</p></div>
      </div>
    </div>
  );
}
