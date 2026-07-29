"use client";

/**
 * Feed first run — extracted from `feed-home.tsx`'s `EmptyHome` when the home
 * dashboard was retired (feed-revamp.md §8). It renders at the surface index
 * whenever the workspace has no brand voice yet, so Plan never opens onto an
 * empty calendar the operator cannot fill.
 *
 * Two steps (feed-create-split.md D7 + D14), unchanged by the revamp:
 *   1. Name the brand voice -> plain `POST /api/assistants`
 *      (`kind='app'`, `appType='distribution'`; the server sets
 *      `clearance='public'`, satisfying the feed eligibility triple).
 *   2. Pick the platform(s) the brand posts on. Skip = all four. The pick is
 *      a per-device localStorage default read by Plan and Voice.
 *
 * [COMP:app-web/feed-onboarding]
 */

import { useEffect, useState } from "react";
import { Megaphone } from "lucide-react";
import { useFeedWorkspace } from "@/contexts/feed-profiles-context";
import { authFetch } from "@/lib/auth-fetch";
import {
  FEED_PLATFORMS,
  getFeedPlatformPick,
  setFeedPlatformPick,
  type FeedPlatform,
} from "@/lib/feed-nav";
import { PlatformIcon } from "@/components/feed/platform-icon";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export function FeedOnboarding({
  canCreateBrand,
  canConnect,
  onConnect,
  onReady,
}: {
  canCreateBrand: boolean;
  canConnect: boolean;
  onConnect: () => void;
  /** Fired once both steps are done, so the surface can swap to the Plan. */
  onReady: () => void;
}) {
  const t = useT().feedPage;
  const team = useFeedWorkspace();
  const brand = team.assistants[0] ?? null;

  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [picked, setPicked] = useState<FeedPlatform[]>([]);
  const [pickState, setPickState] = useState<"loading" | "needed" | "done">(
    "loading",
  );
  // Read in an effect, not the initialiser: localStorage is unavailable
  // during SSR, and reading it inline would make the first client paint
  // disagree with the server's.
  useEffect(() => {
    setPickState(
      getFeedPlatformPick(team.workspaceId).length > 0 ? "done" : "needed",
    );
  }, [team.workspaceId]);

  useEffect(() => {
    if (brand && pickState === "done") onReady();
  }, [brand, pickState, onReady]);

  function confirmPick(platforms: readonly FeedPlatform[]) {
    setFeedPlatformPick(team.workspaceId, platforms);
    setPickState("done");
  }

  async function createBrand() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t.home.emptyNameRequired);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await authFetch(`${API_URL}/api/assistants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmed,
          kind: "app",
          appType: "distribution",
          workspaceId: team.workspaceId,
        }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b?.error ?? t.home.emptyCreateFailed);
      }
      await team.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.home.emptyCreateFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-[70vh] items-center justify-center px-6">
      <div className="w-full max-w-sm space-y-5 text-center">
        <div className="mx-auto inline-flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground ring-1 ring-border">
          <Megaphone className="size-5" aria-hidden />
        </div>

        {brand && pickState === "loading" ? null : brand &&
          pickState === "needed" ? (
          <>
            <h1 className="text-[15px] font-semibold">{t.home.pickTitle}</h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {t.home.pickBody}
            </p>
            <div className="flex flex-wrap justify-center gap-1.5">
              {FEED_PLATFORMS.map((p) => {
                const active = picked.includes(p);
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() =>
                      setPicked((prev) =>
                        prev.includes(p)
                          ? prev.filter((x) => x !== p)
                          : [...prev, p],
                      )
                    }
                    aria-pressed={active}
                    className={cn(
                      "inline-flex h-8 items-center gap-1.5 rounded-full border px-3.5 text-[12.5px] font-medium transition-colors",
                      active
                        ? "border-transparent bg-foreground text-background"
                        : "border-border bg-background text-muted-foreground hover:bg-accent",
                    )}
                  >
                    <PlatformIcon platform={p} className="size-3.5" />
                    {t.platformLabels[p]}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              onClick={() => confirmPick(picked)}
              disabled={picked.length === 0}
              className="inline-flex h-8 w-full items-center justify-center rounded-lg bg-primary px-3 text-[12.5px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {t.home.pickCta}
            </button>
            <button
              type="button"
              onClick={() => confirmPick(FEED_PLATFORMS)}
              className="text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              {t.home.pickSkip}
            </button>
          </>
        ) : (
          <>
            <h1 className="text-[15px] font-semibold">{t.home.emptyTitle}</h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {t.home.emptyBody}
            </p>
            {canCreateBrand ? (
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void createBrand();
                }}
              >
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t.home.emptyNamePlaceholder}
                  disabled={busy}
                  className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm focus:border-primary/50 focus:outline-none disabled:opacity-50"
                />
                <button
                  type="submit"
                  disabled={busy}
                  className="inline-flex h-8 w-full items-center justify-center rounded-lg bg-primary px-3 text-[12.5px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  {busy ? t.home.emptyCreating : t.home.emptyCta}
                </button>
                {error ? (
                  <p className="text-sm text-destructive">{error}</p>
                ) : null}
                {canConnect ? (
                  <div className="space-y-2 pt-1">
                    <p className="text-xs text-muted-foreground">
                      {t.home.emptyOrConnect}
                    </p>
                    <button
                      type="button"
                      onClick={onConnect}
                      disabled={busy}
                      className="inline-flex h-8 items-center justify-center rounded-lg border border-border px-3 text-[12.5px] font-medium transition-colors hover:bg-accent disabled:opacity-50"
                    >
                      {t.home.emptyConnectCta}
                    </button>
                  </div>
                ) : null}
              </form>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t.home.emptyAskAdmin}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
