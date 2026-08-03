"use client";

/**
 * Feed connection — the reusable per-platform account lifecycle card.
 * Platform Settings embeds it so account health and Connect/Reconnect/
 * Disconnect no longer require a separate top-level page. The legacy
 * `/connection` route remains a redirect for old deep links.
 *
 * Connect always carries the route platform into `openConnect(platform)`;
 * this is the regression boundary that prevents X from reopening as Threads.
 *
 * [COMP:app-web/feed-connection]
 */

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { authFetch } from "@/lib/auth-fetch";
import { useFeedWorkspace } from "@/contexts/feed-profiles-context";
import { disconnectFeedProfile } from "@/lib/api/feed";
import { buildAuthorizeUrl } from "@/lib/feed-connect-account";
import { feedPath, isConnectableFeedPlatform } from "@/lib/feed-nav";
import type { FeedPlatform } from "@/lib/feed-nav";
import { useConnectAccount } from "@/components/feed/connect-account-dialog";
import { PlatformIcon } from "@/components/feed/platform-icon";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export function FeedConnection({ embedded = false }: { embedded?: boolean }) {
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
  const {
    openConnect,
    dialog: connectDialog,
    isAdmin: canConnect,
  } = useConnectAccount();
  const isAdmin = team.role === "admin" || team.role === "owner";

  // Coming-soon targets already participate in drafting but have no OAuth
  // integration. Settings still explains that state in the same account card.
  if (!isConnectableFeedPlatform(platform)) {
    if (embedded) {
      return (
        <section className="rounded-xl border border-border/60 bg-card p-4 shadow-xs">
          <div className="flex items-start gap-3">
            <PlatformMark platform={platform} muted />
            <div className="min-w-0 space-y-1">
              <h2 className="text-sm font-medium">
                {format(t.comingSoon.title, { platform: platformLabel })}
              </h2>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {format(t.comingSoon.body, { platform: platformLabel })}
              </p>
            </div>
          </div>
        </section>
      );
    }
    return (
      <div className="max-w-2xl space-y-4 px-4 py-6 md:px-6">
        <h1 className="text-[15px] font-semibold">
          {format(t.comingSoon.title, { platform: platformLabel })}
        </h1>
        <p className="text-sm text-muted-foreground">
          {format(t.comingSoon.body, { platform: platformLabel })}
        </p>
        <Link
          href={feedPath(params.workspaceId, { platform, segment: "posts" })}
          className="inline-flex h-8 items-center justify-center rounded-lg bg-foreground px-3 text-[12.5px] font-medium text-background transition-colors hover:bg-foreground/90"
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
      setError(
        err instanceof Error ? err.message : t.connection.connectionFailed,
      );
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
      setError(
        err instanceof Error ? err.message : t.connection.disconnectFailed,
      );
    } finally {
      setBusy(false);
    }
  }

  if (!profile) {
    const content = (
      <>
        {connectDialog}
        <section className="rounded-xl border border-border/60 bg-card p-4 shadow-xs">
          <div className="flex items-start gap-3">
            <PlatformMark platform={platform} muted />
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-medium">
                {format(t.connection.notConnectedTitle, {
                  platform: platformLabel,
                })}
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {format(t.connection.notConnectedBody, {
                  platform: platformLabel,
                })}
              </p>
              <div className="mt-3">
                {canConnect ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void openConnect(platform)}
                    className="border-foreground bg-foreground text-background hover:bg-foreground/90 hover:text-background"
                  >
                    {t.connection.connectCta}
                  </Button>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {t.connection.adminOnlyConnect}
                  </p>
                )}
              </div>
            </div>
          </div>
        </section>
      </>
    );
    if (embedded) return <div className="space-y-3">{content}</div>;
    return (
      <div className="mx-auto max-w-2xl space-y-3 px-4 py-6 md:px-6">
        {content}
      </div>
    );
  }

  const content = (
    <>
      {error ? (
        <div className="animate-pop-in rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <section className="rounded-xl border border-border/60 bg-card p-4 shadow-xs">
        <div className="flex items-start gap-3">
          <PlatformMark platform={platform} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="text-sm font-medium">
                  <span className="sr-only">{t.connection.handleLabel}: </span>@
                  {profile.platformHandle}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {t.connection.assistantLabel}{" "}
                  <span className="font-medium text-foreground/80">
                    {profile.assistant.name}
                  </span>
                </div>
              </div>
              <span
                className={
                  "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium " +
                  (profile.enabled
                    ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300")
                }
              >
                <span
                  className={
                    "size-1.5 rounded-full " +
                    (profile.enabled
                      ? "bg-emerald-600/80 dark:bg-emerald-400/80"
                      : "bg-amber-500/80 dark:bg-amber-400/80")
                  }
                />
                {profile.enabled
                  ? t.connection.statusEnabled
                  : t.connection.statusDisabled}
              </span>
            </div>

            <div className="mt-3 flex flex-wrap gap-2 border-t border-border/60 pt-3">
              {isAdmin ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => startConnect(profile.assistantId)}
                    disabled={busy}
                  >
                    {busy ? t.connection.reconnecting : t.connection.reconnect}
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={disconnect}
                    disabled={busy}
                  >
                    {t.connection.disconnect}
                  </Button>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {t.connection.adminOnlyManage}
                </p>
              )}
            </div>
          </div>
        </div>
      </section>
    </>
  );

  if (embedded) return <div className="space-y-3">{content}</div>;

  return (
    <div className="mx-auto max-w-4xl space-y-5 px-4 py-5 md:px-6">
      <header className="space-y-1.5">
        <h1 className="text-[15px] font-semibold">
          {format(t.connection.heading, { platform: platformLabel })}
        </h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {t.connection.subtitle}
        </p>
      </header>
      {content}
    </div>
  );
}

function PlatformMark({
  platform,
  muted = false,
}: {
  platform: FeedPlatform;
  muted?: boolean;
}) {
  return (
    <span
      className={
        "flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted " +
        (muted ? "text-muted-foreground" : "text-foreground")
      }
    >
      <PlatformIcon platform={platform} className="size-4" />
    </span>
  );
}
