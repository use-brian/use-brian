"use client";

/** Persistent CRM route owner. [COMP:app-web/crm-record-route] */
import { Suspense } from "react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { CrmSurface } from "./crm-surface";
import { SurfaceSkeletonFor } from "@/components/chrome/surface-skeleton";
import { useT } from "@/lib/i18n/client";
import { crmCollectionHref, crmRouteFromPathname } from "@/lib/crm-view";

function CrmWorkspaceContent() {
  const { workspaceId = "" } = useParams<{ workspaceId: string }>();
  const route = crmRouteFromPathname(usePathname(), workspaceId);
  const t = useT().crmPage.r2;

  if (route.type === "invalid") {
    return (
      <div className="flex min-h-full items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <h1 className="text-lg font-semibold">{t.recordNotFound}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t.recordNotFoundDescription}</p>
          <Link
            href={crmCollectionHref(workspaceId)}
            className="mt-4 inline-flex min-h-8 max-sm:min-h-11 items-center rounded-lg bg-foreground px-3 py-2 text-sm font-medium text-background"
          >
            {t.returnToCrm}
          </Link>
        </div>
      </div>
    );
  }

  // No record key: the collection, selection and scroll survive route changes.
  return <CrmSurface workspaceId={workspaceId} routeRecord={route.type === "record" ? route.record : null} />;
}

export function CrmWorkspace() {
  return (
    <Suspense fallback={<SurfaceSkeletonFor surface="crm" />}>
      <CrmWorkspaceContent />
    </Suspense>
  );
}
