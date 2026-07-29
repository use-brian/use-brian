"use client";

/**
 * Surface transition - the on-brand enter animation the content pane plays
 * when the user moves between top-level surfaces (Home / Brain / Studio /
 * Workflow / an operator app).
 *
 * Before this, a surface switch was a hard cut: the pane blanked, then the new
 * surface appeared fully formed. Combined with the matched skeletons
 * (`surface-skeleton.tsx`) the sequence now reads as one motion - the frame
 * eases in, then fills.
 *
 * **It animates the container, never a remount.** The obvious implementation
 * (`<div key={surface}>`) would tear down and rebuild everything inside on each
 * switch, which is exactly what `p/layout.tsx` and `WorkspaceChrome` were
 * designed to avoid. Instead the wrapper toggles an animation class on and off
 * around a surface change; children are untouched, so the doc shell, its Yjs
 * socket, and any in-flight chat stream all survive.
 *
 * **Only between surfaces.** The key is `surfaceFromPathname`, not the raw
 * pathname, so a `/p/<pageId>` to `/p/<otherId>` page swap - which the shell
 * already handles as a soft in-place swap - does NOT animate. Re-animating
 * there would reintroduce the flash the shell hoist removed.
 *
 * Motion is the existing vocabulary: the `fb-rise-in` curve
 * (`cubic-bezier(0.22, 1, 0.36, 1)`) used by `.animate-rise-in`, at a shorter
 * distance and duration because a whole pane moving 6px reads as heavier than a
 * card doing it. `prefers-reduced-motion` drops it to a plain fade (see
 * `globals.css`).
 *
 * Spec: docs/architecture/features/perceived-performance.md
 * [COMP:app-web/surface-transition]
 */

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { surfaceFromPathname } from "@/lib/doc-page-url";

export function SurfaceTransition({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const surface = surfaceFromPathname(usePathname());
  const previous = useRef<string | null | undefined>(undefined);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    // `undefined` is the first render - the app just booted into this surface,
    // and the boot already had its own entrance. Only a real switch animates.
    if (previous.current === undefined) {
      previous.current = surface;
      return;
    }
    if (previous.current === surface) return;
    previous.current = surface;
    // Drop the class before re-adding it so the animation restarts even when
    // two switches land back to back.
    setPlaying(false);
    const id = requestAnimationFrame(() => setPlaying(true));
    return () => cancelAnimationFrame(id);
  }, [surface]);

  return (
    <div
      className={className}
      data-surface-enter={playing ? "true" : undefined}
      onAnimationEnd={(event) => {
        // Children animate too (skeleton fades, card staggers); only this
        // element's own animation ends the transition.
        if (event.target === event.currentTarget) setPlaying(false);
      }}
    >
      {children}
    </div>
  );
}
