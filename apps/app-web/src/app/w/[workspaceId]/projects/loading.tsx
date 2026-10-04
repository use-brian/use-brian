/**
 * `projects/` fallback - covers entry into `/projects` and every sub-route swap under
 * it. A project page is one reading column under a chrome row - the page shape.
 * Before this boundary existed the pane blanked (or showed a bare "...") for
 * the whole segment load (instant-navigation contract N4).
 *
 * Spec: docs/architecture/features/perceived-performance.md
 */

import { SurfaceSkeletonFor } from "@/components/chrome/surface-skeleton";

export default function ProjectsLoading() {
  return <SurfaceSkeletonFor surface="projects" chrome={false} />;
}
