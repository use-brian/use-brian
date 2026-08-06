"use client";

/**
 * Connect-a-knowledge-source modal (Studio → Knowledge, plan D1).
 *
 * The instance → repo → branch → rootPath cascade that used to render as an
 * inline card on the sources list, moved into a themed `@base-ui/react`
 * dialog (never a native dialog — root CLAUDE.md). Validation errors and the
 * connect action live inside the modal; a successful connect closes it and
 * hands the created source id to the caller so the master-detail can focus
 * the new row.
 *
 * Backend: POST /api/workspaces/:workspaceId/knowledge/sources.
 * [COMP:app-web/kb-add-source-modal]
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Dialog } from "@base-ui/react/dialog";
import { authFetch } from "@/lib/auth-fetch";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n";
import { SearchableSelect } from "@/components/ui/searchable-select";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type ConnectorInstanceOption = {
  id: string;
  label: string;
  connectedEmail: string | null;
  sensitivity: string | null;
};

type RepoOption = {
  fullName: string;
  private: boolean;
  description: string | null;
};

export function AddSourceModal({
  workspaceId,
  open,
  instances,
  onClose,
  onConnected,
}: {
  workspaceId: string;
  open: boolean;
  instances: ConnectorInstanceOption[];
  onClose: () => void;
  /** Called with the created source id + any validation warning. */
  onConnected: (sourceId: string | null, warning: string | null) => void;
}) {
  const t = useT();
  const copy = t.studioPage.knowledgePage;

  const [sourceType, setSourceType] = useState<"github" | "local">("github");
  const [localPath, setLocalPath] = useState("");
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

  // Reset on open; auto-select the only connector.
  useEffect(() => {
    if (!open) return;
    setSourceType("github");
    setLocalPath("");
    setSelectedInstance(instances.length === 1 ? instances[0].id : "");
    setSelectedRepo("");
    setSelectedBranch("");
    setRootPath("");
    setRepos([]);
    setBranches([]);
    setConnectError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Instance picked → refresh the repo dropdown.
  useEffect(() => {
    if (!open || !selectedInstance) {
      setRepos([]);
      return;
    }
    setLoadingRepos(true);
    setConnectError(null);
    authFetch(
      `${API_URL}/api/workspaces/${workspaceId}/knowledge/github/repos?connectorInstanceId=${encodeURIComponent(selectedInstance)}`,
    )
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then((data: { repos: RepoOption[]; error?: string }) => {
        setRepos(data.repos ?? []);
        if (data.error) setConnectError(data.error);
      })
      .catch(() => setConnectError(copy.networkError))
      .finally(() => setLoadingRepos(false));
  }, [open, workspaceId, selectedInstance, copy.networkError]);

  // Repo picked → refresh the branch dropdown.
  useEffect(() => {
    if (!open || !selectedInstance || !selectedRepo) {
      setBranches([]);
      return;
    }
    const [owner, repo] = selectedRepo.split("/");
    if (!owner || !repo) return;
    setLoadingBranches(true);
    authFetch(
      `${API_URL}/api/workspaces/${workspaceId}/knowledge/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?connectorInstanceId=${encodeURIComponent(selectedInstance)}`,
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
      .catch(() => setBranches([]))
      .finally(() => setLoadingBranches(false));
  }, [open, workspaceId, selectedInstance, selectedRepo]);

  async function handleConnect() {
    if (sourceType === "github" && (!selectedInstance || !selectedRepo || !selectedBranch)) return;
    if (sourceType === "local" && !localPath.trim()) return;
    setConnecting(true);
    setConnectError(null);
    try {
      const body =
        sourceType === "local"
          ? { sourceType: "local", localPath: localPath.trim(), rootPath: rootPath.trim() }
          : {
              connectorInstanceId: selectedInstance,
              repo: selectedRepo,
              branch: selectedBranch,
              rootPath: rootPath.trim(),
            };
      const res = await authFetch(
        `${API_URL}/api/workspaces/${workspaceId}/knowledge/sources`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (res.ok) {
        const data = (await res.json()) as {
          id?: string;
          validation?: { warning: string | null };
        };
        onConnected(data.id ?? null, data.validation?.warning ?? null);
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

  const submitDisabled =
    connecting ||
    (sourceType === "github"
      ? !selectedInstance || !selectedRepo || !selectedBranch
      : !localPath.trim());

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !connecting) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop
          className={cn(
            "fixed inset-0 z-50 bg-background/80 backdrop-blur-sm transition-opacity duration-150",
            "data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
          )}
        />
        <Dialog.Popup
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2",
            "rounded-2xl border border-border bg-background p-5 shadow-xl ring-1 ring-foreground/5",
            "transition-all duration-150",
            "data-[starting-style]:opacity-0 data-[starting-style]:scale-95",
            "data-[ending-style]:opacity-0 data-[ending-style]:scale-95",
          )}
        >
          <Dialog.Title className="pb-3 text-sm font-semibold text-foreground">
            {copy.addRepo}
          </Dialog.Title>

          <div className="flex flex-col gap-3">
            <div className="flex gap-1 rounded-lg border border-border p-0.5">
              <button
                onClick={() => setSourceType("github")}
                className={cn(
                  "flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                  sourceType === "github"
                    ? "bg-action text-action-foreground"
                    : "text-muted-foreground hover:bg-muted",
                )}
              >
                {copy.sourceTypeGithub}
              </button>
              <button
                onClick={() => setSourceType("local")}
                className={cn(
                  "flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                  sourceType === "local"
                    ? "bg-action text-action-foreground"
                    : "text-muted-foreground hover:bg-muted",
                )}
              >
                {copy.sourceTypeLocal}
              </button>
            </div>

            {sourceType === "github" ? (
              <>
                <ModalField label={copy.connectorLabel}>
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
                </ModalField>
                {instances.length === 0 && (
                  <div className="text-xs text-muted-foreground">
                    {copy.noGithubConnector}{" "}
                    <Link
                      href={`/w/${workspaceId}/studio/connectors`}
                      className="font-medium text-foreground underline underline-offset-2"
                    >
                      {copy.goToConnectors}
                    </Link>
                  </div>
                )}

                <ModalField label={copy.repoLabel}>
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
                </ModalField>

                <ModalField label={copy.branchLabel}>
                  <SearchableSelect
                    value={selectedBranch}
                    onValueChange={setSelectedBranch}
                    items={branches.map((b) => ({ value: b, label: b }))}
                    disabled={!selectedRepo || loadingBranches}
                    placeholder={loadingBranches ? copy.branchLoading : copy.branchPlaceholder}
                    searchPlaceholder={copy.branchSearchPlaceholder}
                    emptyMessage={copy.branchNoMatch}
                  />
                </ModalField>
              </>
            ) : (
              <ModalField label={copy.localPathLabel} help={copy.localPathHelp}>
                <input
                  type="text"
                  value={localPath}
                  onChange={(e) => setLocalPath(e.target.value)}
                  placeholder={copy.localPathPlaceholder}
                  className="w-full rounded-lg border border-border bg-muted/50 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </ModalField>
            )}

            <ModalField label={copy.rootPathLabel} help={copy.rootPathHelp}>
              <input
                type="text"
                value={rootPath}
                onChange={(e) => setRootPath(e.target.value)}
                placeholder={copy.rootPathPlaceholder}
                className="w-full rounded-lg border border-border bg-muted/50 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </ModalField>

            {connectError && (
              <div className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
                {connectError}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={onClose}
                disabled={connecting}
                className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
              >
                {copy.addRepoCancel}
              </button>
              <button
                onClick={() => void handleConnect()}
                disabled={submitDisabled}
                className="rounded-lg bg-action px-3 py-1.5 text-xs font-medium text-action-foreground transition-colors hover:bg-action/90 disabled:opacity-50"
              >
                {connecting ? copy.addRepoSubmitting : copy.addRepoSubmit}
              </button>
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ModalField({
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
