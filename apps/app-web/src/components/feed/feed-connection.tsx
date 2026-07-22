"use client";

/**
 * Feed connection — the per-platform account lifecycle page, ported
 * faithfully from
 * `apps/feed-web/src/app/w/[workspaceId]/[platform]/connection/page.tsx`
 * (docs/plans/feed-web-consolidation.md §7.6): handle + enabled badge card,
 * admin-gated reconnect (OAuth) and disconnect, and the connect-account
 * dialog entry for the not-connected state.
 *
 * Port deltas (disposition rules §6):
 *   - `useWorkspaceContext()` → `useFeedWorkspace()`; the post-disconnect
 *     `router.refresh()` (feed-web re-ran its server-layout profile fetch)
 *     → `team.refresh()` on the client provider, so the sidebar + context
 *     drop the profile immediately.
 *   - The reconnect OAuth URL rides `buildAuthorizeUrl` — `return_to` lands
 *     on the feed home (`/feed?connected=<platform>`, the one allowlisted
 *     landing with the connected banner + one-shot refresh) instead of
 *     feed-web's return to this page.
 *   - feed-web's `useConfirm()` (in-page dialog element) → the app-root
 *     `confirmDialog()` promise; the inline disconnect DELETE → the feed
 *     SDK (`disconnectFeedProfile`).
 *   - All copy via `useT().feedPage.connection` (+ shared `platformLabels`).
 *
 * [COMP:app-web/feed-connection]
 */

import { useState } from "react";
import Link from "next/link";
import { authFetch } from "@/lib/auth-fetch";
import { useFeedWorkspace } from "@/contexts/feed-profiles-context";
import { disconnectFeedProfile } from "@/lib/api/feed";
import { buildAuthorizeUrl } from "@/lib/feed-connect-account";
import { feedPath, isConnectableFeedPlatform } from "@/lib/feed-nav";
import type { FeedPlatform } from "@/lib/feed-nav";
import { useConnectAccount } from "@/components/feed/connect-account-dialog";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { useParams } from "next/navigation";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export function FeedConnection() {
  const params = useParams<{ workspaceId: string; platform: string }>();
  const team = useFeedWorkspace();
  const t = useT().feedPage;
  // The /feed/[platform] guard layout 404s junk platforms before this
  // renders, so the segment is always a known platform here.
  const platform = params.platform as FeedPlatform;
  const profile = team.profiles.find((p) => p.platform === platform);
  const platformLabel = t.platformLabels[platform] ?? platform;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { openConnect, dialog: connectDialog, isAdmin: canConnect } = useConnectAccount();

  const isAdmin = team.role === "admin" || team.role === "owner";

  // Coming-soon stub for create-only targets (instagram/xhs) — no OAuth
  // integration yet; drafting + the ready queue already work for them
  // (docs/plans/feed-create-split.md D11).
  if (!isConnectableFeedPlatform(platform)) {
    return (
      <div className="px-4 md:px-6 py-6 max-w-2xl space-y-4">
        <h1
          className="text-[15px] font-semibold"        >
          {format(t.comingSoon.title, { platform: platformLabel })}
        </h1>
        <p className="text-sm text-muted-foreground">
          {format(t.comingSoon.body, { platform: platformLabel })}
        </p>
        <Link
          href={feedPath(params.workspaceId, { segment: "drafts" })}
          className="inline-flex items-center justify-center rounded-lg bg-primary px-3 h-8 text-[12.5px] font-medium text-primary-foreground hover:bg-primary/90"
        >
          {t.comingSoon.draftsCta}
        </Link>
      </div>
    );
  }

  async function startConnect(targetAssistantId: string) {
    if (!isConnectableFeedPlatform(platform)) return;
    setBusy(true);
    setError(null);
    try {
      const url = buildAuthorizeUrl({
        apiUrl: API_URL,
        platform,
        assistantId: targetAssistantId,
        origin: window.location.origin,
        workspaceId: team.workspaceId,
      });
      const res = await authFetch(url);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          body?.error ??
            format(t.connection.oauthStartFailed, { platform: platformLabel }),
        );
      }
      const data = (await res.json()) as { redirect: string };
      window.location.href = data.redirect;
    } catch (err) {
      setError(err instanceof Error ? err.message : t.connection.connectionFailed);
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!profile) return;
    const ok = await confirmDialog({
      title: format(t.connection.confirmDisconnectTitle, {
        handle: profile.platformHandle,
      }),
      description: format(t.connection.confirmDisconnectDescription, {
        platform: platformLabel,
      }),
      confirmLabel: t.connection.disconnect,
      variant: "destructive",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const result = await disconnectFeedProfile(profile.assistantId, platform);
      if (!result.ok) {
        throw new Error(result.error ?? t.connection.disconnectFailed);
      }
      await team.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.connection.disconnectFailed);
    } finally {
      setBusy(false);
    }
  }

  if (!profile) {
    return (
      <div className="px-4 md:px-6 py-6 max-w-2xl space-y-4">
        {connectDialog}
        <header>
          <h1 className="text-[15px] font-semibold">
            {format(t.connection.notConnectedTitle, { platform: platformLabel })}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {format(t.connection.notConnectedBody, { platform: platformLabel })}
          </p>
        </header>
        {canConnect ? (
          <button
            type="button"
            onClick={openConnect}
            className="inline-flex items-center justify-center rounded-lg bg-primary px-3 h-8 text-[12.5px] font-medium text-primary-foreground hover:bg-primary/90"
          >
            {t.connection.connectCta}
          </button>
        ) : (
          <p className="text-sm text-muted-foreground">{t.connection.adminOnlyConnect}</p>
        )}
      </div>
    );
  }

  return (
    <div className="px-4 md:px-6 py-5 max-w-4xl mx-auto space-y-5">
      <header className="space-y-1.5">
        <h1 className="text-[15px] font-semibold">
          {format(t.connection.heading, { platform: platformLabel })}
        </h1>
        <p className="text-sm text-muted-foreground leading-relaxed">
          {t.connection.subtitle}
        </p>
      </header>

      {error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive animate-pop-in">
          {error}
        </div>
      ) : null}

      <section className="rounded-xl border border-border bg-card p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              {t.connection.handleLabel}
            </div>
            <div className="text-base font-medium mt-1">@{profile.platformHandle}</div>
          </div>
          <span
            className={
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset " +
              (profile.enabled
                ? "bg-emerald-500/15 text-emerald-300 ring-emerald-400/25"
                : "bg-amber-500/15 text-amber-300 ring-amber-400/25")
            }
          >
            <span
              className={
                "h-1.5 w-1.5 rounded-full " +
                (profile.enabled ? "bg-emerald-400 animate-pulse-soft" : "bg-amber-400")
              }
            />
            {profile.enabled ? t.connection.statusEnabled : t.connection.statusDisabled}
          </span>
        </div>
        <div className="text-xs text-muted-foreground hairline pt-3 border-t border-border">
          {t.connection.assistantLabel}{" "}
          <span className="font-mono text-foreground/85">{profile.assistant.name}</span>
        </div>
      </section>

      {isAdmin ? (
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => startConnect(profile.assistantId)}
            disabled={busy}
            className="rounded-lg border border-border bg-card px-3 h-8 text-[12.5px] font-medium hover:bg-accent active:bg-accent/80 disabled:opacity-50 transition-colors press"
          >
            {busy ? t.connection.reconnecting : t.connection.reconnect}
          </button>
          <button
            type="button"
            onClick={disconnect}
            disabled={busy}
            className="rounded-lg border border-destructive/40 text-destructive px-3 h-8 text-[12.5px] font-medium hover:bg-destructive/10 active:bg-destructive/15 disabled:opacity-50 transition-colors press"
          >
            {t.connection.disconnect}
          </button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t.connection.adminOnlyManage}
        </p>
      )}
    </div>
  );
}
