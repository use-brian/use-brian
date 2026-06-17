"use client";

/**
 * KB gaps review page — `/w/[workspaceId]/knowledge-base/gaps` (app-web).
 *
 * Ported from `apps/web/src/app/(app)/knowledge-base/gaps/page.tsx` as the
 * first surface migration of the app consolidation
 * (docs/plans/doc-web-app-consolidation.md §5a — the pattern-proving
 * vertical slice: route under `/w/[id]` + `useWorkspaces()` adapter + SDK +
 * en/ja/zh i18n + component-map row).
 *
 * CL-9 user-in-the-loop drafting surface. Lists open `kb_gap_candidate` rows
 * for the active workspace, each with the recurring query pattern + counts.
 * Per-card actions: Draft entry / Not now (in-session) / Dismiss.
 *
 * In app-web the active workspace is the route param (no chrome switcher),
 * surfaced via the `useWorkspaces()` adapter (`[COMP:app-web/workspaces-adapter]`).
 * The page renders full-width inside the `/w/[workspaceId]` layout's `<main>`
 * (its own chrome, not the doc page shell).
 *
 * Spec: docs/architecture/context-engine/memory-consolidation.md → CL-9 lock.
 * [COMP:app-web/kb-gaps]
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { useWorkspaces } from "@/contexts/workspace-context";
import {
  listKbGaps,
  dismissKbGap,
  markKbGapDrafted,
  type KbGapCandidate,
} from "@/lib/api/kb-gaps";
import { requestKbGapRefresh } from "@/lib/kb-gap-events";

type ToastKind = "dismissed" | "drafted";
type Toast = { kind: ToastKind; key: number };

export default function KbGapsPage() {
  const t = useT();
  const router = useRouter();
  const { activeId } = useWorkspaces();
  const [rows, setRows] = useState<KbGapCandidate[] | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Initial fetch — runs on workspace change. Resets state so a workspace
  // navigation doesn't carry old rows.
  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    setRows(null);
    setToast(null);
    void (async () => {
      const result = await listKbGaps(activeId);
      if (!cancelled) setRows(result.candidates);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  // Auto-dismiss toast.
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 2500);
    return () => window.clearTimeout(id);
  }, [toast]);

  const handleDismiss = useCallback(
    async (candidate: KbGapCandidate) => {
      setBusyId(candidate.id);
      const result = await dismissKbGap(candidate.id);
      if (result.ok) {
        setRows((prev) =>
          prev ? prev.filter((c) => c.id !== candidate.id) : prev,
        );
        setToast({ kind: "dismissed", key: Date.now() });
        requestKbGapRefresh(activeId);
      }
      setBusyId(null);
    },
    [activeId],
  );

  const handleIgnore = useCallback((candidate: KbGapCandidate) => {
    // In-session only — removes from view without an API call. Next page load
    // re-surfaces the candidate.
    setRows((prev) => (prev ? prev.filter((c) => c.id !== candidate.id) : prev));
  }, []);

  const handleDraft = useCallback(
    async (candidate: KbGapCandidate) => {
      setBusyId(candidate.id);
      const result = await markKbGapDrafted(candidate.id);
      if (result.ok) {
        setToast({ kind: "drafted", key: Date.now() });
        requestKbGapRefresh(activeId);
        // Navigate to the (stub) KB editor with the pattern pre-filled. The
        // editor is git-sourced today; the stub explains that while keeping
        // the pre-fill params wired for the eventual editor.
        if (activeId) {
          router.push(
            `/w/${activeId}/knowledge-base/new?from-gap=${encodeURIComponent(candidate.id)}&pattern=${encodeURIComponent(candidate.patternSummary)}`,
          );
        }
      }
      setBusyId(null);
    },
    [router, activeId],
  );

  const hasRows = rows !== null && rows.length > 0;
  const count = rows?.length ?? 0;

  return (
    <div className="h-full w-full px-8 py-6 flex flex-col gap-5 overflow-y-auto">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold flex items-center gap-2">
          {t.kbGaps.title}
          {hasRows && (
            <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400">
              {format(t.kbGaps.pendingPill, { count })}
            </span>
          )}
        </h1>
        <p className="text-sm text-muted-foreground">{t.kbGaps.description}</p>
      </header>

      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="text-xs px-3 py-2 rounded-md border border-border bg-card self-start"
        >
          {toast.kind === "dismissed" && t.kbGaps.dismissedToast}
          {toast.kind === "drafted" && t.kbGaps.draftedToast}
        </div>
      )}

      {rows === null ? (
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
          {t.kbGaps.loading}
        </div>
      ) : rows.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center gap-3 border border-border rounded-md bg-card/50">
          <svg
            width="40"
            height="40"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
            className="text-muted-foreground/40"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M9 12l2 2 4-4" />
          </svg>
          <div className="font-medium">{t.kbGaps.emptyTitle}</div>
          <p className="text-sm text-muted-foreground max-w-md">{t.kbGaps.empty}</p>
        </div>
      ) : (
        <ul className="flex-1 min-h-0 flex flex-col gap-3">
          {rows.map((candidate) => (
            <li
              key={candidate.id}
              className="border border-border rounded-md bg-card p-4 flex flex-col gap-3"
            >
              <div className="flex flex-col gap-1">
                <div className="text-sm font-medium">{candidate.patternSummary}</div>
                <div className="text-xs text-muted-foreground flex gap-3">
                  <span>
                    {format(t.kbGaps.occurrencesLabel, {
                      count: candidate.occurrences,
                    })}
                  </span>
                  <span>
                    {format(t.kbGaps.distinctSessionsLabel, {
                      count: candidate.distinctSessions,
                    })}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={busyId === candidate.id}
                  onClick={() => void handleDraft(candidate)}
                  className="text-xs px-3 py-1.5 rounded-md border border-primary bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {t.kbGaps.draftButton}
                </button>
                <button
                  type="button"
                  disabled={busyId === candidate.id}
                  onClick={() => handleIgnore(candidate)}
                  className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-muted disabled:opacity-50"
                >
                  {t.kbGaps.ignoreButton}
                </button>
                <button
                  type="button"
                  disabled={busyId === candidate.id}
                  onClick={() => void handleDismiss(candidate)}
                  className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-muted text-muted-foreground disabled:opacity-50"
                >
                  {t.kbGaps.dismissButton}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
