/**
 * Legacy URL - redirects to the unified Brain page with the inbox filter
 * pre-selected, workspace-scoped.
 *
 * Ported from `apps/web/src/app/(app)/memories/review/page.tsx` (consolidation
 * §5a). The memory review surface was generalised into the primitive-agnostic
 * Brain inbox, which folded into `/brain` itself; this shim preserves bookmarks
 * and external links that still point at the old URL.
 *
 * Spec: docs/architecture/brain/corrections.md. [COMP:app-web/memories-redirect]
 */

import { redirect } from "next/navigation";

export default async function MemoryReviewRedirect(props: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await props.params;
  redirect(`/w/${workspaceId}/brain?pending=true`);
}
