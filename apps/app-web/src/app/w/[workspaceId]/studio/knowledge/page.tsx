"use client";

/**
 * Studio → Knowledge management (app-web).
 *
 * Ported from `apps/web/src/app/(app)/studio/knowledge/page.tsx` for the app
 * consolidation (docs/architecture/features/doc.md §9 #5, CHUNK 4).
 * Rendered inside the Studio full-page layout, NOT the doc three-column
 * page shell.
 *
 * Lists the active workspace's connected knowledge sources (GitHub
 * repositories synced into `workspace_knowledge_sources`) and lets the
 * user connect new ones via a workspace-scoped GitHub connector instance.
 *
 * Sources are workspace-scoped — every assistant in the workspace shares the
 * same source set. The per-assistant Knowledge tab (on the assistant detail
 * page) is the entry browser; this page owns source CRUD.
 *
 * app-web deltas vs apps/web:
 *   - `activeId` comes from the app-web `useWorkspaces()` adapter.
 *   - Cross-links to Connectors are workspace-scoped
 *     (`/w/[workspaceId]/studio/connectors`).
 *   - `window.confirm` is replaced with `confirmDialog()` (themed,
 *     Promise-returning) per the root CLAUDE.md ban on native dialogs.
 *
 * Backend: /api/workspaces/:workspaceId/knowledge (packages/api/src/routes/knowledge.ts → workspaceKnowledgeRoutes).
 *
 * [COMP:app-web/studio-knowledge]
 */

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { authFetch } from "@/lib/auth-fetch";
import { useWorkspaces } from "@/contexts/workspace-context";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

type ConnectorInstance = {
  id: string;
  label: string;
  connectedEmail: string | null;
  sensitivity: string | null;
};

type KnowledgeSource = {
  id: string;
  workspaceId: string;
  sourceType: string;
  repo: string;
  branch: string;
  rootPath: string;
  lastSyncedSha: string | null;
  lastSyncedAt: string | null;
  syncError: string | null;
};

type RepoOption = {
  fullName: string;
  private: boolean;
  description: string | null;
};

export default function StudioKnowledgePage() {
  const t = useT();
  const copy = t.studioPage.knowledgePage;
  const { activeId } = useWorkspaces();
  const params = useParams<{ workspaceId: string }>();
  const workspaceId = params?.workspaceId ?? "";
  const connectorsHref = `/w/${workspaceId}/studio/connectors`;

  const [sources, setSources] = useState<KnowledgeSource[] | null>(null);
  const [instances, setInstances] = useState<ConnectorInstance[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  // Picker state
  const [showPicker, setShowPicker] = useState(false);
  const [selectedInstance, setSelectedInstance] = useState("");
  const [repos, setRepos] = useState<RepoOption[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [selectedBranch, setSelectedBranch] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectWarning, setConnectWarning] = useState<string | null>(null);

  // Per-source sync state
  const [syncingId, setSyncingId] = useState<string | null>(null);

  const fetchSources = useCallback(async () => {
    if (!activeId) return;
    try {
      const res = await authFetch(
        `${API_URL}/api/workspaces/${activeId}/knowledge/sources`,
      );
      if (res.ok) {
        const data = (await res.json()) as { sources: KnowledgeSource[] };
        setSources(data.sources ?? []);
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
        const data = (await res.json()) as { instances: ConnectorInstance[] };
        setInstances(data.instances ?? []);
      }
    } catch {
      // non-fatal — picker will surface no-connector empty state
    }
  }, [activeId]);

  useEffect(() => {
    if (!activeId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(false);
    Promise.all([fetchSources(), fetchInstances()]).finally(() => setLoading(false));
  }, [activeId, fetchSources, fetchInstances]);

  // When the user picks an instance, refresh the repo dropdown.
  useEffect(() => {
    if (!activeId || !selectedInstance) {
      setRepos([]);
      return;
    }
    setLoadingRepos(true);
    setConnectError(null);
    authFetch(
      `${API_URL}/api/workspaces/${activeId}/knowledge/github/repos?connectorInstanceId=${encodeURIComponent(selectedInstance)}`,
    )
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then((data: { repos: RepoOption[]; error?: string }) => {
        setRepos(data.repos ?? []);
        if (data.error) setConnectError(data.error);
      })
      .catch(() => setConnectError(copy.networkError))
      .finally(() => setLoadingRepos(false));
  }, [activeId, selectedInstance, copy.networkError]);

  // When the user picks a repo, refresh the branch dropdown.
  useEffect(() => {
    if (!activeId || !selectedInstance || !selectedRepo) {
      setBranches([]);
      return;
    }
    const [owner, repo] = selectedRepo.split("/");
    if (!owner || !repo) return;
    setLoadingBranches(true);
    authFetch(
      `${API_URL}/api/workspaces/${activeId}/knowledge/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?connectorInstanceId=${encodeURIComponent(selectedInstance)}`,
    )
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then((data: { branches: string[] }) => {
        const list = data.branches ?? [];
        setBranches(list);
        if (list.includes("main")) setSelectedBranch("main");
        else if (list.includes("master")) setSelectedBranch("master");
        else if (list.length > 0) setSelectedBranch(list[0]);
        else setSelectedBranch("");
      })
      .catch(() => {
        setBranches([]);
      })
      .finally(() => setLoadingBranches(false));
  }, [activeId, selectedInstance, selectedRepo]);

  function openPicker() {
    setShowPicker(true);
    setConnectError(null);
    setConnectWarning(null);
    // Auto-select the only connector if there's just one.
    if (instances.length === 1 && !selectedInstance) {
      setSelectedInstance(instances[0].id);
    }
  }

  function closePicker() {
    setShowPicker(false);
    setSelectedInstance("");
    setSelectedRepo("");
    setSelectedBranch("");
    setRootPath("");
    setRepos([]);
    setBranches([]);
    setConnectError(null);
  }

  async function handleConnect() {
    if (!activeId || !selectedInstance || !selectedRepo || !selectedBranch) return;
    setConnecting(true);
    setConnectError(null);
    setConnectWarning(null);
    try {
      const res = await authFetch(
        `${API_URL}/api/workspaces/${activeId}/knowledge/sources`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            connectorInstanceId: selectedInstance,
            repo: selectedRepo,
            branch: selectedBranch,
            rootPath: rootPath.trim(),
          }),
        },
      );
      if (res.ok) {
        const data = (await res.json()) as { validation?: { warning: string | null } };
        if (data.validation?.warning) setConnectWarning(data.validation.warning);
        closePicker();
        fetchSources();
      } else {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setConnectError(
          err.error
            ? format(copy.connectError, { message: err.error })
            : copy.defaultConnectError,
        );
      }
    } catch {
      setConnectError(copy.networkError);
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect(source: KnowledgeSource) {
    if (!activeId) return;
    const confirmMsg = format(copy.sourceDisconnectConfirm, { repo: source.repo });
    const ok = await confirmDialog({
      description: confirmMsg,
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
      if (res.ok) fetchSources();
    } catch {
      // ignore — surface via reload
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
        fetchSources();
        setSyncingId(null);
      }, 2000);
    } catch {
      setSyncingId(null);
    }
  }

  if (!activeId) {
    return (
      <div className="flex flex-col gap-6">
        <div className="text-sm text-muted-foreground">{copy.noConnectorWorkspace}</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {connectWarning && (
        <div className="text-[13px] text-amber-600 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-3">
          {format(copy.validationWarning, { message: connectWarning })}
        </div>
      )}

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-[13px] font-semibold tracking-tight uppercase text-muted-foreground">
            {copy.sources}
          </h2>
          {!showPicker && (
            instances.length > 0 ? (
              <button
                onClick={openPicker}
                className="text-xs font-medium bg-primary text-primary-foreground px-3 py-1.5 rounded-lg hover:bg-primary/90 transition-colors"
              >
                {copy.addRepo}
              </button>
            ) : (
              <Link
                href={connectorsHref}
                className="text-xs font-medium border border-border px-3 py-1.5 rounded-lg text-muted-foreground hover:bg-muted transition-colors"
              >
                {copy.goToConnectors}
              </Link>
            )
          )}
        </div>

        {showPicker && (
          <div className="rounded-xl border border-border bg-card p-5 flex flex-col gap-3">
            <PickerField label={copy.connectorLabel}>
              <SearchableSelect
                value={selectedInstance}
                onValueChange={(next) => {
                  setSelectedInstance(next);
                  setSelectedRepo("");
                  setSelectedBranch("");
                }}
                items={instances.map((i) => ({
                  value: i.id,
                  label: i.label,
                  hint: i.connectedEmail ?? undefined,
                }))}
                placeholder={copy.connectorPlaceholder}
                searchPlaceholder={copy.connectorSearchPlaceholder}
                emptyMessage={copy.connectorNoMatch}
              />
            </PickerField>

            <PickerField label={copy.repoLabel}>
              <SearchableSelect
                value={selectedRepo}
                onValueChange={(next) => {
                  setSelectedRepo(next);
                  setSelectedBranch("");
                }}
                items={repos.map((r) => ({
                  value: r.fullName,
                  label: r.fullName,
                  hint: r.private ? "private" : undefined,
                }))}
                disabled={!selectedInstance || loadingRepos}
                placeholder={loadingRepos ? copy.repoLoading : copy.repoPlaceholder}
                searchPlaceholder={copy.repoSearchPlaceholder}
                emptyMessage={copy.repoNoMatch}
              />
            </PickerField>

            <PickerField label={copy.branchLabel}>
              <SearchableSelect
                value={selectedBranch}
                onValueChange={setSelectedBranch}
                items={branches.map((b) => ({ value: b, label: b }))}
                disabled={!selectedRepo || loadingBranches}
                placeholder={loadingBranches ? copy.branchLoading : copy.branchPlaceholder}
                searchPlaceholder={copy.branchSearchPlaceholder}
                emptyMessage={copy.branchNoMatch}
              />
            </PickerField>

            <PickerField label={copy.rootPathLabel} help={copy.rootPathHelp}>
              <input
                type="text"
                value={rootPath}
                onChange={(e) => setRootPath(e.target.value)}
                placeholder={copy.rootPathPlaceholder}
                className="w-full text-sm bg-muted/50 border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30 font-mono"
              />
            </PickerField>

            {connectError && (
              <div className="text-[12px] text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
                {connectError}
              </div>
            )}

            <div className="flex gap-2 justify-end pt-1">
              <button
                onClick={closePicker}
                disabled={connecting}
                className="text-xs font-medium border border-border px-3 py-1.5 rounded-lg text-muted-foreground hover:bg-muted transition-colors disabled:opacity-50"
              >
                {copy.addRepoCancel}
              </button>
              <button
                onClick={handleConnect}
                disabled={connecting || !selectedInstance || !selectedRepo || !selectedBranch}
                className="text-xs font-medium bg-primary text-primary-foreground px-3 py-1.5 rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {connecting ? copy.addRepoSubmitting : copy.addRepoSubmit}
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="text-sm text-muted-foreground">{copy.loading}</div>
        ) : loadError ? (
          <div className="text-sm text-destructive">{copy.loadError}</div>
        ) : sources && sources.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border px-5 py-6 text-sm text-muted-foreground">
            {instances.length === 0 ? copy.noGithubConnector : copy.empty}
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {(sources ?? []).map((s) => (
              <li
                key={s.id}
                className="border border-border rounded-xl bg-card px-5 py-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium">{s.repo}</span>
                      <span className="text-[11px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                        {s.branch}
                      </span>
                      {s.rootPath && (
                        <span className="text-[11px] text-muted-foreground font-mono">
                          /{s.rootPath}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-muted-foreground mt-1 space-x-3">
                      {s.lastSyncedAt ? (
                        <span>
                          {format(copy.sourceLastSynced, {
                            time: new Date(s.lastSyncedAt).toLocaleString(),
                          })}
                        </span>
                      ) : (
                        <span className="text-amber-600 dark:text-amber-400">{copy.sourceNeverSynced}</span>
                      )}
                      {s.lastSyncedSha && (
                        <span className="font-mono">{s.lastSyncedSha.slice(0, 7)}</span>
                      )}
                    </div>
                    {s.syncError && (
                      <div className="text-[11px] text-destructive mt-1">
                        {format(copy.sourceSyncFailed, { message: s.syncError })}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => handleSync(s)}
                      disabled={syncingId === s.id}
                      className="text-xs font-medium border border-border px-2.5 py-1 rounded-lg text-muted-foreground hover:bg-muted transition-colors disabled:opacity-50"
                    >
                      {syncingId === s.id ? copy.sourceSyncing : copy.sourceSync}
                    </button>
                    <button
                      onClick={() => handleDisconnect(s)}
                      className="text-xs font-medium border border-border px-2.5 py-1 rounded-lg text-muted-foreground hover:text-destructive hover:border-destructive/30 transition-colors"
                    >
                      {copy.sourceDisconnect}
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function PickerField({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
      {help && <span className="text-[11px] text-muted-foreground">{help}</span>}
    </label>
  );
}
