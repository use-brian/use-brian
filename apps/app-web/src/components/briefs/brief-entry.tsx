"use client";

/**
 * Compact Brief entry on an existing surface (Project detail): accepted
 * revision, selected rule basis and pending count, opening the shared Brief
 * pane on demand. No navigation redesign. [COMP:app-web/brief-journey]
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { format, useT } from "@/lib/i18n/client";
import { getBriefByOwner, type BriefOwnerKind, type BriefView } from "@/lib/api/briefs";
import { BriefPane } from "./brief-pane";

export function BriefEntry({ workspaceId, ownerKind, ownerId }: { workspaceId: string; ownerKind: BriefOwnerKind; ownerId: string }) {
  const t = useT().briefs;
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<BriefView | null | undefined>(undefined);
  useEffect(() => {
    let live = true
    getBriefByOwner(workspaceId, ownerKind, ownerId).then(view => { if (live) setSummary(view) }).catch(() => { if (live) setSummary(null) })
    return () => { live = false }
  }, [workspaceId, ownerKind, ownerId, open]);
  const facts = summary ? [
    summary.binding.directionRevision > 0 ? format(t.revision, { revision: String(summary.binding.directionRevision) }) : t.noRevision,
    ...(ownerKind === "project" ? [summary.selections.length ? format(t.rulesBasis, { count: String(summary.selections.length) }) : t.noRulesBasis] : []),
    ...(summary.proposals.length ? [format(t.pendingCount, { count: String(summary.proposals.length) })] : []),
  ] : [];
  return <section aria-labelledby="brief-entry" className="rounded-xl border border-border p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <h2 id="brief-entry" className="font-medium">{t.entryTitle}</h2>
        <p className="text-sm text-muted-foreground">{facts.length ? facts.join(" · ") : t.entryHint}</p>
      </div>
      <Button variant="outline" className="max-sm:min-h-11" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? t.close : t.open}</Button>
    </div>
    {open ? <div className="mt-4"><BriefPane workspaceId={workspaceId} ownerKind={ownerKind} ownerId={ownerId}
      pageHref={pageId => `/w/${workspaceId}/p/${pageId}`} /></div> : null}
  </section>;
}
