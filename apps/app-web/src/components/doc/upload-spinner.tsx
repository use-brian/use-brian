"use client";

/**
 * Tiny inline upload spinner shared by the media blocks' "Uploading…" state.
 * Pure SVG + `animate-spin` (no deps); inherits `currentColor` so it tints with
 * the surrounding muted text. `motion-reduce` stops the spin for vestibular
 * safety, leaving a static ring.
 */
export function UploadSpinner() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      className="shrink-0 animate-spin text-current motion-reduce:animate-none"
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
