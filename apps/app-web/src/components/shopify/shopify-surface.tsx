"use client";

/**
 * The Shopify operator surface.
 *
 * A built-in app, not a sandboxed bundle: it renders in-process with the
 * user's session and reaches the store through `/api/apps/shopify`, which
 * executes tools but never decides them.
 *
 * Structure is the operator-surface shape every other built-in uses -
 * `OperatorTopbar` over a full-height column, sections in the topbar's `center`
 * slot AND in the left sidebar panel, exactly as CRM does. The workspace layout
 * never constrains width, so nothing here may either: a `max-w` on the root is
 * what made this read as a document rather than an app.
 *
 * Availability is a runtime question, not a config one. There is no per-
 * workspace install for a built-in, so the surface asks the server what it can
 * reach and says plainly when the answer is nothing - a store connector that
 * has not been shared with this workspace is the likeliest state, and it is one
 * the owner can fix in Studio.
 *
 * That reachability answer is read through the surface cache
 * (`shopifyToolsCacheKey`, instant-navigation contract N1/N2): the sidebar
 * panel reads the SAME key and the Shopify icon's hover warms it, so a revisit
 * paints the section strip on the first frame and the three never fetch
 * separately. An external store has no workspace-event spine primitive, so
 * the entry revalidates on mount past the stale window and on Retry; an empty
 * cache paints the rail skeleton, never a sentence (N4).
 *
 * The section strip sits in the topbar centre from `md` and, below it, in a
 * full-width two-column row under the bar (responsive contract M8): at 360px
 * the bar's left cluster leaves ~220px for the centre slot, and the four
 * labels need ~420px, so a strip parked in the slot was a blind horizontal
 * scrub. Buttons are 36px on a phone (M3) and the bar's 26px from `md`.
 *
 * [COMP:app-web/shopify-app]
 * [COMP:app-web/shopify-surface-cache] (the cache read + first-paint rule)
 */

import { useCallback } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { RailSurfaceSkeleton } from "@/components/chrome/surface-skeleton";
import { OperatorTopbar } from "@/components/operator/operator-topbar";
import { Button, buttonVariants } from "@/components/ui/button";
import { useT } from "@/lib/i18n/client";
import { listTools } from "@/lib/api/shopify";
import { shopifyToolsCacheKey } from "@/lib/surface-prefetch";
import { useLeasedResource } from "@/lib/offline/surface-content-cache";
import {
  SHOPIFY_SECTIONS,
  shopifySectionFromParams,
  type ShopifySection,
} from "@/lib/shopify-view";
import { cn } from "@/lib/utils";
import { AnalyseTab } from "./analyse-tab";
import { CampaignTab } from "./campaign-tab";
import { DraftTab } from "./draft-tab";
import { InventoryTab } from "./inventory-tab";
import { Note } from "./shopify-shared";

export function ShopifySurface({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const section = shopifySectionFromParams(searchParams);

  // The reachability answer, from the surface cache. `null` key until the
  // route hands over a workspace id, so a half-mounted page never fetches
  // (or caches) under an empty key.
  // Leased (perceived-performance.md, "Content lease for protected lists"):
  // when the store stops being reachable for this viewer, the tabs and the
  // store data they hold unmount within 30 seconds.
  const tools = useLeasedResource(
    workspaceId ? shopifyToolsCacheKey(workspaceId) : null,
    () => listTools(workspaceId),
  );
  const state: "loading" | "ready" | "empty" | "error" = tools.data
    ? tools.data.connected
      ? "ready"
      : "empty"
    : tools.error !== undefined
      ? "error"
      : "loading";
  const error =
    tools.error instanceof Error
      ? tools.error.message
      : tools.error !== undefined
        ? String(tools.error)
        : null;
  const availableTools = tools.data?.tools ?? [];

  // `replace`, not `push`: flipping between sections is a view change, not a
  // place you should have to press back through three times to leave.
  const setSection = useCallback(
    (next: ShopifySection) => {
      router.replace(`${pathname}?section=${next}`, { scroll: false });
    },
    [router, pathname],
  );

  const labels: Record<ShopifySection, string> = {
    draft: t.shopifyApp.tabDraft,
    inventory: t.shopifyApp.tabInventory,
    analyse: t.shopifyApp.tabAnalyse,
    campaign: t.shopifyApp.tabCampaign,
  };

  /**
   * The section switch, rendered twice from one recipe: in the topbar centre
   * from `md` (a 26px inline strip) and as a full-width two-column row below
   * the bar on a phone (36px cells, every section visible, no scrub).
   */
  const sectionStrip = (placement: "topbar" | "phone") => (
    <div
      data-shopify-sections={placement}
      className={cn(
        "gap-0.5 rounded-lg bg-sidebar-accent/60 p-0.5",
        placement === "topbar"
          ? "hidden shrink-0 items-center md:flex"
          : "grid grid-cols-2 md:hidden",
      )}
    >
      {SHOPIFY_SECTIONS.map((key) => (
        <button
          key={key}
          type="button"
          aria-pressed={section === key}
          onClick={() => setSection(key)}
          className={cn(
            "inline-flex h-9 items-center justify-center rounded-md px-2 text-[12.5px] transition-colors md:h-6.5 md:justify-start",
            section === key
              ? "bg-background font-medium shadow-sm"
              : "text-sidebar-foreground/70 hover:text-sidebar-accent-foreground",
          )}
        >
          {labels[key]}
        </button>
      ))}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <OperatorTopbar
        app="shopify"
        center={state === "ready" ? sectionStrip("topbar") : null}
      />
      {state === "ready" ? (
        <div className="shrink-0 border-b border-border px-3 py-2 md:hidden">
          {sectionStrip("phone")}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-4 py-3">
          {state === "loading" ? (
            // Nothing cached yet: the rail shape the route's `loading.tsx`
            // already drew, minus the chrome the topbar above just painted.
            <RailSurfaceSkeleton chrome={false} padded={false} rows={4} />
          ) : null}

          {state === "error" ? (
            <div className="max-w-xl space-y-2">
              <Note tone="error">{error}</Note>
              {/* The cache never retries a cold-load failure on its own (a
                  mounted surface must not hammer a broken endpoint), so the
                  retry is an explicit control. */}
              <Button variant="outline" size="sm" onClick={() => void tools.refresh()}>
                {t.shopifyApp.retry}
              </Button>
            </div>
          ) : null}

          {state === "empty" ? (
            // The measure lives on THIS block, never the root: an empty-state
            // paragraph stretched across a wide pane is unreadable, while the
            // tables and template grid below want every pixel.
            <div className="max-w-xl space-y-2 rounded-xl border border-border bg-card px-4 py-4">
              <p className="text-sm font-medium">{t.shopifyApp.notConnected}</p>
              <p className="text-[13px] text-muted-foreground">{t.shopifyApp.notConnectedHelp}</p>
              {/* `buttonVariants`, not hand-rolled classes: the filled action
                  token is `bg-action`, and `bg-primary` fills are a frozen
                  legacy list reserved for compact indicators. */}
              <Link
                href={`/w/${workspaceId}/studio/connectors`}
                // 36px on a phone (M3); the compact 28px only from `md`.
                className={buttonVariants({ size: "sm", className: "h-9 md:h-7" })}
              >
                {t.shopifyApp.openStudio}
              </Link>
            </div>
          ) : null}

          {state === "ready" ? (
            <>
              {section === "draft" ? <DraftTab workspaceId={workspaceId} /> : null}
              {section === "inventory" ? <InventoryTab workspaceId={workspaceId} /> : null}
              {section === "analyse" ? <AnalyseTab workspaceId={workspaceId} /> : null}
              {section === "campaign" ? (
                <CampaignTab workspaceId={workspaceId} availableTools={availableTools} />
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
