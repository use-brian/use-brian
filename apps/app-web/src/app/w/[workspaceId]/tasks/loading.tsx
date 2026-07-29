/**
 * Tasks fallback - operator topbar, filter strip, and dense table rows.
 *
 * Spec: docs/architecture/features/perceived-performance.md
 */

import { ListSurfaceSkeleton } from "@/components/chrome/surface-skeleton";

export default function TasksLoading() {
  return <ListSurfaceSkeleton />;
}
