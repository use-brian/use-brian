"use client";

/**
 * Ready-to-post queue — approved drafts whose target platform has no live
 * connection, waiting for the operator to post them by hand
 * (docs/plans/feed-create-split.md D2/D6).
 *
 * Data: `approved / ready-manual` events via the feed SDK
 * (`fetchFeedReadyPosts`), aggregated across every distribution assistant in
 * the workspace, grouped by platform. Actions: copy caption / copy image
 * brief (clipboard), mark posted (optional live permalink), discard. Both
 * mutations re-fetch the list; the buttons stay disabled while in flight.
 *
 * [COMP:app-web/feed-ready]
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy, Trash2 } from "lucide-react";
import { useFeedWorkspace } from "@/contexts/feed-profiles-context";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  discardFeedReadyPost,
  fetchFeedReadyPosts,
  markFeedReadyPostPosted,
  type FeedReadyPost,
} from "@/lib/api/feed";
import { FEED_PLATFORMS, type FeedPlatform } from "@/lib/feed-nav";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";

type ReadyRow = FeedReadyPost & { assistantId: string };

export function FeedReady() {
  const team = useFeedWorkspace();
  const t = useT().feedPage;
  const tr = t.ready;

  // Every distribution assistant can hold ready posts — connected profiles
  // AND the unconnected brand voice.
  const assistantIds = useMemo(() => {
    const ids = new Set<string>();
    for (const p of team.profiles) ids.add(p.assistantId);
    for (const a of team.assistants) ids.add(a.id);
    return Array.from(ids);
  }, [team.profiles, team.assistants]);

  const [rows, setRows] = useState<ReadyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const perAssistant = await Promise.all(
        assistantIds.map(async (assistantId) => {
          const posts = await fetchFeedReadyPosts(assistantId);
          if (posts === null) return { failed: true as const, rows: [] };
          return {
            failed: false as const,
            rows: posts.map((p) => ({ ...p, assistantId })),
          };
        }),
      );
      if (perAssistant.length > 0 && perAssistant.every((r) => r.failed)) {
        setError(tr.loadFailed);
      }
      const all = perAssistant.flatMap((r) => r.rows);
      all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      setRows(all);
    } finally {
      setLoading(false);
    }
  }, [assistantIds, tr.loadFailed]);

  useEffect(() => {
    void load();
  }, [load]);

  const byPlatform = useMemo(() => {
    const groups = new Map<FeedPlatform, ReadyRow[]>();
    for (const platform of FEED_PLATFORMS) groups.set(platform, []);
    for (const row of rows) groups.get(row.platform)?.push(row);
    return groups;
  }, [rows]);

  async function copyText(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500);
    } catch {
      setError(tr.copyFailed);
    }
  }

  async function markPosted(row: ReadyRow) {
    // The dialog hosts the node; this closure owns the value (the
    // `content` contract in confirm-dialog.tsx).
    let permalink = "";
    const ok = await confirmDialog({
      title: tr.markPostedTitle,
      description: tr.markPostedDescription,
      confirmLabel: tr.markPostedConfirm,
      content: (
        <input
          type="url"
          placeholder={tr.permalinkPlaceholder}
          onChange={(e) => {
            permalink = e.target.value;
          }}
          className="w-full h-9 rounded-lg border border-border bg-background px-3 text-sm focus:outline-none focus:border-primary/50"
        />
      ),
    });
    if (!ok) return;
    setBusyId(row.id);
    setError(null);
    try {
      const result = await markFeedReadyPostPosted(row.assistantId, row.id, {
        ...(permalink.trim() ? { permalink: permalink.trim() } : {}),
      });
      if (!result.ok) {
        setError(result.error ?? tr.actionFailed);
        return;
      }
      setRows((prev) => prev.filter((r) => r.id !== row.id));
    } finally {
      setBusyId(null);
    }
  }

  async function discard(row: ReadyRow) {
    const ok = await confirmDialog({
      title: tr.discardTitle,
      description: tr.discardDescription,
      confirmLabel: tr.discardConfirm,
      variant: "destructive",
    });
    if (!ok) return;
    setBusyId(row.id);
    setError(null);
    try {
      const result = await discardFeedReadyPost(row.assistantId, row.id);
      if (!result.ok) {
        setError(result.error ?? tr.actionFailed);
        return;
      }
      setRows((prev) => prev.filter((r) => r.id !== row.id));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="px-4 md:px-6 py-5 max-w-4xl mx-auto space-y-5">
      <header className="space-y-1.5">
        <h1
          className="text-[15px] font-semibold"        >
          {t.sections.ready}
        </h1>
        <p className="text-xs text-muted-foreground">{tr.subtitle}</p>
      </header>

      {error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="text-sm text-muted-foreground">…</div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tr.empty}</p>
      ) : (
        FEED_PLATFORMS.map((platform) => {
          const group = byPlatform.get(platform) ?? [];
          if (group.length === 0) return null;
          return (
            <section key={platform} className="space-y-3">
              <h2 className="text-sm font-semibold text-muted-foreground">
                {t.platformLabels[platform]}
              </h2>
              <ul className="space-y-3">
                {group.map((row) => (
                  <li
                    key={row.id}
                    className="rounded-xl border border-border/60 bg-card p-4 space-y-3 shadow-xs"
                  >
                    <p className="whitespace-pre-wrap text-sm text-foreground">
                      {row.finalText}
                    </p>
                    {row.imageBrief ? (
                      <div className="rounded-lg border border-border/60 bg-muted/30 p-3 space-y-1">
                        <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                          {tr.imageBriefLabel}
                        </div>
                        <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                          {row.imageBrief}
                        </p>
                      </div>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void copyText(`caption:${row.id}`, row.finalText)}
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-medium hover:bg-accent transition-colors"
                      >
                        {copiedKey === `caption:${row.id}` ? (
                          <Check className="size-3.5" aria-hidden />
                        ) : (
                          <Copy className="size-3.5" aria-hidden />
                        )}
                        {copiedKey === `caption:${row.id}` ? tr.copied : tr.copyCaption}
                      </button>
                      {row.imageBrief ? (
                        <button
                          type="button"
                          onClick={() =>
                            void copyText(`brief:${row.id}`, row.imageBrief ?? "")
                          }
                          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-medium hover:bg-accent transition-colors"
                        >
                          {copiedKey === `brief:${row.id}` ? (
                            <Check className="size-3.5" aria-hidden />
                          ) : (
                            <Copy className="size-3.5" aria-hidden />
                          )}
                          {copiedKey === `brief:${row.id}` ? tr.copied : tr.copyBrief}
                        </button>
                      ) : null}
                      <div className="flex-1" />
                      <button
                        type="button"
                        disabled={busyId === row.id}
                        onClick={() => void markPosted(row)}
                        className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
                      >
                        {tr.markPosted}
                      </button>
                      <button
                        type="button"
                        disabled={busyId === row.id}
                        onClick={() => void discard(row)}
                        aria-label={tr.discard}
                        className="inline-flex size-8 items-center justify-center rounded-lg border border-border text-muted-foreground hover:text-destructive hover:border-destructive/40 disabled:opacity-50 transition-colors"
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}
    </div>
  );
}
