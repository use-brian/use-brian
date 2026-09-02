"use client";


import { publicRuntimeConfig } from "@/lib/runtime-public-config";
/**
 * Studio → Knowledge — the master-detail knowledge-base surface (app-web).
 *
 * Revamp of the flat sources list (docs/plans/knowledge-ux-revamp.md):
 * a left rail lists every connected source plus a "Manual entries"
 * pseudo-row for the `source_id IS NULL` pool; the focused row's management
 * panel renders beside it. Mirrors Studio → Connectors / Events' layout.
 *
 * Focused-source features:
 *   - Overview + Sync: provenance, last sync, write badge, Sync now,
 *     Disconnect (D2)
 *   - Clearance: per-source default sensitivity for unstamped entries,
 *     mig 410 (D3)
 *   - Ask & update: embedded chat panel scoped to the source (D4 —
 *     `KbChatPanel`)
 *   - Self-maintain: the mandatory-field maintenance agent (D5/D6 —
 *     `KbMaintenanceForm`)
 *
 * Connecting a source happens in `AddSourceModal` (D1), not an inline card.
 *
 * Sources are workspace-scoped — every assistant shares the set; the
 * per-assistant Knowledge tab keeps the viewer + enable/disable toggle.
 *
 * Backend: /api/workspaces/:workspaceId/knowledge
 * (packages/api/src/routes/knowledge.ts → workspaceKnowledgeRoutes).
 *
 * [COMP:app-web/studio-knowledge]
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { authFetch } from "@/lib/auth-fetch";
import { useWorkspaces } from "@/contexts/workspace-context";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { StudioTopbarActions } from "@/components/studio/studio-topbar";
import { AddSourceModal, type ConnectorInstanceOption } from "@/components/knowledge/add-source-modal";
import { KbChatPanel } from "@/components/knowledge/kb-chat-panel";
import { KbMaintenanceForm } from "@/components/knowledge/kb-maintenance-form";
import { KbCaptureRules } from "@/components/knowledge/kb-capture-rules";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n";
import { BookOpen, FolderGit2, HardDrive, NotebookPen } from "lucide-react";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";

type Sensitivity = "public" | "internal" | "confidential";

type KnowledgeSource = {
  id: string;
  workspaceId: string;
  sourceType: "github" | "local";
  repo: string;
  branch: string;
  rootPath: string;
  lastSyncedSha: string | null;
  lastSyncedAt: string | null;
  syncError: string | null;
  writeAccess: boolean | null;
  defaultSensitivity: Sensitivity;
  entryCount: number;
};

/** Rail selection: a source id, or the manual-entries pseudo-row. */
type Selection = { kind: "source"; id: string } | { kind: "manual" };

const TIERS: Sensitivity[] = ["public", "internal", "confidential"];

export default function StudioKnowledgePage() {
  const t = useT();
  const copy = t.studioPage.knowledgePage;
  const { activeId } = useWorkspaces();

  const [sources, setSources] = useState<KnowledgeSource[] | null>(null);
  const [manualCount, setManualCount] = useState(0);
  const [instances, setInstances] = useState<ConnectorInstanceOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [connectWarning, setConnectWarning] = useState<string | null>(null);

  // Per-source action state
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [savingTierId, setSavingTierId] = useState<string | null>(null);
  const [resyncPendingId, setResyncPendingId] = useState<string | null>(null);

  const fetchSources = useCallback(async () => {
    if (!activeId) return;
    try {
      const res = await authFetch(
        `${API_URL}/api/workspaces/${activeId}/knowledge/sources`,
      );
      if (res.ok) {
        const data = (await res.json()) as {
          sources: KnowledgeSource[];
          manualCount?: number;
        };
        setSources(data.sources ?? []);
        setManualCount(data.manualCount ?? 0);
      } else {
        setLoadError(true);
      }
    } catch {
      setLoadError(true);
    }
  }, [activeId]);

  const fetchInstances = useCallback(async () => {
    if (!activeId) return;
    try {
      const res = await authFetch(
        `${API_URL}/api/workspaces/${activeId}/knowledge/github/instances`,
      );
      if (res.ok) {
        const data = (await res.json()) as { instances: ConnectorInstanceOption[] };
        setInstances(data.instances ?? []);
      }
    } catch {
      // non-fatal — the modal surfaces its no-connector empty state
    }
  }, [activeId]);

  useEffect(() => {
    if (!activeId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(false);
    setSelected(null);
    Promise.all([fetchSources(), fetchInstances()]).finally(() => setLoading(false));
  }, [activeId, fetchSources, fetchInstances]);

  // Default focus: first source, else the manual pseudo-row. Repair-only —
  // never yank an existing valid selection when the list refreshes.
  useEffect(() => {
    if (sources === null) return;
    setSelected((prev) => {
      if (prev?.kind === "manual") return prev;
      if (prev?.kind === "source" && sources.some((s) => s.id === prev.id)) return prev;
      return sources.length > 0 ? { kind: "source", id: sources[0].id } : { kind: "manual" };
    });
  }, [sources]);

  const sel = useMemo(() => {
    if (!selected || sources === null) return null;
    if (selected.kind === "manual") return { kind: "manual" as const };
    const source = sources.find((s) => s.id === selected.id);
    return source ? { kind: "source" as const, source } : null;
  }, [selected, sources]);

  async function handleDisconnect(source: KnowledgeSource) {
    if (!activeId) return;
    const ok = await confirmDialog({
      description: format(copy.sourceDisconnectConfirm, { repo: source.repo }),
      confirmLabel: copy.sourceDisconnect,
      cancelLabel: copy.addRepoCancel,
      variant: "destructive",
    });
    if (!ok) return;
    try {
      const res = await authFetch(
        `${API_URL}/api/workspaces/${activeId}/knowledge/sources/${source.id}`,
        { method: "DELETE" },
      );
      if (res.ok) {
        setSelected(null);
        void fetchSources();
      }
    } catch {
      // surface via reload
    }
  }

  async function handleSync(source: KnowledgeSource) {
    if (!activeId) return;
    setSyncingId(source.id);
    try {
      await authFetch(
        `${API_URL}/api/workspaces/${activeId}/knowledge/sources/${source.id}/sync`,
        { method: "POST" },
      );
      // Give the worker a moment, then refresh.
      setTimeout(() => {
        void fetchSources();
        setSyncingId(null);
      }, 2000);
    } catch {
      setSyncingId(null);
    }
  }

  async function handleTierChange(source: KnowledgeSource, tier: Sensitivity) {
    if (!activeId || tier === source.defaultSensitivity) return;
    setSavingTierId(source.id);
    try {
      const res = await authFetch(
        `${API_URL}/api/workspaces/${activeId}/knowledge/sources/${source.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ defaultSensitivity: tier }),
        },
      );
      if (res.ok) {
        const data = (await res.json()) as { resyncScheduled?: boolean };
        if (data.resyncScheduled) setResyncPendingId(source.id);
        void fetchSources();
      }
    } catch {
      // surfaced by the unchanged control on refresh
    } finally {
      setSavingTierId(null);
    }
  }

  if (!activeId) {
    return (
      <div className="flex flex-col gap-6">
        <div className="text-sm text-muted-foreground">{copy.noConnectorWorkspace}</div>
      </div>
    );
  }

  // ── Rail row ──────────────────────────────────────────────────

  function railRow(row: Selection, label: string, subtitle: string | null, icon: React.ReactNode, dot: "ok" | "attention" | null, count: number) {
    const isSel =
      selected !== null &&
      ((row.kind === "manual" && selected.kind === "manual") ||
        (row.kind === "source" && selected.kind === "source" && selected.id === row.id));
    return (
      <li key={row.kind === "source" ? row.id : "manual"}>
        <button
          type="button"
          onClick={() => setSelected(row)}
          aria-current={isSel ? "true" : undefined}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
            isSel
              ? "bg-muted font-medium text-foreground"
              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
          )}
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted">
            {icon}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate">{label}</span>
            {subtitle && (
              <span className="block truncate text-[11px] font-normal text-muted-foreground">
                {subtitle}
              </span>
            )}
          </span>
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60">
            {count}
          </span>
          {dot && (
            <span
              aria-hidden
              className={cn(
                "h-1.5 w-1.5 shrink-0 rounded-full",
                dot === "attention" ? "bg-amber-500" : "bg-primary",
              )}
            />
          )}
        </button>
      </li>
    );
  }

  // ── Detail panels ─────────────────────────────────────────────

  function renderSourceDetail(s: KnowledgeSource) {
    const writeBadge =
      s.sourceType === "local"
        ? copy.writeBadgeLocal
        : s.writeAccess === true
          ? copy.writeBadgeWritable
          : s.writeAccess === false
            ? copy.writeBadgeReadOnly
            : copy.writeBadgeUnprobed;
    return (
      <div key={s.id} className="space-y-4">
        {/* Header */}
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
            {s.sourceType === "local" ? (
              <HardDrive className="size-4.5 text-muted-foreground" aria-hidden />
            ) : (
              <FolderGit2 className="size-4.5 text-muted-foreground" aria-hidden />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <h2 className="truncate text-[15px] font-semibold tracking-tight">{s.repo}</h2>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {s.branch}
              </span>
              {s.rootPath && (
                <span className="font-mono text-[11px] text-muted-foreground">/{s.rootPath}</span>
              )}
            </div>
            <p className="truncate text-[12px] text-muted-foreground">
              {format(copy.entryCountLine, { count: String(s.entryCount) })}
              {" · "}
              {writeBadge}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={() => void handleSync(s)}
              disabled={syncingId === s.id}
              className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
            >
              {syncingId === s.id ? copy.sourceSyncing : copy.sourceSync}
            </button>
            <button
              onClick={() => void handleDisconnect(s)}
              className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-destructive/30 hover:text-destructive"
            >
              {copy.sourceDisconnect}
            </button>
          </div>
        </div>

        {/* Sync status */}
        <div className="rounded-lg border border-border px-4 py-3">
          <div className="text-[11px] text-muted-foreground space-x-3">
            {s.lastSyncedAt ? (
              <span>
                {format(copy.sourceLastSynced, {
                  time: new Date(s.lastSyncedAt).toLocaleString(),
                })}
              </span>
            ) : (
              <span className="text-amber-600 dark:text-amber-400">{copy.sourceNeverSynced}</span>
            )}
            {s.lastSyncedSha && <span className="font-mono">{s.lastSyncedSha.slice(0, 7)}</span>}
          </div>
          {s.syncError && (
            <div className="mt-1 text-[11px] text-destructive">
              {format(copy.sourceSyncFailed, { message: s.syncError })}
            </div>
          )}
          {resyncPendingId === s.id && !s.lastSyncedSha && (
            <div className="mt-1 text-[11px] text-muted-foreground">{copy.resyncPending}</div>
          )}
        </div>

        {/* Clearance — per-source default sensitivity (mig 410) */}
        <section className="space-y-2">
          <h3 className="text-[13px] font-medium">{copy.clearanceTitle}</h3>
          <div className="rounded-lg border border-border px-4 py-3 space-y-2">
            <div className="flex items-center gap-2">
              {TIERS.map((tier) => (
                <button
                  key={tier}
                  type="button"
                  disabled={savingTierId === s.id}
                  onClick={() => void handleTierChange(s, tier)}
                  className={cn(
                    "rounded-lg px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50",
                    s.defaultSensitivity === tier
                      ? "bg-action text-action-foreground"
                      : "border border-border text-muted-foreground hover:bg-muted",
                  )}
                >
                  {copy.tiers[tier]}
                </button>
              ))}
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {copy.clearanceHelp}
            </p>
          </div>
        </section>

        {/* Ask & update — embedded scoped chat */}
        <section className="space-y-2">
          <h3 className="text-[13px] font-medium">{copy.chat.title}</h3>
          <KbChatPanel workspaceId={activeId!} scope={{ kind: "source", sourceId: s.id }} />
        </section>

        {/* Self-maintain agent */}
        <section className="space-y-2">
          <h3 className="text-[13px] font-medium">{copy.maintenance.title}</h3>
          <div className="rounded-lg border border-border px-4 py-3">
            <KbMaintenanceForm workspaceId={activeId!} sourceId={s.id} />
          </div>
        </section>
      </div>
    );
  }

  function renderManualDetail() {
    return (
      <div key="manual" className="space-y-4">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
            <NotebookPen className="size-4.5 text-muted-foreground" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[15px] font-semibold tracking-tight">
              {copy.manualTitle}
            </h2>
            <p className="truncate text-[12px] text-muted-foreground">
              {format(copy.entryCountLine, { count: String(manualCount) })}
            </p>
          </div>
        </div>
        <div className="rounded-lg border border-border px-4 py-3 space-y-1.5">
          <p className="text-[12px] leading-relaxed text-muted-foreground">{copy.manualBody}</p>
          <Link
            href={`/w/${activeId}/brain?kinds=knowledge`}
            className="inline-block text-xs font-medium text-foreground underline underline-offset-2"
          >
            {copy.manualBrainLink}
          </Link>
        </div>
        <section className="space-y-2">
          <h3 className="text-[13px] font-medium">{copy.chat.title}</h3>
          <KbChatPanel workspaceId={activeId!} scope={{ kind: "manual" }} />
        </section>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <StudioTopbarActions>
        <button
          onClick={() => {
            setConnectWarning(null);
            setShowModal(true);
          }}
          className="text-xs font-medium bg-action text-action-foreground px-3 py-1.5 rounded-lg hover:bg-action/90 transition-colors"
        >
          {copy.addRepo}
        </button>
      </StudioTopbarActions>

      <AddSourceModal
        workspaceId={activeId}
        open={showModal}
        instances={instances}
        onClose={() => setShowModal(false)}
        onConnected={(sourceId, warning) => {
          setShowModal(false);
          setConnectWarning(warning);
          if (sourceId) setSelected({ kind: "source", id: sourceId });
          void fetchSources();
        }}
      />

      {connectWarning && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[13px] text-amber-600 dark:text-amber-400">
          {format(copy.validationWarning, { message: connectWarning })}
        </div>
      )}

      <KbCaptureRules workspaceId={activeId} sources={sources ?? []} />

      {loading ? (
        <div className="py-10 text-center text-sm text-muted-foreground">{copy.loading}</div>
      ) : loadError ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-3 text-center text-sm text-destructive">
          {copy.loadError}
        </div>
      ) : sources !== null && sources.length === 0 && manualCount === 0 ? (
        <section className="flex flex-col items-center gap-2 rounded-xl border border-border bg-card/50 p-8 text-center">
          <BookOpen className="size-5 text-muted-foreground" aria-hidden />
          <div className="text-sm font-medium">{copy.emptyTitle}</div>
          <p className="max-w-sm text-sm text-muted-foreground">{copy.empty}</p>
          <button
            onClick={() => setShowModal(true)}
            className="mt-2 rounded-lg bg-action px-4 py-2 text-sm font-medium text-action-foreground transition-colors hover:bg-action/90"
          >
            {copy.addRepo}
          </button>
        </section>
      ) : (
        /* ── Master-detail: source rail + focused panel ── */
        <div className="flex flex-col gap-6 md:flex-row">
          <aside className="w-full shrink-0 self-start md:w-64">
            <nav aria-label={copy.railAriaLabel} className="flex flex-col gap-3">
              <div>
                <div className="flex items-center gap-1.5 px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {copy.sources}
                  <span className="font-normal text-muted-foreground/50">
                    {sources?.length ?? 0}
                  </span>
                </div>
                <ul className="flex flex-col gap-0.5">
                  {(sources ?? []).map((s) =>
                    railRow(
                      { kind: "source", id: s.id },
                      s.repo,
                      s.rootPath ? `/${s.rootPath}` : s.branch,
                      s.sourceType === "local" ? (
                        <HardDrive className="size-3.5 text-muted-foreground" aria-hidden />
                      ) : (
                        <FolderGit2 className="size-3.5 text-muted-foreground" aria-hidden />
                      ),
                      s.syncError || !s.lastSyncedAt ? "attention" : "ok",
                      s.entryCount,
                    ),
                  )}
                  {railRow(
                    { kind: "manual" },
                    copy.manualTitle,
                    null,
                    <NotebookPen className="size-3.5 text-muted-foreground" aria-hidden />,
                    null,
                    manualCount,
                  )}
                </ul>
              </div>
            </nav>
          </aside>

          <div className="min-w-0 flex-1">
            {!sel ? (
              <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
                {copy.selectPrompt}
              </div>
            ) : sel.kind === "source" ? (
              renderSourceDetail(sel.source)
            ) : (
              renderManualDetail()
            )}
          </div>
        </div>
      )}
    </div>
  );
}
