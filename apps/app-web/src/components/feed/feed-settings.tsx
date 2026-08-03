"use client";

/**
 * Feed settings — the consolidated per-platform management surface.
 * Connection health and lifecycle actions live inline; only the deeper reply
 * policy and member-access editors remain links. This removes the old settings
 * index → connection page → connect dialog hop.
 *
 * [COMP:app-web/feed-settings]
 */

import { useParams } from "next/navigation";
import Link from "next/link";
import { useFeedWorkspace } from "@/contexts/feed-profiles-context";
import { FeedConnection } from "@/components/feed/feed-connection";
import { PlatformIcon } from "@/components/feed/platform-icon";
import { feedPath, type FeedPlatform } from "@/lib/feed-nav";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";

export function FeedSettings() {
  const params = useParams<{ workspaceId: string; platform: string }>();
  const team = useFeedWorkspace();
  const t = useT().feedPage;
  // The /feed/[platform] guard layout 404s junk platforms before this
  // renders, so the segment is always a known platform here.
  const platform = params.platform as FeedPlatform;
  const profile = team.profiles.find((p) => p.platform === platform);
  const platformLabel = t.platformLabels[platform] ?? platform;

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-5 md:px-6">
      <header className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
          <PlatformIcon platform={platform} className="size-4" />
        </span>
        <div className="min-w-0 space-y-1">
          <h1 className="text-[15px] font-semibold">
            {format(t.settings.heading, { platform: platformLabel })}
          </h1>
          <p className="text-sm text-muted-foreground">
            {profile
              ? format(t.settings.connectedAs, {
                  handle: profile.platformHandle,
                })
              : format(t.settings.notConnectedSubtitle, {
                  platform: platformLabel,
                })}
          </p>
        </div>
      </header>

      <section className="space-y-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t.settings.connectionTitle}
        </h2>
        <FeedConnection embedded />
      </section>

      <section className="grid gap-3 sm:grid-cols-2">
        <SettingCard
          href={feedPath(team.workspaceId, { platform, segment: "policy" })}
          title={t.settings.policyTitle}
          desc={t.settings.policyDesc}
          icon={<PolicyIcon />}
        />
        <SettingCard
          href={feedPath(team.workspaceId, { platform, segment: "settings/members" })}
          title={t.settings.membersTitle}
          desc={t.settings.membersDesc}
          icon={<MembersIcon />}
        />
      </section>
    </div>
  );
}

function SettingCard(props: {
  href: string;
  title: string;
  desc: string;
  icon: React.ReactNode;
}) {
  return (
    <Link
      href={props.href}
      className="group rounded-xl border border-border/60 bg-card p-4 shadow-xs transition-colors hover:bg-muted/50 active:bg-muted/70"
    >
      <div className="flex items-start gap-3">
        <span className="inline-flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors group-hover:text-foreground">
          {props.icon}
        </span>
        <div className="space-y-1 min-w-0">
          <div className="text-sm font-medium">{props.title}</div>
          <div className="text-xs text-muted-foreground leading-relaxed">{props.desc}</div>
        </div>
      </div>
    </Link>
  );
}

function PolicyIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 12h6" />
      <path d="M9 8h6" />
      <path d="M9 16h6" />
      <rect x="4" y="4" width="16" height="16" rx="3" />
    </svg>
  );
}

function MembersIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M21 19c0-2.3-1.5-4-4-4" />
    </svg>
  );
}
