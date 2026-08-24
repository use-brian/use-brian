"use client";

/** Canonical cold-loadable CRM record route. [COMP:app-web/crm-record-route] */

import { Suspense } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { CrmSurface, type CrmRouteRecord } from "@/components/crm/crm-surface";
import { useT } from "@/lib/i18n/client";
import { crmCollectionHref } from "@/lib/crm-view";

const KINDS = new Set<CrmRouteRecord["kind"]>(["deal", "contact", "company"]);

function InvalidRecordRoute({ workspaceId }: { workspaceId: string }) {
  const t = useT().crmPage.r2;
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="max-w-sm text-center">
        <h1 className="text-lg font-semibold">{t.recordNotFound}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t.recordNotFoundDescription}</p>
        <Link
          href={crmCollectionHref(workspaceId)}
          className="mt-4 inline-flex rounded-lg bg-foreground px-3 py-2 text-sm font-medium text-background"
        >
          {t.returnToCrm}
        </Link>
      </div>
    </div>
  );
}

export default function CrmRecordPage() {
  const params = useParams<{ workspaceId: string; kind: string; recordId: string }>();
  const workspaceId = params?.workspaceId ?? "";
  const kind = params?.kind ?? "";
  const recordId = params?.recordId ?? "";
  if (!KINDS.has(kind as CrmRouteRecord["kind"]) || !recordId) {
    return <InvalidRecordRoute workspaceId={workspaceId} />;
  }
  return (
    <Suspense fallback={null}>
      <CrmSurface
        workspaceId={workspaceId}
        routeRecord={{ kind: kind as CrmRouteRecord["kind"], id: recordId }}
      />
    </Suspense>
  );
}
