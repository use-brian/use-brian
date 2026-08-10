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
 * Fetches its own copy of everything (the "sidebar fetches its own copy"
 * pattern) - the panel outlives any individual section's mount.
 *
 * [COMP:app-web/shopify-app] (the sidebar-panel flavour)
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ClipboardList, ExternalLink, PackageSearch, Sparkles, Store } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { callTool, listTools } from "@/lib/api/shopify";
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
};

type DraftProduct = { id?: string; title?: string; updated_at?: string };

/** `gid://shopify/Product/123` → `123`, for the admin deep link. */
function numericId(gid: string | undefined): string | null {
  const m = /\/(\d+)(?:\?|$)/.exec(String(gid ?? ""));
  return m ? m[1] : null;
}

export function ShopifySidebarPanel({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const active = shopifySectionFromParams(searchParams);
  const onSurface = pathname.startsWith(`/w/${workspaceId}/shopify`);

  const [shop, setShop] = useState<{ name: string | null; domain: string | null }>({
    name: null,
    domain: null,
  });
  const [connected, setConnected] = useState<boolean | null>(null);
  const [drafts, setDrafts] = useState<DraftProduct[] | null>(null);
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

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const tools = await listTools(workspaceId);
        if (!alive) return;
        setConnected(tools.connected);
        if (!tools.connected) return;

        const info = await callTool<{ name?: string; myshopify_domain?: string }>(
          workspaceId,
          "shopifyGetShop",
          {},
        );
        if (!alive) return;
        setShop({ name: info.name ?? null, domain: info.myshopify_domain ?? null });

        const list = await callTool<{ items?: DraftProduct[] }>(workspaceId, "shopifyListProducts", {
          query: "status:draft",
          first: 10,
        });
        if (!alive) return;
        setDrafts(
          [...(list.items ?? [])]
            .sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")))
            .slice(0, 6),
        );
      } catch {
        // The panel is navigation first. A store we cannot reach must not stop
        // the section rows rendering, so this degrades to "no lists shown".
        if (alive) {
          setConnected(false);
          setDrafts([]);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [workspaceId]);

  const labels: Record<ShopifySection, string> = {
    draft: t.shopifyApp.tabDraft,
    inventory: t.shopifyApp.tabInventory,
    analyse: t.shopifyApp.tabAnalyse,
  };

  /** The history nested under a section, rendered only while it is open. */
  function historyFor(section: ShopifySection) {
    if (!connected) return null;

    if (section === "draft") {
      if (drafts === null) return <p className={subNoteCls}>{t.shopifyApp.loading}</p>;
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
