"use client";

/**
 * Connected-card panel for the Company Email (imap) connector: archive sync
 * status ("Syncing 8,200 of 14,200" / "Up to date") + the backfill consent
 * flow (D9 — cheap STATUS preflight, then scope choices with Later as a
 * first-class option; live tools work with zero backfill).
 *
 * [COMP:web/imap-sync-panel]
 */

import { useCallback, useEffect, useState } from "react";
import { authFetch } from "@/lib/auth-fetch";
import { useT } from "@/lib/i18n/client";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type ImapSyncStatus = {
  email: string;
  archived: number;
  backfill: { scope: string; status: "running" | "done"; totalEstimate?: number } | null;
  lastSyncAt: string | null;
  lastError: string | null;
  ingestionEnabled: boolean;
};

/** Pure status-line formatter — "Syncing N of M" while a backfill runs, else
 *  "Up to date" with the archived count. Exported for tests. */
export function formatImapSyncLine(
  status: Pick<ImapSyncStatus, "archived" | "backfill">,
  copy: { syncing: string; upToDate: string },
): string {
  const backfillRunning = status.backfill?.status === "running";
  return backfillRunning
    ? copy.syncing
        .replace("{n}", String(status.archived))
        .replace("{m}", String(status.backfill?.totalEstimate ?? status.archived))
    : copy.upToDate.replace("{n}", String(status.archived));
}

type ProbeResult = { folders: Array<{ path: string; messages: number }>; total: number };

/**
 * `instanceId` targets a specific connected mailbox (multi-account); omit for
 * the primary. Each mailbox row renders its own panel bound to its instance.
 */
export function ImapSyncPanel({ instanceId }: { instanceId?: string } = {}) {
  const t = useT();
  const tm = t.settings.connectors.imap;
  const [status, setStatus] = useState<ImapSyncStatus | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  const [arming, setArming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const qs = instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : "";
      const res = await authFetch(`${API_URL}/api/connectors/imap/sync-status${qs}`);
      if (res.ok) setStatus((await res.json()) as ImapSyncStatus);
    } catch {
      // Status is decorative — a failed poll shows the last known state.
    }
  }, [instanceId]);

  useEffect(() => {
    void loadStatus();
    const timer = setInterval(() => void loadStatus(), 30_000);
    return () => clearInterval(timer);
  }, [loadStatus]);

  async function runPreflight() {
    setProbing(true);
    setError(null);
    try {
      const res = await authFetch(`${API_URL}/api/connectors/imap/backfill/preflight`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instanceId }),
      });
      if (res.ok) setProbe((await res.json()) as ProbeResult);
      else setError(tm.backfillFailed);
    } catch {
      setError(tm.backfillFailed);
    }
    setProbing(false);
  }

  async function armBackfill(scope: "12m" | "2y" | "all") {
    setArming(true);
    setError(null);
    try {
      const res = await authFetch(`${API_URL}/api/connectors/imap/backfill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, instanceId }),
      });
      if (res.ok) {
        setProbe(null);
        await loadStatus();
      } else {
        setError(tm.backfillFailed);
      }
    } catch {
      setError(tm.backfillFailed);
    }
    setArming(false);
  }

  if (!status) return null;

  const backfillRunning = status.backfill?.status === "running";
  const syncLine = formatImapSyncLine(status, tm);

  return (
    <div className="space-y-2 border border-border rounded-lg p-3">
      <div className="text-[13px] font-medium">{tm.syncStatusTitle}</div>
      <p className="text-xs text-muted-foreground">{syncLine}</p>
      {status.lastError && <p className="text-xs text-destructive">{tm.syncError}</p>}

      {/* Backfill consent — offered until a backfill has been armed. */}
      {!status.backfill && !probe && (
        <button
          onClick={() => void runPreflight()}
          disabled={probing}
          className="text-xs font-medium border border-border px-3 py-1 rounded-lg text-muted-foreground hover:bg-muted disabled:opacity-50 transition-colors"
        >
          {probing ? tm.backfillProbing : tm.backfillProbeBtn}
        </button>
      )}
      {probe && !backfillRunning && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {tm.backfillCounts.replace("{n}", String(probe.total))}
          </p>
          <p className="text-[11px] text-muted-foreground">{tm.backfillHelp}</p>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => void armBackfill("12m")}
              disabled={arming}
              className="text-xs font-medium bg-primary text-primary-foreground px-3 py-1 rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {tm.scope12m}
            </button>
            <button
              onClick={() => void armBackfill("2y")}
              disabled={arming}
              className="text-xs font-medium border border-border px-3 py-1 rounded-lg hover:bg-muted disabled:opacity-50 transition-colors"
            >
              {tm.scope2y}
            </button>
            <button
              onClick={() => void armBackfill("all")}
              disabled={arming}
              className="text-xs font-medium border border-border px-3 py-1 rounded-lg hover:bg-muted disabled:opacity-50 transition-colors"
            >
              {tm.scopeAll}
            </button>
            <button
              onClick={() => setProbe(null)}
              disabled={arming}
              className="text-xs font-medium text-muted-foreground px-3 py-1 rounded-lg hover:bg-muted disabled:opacity-50 transition-colors"
            >
              {tm.scopeLater}
            </button>
          </div>
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
