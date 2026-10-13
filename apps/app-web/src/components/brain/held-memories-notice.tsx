"use client";

/**
 * HeldMemoriesNotice - the member's view of their own hidden memories
 * (docs/plans/scope-hold-recovery.md §2 D3, §5 "Member UI").
 *
 * A quiet count banner, shown only when the caller has held memories:
 * no content and no hold reason beyond "pending review". "Request review"
 * records an audit event that the admin scope-review screen counts; once a
 * request is open the button reads "Review requested" and stays disabled.
 *
 * Mounted by the Brain page, which remounts on navigation, so a fetch keyed
 * on the workspace is enough (no persistent-layout signal needed).
 *
 * [COMP:app-web/held-memories-notice]
 */

import { useEffect, useState } from "react";
import type { HeldMemorySummary } from "@use-brian/shared";
import { useT, format } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { fetchHeldMemorySummary, requestHeldMemoryReview } from "@/lib/api/workspace-access";

export function HeldMemoriesNotice({ workspaceId }: { workspaceId: string }) {
  const t = useT().brainPage.heldMemories;
  const [summary, setSummary] = useState<HeldMemorySummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let live = true;
    setSummary(null);
    fetchHeldMemorySummary(workspaceId)
      .then((next) => { if (live) setSummary(next); })
      .catch(() => { /* Quiet surface: an unavailable summary shows nothing. */ });
    return () => { live = false; };
  }, [workspaceId]);

  if (!summary || summary.count <= 0) return null;
  const requested = summary.requestedAt !== null;

  const request = async () => {
    setBusy(true);
    setError(false);
    try {
      setSummary(await requestHeldMemoryReview(workspaceId));
    } catch (err) {
      // Nothing left to review: the count dropped since the summary loaded.
      if (err instanceof Error && err.message === "nothing_held") setSummary({ count: 0, requestedAt: null });
      else setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-muted/20 px-4 py-2 text-sm text-muted-foreground"
    >
      <span className="min-w-0 flex-1">
        {summary.count === 1 ? t.noticeOne : format(t.notice, { count: summary.count })}
      </span>
      {error ? <span role="alert" className="text-destructive">{t.requestError}</span> : null}
      <Button
        variant="outline"
        size="sm"
        className="max-sm:min-h-11"
        disabled={busy || requested}
        onClick={() => void request()}
      >
        {requested ? t.requested : t.request}
      </Button>
    </div>
  );
}
