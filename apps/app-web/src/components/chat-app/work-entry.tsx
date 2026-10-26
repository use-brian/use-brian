"use client";

/**
 * The Chat work entry (chat-app.md -> "Work entry"): rendered under the hero
 * composer while no thread is open. With no Project or Department picked it
 * shows the viewer's personal work; picking one in the existing context
 * picker switches to that scope's projection with a link to its Brief.
 *
 * Pickup is draft-only: `onDraft` fills the composer and focuses it, it never
 * sends. The remaining live dock attention (approvals, Goals, Brain review,
 * failed runs, broken connectors) renders as compact links to the same
 * destinations the retired Suggested briefing used, so no route was lost.
 * Rendering also records the Home landing cadence watermark.
 *
 * [COMP:app-web/brief-work]
 */
import Link from "next/link";
import { useEffect } from "react";
import { ClientDeliveryOversight } from "./client-delivery-oversight";
import { BriefWork } from "@/components/briefs/brief-work";
import { useSidebarData } from "@/components/doc/doc-sidebar-data";
import { format, useT } from "@/lib/i18n/client";
import { pendingApprovalTotal, type ResolvedNeed } from "@/lib/api/home-dock";
import type { WorkScope } from "@/lib/api/work";
import { markSuggestedShown } from "@/lib/suggested-landing";

/** Where each live dock card used to send people. */
export function attentionHref(workspaceId: string, kind: ResolvedNeed["kind"]): string {
  switch (kind) {
    case "brain_review": return `/w/${workspaceId}/brain?pending=true`;
    case "approvals": return `/w/${workspaceId}/p?panel=approvals`;
    case "autopilot": return `/w/${workspaceId}/p?panel=goals`;
    case "task_triage": return `/w/${workspaceId}/p?panel=triage`;
    case "task_cleanup": return `/w/${workspaceId}/tasks?filter=stale`;
    case "deal_attention": return `/w/${workspaceId}/crm?filter=overdue`;
    case "connector_attention": return `/w/${workspaceId}/studio/connectors`;
    case "workflow_attention": return `/w/${workspaceId}/workflow`;
  }
}

export function WorkEntry({ workspaceId, scope, onDraft, includeDelivery=true }: {
  workspaceId: string;
  scope: WorkScope;
  onDraft: (draft: string) => void;
  includeDelivery?: boolean;
}) {
  const t = useT().briefs.work;
  const { dock, dockLoading } = useSidebarData();

  // The work entry is the Home landing now: record the cadence watermark once
  // the dock it is measured against has resolved.
  const approvals = pendingApprovalTotal(dock);
  useEffect(() => {
    if (!dockLoading && dock) markSuggestedShown(workspaceId, approvals);
  }, [workspaceId, dockLoading, dock, approvals]);

  const attention = (dock?.needsYou ?? []).filter((need) => need.count > 0);
  const briefHref = scope.kind === "personal" ? null : `/w/${workspaceId}/briefs/${scope.kind}/${scope.id}`;

  return (
    <div className="space-y-3" data-testid="work-entry">
      <p className="text-xs leading-5 text-muted-foreground">{t.description}</p>
      <BriefWork
        workspaceId={workspaceId}
        scope={scope}
        title={scope.kind === "personal" ? t.title : t.scopedTitle}
        onContinueInChat={(_item, draft) => onDraft(draft)}
        embedded
      />
      {includeDelivery?<ClientDeliveryOversight workspaceId={workspaceId} scope={scope} onDraft={onDraft}/>:null}
      {briefHref ? (
        <Link href={briefHref} className="inline-flex text-sm underline max-sm:min-h-11 max-sm:items-center">{t.actions.openBrief}</Link>
      ) : null}
      {attention.length > 0 ? (
        <nav aria-label={t.attentionTitle} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="text-muted-foreground">{t.attentionTitle}</span>
          {attention.map((need) => (
            <Link key={need.kind} href={attentionHref(workspaceId, need.kind)} className="underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center">
              {format(t.attention[need.kind], { count: String(need.count) })}
            </Link>
          ))}
        </nav>
      ) : null}
    </div>
  );
}
