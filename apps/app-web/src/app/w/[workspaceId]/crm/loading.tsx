/**
 * CRM fallback - same operator shape as Tasks (topbar, filter strip, rows).
 *
 * Spec: docs/architecture/features/perceived-performance.md
 */

import { ListSurfaceSkeleton } from "@/components/chrome/surface-skeleton";

export default function CrmLoading() {
  return <ListSurfaceSkeleton />;
}
