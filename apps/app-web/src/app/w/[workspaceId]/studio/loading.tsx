/**
 * Studio SECTION fallback - pane only.
 *
 * `studio/layout.tsx` renders the `StudioTopbar` and the `<md` section strip
 * and persists across section swaps, so this boundary covers only the pane it
 * wraps. Drawing a chrome row here would stack a second one under the real
 * topbar. Entry into Studio from another surface is covered by the
 * workspace-level fallback, which does draw the chrome.
 *
 * Spec: docs/architecture/features/perceived-performance.md
 */

import { RailSurfaceSkeleton } from "@/components/chrome/surface-skeleton";

export default function StudioSectionLoading() {
  return <RailSurfaceSkeleton chrome={false} />;
}
