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
 * [COMP:app-web/shopify-app]
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { OperatorTopbar } from "@/components/operator/operator-topbar";
import { buttonVariants } from "@/components/ui/button";
import { useT } from "@/lib/i18n/client";
import { listTools } from "@/lib/api/shopify";
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

  const [state, setState] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [availableTools, setAvailableTools] = useState<string[]>([]);

  // `replace`, not `push`: flipping between sections is a view change, not a
  // place you should have to press back through three times to leave.
  const setSection = useCallback(
    (next: ShopifySection) => {
      router.replace(`${pathname}?section=${next}`, { scroll: false });
    },
    [router, pathname],
  );

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await listTools(workspaceId);
        if (!alive) return;
        setAvailableTools(res.tools);
        setState(res.connected ? "ready" : "empty");
      } catch (err) {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
        setState("error");
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
    campaign: t.shopifyApp.tabCampaign,
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <OperatorTopbar
        app="shopify"
        center={
          state === "ready" ? (
            <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-sidebar-accent/60 p-0.5">
              {SHOPIFY_SECTIONS.map((key) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={section === key}
                  onClick={() => setSection(key)}
                  className={cn(
                    "inline-flex h-6.5 items-center rounded-md px-2 text-[12.5px] transition-colors",
                    section === key
                      ? "bg-background font-medium shadow-sm"
                      : "text-sidebar-foreground/70 hover:text-sidebar-accent-foreground",
                  )}
                >
                  {labels[key]}
                </button>
              ))}
            </div>
          ) : null
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-4 py-3">
          {state === "loading" ? (
            <p className="text-sm text-muted-foreground">{t.shopifyApp.loading}</p>
          ) : null}

          {state === "error" ? <Note tone="error">{error}</Note> : null}

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
                className={buttonVariants({ size: "sm" })}
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
