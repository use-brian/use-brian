"use client";

/**
 * Feed reply policy — the structured per-platform policy editor, ported
 * faithfully from
 * `apps/feed-web/src/app/w/[workspaceId]/[platform]/policy/page.tsx`
 * (docs/plans/feed-web-consolidation.md §7.6): the three-way auto-reply
 * mode radio, whitelist-handles + blocked-topics line-list textareas, the
 * admin-gated sticky save bar, and the raw replyPolicy JSON disclosure.
 *
 * Port deltas (disposition rules §6):
 *   - `useWorkspaceContext()` → `useFeedWorkspace()`; inline `authFetch`
 *     RPCs → the feed SDK (`fetchFeedAssistantProfiles` /
 *     `updateFeedProfilePolicy`).
 *   - The `!profile` empty state links to the feed home (`feedPath`) —
 *     feed-web's `/onboarding` route is not ported (§5 route map).
 *   - The load-failure banner shows the fixed `policy.loadFailed` copy
 *     (feed-web surfaced its own thrown "Failed to load policy" string).
 *   - All copy via `useT().feedPage.policy` (+ shared `platformLabels`).
 *   - Native radio inputs stay (not on the banned-primitives list).
 *
 * [COMP:app-web/feed-policy]
 */

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useFeedWorkspace } from "@/contexts/feed-profiles-context";
import {
  fetchFeedAssistantProfiles,
  updateFeedProfilePolicy,
  type FeedAutoReplyMode,
  type FeedProfilePolicy,
  type FeedReplyPolicy,
} from "@/lib/api/feed";
import { feedPath, type FeedPlatform } from "@/lib/feed-nav";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";

type FeedPageDict = ReturnType<typeof useT>["feedPage"];
type PolicyDict = FeedPageDict["policy"];

const MODE_VALUES: readonly FeedAutoReplyMode[] = [
  "disabled",
  "draft-only",
  "auto-whitelisted",
];

/**
 * feed-web's `parseList` — one entry per line, trimmed, empties dropped.
 * The serialization the PATCH body ships for both line-list textareas.
 */
// exported for tests
export function parsePolicyList(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The inverse — the newline-joined textarea seed feed-web applied inline
 * to the loaded policy lists (`(list ?? []).join("\n")`).
 */
// exported for tests
export function formatPolicyList(items: string[] | undefined): string {
  return (items ?? []).join("\n");
}

export function FeedPolicy() {
  const params = useParams<{ workspaceId: string; platform: string }>();
  const team = useFeedWorkspace();
  const t = useT().feedPage;
  // The /feed/[platform] guard layout 404s junk platforms before this
  // renders, so the segment is always a known platform here.
  const platform = params.platform as FeedPlatform;
  const profile = team.profiles.find((p) => p.platform === platform);
  const platformLabel = t.platformLabels[platform] ?? platform;
  const isAdmin = team.role === "admin" || team.role === "owner";

  const [data, setData] = useState<FeedProfilePolicy | null>(null);
  const [autoReplyMode, setAutoReplyMode] = useState<FeedAutoReplyMode>("draft-only");
  const [whitelist, setWhitelist] = useState("");
  const [blocked, setBlocked] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!profile) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const profiles = await fetchFeedAssistantProfiles(profile.assistantId);
        const match = profiles.find((p) => p.platform === platform);
        if (!match || cancelled) return;
        setData(match);
        setAutoReplyMode(match.autoReplyMode);
        setWhitelist(formatPolicyList(match.replyPolicy?.whitelistHandles));
        setBlocked(formatPolicyList(match.replyPolicy?.blockedTopics));
      } catch {
        if (!cancelled) setError(t.policy.loadFailed);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, platform]);

  async function save() {
    if (!profile) return;
    setSaving(true);
    setError(null);
    try {
      const replyPolicy: FeedReplyPolicy = {
        whitelistHandles: parsePolicyList(whitelist),
        blockedTopics: parsePolicyList(blocked),
      };
      const result = await updateFeedProfilePolicy(profile.assistantId, platform, {
        autoReplyMode,
        replyPolicy,
      });
      if (!result.ok) throw new Error(result.error ?? t.policy.saveFailed);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : t.policy.saveFailed);
    } finally {
      setSaving(false);
    }
  }

  if (!profile) {
    return (
      <EmptyState
        workspaceId={team.workspaceId}
        platformLabel={platformLabel}
        t={t.policy}
      />
    );
  }
  if (loading) {
    return (
      <div className="px-4 md:px-6 py-5 max-w-4xl mx-auto space-y-5">
        <div className="space-y-2">
          <div className="skeleton h-6 w-56" />
          <div className="skeleton h-3 w-80" />
        </div>
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="skeleton h-16 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 md:px-6 py-5 max-w-4xl mx-auto space-y-5">
      <header className="space-y-1.5">
        <h1 className="text-[15px] font-semibold">
          {format(t.policy.heading, { platform: platformLabel })}
        </h1>
        <p className="text-sm text-muted-foreground leading-relaxed">
          {t.policy.subtitleBefore}{" "}
          <span className="font-medium text-foreground">@{profile.platformHandle}</span>
          {t.policy.subtitleAfter}
        </p>
      </header>

      {error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive animate-pop-in">
          {error}
        </div>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {t.policy.modeHeading}
        </h2>
        <div className="space-y-2 animate-stagger">
          {MODE_VALUES.map((value) => (
            <label
              key={value}
              className={
                "flex items-start gap-3 rounded-xl border p-3.5 cursor-pointer transition-all duration-200 " +
                (autoReplyMode === value
                  ? "border-primary bg-primary/10 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--primary)_30%,transparent)]"
                  : "border-border bg-card hover:border-primary/25 hover:bg-accent/40")
              }
            >
              <input
                type="radio"
                name="autoReplyMode"
                value={value}
                checked={autoReplyMode === value}
                onChange={() => setAutoReplyMode(value)}
                disabled={!isAdmin}
                className="mt-0.5 accent-primary"
              />
              <span>
                <span className="block text-sm font-medium">{t.policy.modes[value].label}</span>
                <span className="block text-xs text-muted-foreground mt-0.5 leading-relaxed">
                  {t.policy.modes[value].hint}
                </span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <label className="block text-sm font-medium">{t.policy.whitelistLabel}</label>
        <p className="text-xs text-muted-foreground">
          {t.policy.whitelistHintBefore} <code>@</code>
          {t.policy.whitelistHintAfter}
        </p>
        <textarea
          value={whitelist}
          onChange={(e) => setWhitelist(e.target.value)}
          disabled={!isAdmin}
          rows={6}
          placeholder={t.policy.whitelistPlaceholder}
          className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
        />
      </section>

      <section className="space-y-2">
        <label className="block text-sm font-medium">{t.policy.blockedLabel}</label>
        <p className="text-xs text-muted-foreground">{t.policy.blockedHint}</p>
        <textarea
          value={blocked}
          onChange={(e) => setBlocked(e.target.value)}
          disabled={!isAdmin}
          rows={4}
          placeholder={t.policy.blockedPlaceholder}
          className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
        />
      </section>

      {isAdmin ? (
        <div className="flex items-center gap-3 sticky bottom-4 backdrop-blur-sm">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="rounded-lg bg-primary text-primary-foreground px-3 h-8 text-[12.5px] font-medium hover:bg-primary/90 active:bg-primary/85 disabled:opacity-50 transition-colors press"
          >
            {saving ? t.policy.saving : t.policy.saveCta}
          </button>
          {savedAt ? (
            <span className="text-xs text-emerald-400 inline-flex items-center gap-1 animate-fade-in">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              {t.policy.saved}
            </span>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t.policy.adminOnly}</p>
      )}

      {data ? (
        <details className="group rounded-xl border border-border bg-card p-3 text-xs transition-colors hover:border-primary/30 [&_summary::-webkit-details-marker]:hidden">
          <summary className="flex cursor-pointer items-center gap-2 text-muted-foreground hover:text-foreground transition-colors list-none">
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="transition-transform duration-200 group-open:rotate-90"
              aria-hidden
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
            {t.policy.rawJson}
          </summary>
          <pre className="mt-2 overflow-auto animate-fade-in">{JSON.stringify(data.replyPolicy, null, 2)}</pre>
        </details>
      ) : null}
    </div>
  );
}

function EmptyState(props: {
  workspaceId: string;
  platformLabel: string;
  t: PolicyDict;
}) {
  return (
    <div className="px-4 md:px-6 py-6 max-w-2xl space-y-4">
      <h1 className="text-[15px] font-semibold">
        {format(props.t.notConnectedTitle, { platform: props.platformLabel })}
      </h1>
      <p className="text-sm text-muted-foreground">
        {format(props.t.notConnectedBody, { platform: props.platformLabel })}
      </p>
      <Link
        href={feedPath(props.workspaceId)}
        className="inline-flex items-center justify-center rounded-lg bg-primary px-3 h-8 text-[12.5px] font-medium text-primary-foreground hover:bg-primary/90"
      >
        {props.t.startSetup}
      </Link>
    </div>
  );
}
