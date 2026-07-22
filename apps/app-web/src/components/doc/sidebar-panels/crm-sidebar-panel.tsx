"use client";

/**
 * CRM surface sidebar panel — swapped into the persistent left sidebar
 * while the CRM operator surface is active (mirrors `TasksSidebarPanel`).
 *
 * Sections:
 *   - Sections — Deals / Contacts / Companies with live counts,
 *     deep-linking `?section=…` (the same codec the surface uses);
 *   - Attention — the quick-filter presets with live counts, deep-linking
 *     `?filter=…` (the same definitions the surface chips and the Home
 *     dock's `deal_attention` card use, so "needs attention" means one
 *     thing everywhere).
 *
 * Fetches its own row copy for the counts (the "sidebar fetches its own
 * copy" pattern) — cheap against the flat endpoint, refreshed on the
 * brain-refresh signal the surface fires after mutations.
 *
 * [COMP:app-web/crm-surface] (the sidebar-panel flavour)
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { BRAIN_REFRESH_EVENT } from "@/lib/brain-events";
import { fetchWorkspaceCrm, type CrmData } from "@/lib/api/crm";
import {
  crmQuickCounts,
  crmViewFromSearch,
  sectionForQuickFilter,
  CONTACT_QUICK_FILTERS,
  CRM_SECTIONS,
  DEAL_QUICK_FILTERS,
  type CrmQuickFilter,
  type CrmSection,
} from "@/lib/crm-view";

export function CrmSidebarPanel({ workspaceId }: { workspaceId: string }) {
  const t = useT().crmPage;
  const searchParams = useSearchParams();

  // ── Live counts (own fetch; refreshed on the surface's mutate signal) ──
  const [data, setData] = useState<CrmData | null>(null);
  const refresh = useCallback(() => {
    fetchWorkspaceCrm(workspaceId)
      .then(setData)
      .catch(() => setData({ deals: [], contacts: [], companies: [] }));
  }, [workspaceId]);
  useEffect(() => {
    setData(null);
    refresh();
    window.addEventListener(BRAIN_REFRESH_EVENT, refresh);
    return () => window.removeEventListener(BRAIN_REFRESH_EVENT, refresh);
  }, [refresh]);

  const counts = useMemo(
    () => crmQuickCounts(data?.deals ?? [], data?.contacts ?? [], new Date()),
    [data],
  );

  const view = crmViewFromSearch(searchParams);
  const sectionLabels: Record<CrmSection, string> = {
    deals: t.sectionDeals,
    contacts: t.sectionContacts,
    companies: t.sectionCompanies,
  };
  const sectionCounts: Record<CrmSection, number> = {
    deals: data?.deals.length ?? 0,
    contacts: data?.contacts.length ?? 0,
    companies: data?.companies.length ?? 0,
  };
  const quickLabels: Record<CrmQuickFilter, string> = {
    overdue: t.quickOverdue,
    stale: t.quickStale,
    noAmount: t.quickNoAmount,
    orphaned: t.quickOrphaned,
  };

  const base = `/w/${workspaceId}/crm`;

  return (
    <div className="flex flex-col gap-4">
      {/* Sections */}
      <section>
        <div className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-sidebar-foreground/45">
          {t.sectionsLabel}
        </div>
        <ul className="space-y-0.5">
          {CRM_SECTIONS.map((section) => (
            <li key={section}>
              <Link
                href={section === "deals" ? base : `${base}?section=${section}`}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1 text-[13px]",
                  view.section === section && !view.quick
                    ? "doc-nav-active font-medium"
                    : "text-sidebar-foreground/80 hover:bg-sidebar-accent",
                )}
              >
                <span className="min-w-0 flex-1 truncate">
                  {sectionLabels[section]}
                </span>
                {data !== null && (
                  <span className="tabular-nums text-[11px] text-sidebar-foreground/50">
                    {sectionCounts[section]}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {/* Attention presets */}
      <section>
        <div className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-sidebar-foreground/45">
          {t.attentionLabel}
        </div>
        <ul className="space-y-0.5">
          {[...DEAL_QUICK_FILTERS, ...CONTACT_QUICK_FILTERS].map((f) => (
            <li key={f}>
              <Link
                href={`${base}?filter=${f}${
                  sectionForQuickFilter(f) === "deals" ? "&view=table" : ""
                }`}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1 text-[13px]",
                  view.quick === f
                    ? "doc-nav-active font-medium"
                    : "text-sidebar-foreground/80 hover:bg-sidebar-accent",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{quickLabels[f]}</span>
                <span className="tabular-nums text-[11px] text-sidebar-foreground/50">
                  {counts[f]}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
