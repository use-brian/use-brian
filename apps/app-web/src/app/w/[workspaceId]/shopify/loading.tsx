/**
 * Shopify surface loading frame.
 *
 * Without this file the route had no `loading.tsx` at all, so its skeleton
 * never rendered and the pane sat blank until the first paint - the surface was
 * classified in `surfaceSkeletonKind` but nothing ever asked for the shape.
 *
 * [COMP:app-web/surface-skeleton]
 */

import { SurfaceSkeletonFor } from "@/components/chrome/surface-skeleton";

export default function Loading() {
  return <SurfaceSkeletonFor surface="shopify" />;
}
