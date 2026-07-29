"use client";

/**
 * Route-level fallback for everything under `/w/[workspaceId]/`, rendered
 * inside the persistent chrome (the sidebar stays put) while the destination
 * surface's segment loads.
 *
 * It used to be an empty div with an `sr-only` label, so every surface switch
 * blanked the content pane for a full round trip with no visible signal beyond
 * the 2px progress bar. Now it paints the destination's frame.
 *
 * **Why it dispatches on `usePathname()` rather than being one fixed shape:**
 * this boundary covers the *entry* into a surface, which is exactly the moment
 * that surface's own segment (and, where it has one, its layout) is still
 * loading - so a per-surface `loading.tsx` cannot help there. The App Router
 * commits the destination URL when the navigation starts, which is what already
 * makes the sidebar's active-row highlight move on click (`WorkspaceChrome`
 * reads `surfaceFromPathname(usePathname())` the same way). Reading the same
 * signal here means the skeleton matches where you are going, not where you
 * were.
 *
 * Surfaces WITHOUT a chrome-rendering layout (Brain, Workflow, Tasks, CRM) also
 * carry their own `loading.tsx`; those take precedence for sub-route swaps
 * within the surface. Studio and Feed carry pane-only ones for the same reason.
 *
 * Spec: docs/architecture/features/perceived-performance.md
 */

import { usePathname } from "next/navigation";
import { SurfaceSkeletonFor } from "@/components/chrome/surface-skeleton";
import { surfaceFromPathname } from "@/lib/doc-page-url";

export default function WorkspaceRouteLoading() {
  const pathname = usePathname();
  return <SurfaceSkeletonFor surface={surfaceFromPathname(pathname)} />;
}
