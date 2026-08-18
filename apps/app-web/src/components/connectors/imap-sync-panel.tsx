"use client";

/**
 * Connected-card panel for the Company Email (imap) connector: archive sync
 * status ("Syncing 8,200 of 14,200" / "Up to date") + the backfill consent
 * flow (D9 — cheap STATUS preflight, then scope choices with Later as a
 * first-class option; live tools work with zero backfill) + the send-as
 * alias list (mailbox-imap.md → "Send-as aliases": the addresses this
 * mailbox may reply AS; `PATCH /imap/send-as`, read back on sync-status).
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
  backfill: {
    scope: string;
    status: "running" | "done" | "stalled";
    totalEstimate?: number;
    consecutiveFailures?: number;
    lastError?: string | null;
  } | null;
  lastSyncAt: string | null;
  lastError: string | null;
  lastFailedSyncAt?: string | null;
  ingestionEnabled: boolean;
  /** Configured send-as aliases (bare lowercase); absent on older servers. */
  sendAsAliases?: string[];
};

/** Client-side shape check before the round-trip; the server re-validates. */
export function looksLikeEmailAddress(value: string): boolean {
  return /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/.test(value.trim());
}

/** Pure status-line formatter — "Syncing N of M" while a backfill runs,
 *  "History sync paused" once it has parked, else "Up to date" with the
 *  archived count. Exported for tests.
 *
 *  The paused branch exists because the running branch used to be a lie: a
 *  wedged backfill kept `status: "running"` forever, so this line read
 *  "Syncing 72,497 of 155,363..." for twelve days while nothing moved. A
 *  progress string with no progress behind it is worse than an error. */
export function formatImapSyncLine(
  status: Pick<ImapSyncStatus, "archived" | "backfill">,
  copy: { syncing: string; upToDate: string; backfillStalled: string },
): string {
  if (status.backfill?.status === "stalled") {
    return copy.backfillStalled.replace("{n}", String(status.archived));
  }
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
  const [aliasDraft, setAliasDraft] = useState("");
  const [aliasSaving, setAliasSaving] = useState(false);
  const [aliasError, setAliasError] = useState<string | null>(null);

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

  async function saveAliases(next: string[]) {
    setAliasSaving(true);
    setAliasError(null);
    try {
      const res = await authFetch(`${API_URL}/api/connectors/imap/send-as`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instanceId, sendAsAliases: next }),
      });
      if (res.ok) {
        const body = (await res.json()) as { sendAsAliases?: string[] };
        setStatus((prev) => (prev ? { ...prev, sendAsAliases: body.sendAsAliases ?? next } : prev));
        setAliasDraft("");
      } else if (res.status === 400) {
        setAliasError(tm.sendAsInvalid);
      } else {
        setAliasError(tm.sendAsFailed);
      }
    } catch {
      setAliasError(tm.sendAsFailed);
    }
    setAliasSaving(false);
  }

  function addAlias() {
    const value = aliasDraft.trim().toLowerCase();
    if (!value) return;
    if (!looksLikeEmailAddress(value)) {
      setAliasError(tm.sendAsInvalid);
      return;
    }
    const current = status?.sendAsAliases ?? [];
    if (current.includes(value)) {
      setAliasDraft("");
      return;
    }
    void saveAliases([...current, value]);
  }

  if (!status) return null;

  const backfillRunning = status.backfill?.status === "running";
  const aliases = status.sendAsAliases ?? [];
  const backfillStalled = status.backfill?.status === "stalled";
  const syncLine = formatImapSyncLine(status, tm);

  return (
    <div className="space-y-2 border border-border rounded-lg p-3">
      <div className="text-[13px] font-medium">{tm.syncStatusTitle}</div>
      <p className="text-xs text-muted-foreground">{syncLine}</p>
      {/* A parked backfill reports the server's own words. The generic
          "it will retry automatically" line is reserved for the transient
          case, because once parked it will NOT retry until re-armed - saying
          otherwise is how this stayed invisible for twelve days. */}
      {backfillStalled ? (
        <p className="text-xs text-destructive">
          {tm.backfillStalledDetail.replace("{err}", status.backfill?.lastError ?? tm.syncErrorUnknown)}
        </p>
      ) : (
        status.lastError && <p className="text-xs text-destructive">{tm.syncError}</p>
      )}

      {/* Backfill consent - offered when none has been armed, and again once one
          has parked, otherwise a stalled mailbox has no way back. */}
      {(!status.backfill || backfillStalled) && !probe && (
        <button
          onClick={() => void runPreflight()}
          disabled={probing}
          className="text-xs font-medium border border-border px-3 py-1 rounded-lg text-muted-foreground hover:bg-muted disabled:opacity-50 transition-colors"
        >
          {probing ? tm.backfillProbing : backfillStalled ? tm.backfillRetryBtn : tm.backfillProbeBtn}
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
              className="text-xs font-medium bg-action text-action-foreground px-3 py-1 rounded-lg hover:bg-action/90 disabled:opacity-50 transition-colors"
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

      {/* Send-as aliases: the identities this mailbox may reply AS. Replies
          resolve to the alias the original was addressed to, so this list is
          what makes "reply from bd@" work without the model picking a sender. */}
      <div className="pt-2 border-t border-border space-y-2" data-testid="imap-send-as">
        <div className="text-[13px] font-medium">{tm.sendAsTitle}</div>
        <p className="text-[11px] text-muted-foreground">{tm.sendAsHelp}</p>
        {aliases.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {tm.sendAsEmpty.replace("{email}", status.email)}
          </p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {aliases.map((alias) => (
              <li
                key={alias}
                className="inline-flex items-center gap-1 text-xs border border-border rounded-full pl-2.5 pr-1 py-0.5"
              >
                <span>{alias}</span>
                <button
                  type="button"
                  aria-label={tm.sendAsRemove.replace("{addr}", alias)}
                  disabled={aliasSaving}
                  onClick={() => void saveAliases(aliases.filter((a) => a !== alias))}
                  className="rounded-full px-1 text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            addAlias();
          }}
        >
          <input
            type="email"
            value={aliasDraft}
            onChange={(e) => {
              setAliasDraft(e.target.value);
              if (aliasError) setAliasError(null);
            }}
            placeholder={tm.sendAsPlaceholder}
            disabled={aliasSaving}
            className="flex-1 min-w-0 text-xs bg-background border border-border rounded-lg px-2.5 py-1 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={aliasSaving || !aliasDraft.trim()}
            className="text-xs font-medium border border-border px-3 py-1 rounded-lg text-muted-foreground hover:bg-muted disabled:opacity-50 transition-colors"
          >
            {tm.sendAsAdd}
          </button>
        </form>
        {aliasError && <p className="text-xs text-destructive">{aliasError}</p>}
      </div>
    </div>
  );
}
