"use client";

/** [COMP:app-web/feed-policy] Team moderation settings for a connected account. */

import { useEffect, useId, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useFeedWorkspace } from "@/contexts/feed-profiles-context";
import {
  fetchFeedAssistantProfiles,
  updateFeedProfilePolicy,
  type FeedProfilePolicy,
} from "@/lib/api/feed";
import { feedPath, type FeedPlatform } from "@/lib/feed-nav";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";

type FeedPageDict = ReturnType<typeof useT>["feedPage"];
type PolicyDict = FeedPageDict["policy"];

// exported for tests
export function parsePolicyList(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

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
  const [blocked, setBlocked] = useState("");
  const blockedId = useId();
  const currentPolicy = data?.assistantId === profile?.assistantId && data?.platform === platform
    ? data.replyPolicy
    : null;
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
        setBlocked(formatPolicyList(match.replyPolicy.topic_blocklist ?? match.replyPolicy.blockedTopics));
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
    if (!profile || !currentPolicy) return;
    setSaving(true);
    setError(null);
    try {
      const result = await updateFeedProfilePolicy(profile.assistantId, platform, {
        replyPolicy: {
          ...currentPolicy,
          topic_blocklist: parsePolicyList(blocked),
        },
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
          {format(t.policy.subtitle, { handle: profile.platformHandle.replace(/^@/, "") })}
        </p>
      </header>

      {error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive animate-pop-in">
          {error}
        </div>
      ) : null}

      <section className="space-y-2">
        <label htmlFor={blockedId} className="block text-sm font-medium">{t.policy.blockedLabel}</label>
        <p id={`${blockedId}-hint`} className="text-xs text-muted-foreground">{t.policy.blockedHint}</p>
        <textarea
          id={blockedId}
          aria-describedby={`${blockedId}-hint`}
          value={blocked}
          onChange={(e) => setBlocked(e.target.value)}
          disabled={!isAdmin || !currentPolicy}
          rows={4}
          placeholder={t.policy.blockedPlaceholder}
          className="w-full rounded-xl border border-border bg-background px-3 py-2 text-[16px] md:text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
        />
      </section>

      {isAdmin ? (
        <div className="flex items-center gap-3 sticky bottom-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur-sm">
          <button
            type="button"
            onClick={save}
            disabled={saving || !currentPolicy}
            className="rounded-lg bg-action text-action-foreground px-3 h-11 md:h-8 text-[12.5px] font-medium hover:bg-action/90 active:bg-action/85 disabled:opacity-50 transition-colors press"
          >
            {saving ? t.policy.saving : t.policy.saveCta}
          </button>
          {savedAt ? (
            <span className="text-xs text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1 animate-fade-in">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              {t.policy.saved}
            </span>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t.policy.adminOnly}</p>
      )}
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
        className="inline-flex items-center justify-center rounded-lg bg-action px-3 h-11 md:h-8 text-[12.5px] font-medium text-action-foreground hover:bg-action/90"
      >
        {props.t.startSetup}
      </Link>
    </div>
  );
}
