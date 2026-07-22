"use client";

/**
 * Feed settings — the per-platform settings index, ported faithfully from
 * `apps/feed-web/src/app/w/[workspaceId]/[platform]/settings/page.tsx`
 * (docs/plans/feed-web-consolidation.md §7.6): three cards linking to the
 * reply-policy editor, the connection lifecycle page, and the members
 * draft-access page.
 *
 * Port deltas (disposition rules §6):
 *   - `useWorkspaceContext()` → `useFeedWorkspace()`; hrefs via `feedPath()`.
 *   - All copy via `useT().feedPage.settings` (+ shared `platformLabels`).
 *   - feed-web's per-route `settings/layout.tsx` (metadata-only passthrough)
 *     is folded — the feed surface's client routes carry no per-page
 *     metadata (same treatment as every other ported feed route).
 *
 * [COMP:app-web/feed-settings]
 */

import { useParams } from "next/navigation";
import Link from "next/link";
import { useFeedWorkspace } from "@/contexts/feed-profiles-context";
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
    <div className="px-4 md:px-6 py-5 max-w-5xl mx-auto space-y-5">
      <header className="space-y-1.5">
        <h1 className="text-[15px] font-semibold">
          {format(t.settings.heading, { platform: platformLabel })}
        </h1>
        <p className="text-sm text-muted-foreground">
          {profile
            ? format(t.settings.connectedAs, { handle: profile.platformHandle })
            : format(t.settings.notConnectedSubtitle, { platform: platformLabel })}
        </p>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 animate-stagger">
        <SettingCard
          href={feedPath(team.workspaceId, { platform, segment: "policy" })}
          title={t.settings.policyTitle}
          desc={t.settings.policyDesc}
          icon={<PolicyIcon />}
        />
        <SettingCard
          href={feedPath(team.workspaceId, { platform, segment: "connection" })}
          title={t.settings.connectionTitle}
          desc={
            profile
              ? format(t.settings.connectionDescConnected, {
                  handle: profile.platformHandle,
                })
              : format(t.settings.connectionDescNotConnected, {
                  platform: platformLabel,
                })
          }
          icon={<PlugIcon />}
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
      className="group rounded-xl border border-border bg-card p-4 hover:border-primary/40 hover:bg-accent/40 active:bg-accent/55 transition-all duration-200"
    >
      <div className="flex items-start gap-3">
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20 transition-all duration-200 group-hover:bg-primary/15 group-hover:ring-primary/35">
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

function PlugIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 2v6" />
      <path d="M15 2v6" />
      <path d="M5 8h14v3a7 7 0 0 1-14 0V8z" />
      <path d="M12 18v4" />
    </svg>
  );
}
