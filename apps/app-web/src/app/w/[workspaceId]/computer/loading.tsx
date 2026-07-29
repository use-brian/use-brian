/**
 * Browsers PANE fallback - `computer/layout.tsx` mounts
 * `BrowsersSurfaceShell`, which owns the operator top bar and persists across
 * session swaps, so this covers only the pane (same reasoning as
 * `studio/loading.tsx`).
 *
 * Spec: docs/architecture/features/perceived-performance.md
 */

import { GridSurfaceSkeleton } from "@/components/chrome/surface-skeleton";

export default function ComputerLoading() {
  // `padded`: `BrowsersSurfaceShell` hands children a bare scroll container.
  return <GridSurfaceSkeleton cards={4} chrome={false} padded />;
}
