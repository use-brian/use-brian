/**
 * Cold-load fallback for the whole workspace subtree.
 *
 * `w/[workspaceId]/layout.tsx` is an async server component: it awaits
 * `serverApiFetch('/api/workspaces/:id')` before it can render the sidebar or
 * anything inside it. Its own `loading.tsx` sits BELOW that layout, so it
 * cannot cover the layout's own wait - and there was no boundary above it,
 * which meant a hard refresh or a first navigation into a workspace showed the
 * previous page (or white) for the entire round trip.
 *
 * This boundary is that missing cover. It sits on the `/w` segment, one level
 * above `[workspaceId]`, so it renders the instant the URL changes and holds
 * until the workspace layout resolves.
 *
 * Server component with no strings and no hooks on purpose: no client chunk has
 * to download before it can paint.
 *
 * Spec: docs/architecture/features/perceived-performance.md
 */

import { AppShellSkeleton } from "@/components/chrome/surface-skeleton";

export default function WorkspaceBootLoading() {
  return <AppShellSkeleton />;
}
