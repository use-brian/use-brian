"use client";

/**
 * CRM operator surface route — thin wrapper: the meat lives in
 * `@/components/crm/crm-surface` (`[COMP:app-web/crm-surface]`) so the
 * desktop SPA can import the client component directly (the feed-port
 * disposition rule, feed-web-consolidation §6/§10). The Suspense boundary
 * covers `useSearchParams` (the view codec + the dock card's
 * `?filter=overdue` deep link).
 *
 * Spec: docs/architecture/features/crm.md → "Operator surface".
 */

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { CrmSurface } from "@/components/crm/crm-surface";

export default function CrmPage() {
  const params = useParams<{ workspaceId: string }>();
  const workspaceId = params?.workspaceId ?? "";
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">…</div>}>
      <CrmSurface workspaceId={workspaceId} />
    </Suspense>
  );
}
