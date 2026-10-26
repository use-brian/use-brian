"use client";

/**
 * Ordinary workspace entry opens the Chat mini-app immediately. Explicit
 * capture, recorder, native handoff and checkout-return parameters retain
 * their existing destinations. No workspace app-list read gates Home.
 * Spec: docs/architecture/features/workspace-navigation.md.
 * [COMP:app-web/workspace-root]
 */

import { Suspense, useEffect } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { SurfaceSkeletonFor } from "@/components/chrome/surface-skeleton";
import { surfaceFromPathname } from "@/lib/doc-page-url";
import { defaultHomePath } from "@/lib/operator-apps";
import { forwardPlanGateCheckoutReturn } from "@/lib/plan-gate";
import { useBrianWorkspacePath } from "@/lib/siri-use-brian";

function WorkspaceRootRedirect() {
  const params = useParams<{ workspaceId: string }>();
  const workspaceId = params?.workspaceId ?? "";
  const router = useRouter();
  const searchParams = useSearchParams();
  const defaultPath = workspaceId ? defaultHomePath(workspaceId) : null;

  useEffect(() => {
    if (!workspaceId) return;
    const capture = searchParams?.get("capture") === "1";
    const record = searchParams?.get("record") === "1";
    if (capture || record) {
      router.replace(`/w/${workspaceId}/p?${capture ? "capture=1" : "record=1"}`);
      return;
    }
    const useBrianPath = useBrianWorkspacePath(
      workspaceId,
      searchParams?.get("useBrian"),
    );
    if (useBrianPath) {
      router.replace(useBrianPath);
      return;
    }
    if (!defaultPath) return;
    router.replace(
      forwardPlanGateCheckoutReturn(
        defaultPath,
        searchParams?.toString() ?? "",
      ),
    );
  }, [defaultPath, router, searchParams, workspaceId]);

  // Chat paints immediately; Home never waits for catalogue configuration.
  return <SurfaceSkeletonFor surface={surfaceFromPathname(defaultPath ?? "")} />;
}

export default function WorkspaceRootPage() {
  return (
    <Suspense fallback={<SurfaceSkeletonFor surface="chat" />}>
      <WorkspaceRootRedirect />
    </Suspense>
  );
}
