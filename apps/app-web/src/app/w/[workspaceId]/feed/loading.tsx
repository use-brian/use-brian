/**
 * Feed PANE fallback - `feed/layout.tsx` mounts `FeedSurfaceShell`, which owns
 * the surface chrome and persists across feed routes, so this covers only the
 * pane (same reasoning as `studio/loading.tsx`).
 *
 * Spec: docs/architecture/features/perceived-performance.md
 */

import { GridSurfaceSkeleton } from "@/components/chrome/surface-skeleton";

export default function FeedLoading() {
  // `padded`: the feed shell hands children a bare scroll container, unlike
  // Studio's layout which pads them itself.
  return <GridSurfaceSkeleton chrome={false} padded />;
}
