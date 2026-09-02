"use client";

/**
 * The workspace root — forwards to the workspace's Home app.
 *
 * This used to be a server component that hard-redirected to `/p`. It cannot
 * be any more: which apps a workspace shows is configuration
 * (`workspaces.home_apps`, migration 385) and Page may be deselected, so a
 * fixed `/p` would drop those workspaces onto a surface that is not on their
 * strip. Home resolution is now one rule everywhere — the persisted app and
 * its last safe pathname, constrained to the configured list and falling back
 * to its first entry (`homePath`, `lib/operator-apps.ts`). The daily/+3
 * approvals cadence may then replace that resume destination with the explicit
 * Suggested briefing (`homeLandingPath`, `lib/suggested-landing.ts`).
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
 * Stripe's one-shot `checkout` / `session_id` handoff is also preserved onto
 * the resolved Home path so the workspace plan gate can reconcile it there.
 *
 * Spec: docs/architecture/features/home-apps.md → "Home resolution".
 */

import { Suspense, useEffect } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useSidebarData } from "@/components/doc/doc-sidebar-data";
import { homePath } from "@/lib/operator-apps";
import { pendingApprovalTotal } from "@/lib/api/home-dock";
import { homeLandingPath } from "@/lib/suggested-landing";
import { forwardPlanGateCheckoutReturn } from "@/lib/plan-gate";
import { siriAskSuffix } from "@/lib/siri-ask";

function WorkspaceRootRedirect() {
  const params = useParams<{ workspaceId: string }>();
  const workspaceId = params?.workspaceId ?? "";
  const router = useRouter();
  const searchParams = useSearchParams();
  const { homeApps, dock, dockLoading } = useSidebarData();

  useEffect(() => {
    if (!workspaceId) return;
    const capture = searchParams?.get("capture") === "1";
    const record = searchParams?.get("record") === "1";
    if (capture || record) {
      router.replace(`/w/${workspaceId}/p?${capture ? "capture=1" : "record=1"}`);
      return;
    }
    const askSuffix = siriAskSuffix(searchParams?.get("ask"));
    if (askSuffix) {
      router.replace(`/w/${workspaceId}/p${askSuffix}`);
      return;
    }
    if (dockLoading) return;
    const resumePath = homePath(workspaceId, homeApps);
    router.replace(
      forwardPlanGateCheckoutReturn(
        homeLandingPath(
          workspaceId,
          resumePath,
          pendingApprovalTotal(dock),
        ),
        searchParams?.toString() ?? "",
      ),
    );
  }, [dock, dockLoading, homeApps, router, searchParams, workspaceId]);

  return null;
}

export default function WorkspaceRootPage() {
  return (
    <Suspense fallback={null}>
      <WorkspaceRootRedirect />
    </Suspense>
  );
}
