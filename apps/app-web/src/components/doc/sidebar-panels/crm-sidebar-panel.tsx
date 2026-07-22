"use client";

/**
 * CRM surface sidebar panel — swapped into the persistent left sidebar
 * while the CRM operator surface is active. Styled on the Brain panel's
 * recipe (`brain-sidebar-panel.tsx`): top-level SECTION ROWS in the Studio
 * `.doc-nav-active` nav language (no primary blue), quiet tabular counts,
 * and an Attention block whose live counts render as the same amber badge
 * the Brain Reviews row wears.
 *
 * Sections deep-link `?section=…`, attention presets `?filter=…` — the
 * same `crm-view.ts` codec the surface and the Home dock card use, so
 * "needs attention" means one thing everywhere.
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

/** The Brain panel's nav-row recipe — active is the `.doc-nav-active` pill. */
const rowCls = (active: boolean) =>
  cn(
    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
    active
      ? "doc-nav-active font-medium text-sidebar-accent-foreground"
      : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
  );

const sectionHeaderCls =
  "px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-sidebar-foreground/45";

/** The Brain Reviews row's amber attention badge. */
function AttentionBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="shrink-0 min-w-[1.1rem] h-[1.1rem] px-1 inline-flex items-center justify-center rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-400 text-[10px] font-semibold tabular-nums">
      {count}
    </span>
  );
}

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
    <div className="flex flex-col gap-3 px-1 pt-1">
      {/* Top-level section rows — Deals / Contacts / Companies. */}
      <div className="flex flex-col gap-0.5">
        {CRM_SECTIONS.map((section) => (
          <Link
            key={section}
            href={section === "deals" ? base : `${base}?section=${section}`}
            aria-current={
              view.section === section && !view.quick ? "page" : undefined
            }
            className={rowCls(view.section === section && !view.quick)}
          >
            <span className="min-w-0 flex-1 truncate">
              {sectionLabels[section]}
            </span>
            {data !== null && (
              <span className="shrink-0 tabular-nums text-[11px] text-sidebar-foreground/50">
                {sectionCounts[section]}
              </span>
            )}
          </Link>
        ))}
      </div>

      {/* Attention presets — live counts as the amber attention badge. */}
      <div>
        <div className={sectionHeaderCls}>{t.attentionLabel}</div>
        <div className="flex flex-col gap-0.5">
          {[...DEAL_QUICK_FILTERS, ...CONTACT_QUICK_FILTERS].map((f) => (
            <Link
              key={f}
              href={`${base}?filter=${f}${
                sectionForQuickFilter(f) === "deals" ? "&view=table" : ""
              }`}
              aria-current={view.quick === f ? "page" : undefined}
              className={rowCls(view.quick === f)}
            >
              <span className="min-w-0 flex-1 truncate">{quickLabels[f]}</span>
              <AttentionBadge count={counts[f]} />
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
