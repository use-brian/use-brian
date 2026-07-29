/**
 * Brain fallback - covers entry into `/brain` and every sub-route swap
 * (`/brain/<entityId>`, `/brain/skills/<id>`, `/brain/entry/<kind>/<id>`).
 * Brain has no chrome-rendering layout, so this boundary owns the whole pane
 * including the topbar row.
 *
 * Spec: docs/architecture/features/perceived-performance.md
 */

import { BrainSurfaceSkeleton } from "@/components/chrome/surface-skeleton";

export default function BrainLoading() {
  return <BrainSurfaceSkeleton />;
}
