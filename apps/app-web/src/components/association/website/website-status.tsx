"use client";

/** Website publication status in staff words, used by Website → Pages & sections. [COMP:app-web/site-content] */
import { getSiteContentDraft, getWebsiteStatus, websiteSiteLabel, type MembershipLocale, type WebsitePublicationSummary } from "@/lib/api/association";
import { format } from "@/lib/i18n/format";
import { useLocale, useT } from "@/lib/i18n/client";
import { useCachedResource } from "@/lib/surface-cache";
import { associationPageCacheKey } from "@/lib/surface-prefetch";
import { StatusPill, type AssociationTone } from "../ui";

export function useWebsiteStatus(workspaceId: string) {
  return useCachedResource(associationPageCacheKey(workspaceId, "website-status"), () => getWebsiteStatus(workspaceId));
}

/** Site key → the name staff know it by, from the published site settings (owner/admin read). */
export function useWebsiteSiteNames(workspaceId: string, enabled: boolean): Record<string, string> {
  const locale = useLocale();
  const settings = useCachedResource(enabled ? associationPageCacheKey(workspaceId, "site-content:settings") : null, () => getSiteContentDraft(workspaceId, "settings"));
  const sites = (settings.data?.published as { sites?: Record<string, { name?: Partial<Record<MembershipLocale, string>> & { en: string } } | undefined> } | null)?.sites ?? {};
  const wanted: MembershipLocale = locale === "zh" ? "zh-Hant" : locale === "zh-CN" ? "zh-Hans" : "en";
  return Object.fromEntries(Object.entries(sites).flatMap(([site, value]) => value?.name ? [[site, value.name[wanted]?.trim() || value.name.en]] : []));
}

export type PublicationState = { key: "attention" | "changes" | "waiting" | "published" | "notStarted"; tone: AssociationTone; waitingFor: string[] };

/** One status per page: issues first, then unpublished edits, then websites that have not picked up the latest publication. */
export function publicationState(summary: WebsitePublicationSummary, readers: readonly string[]): PublicationState {
  const waitingFor = summary.publishedRevision > 0 ? readers.filter(site => summary.observations[site]?.revision !== summary.publishedRevision) : [];
  if (summary.version === 0) return { key: "notStarted", tone: "neutral", waitingFor };
  if (summary.issueCount > 0) return { key: "attention", tone: "danger", waitingFor };
  if (summary.version !== summary.publishedRevision) return { key: "changes", tone: "warning", waitingFor };
  if (waitingFor.length) return { key: "waiting", tone: "info", waitingFor };
  return { key: "published", tone: "success", waitingFor };
}

export function PublicationStatus({ state, names }: { state: PublicationState; names: Record<string, string> }) {
  const c = useT().associationPage.content;
  const label = state.key === "attention" ? c.statusAttention : state.key === "changes" ? c.statusChanges : state.key === "notStarted" ? c.statusNotStarted
    : state.key === "waiting" ? format(c.pending, { site: state.waitingFor.map(site => websiteSiteLabel(site, names)).join(", ") }) : c.statusPublished;
  return <StatusPill status={state.key} tone={state.tone} label={label} />;
}
