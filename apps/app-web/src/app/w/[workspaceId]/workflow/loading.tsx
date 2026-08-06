/**
 * Workflow fallback - the card grid the list page paints. The persistent
 * Workflow top bar is provided by `workflow/layout.tsx`; this fallback covers
 * the list, board, and run-detail sub-routes.
 *
 * Spec: docs/architecture/features/perceived-performance.md
 */

import { GridSurfaceSkeleton } from "@/components/chrome/surface-skeleton";

export default function WorkflowLoading() {
  return <GridSurfaceSkeleton />;
}
