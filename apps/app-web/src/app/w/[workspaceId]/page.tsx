"use client";

/**
 * The workspace root — forwards to the workspace's Home app.
 *
 * This used to be a server component that hard-redirected to `/p`. It cannot
 * be any more: which apps a workspace shows is configuration
 * (`workspaces.home_apps`, migration 385) and Page may be deselected, so a
 * fixed `/p` would drop those workspaces onto a surface that is not on their
 * strip. Home resolution is now one rule everywhere — the persisted app,
 * constrained to the configured list, falling back to its first entry
 * (`homePath`, `lib/operator-apps.ts`).
 *
 * Resolution is client-side because the sticky selection lives in
 * localStorage. That costs nothing here: this route renders no UI, it only
 * forwards, and it sits under the workspace layout, so the config is already
 * in the sidebar-data provider — no extra fetch, no flash of a wrong surface.
 *
 * The desktop quick-capture (`?capture=1`) and recorder (`?record=1`) hints
 * always land on `/p` regardless of config: both are doc-surface affordances
 * (open a fresh draft, start the dock recorder), so honouring them anywhere
 * else would silently drop what the user was capturing.
 *
 * Spec: docs/architecture/features/home-apps.md → "Home resolution".
 */

import { Suspense, useEffect } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useSidebarData } from "@/components/doc/doc-sidebar-data";
import { homePath } from "@/lib/operator-apps";

function WorkspaceRootRedirect() {
  const params = useParams<{ workspaceId: string }>();
  const workspaceId = params?.workspaceId ?? "";
  const router = useRouter();
  const searchParams = useSearchParams();
  const { homeApps } = useSidebarData();

  useEffect(() => {
    if (!workspaceId) return;
    const capture = searchParams?.get("capture") === "1";
    const record = searchParams?.get("record") === "1";
    if (capture || record) {
      router.replace(`/w/${workspaceId}/p?${capture ? "capture=1" : "record=1"}`);
      return;
    }
    router.replace(homePath(workspaceId, homeApps));
  }, [homeApps, router, searchParams, workspaceId]);

  return null;
}

export default function WorkspaceRootPage() {
  return (
    <Suspense fallback={null}>
      <WorkspaceRootRedirect />
    </Suspense>
  );
}
