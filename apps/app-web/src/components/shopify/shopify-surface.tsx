"use client";

/**
 * The Shopify operator surface.
 *
 * A built-in app, not a sandboxed bundle: it renders in-process with the
 * user's session and reaches the store through `/api/apps/shopify`, which
 * executes tools but never decides them.
 *
 * Availability is a runtime question, not a config one. There is no per-
 * workspace install for a built-in, so the surface asks the server what it can
 * reach and says plainly when the answer is nothing - a store connector that
 * has not been shared with this workspace is the likeliest state, and it is one
 * the owner can fix in Studio.
 *
 * [COMP:app-web/shopify-app]
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { ShoppingBag } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { useT } from "@/lib/i18n/client";
import { listTools } from "@/lib/api/shopify";
import { AnalyseTab } from "./analyse-tab";
import { DraftTab } from "./draft-tab";
import { InventoryTab } from "./inventory-tab";
import { Note } from "./shopify-shared";

type TabKey = "draft" | "inventory" | "analyse";

export function ShopifySurface({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const [tab, setTab] = useState<TabKey>("draft");
  const [state, setState] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await listTools(workspaceId);
        if (!alive) return;
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

  const tabs: Array<{ key: TabKey; label: string }> = [
    { key: "draft", label: t.shopifyApp.tabDraft },
    { key: "inventory", label: t.shopifyApp.tabInventory },
    { key: "analyse", label: t.shopifyApp.tabAnalyse },
  ];

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6">
      <header className="flex items-start gap-3">
        <ShoppingBag className="mt-0.5 size-5 text-muted-foreground" aria-hidden />
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{t.shopifyApp.title}</h1>
          <p className="mt-0.5 text-[13px] text-muted-foreground">{t.shopifyApp.subtitle}</p>
        </div>
      </header>

      {state === "loading" ? (
        <p className="mt-6 text-sm text-muted-foreground">{t.shopifyApp.loading}</p>
      ) : null}

      {state === "error" ? (
        <div className="mt-6">
          <Note tone="error">{error}</Note>
        </div>
      ) : null}

      {state === "empty" ? (
        <div className="mt-6 space-y-3 rounded-xl border border-border bg-card px-5 py-6">
          <p className="text-sm font-medium">{t.shopifyApp.notConnected}</p>
          <p className="text-[13px] text-muted-foreground">{t.shopifyApp.notConnectedHelp}</p>
          {/* `buttonVariants`, not hand-rolled classes: the filled action token
              is `bg-action`, and `bg-primary` fills are a frozen legacy list
              reserved for compact indicators (badges, avatars). */}
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
          <div
            role="tablist"
            aria-label={t.shopifyApp.title}
            className="mt-5 flex gap-1 border-b border-border"
          >
            {tabs.map((x) => (
              <button
                key={x.key}
                role="tab"
                type="button"
                aria-selected={tab === x.key}
                onClick={() => setTab(x.key)}
                className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                  tab === x.key
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {x.label}
              </button>
            ))}
          </div>

          <div className="mt-5">
            {tab === "draft" ? <DraftTab workspaceId={workspaceId} /> : null}
            {tab === "inventory" ? <InventoryTab workspaceId={workspaceId} /> : null}
            {tab === "analyse" ? <AnalyseTab workspaceId={workspaceId} /> : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
