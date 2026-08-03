"use client";

/**
 * Feed first run — extracted from `feed-home.tsx`'s `EmptyHome` when the home
 * dashboard was retired (feed-revamp.md §8). It renders at the surface index
 * whenever the workspace has no brand voice yet, so Plan never opens onto an
 * empty calendar the operator cannot fill.
 *
 * Three steps (feed-create-split.md D7 + D14; step 3 feed-import-account.md §3.3):
 *   1. Name the brand voice -> plain `POST /api/assistants`
 *      (`kind='app'`, `appType='distribution'`; the server sets
 *      `clearance='public'`, satisfying the feed eligibility triple).
 *   2. Pick the platform(s) the brand posts on. Skip = all four. The pick is
 *      a per-device localStorage default read by Plan and Voice.
 *   3. Optional: "Already posting on X?" — a public handle seeds the tuning
 *      chat with the voice-import skill prompt and lands on the Voice page.
 *      Live-first-run only: a workspace whose pick was already stored never
 *      sees it (the step arms in `confirmPick`, not on mount).
 *
 * [COMP:app-web/feed-onboarding]
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Megaphone } from "lucide-react";
import { useFeedWorkspace } from "@/contexts/feed-profiles-context";
import { authFetch } from "@/lib/auth-fetch";
import {
  FEED_PLATFORMS,
  getFeedPlatformPick,
  setCurrentFeedPlatform,
  setFeedPlatformPick,
  type FeedPlatform,
} from "@/lib/feed-nav";
import { requestFeedChatSeed } from "@/lib/feed-chat-seed";
import { PlatformIcon } from "@/components/feed/platform-icon";
import { useT, format } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

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
  const router = useRouter();
  const brand = team.assistants[0] ?? null;

  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [picked, setPicked] = useState<FeedPlatform[]>([]);
  const [pickState, setPickState] = useState<"loading" | "needed" | "done">(
    "loading",
  );
  // Step 3 (feed-import-account.md §3.3): offered ONLY on the live first-run
  // path — `confirmPick` arms it. Default "done" so a workspace whose pick
  // was already stored (pickState reads "done" on mount) skips straight to
  // `onReady` exactly as before this step existed.
  const [voiceState, setVoiceState] = useState<"done" | "offered">("done");
  const [voiceHandle, setVoiceHandle] = useState("");
  // Read in an effect, not the initialiser: localStorage is unavailable
  // during SSR, and reading it inline would make the first client paint
  // disagree with the server's.
  useEffect(() => {
    setPickState(
      getFeedPlatformPick(team.workspaceId).length > 0 ? "done" : "needed",
    );
  }, [team.workspaceId]);

  useEffect(() => {
    if (brand && pickState === "done" && voiceState === "done") onReady();
  }, [brand, pickState, voiceState, onReady]);

  function confirmPick(platforms: readonly FeedPlatform[]) {
    setFeedPlatformPick(team.workspaceId, platforms);
    if (platforms[0]) setCurrentFeedPlatform(team.workspaceId, platforms[0]);
    setVoiceState("offered");
    setPickState("done");
  }

  /**
   * Seed the tuning chat with the voice-import skill prompt for the given
   * handle and land on the Voice page. The feed dock stays mounted across
   * feed route changes, so the seeded composer survives the navigation.
   */
  function importVoice() {
    const trimmed = voiceHandle.trim().replace(/^@/, "").slice(0, 30);
    if (trimmed) {
      requestFeedChatSeed({
        prefill: format(t.voice.importHandlePrompt, { handle: trimmed }),
      });
      router.push(`/w/${team.workspaceId}/feed/voice`);
    }
    setVoiceState("done");
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

  if (brand && pickState === "needed") {
    return (
      <div className="grid min-h-full w-full bg-muted/15 lg:grid-cols-[minmax(0,1.08fr)_minmax(360px,0.92fr)]">
        <main className="flex items-center border-b border-border/60 bg-background px-5 py-10 sm:px-8 lg:border-b-0 lg:border-r lg:px-12">
          <div className="mx-auto w-full max-w-2xl space-y-8 lg:mx-0">
            <header className="space-y-3">
              <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                <Megaphone className="size-3.5" aria-hidden />
                {t.home.setupEyebrow}
                <span aria-hidden>·</span>
                {t.home.pickStep}
              </div>
              <h1 className="text-xl font-semibold tracking-tight">{t.home.pickTitle}</h1>
              <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
                {t.home.pickBody}
              </p>
            </header>

            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {FEED_PLATFORMS.map((platform) => {
                const active = picked.includes(platform);
                return (
                  <button
                    key={platform}
                    type="button"
                    onClick={() =>
                      setPicked((previous) =>
                        previous.includes(platform)
                          ? previous.filter((item) => item !== platform)
                          : [...previous, platform],
                      )
                    }
                    aria-pressed={active}
                    className={cn(
                      "flex min-h-20 items-start gap-3 rounded-xl border p-3.5 text-left transition-colors",
                      active
                        ? "border-foreground bg-foreground text-background"
                        : "border-border/70 bg-background hover:bg-muted/50",
                    )}
                  >
                    <span className={cn("inline-flex size-8 shrink-0 items-center justify-center rounded-lg border", active ? "border-background/20 bg-background/10" : "border-border/60 bg-muted/40")}>
                      <PlatformIcon platform={platform} className="size-4" />
                    </span>
                    <span className="pt-1 text-[12.5px] font-medium">
                      {t.platformLabels[platform]}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center gap-3 border-t border-border/60 pt-5">
              <Button
                type="button"
                onClick={() => confirmPick(picked)}
                disabled={picked.length === 0}
                className="bg-foreground text-background shadow-none hover:bg-foreground/90"
              >
                {t.home.pickCta}
              </Button>
              <Button variant="ghost" type="button" onClick={() => confirmPick(FEED_PLATFORMS)}>
                {t.home.pickSkip}
              </Button>
            </div>
          </div>
        </main>

        <aside className="flex items-center px-5 py-10 sm:px-8 lg:px-12">
          <div className="mx-auto w-full max-w-md space-y-3">
            <div className="rounded-2xl border border-border/60 bg-background p-5 shadow-xs">
              <div className="flex items-start gap-3">
                <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-foreground text-background">
                  <Megaphone className="size-4" aria-hidden />
                </span>
                <div>
                  <h2 className="text-[13px] font-semibold">{t.home.pickWhyTitle}</h2>
                  <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
                    {t.home.pickWhyBody}
                  </p>
                </div>
              </div>
            </div>
            <div className="rounded-2xl border border-border/60 bg-background/70 p-5">
              <h2 className="text-[13px] font-semibold">{t.home.pickTipTitle}</h2>
              <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
                {t.home.pickTipBody}
              </p>
            </div>
          </div>
        </aside>
      </div>
    );
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
        ) : brand && pickState === "done" && voiceState === "offered" ? (
          <>
            <h1 className="text-[15px] font-semibold">
              {t.home.onboardVoiceTitle}
            </h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {t.home.onboardVoiceBody}
            </p>
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                importVoice();
              }}
            >
              <input
                type="text"
                value={voiceHandle}
                onChange={(e) => setVoiceHandle(e.target.value)}
                placeholder={t.home.onboardVoicePlaceholder}
                className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm focus:border-primary/50 focus:outline-none"
              />
              <button
                type="submit"
                disabled={voiceHandle.trim().replace(/^@/, "").length === 0}
                className="inline-flex h-8 w-full items-center justify-center rounded-lg bg-primary px-3 text-[12.5px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {t.home.onboardVoiceCta}
              </button>
            </form>
            <button
              type="button"
              onClick={() => setVoiceState("done")}
              className="text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              {t.home.onboardVoiceSkip}
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
