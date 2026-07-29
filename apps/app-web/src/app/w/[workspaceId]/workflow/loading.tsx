/**
 * Workflow fallback - the card grid the list page paints, plus the chrome row
 * (no workflow layout renders one). Also covers `/workflow/<id>` and its run
 * detail sub-route.
 *
 * Spec: docs/architecture/features/perceived-performance.md
 */

import { GridSurfaceSkeleton } from "@/components/chrome/surface-skeleton";

export default function WorkflowLoading() {
  return <GridSurfaceSkeleton />;
}
