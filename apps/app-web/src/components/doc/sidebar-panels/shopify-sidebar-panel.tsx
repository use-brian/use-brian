"use client";

/**
 * Shopify surface sidebar panel — swapped into the persistent left sidebar
 * while the Shopify operator surface is active.
 *
 * Section rows in the shared `.doc-nav-active` nav language, deep-linked with
 * the same `?section=` codec the topbar pills use (`lib/shopify-view.ts`), so
 * the two controls cannot disagree about which section is open.
 *
 * Each section owns its own history, nested beneath it and expanded only while
 * that section is the one being viewed. Three lists open at once would make the
 * panel taller than the screen and bury the navigation it exists for.
 *
 * The two histories are deliberately NOT the same kind of thing:
 *
 *   - **Recent drafts** (under Draft a product) read live from the store
 *     (`status:draft`). A drafted product is a real object, so its history is
 *     true for every teammate on every device with nothing to keep in sync. A
 *     local log of "products I drafted here" would drift the moment anyone
 *     edited one elsewhere, and drift silently.
 *   - **Recent questions** (under Act on the numbers) are `localStorage`,
 *     because an analysis leaves no trace anywhere - it is a question plus a
 *     window, and the only place that pairing exists is the browser that asked.
 *     The group says so rather than implying a synced history.
 *
 * Reads through the surface cache, never its own copy (instant-navigation
 * contract N2): reachability comes from the SAME `shopify:<wid>` key the
 * surface reads (one request, one paint for both), and the drafts group has
 * its own `shopify-drafts:<wid>` key whose fetcher asks for the shop identity
 * and the `status:draft` products in parallel (N7). The drafts key is gated on
 * `connected` - an unshared store has no tools to call, so asking would only
 * manufacture a failure - which on a cold load is one gated round trip after
 * the reachability answer, and on a warm one is nothing at all: both keys
 * paint on the first frame. An empty cache paints skeleton rows (N4). No
 * spine primitive exists for an external store, so the panel carries no
 * listener and the keys revalidate on mount past the stale window.
 *
 * [COMP:app-web/shopify-app] (the sidebar-panel flavour)
 * [COMP:app-web/shopify-surface-cache] (the shared-key read + first-paint rule)
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ClipboardList, ExternalLink, Megaphone, PackageSearch, Sparkles, Store } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Skeleton } from "@/components/skeleton";
import { useT } from "@/lib/i18n/client";
import { callTool, listTools } from "@/lib/api/shopify";
import { shopifyDraftsCacheKey, shopifyToolsCacheKey } from "@/lib/surface-prefetch";
import { useLeasedResource } from "@/lib/offline/surface-content-cache";
import { readRuns, runHref, type ShopifyRun } from "@/lib/shopify-history";
import {
  SHOPIFY_SECTIONS,
  shopifySectionFromParams,
  shopifySectionHref,
  type ShopifySection,
} from "@/lib/shopify-view";
import { cn } from "@/lib/utils";

const rowCls = (active: boolean) =>
  cn(
    "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
    active
      ? "doc-nav-active font-medium text-sidebar-accent-foreground"
      : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
  );

/** Nested one step in, so the list reads as belonging to the row above it. */
const subRowCls =
  "flex items-center gap-1.5 rounded-md py-1 pr-2 pl-8 text-[12px] text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground";

const subNoteCls = "py-1 pr-2 pl-8 text-[12px] text-sidebar-foreground/45";

const SECTION_ICON: Record<ShopifySection, LucideIcon> = {
  draft: ClipboardList,
  inventory: PackageSearch,
  analyse: Sparkles,
  campaign: Megaphone,
};

type DraftProduct = { id?: string; title?: string; updated_at?: string };

/** What the `shopify-drafts:<wid>` key holds: the shop identity (for the
 *  admin deep links + the footer) and the newest draft products. */
type DraftsRecord = {
  shop: { name: string | null; domain: string | null };
  drafts: DraftProduct[];
};

/** `gid://shopify/Product/123` → `123`, for the admin deep link. */
function numericId(gid: string | undefined): string | null {
  const m = /\/(\d+)(?:\?|$)/.exec(String(gid ?? ""));
  return m ? m[1] : null;
}

/** The drafts fetcher: shop identity and draft products in ONE parallel round (N7). */
async function loadDrafts(workspaceId: string): Promise<DraftsRecord> {
  const [info, list] = await Promise.all([
    callTool<{ name?: string; myshopify_domain?: string }>(workspaceId, "shopifyGetShop", {}),
    callTool<{ items?: DraftProduct[] }>(workspaceId, "shopifyListProducts", {
      query: "status:draft",
      first: 10,
    }),
  ]);
  return {
    shop: { name: info.name ?? null, domain: info.myshopify_domain ?? null },
    drafts: [...(list.items ?? [])]
      .sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")))
      .slice(0, 6),
  };
}

/** Two placeholder lines in the nested sub-row geometry - the cold-cache frame
 *  for the drafts group, never a sentence (N4). Decorative only. */
function DraftsSkeleton() {
  return (
    <div className="space-y-1.5 py-1 pr-2 pl-8" aria-hidden data-shopify-drafts-skeleton>
      <Skeleton className="h-3 w-3/4" />
      <Skeleton className="h-3 w-1/2" />
    </div>
  );
}

export function ShopifySidebarPanel({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const active = shopifySectionFromParams(searchParams);
  const onSurface = pathname.startsWith(`/w/${workspaceId}/shopify`);

  const tools = useLeasedResource(shopifyToolsCacheKey(workspaceId), () => listTools(workspaceId));
  // `null` while nothing is known. A store we cannot reach reads as "not
  // connected" here, as before: the panel is navigation first, and the
  // section rows must render whatever the store says.
  const connected: boolean | null = tools.data
    ? tools.data.connected
    : tools.error !== undefined
      ? false
      : null;
  const draftsResource = useLeasedResource(
    connected ? shopifyDraftsCacheKey(workspaceId) : null,
    () => loadDrafts(workspaceId),
  );
  const shop = draftsResource.data?.shop ?? { name: null, domain: null };
  // `null` = nothing cached and nothing failed yet (skeleton). A failed read
  // degrades to "no lists shown" rather than blanking the section rows.
  const drafts: DraftProduct[] | null = draftsResource.data
    ? draftsResource.data.drafts
    : draftsResource.error !== undefined
      ? []
      : null;
  const [runs, setRuns] = useState<ShopifyRun[]>([]);

  // Re-read on every section change: a run recorded in the Analyse section
  // should appear without a reload, and the panel never unmounts to refetch.
  //
  // Keyed on the section STRING, not the `searchParams` object. Depending on
  // that object's identity is a render loop waiting for a caller that returns a
  // fresh instance each render - `setRuns` re-renders, which produces a new
  // object, which fires the effect again. Next's own hook happens to be stable,
  // so this would have looked fine until something else supplied it.
  useEffect(() => {
    setRuns(readRuns(workspaceId));
  }, [workspaceId, active]);

  const labels: Record<ShopifySection, string> = {
    draft: t.shopifyApp.tabDraft,
    inventory: t.shopifyApp.tabInventory,
    analyse: t.shopifyApp.tabAnalyse,
    campaign: t.shopifyApp.tabCampaign,
  };

  /** The history nested under a section, rendered only while it is open. */
  function historyFor(section: ShopifySection) {
    if (!connected) return null;

    if (section === "draft") {
      if (drafts === null) return <DraftsSkeleton />;
      if (drafts.length === 0) return <p className={subNoteCls}>{t.shopifyApp.noDrafts}</p>;
      return drafts.map((d) => {
        const id = numericId(d.id);
        const href = shop.domain && id ? `https://${shop.domain}/admin/products/${id}` : null;
        const label = d.title ?? "(untitled)";
        return href ? (
          <a
            key={d.id ?? label}
            href={href}
            target="_blank"
            rel="noreferrer"
            className={subRowCls}
            title={t.shopifyApp.openInShopify}
          >
            <span className="min-w-0 flex-1 truncate">{label}</span>
            <ExternalLink className="size-3 shrink-0 opacity-50" aria-hidden />
          </a>
        ) : (
          <span key={d.id ?? label} className={subRowCls}>
            <span className="min-w-0 flex-1 truncate">{label}</span>
          </span>
        );
      });
    }

    if (section === "analyse") {
      if (runs.length === 0) return <p className={subNoteCls}>{t.shopifyApp.noRuns}</p>;
      return (
        <>
          {runs.map((r) => (
            <Link
              key={`${r.key}-${r.since}-${r.until}`}
              href={runHref(workspaceId, r)}
              className={subRowCls}
              title={`${r.since} to ${r.until}`}
            >
              <span className="min-w-0 flex-1 truncate">{r.title}</span>
            </Link>
          ))}
          <p className={cn(subNoteCls, "opacity-70")}>{t.shopifyApp.thisBrowserOnly}</p>
        </>
      );
    }

    return null;
  }

  return (
    <div className="flex flex-col gap-0.5 px-1 pt-1">
      <nav aria-label={t.shopifyApp.title} className="flex flex-col gap-0.5">
        {SHOPIFY_SECTIONS.map((section) => {
          const Icon = SECTION_ICON[section];
          const isActive = onSurface && active === section;
          const history = isActive ? historyFor(section) : null;
          return (
            <div key={section} className="flex flex-col gap-0.5">
              <Link
                href={shopifySectionHref(workspaceId, section)}
                aria-current={isActive ? "page" : undefined}
                aria-expanded={history ? true : undefined}
                className={rowCls(isActive)}
              >
                <Icon className="size-4 shrink-0 text-sidebar-foreground/55" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{labels[section]}</span>
              </Link>
              {history}
            </div>
          );
        })}
      </nav>

      {connected === false ? (
        <p className="px-2 pt-1 text-[11.5px] leading-snug text-muted-foreground">
          {t.shopifyApp.notConnected}
        </p>
      ) : null}

      {shop.name ? (
        <div className="flex items-center gap-2 px-2 pt-2 text-[11.5px] text-muted-foreground">
          <Store className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">{shop.name}</span>
        </div>
      ) : null}
    </div>
  );
}
