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
 * Reads the SURFACE's cache slots for its counts instead of fetching a copy
 * (instant-navigation contract N1 / N2 / N3): the config (`crmConfigCacheKey`)
 * to resolve the selected pipeline exactly as the surface does, then the
 * `summary`, `lookups` and `email-drafts` regions through
 * `crmRegionCacheKey` and the approvals queue through `approvalsCacheKey` -
 * every key built in `lib/surface-prefetch.ts`, never by hand. The panel
 * remounts on every surface entry, and its old private `fetchWorkspaceCrm`
 * paid a second request (the full flat record set) and blanked the counts
 * each time while the surface's regions sat in the cache. Live updates come
 * from the ONE spine map (`lib/surface-cache-invalidation.ts` marks
 * `crm:<wid>:` and `approvals:<wid>` stale), so there is no listener here.
 * Counts paint from cached values; skeleton pills show only when nothing is
 * cached (N4).
 *
 * [COMP:app-web/crm-sidebar-panel]
 */

import { useMemo } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { Skeleton } from "@/components/skeleton";
import { useCachedResource } from "@/lib/surface-cache";
import { useLeasedResource } from "@/lib/offline/surface-content-cache";
import {
  approvalsCacheKey,
  crmConfigCacheKey,
  crmRegionCacheKey,
} from "@/lib/surface-prefetch";
import { listApprovals, type PendingApprovalRow } from "@/lib/api/approvals";
import {
  fetchCrmConfig,
  fetchCrmDirectories,
  fetchCrmEmailDrafts,
  fetchCrmSummary,
  type CrmConfig,
  type CrmDirectories,
  type CrmEmailDraft,
  type CrmSummary,
} from "@/lib/api/crm";
import { crmEmailApprovalQueue } from "@/lib/crm-r2";
import {
  crmDataFromDirectories,
  crmViewFromSearch,
  resolveSelectedPipeline,
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

  const view = crmViewFromSearch(searchParams);

  // ── Live counts from the surface's own cache slots ─────────────────────
  // The four reads are independent and run in parallel on a cold cache (N7);
  // on a warm one none of them fetches at all.
  const configResource = useCachedResource<CrmConfig>(
    crmConfigCacheKey(workspaceId),
    () => fetchCrmConfig(workspaceId),
  );
  const selectedPipeline = resolveSelectedPipeline(configResource.data?.pipelines, view.pipeline);
  // Content lease: protected counts and names expire with the viewer's authority.
  const summaryResource = useLeasedResource<CrmSummary>(
    crmRegionCacheKey(workspaceId, "summary", selectedPipeline?.id ?? "all"),
    () => fetchCrmSummary(workspaceId, selectedPipeline?.id),
  );
  const directoriesResource = useLeasedResource<CrmDirectories>(
    crmRegionCacheKey(workspaceId, "lookups"),
    () => fetchCrmDirectories(workspaceId),
  );
  const emailDraftsResource = useLeasedResource<CrmEmailDraft[]>(
    crmRegionCacheKey(workspaceId, "email-drafts"),
    () => fetchCrmEmailDrafts(workspaceId),
  );
  const approvalsResource = useLeasedResource<PendingApprovalRow[]>(
    approvalsCacheKey(workspaceId),
    () => listApprovals(workspaceId, { throwOnError: true }),
  );

  const summary = summaryResource.data ?? null;
  const counts = summary?.attention ?? { overdue: 0, stale: 0, noAmount: 0, orphaned: 0 };
  const emailDraftCount = useMemo(() => {
    const canonical = emailDraftsResource.data?.length ?? 0;
    const queued = crmEmailApprovalQueue(
      crmDataFromDirectories(directoriesResource.data),
      approvalsResource.data ?? [],
    ).length;
    return canonical + queued;
  }, [approvalsResource.data, directoriesResource.data, emailDraftsResource.data]);
  const emailCountReady =
    emailDraftsResource.data !== undefined || approvalsResource.data !== undefined;
  const sectionLabels: Record<CrmSection, string> = {
    deals: t.sectionDeals,
    contacts: t.sectionContacts,
    companies: t.sectionCompanies,
  };
  const sectionCounts: Record<CrmSection, number> = {
    deals: summary?.totals.deals ?? 0,
    contacts: summary?.totals.contacts ?? 0,
    companies: summary?.totals.companies ?? 0,
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
              view.review === null && view.section === section && !view.quick ? "page" : undefined
            }
            className={rowCls(view.review === null && view.section === section && !view.quick)}
          >
            <span className="min-w-0 flex-1 truncate">
              {sectionLabels[section]}
            </span>
            {summary !== null ? (
              <span className="shrink-0 tabular-nums text-[11px] text-sidebar-foreground/50">
                {sectionCounts[section]}
              </span>
            ) : (
              <Skeleton className="h-3 w-5 shrink-0 rounded" data-sidebar-count-skeleton />
            )}
          </Link>
        ))}
        <Link
          href={`${base}?review=email`}
          aria-current={view.review === "email" ? "page" : undefined}
          className={rowCls(view.review === "email")}
        >
          <span className="min-w-0 flex-1 truncate">{t.r2.emailDrafts}</span>
          {emailCountReady ? (
            <AttentionBadge count={emailDraftCount} />
          ) : (
            <Skeleton className="h-[1.1rem] w-5 shrink-0 rounded-full" data-sidebar-count-skeleton />
          )}
        </Link>
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
              aria-current={view.review === null && view.quick === f ? "page" : undefined}
              className={rowCls(view.review === null && view.quick === f)}
            >
              <span className="min-w-0 flex-1 truncate">{quickLabels[f]}</span>
              {summary !== null ? (
                <AttentionBadge count={counts[f]} />
              ) : (
                <Skeleton className="h-[1.1rem] w-5 shrink-0 rounded-full" data-sidebar-count-skeleton />
              )}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
