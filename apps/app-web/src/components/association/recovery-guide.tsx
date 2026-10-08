"use client";

/** Content-free recovery navigation. [COMP:app-web/association-recovery] */
import Link from "next/link";
import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import { Checkbox } from "@/components/ui/checkbox";
import { associationHref } from "./navigation";

export function AssociationRecoveryGuide({ workspaceId, canManage }: { workspaceId: string; canManage: boolean }) {
  return <RecoveryGuide key={`${workspaceId}:${canManage}`} workspaceId={workspaceId} canManage={canManage} />;
}

function RecoveryGuide({ workspaceId, canManage }: { workspaceId: string; canManage: boolean }) {
  const t = useT().associationPage.recovery;
  const [reviewed, setReviewed] = useState(false);
  const linkClass = "inline-flex min-h-11 md:min-h-8 items-center rounded-md px-2 text-sm text-primary underline focus-visible:outline-2 focus-visible:outline-ring";
  return <details className="rounded-xl border border-border bg-background px-4" data-association-recovery>
    <summary className="min-h-11 md:min-h-8 cursor-pointer content-center text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">{t.title}</summary>
    <div className="space-y-3 pb-4 text-sm text-muted-foreground">
      <p>{t.access}</p><p>{t.history}</p><p>{t.uncertain}</p>
      <div className="flex flex-wrap gap-2">
        <Link className={linkClass} href={associationHref(workspaceId, "contacts")}>{t.contacts}</Link>
        {canManage && <Link className={linkClass} href={associationHref(workspaceId, "admin", { tab: "sync" })}>{t.sync}</Link>}
      </div>
      {canManage && <>
        <label className="flex min-h-11 md:min-h-8 cursor-pointer items-start gap-3 py-2 text-foreground">
          <Checkbox checked={reviewed} onCheckedChange={setReviewed} className="mt-0.5 shrink-0" />
          <span>{t.ack}</span>
        </label>
        {reviewed && <div className="space-y-2" data-recovery-fresh-start>
          <p>{t.fresh}</p>
          <div className="flex flex-wrap gap-2">
            <Link className={linkClass} href={associationHref(workspaceId, "events")}>{t.events}</Link>
            <Link className={linkClass} href={associationHref(workspaceId, "memberships", { new: "1" })}>{t.membership}</Link>
            <Link className={linkClass} href={associationHref(workspaceId, "payments", { new: "1" })}>{t.payment}</Link>
          </div>
        </div>}
      </>}
    </div>
  </details>;
}
