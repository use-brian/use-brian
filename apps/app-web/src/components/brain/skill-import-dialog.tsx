"use client";

/**
 * Skill import dialog — bring an existing skill file into the workspace
 * library from a public URL or a connected GitHub repo (private repos work
 * through the connector PAT). Two tabs:
 *
 *   url    — paste a GitHub file link / gist / raw.githubusercontent.com URL
 *   github — account select > repo select > directory browse; pick a
 *            markdown file, or import a whole Agent Skills folder when the
 *            current directory holds a SKILL.md
 *
 * The import is parse-only (`POST /api/skills/import`): on success the
 * dialog shows the parsed draft with its warnings (what will not carry
 * over: foreign tools, $ARGUMENTS, dropped metadata, non-executable
 * scripts), and "Open in editor" hands a `SkillImportPrefill` to the parent,
 * which opens the skill creator pre-filled on the doc stage. Nothing is
 * saved until the user reviews and saves there.
 *
 * Inline error state throughout (app-web has no global toast).
 *
 * Spec: docs/architecture/engine/skill-system.md → "Importing skills
 * (GitHub / URL)" → "UI".  [COMP:app-web/brain-skill-import]
 */

import * as React from "react";
import { Dialog } from "@base-ui/react/dialog";
import {
  ChevronRight,
  FileText,
  Folder,
  FolderGit2,
  Link2,
  Loader2,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  importSkill,
  listImportGithubContents,
  listImportGithubInstances,
  listImportGithubRepos,
  type SkillImportGithubEntry,
  type SkillImportGithubInstance,
  type SkillImportGithubRepo,
  type SkillImportResult,
  type SkillImportSource,
} from "@/lib/api/skills";
import type { SkillImportPrefill } from "./skill-creator";
import {
  crumbsOf,
  folderHasSkillMd,
  toSkillImportPrefill,
} from "@/lib/skill-import";

type Props = {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
  /** Fired with the parsed draft; the parent opens the creator pre-filled. */
  onImported: (prefill: SkillImportPrefill) => void;
};

type Tab = "url" | "github";

export function SkillImportDialog({ workspaceId, open, onClose, onImported }: Props) {
  const t = useT();
  const copy = t.brainPage.skillImport;

  const [tab, setTab] = React.useState<Tab>("url");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<SkillImportResult | null>(null);

  // URL tab.
  const [url, setUrl] = React.useState("");

  // GitHub tab — loaded lazily the first time the tab opens.
  const [instances, setInstances] = React.useState<SkillImportGithubInstance[] | null>(null);
  const [instanceId, setInstanceId] = React.useState("");
  const [repos, setRepos] = React.useState<SkillImportGithubRepo[]>([]);
  const [repoFullName, setRepoFullName] = React.useState("");
  const [path, setPath] = React.useState("");
  const [entries, setEntries] = React.useState<SkillImportGithubEntry[] | null>(null);
  const [browseLoading, setBrowseLoading] = React.useState(false);

  // Leaving the dialog clears the transient stages but keeps the pickers, so
  // reopening lands where the user left off.
  React.useEffect(() => {
    if (!open) {
      setBusy(false);
      setError(null);
      setResult(null);
    }
  }, [open]);

  // ── Import actions ──────────────────────────────────────────

  async function runImport(source: SkillImportSource) {
    setBusy(true);
    setError(null);
    const res = await importSkill(workspaceId, source);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setResult(res.result);
  }

  function openInEditor() {
    if (!result) return;
    onImported(toSkillImportPrefill(result));
    setResult(null);
    onClose();
  }

  // ── GitHub browse data ──────────────────────────────────────

  const loadInstances = React.useCallback(async () => {
    const res = await listImportGithubInstances(workspaceId);
    if (!res.ok) {
      setError(res.error);
      setInstances([]);
      return;
    }
    setInstances(res.instances);
    if (res.instances.length > 0 && !res.instances.some((i) => i.id === instanceId)) {
      setInstanceId(res.instances[0]!.id);
    }
  }, [workspaceId, instanceId]);

  React.useEffect(() => {
    if (open && tab === "github" && instances === null) void loadInstances();
  }, [open, tab, instances, loadInstances]);

  React.useEffect(() => {
    if (!instanceId) return;
    let cancelled = false;
    setRepos([]);
    setRepoFullName("");
    setEntries(null);
    void listImportGithubRepos(workspaceId, instanceId).then((res) => {
      if (cancelled) return;
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setRepos(res.repos);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, instanceId]);

  const browse = React.useCallback(
    async (nextPath: string) => {
      const repo = repos.find((r) => r.fullName === repoFullName);
      if (!repo) return;
      setBrowseLoading(true);
      setError(null);
      const res = await listImportGithubContents(
        workspaceId,
        instanceId,
        repo.owner,
        repo.name,
        nextPath,
      );
      setBrowseLoading(false);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setPath(nextPath);
      setEntries(res.entries);
    },
    [workspaceId, instanceId, repos, repoFullName],
  );

  React.useEffect(() => {
    if (repoFullName) void browse("");
    // Descend/breadcrumb navigation calls browse() directly; this effect only
    // resets to the root when the repo pick changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoFullName]);

  function githubSource(entryPath: string): SkillImportSource | null {
    const repo = repos.find((r) => r.fullName === repoFullName);
    if (!repo) return null;
    return {
      kind: "github",
      connectorInstanceId: instanceId,
      owner: repo.owner,
      repo: repo.name,
      path: entryPath,
    };
  }

  const canImportFolder = folderHasSkillMd(entries);
  const crumbs = crumbsOf(path);

  // ── Render ──────────────────────────────────────────────────

  const warningLabels = copy.warnings as Record<string, string>;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop
          className={cn(
            "fixed inset-0 z-50 bg-background/80 backdrop-blur-sm transition-opacity duration-150",
            "data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
          )}
        />
        <Dialog.Popup
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2",
            "rounded-2xl border border-border bg-background p-6 shadow-xl ring-1 ring-foreground/5",
            "transition-all duration-150",
            "data-[starting-style]:opacity-0 data-[starting-style]:scale-95",
            "data-[ending-style]:opacity-0 data-[ending-style]:scale-95",
          )}
        >
          <Dialog.Title className="text-base font-semibold text-foreground">
            {copy.title}
          </Dialog.Title>

          {result ? (
            /* ── Preview stage: parsed draft + warnings ── */
            <div className="mt-4">
              <div className="rounded-lg border border-border p-3">
                <p className="text-sm font-medium text-foreground">{result.draft.name}</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {result.draft.description}
                </p>
                {result.supportFiles.length > 0 && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {result.supportFiles.length === 1
                      ? copy.supportFilesOne
                      : copy.supportFilesMany.replace(
                          "{count}",
                          String(result.supportFiles.length),
                        )}
                  </p>
                )}
              </div>
              {result.warnings.length > 0 && (
                <div className="mt-3 rounded-lg border border-amber-300/60 bg-amber-50 p-3 dark:border-amber-400/30 dark:bg-amber-950/30">
                  <p className="text-xs font-medium text-amber-800 dark:text-amber-300">
                    {copy.warningsTitle}
                  </p>
                  <ul className="mt-2 space-y-1.5">
                    {result.warnings.map((w, i) => (
                      <li key={i} className="text-xs leading-relaxed text-amber-800/90 dark:text-amber-200/90">
                        <span className="font-medium">
                          {warningLabels[w.code] ?? w.code}
                        </span>
                        {": "}
                        {w.detail}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="mt-6 flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setResult(null)}>
                  {copy.back}
                </Button>
                <Button variant="default" size="sm" onClick={openInEditor}>
                  {copy.openEditor}
                </Button>
              </div>
            </div>
          ) : (
            <>
              {/* ── Tabs ── */}
              <div className="mt-4 flex gap-1 rounded-lg bg-muted p-1" role="tablist">
                {(
                  [
                    { key: "url" as Tab, label: copy.tabUrl, icon: Link2 },
                    { key: "github" as Tab, label: copy.tabGithub, icon: FolderGit2 },
                  ]
                ).map(({ key, label, icon: Icon }) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={tab === key}
                    onClick={() => {
                      setTab(key);
                      setError(null);
                    }}
                    className={cn(
                      "inline-flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                      tab === key
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Icon className="size-3.5" aria-hidden />
                    {label}
                  </button>
                ))}
              </div>

              {tab === "url" ? (
                <div className="mt-4">
                  <label className="text-xs font-medium text-foreground" htmlFor="skill-import-url">
                    {copy.urlLabel}
                  </label>
                  <input
                    id="skill-import-url"
                    type="url"
                    value={url}
                    placeholder={copy.urlPlaceholder}
                    onChange={(e) => setUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && url.trim() && !busy) {
                        e.preventDefault();
                        void runImport({ kind: "url", url: url.trim() });
                      }
                    }}
                    className="mt-1.5 h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
                  />
                  <p className="mt-1.5 text-xs text-muted-foreground">{copy.urlHint}</p>
                </div>
              ) : (
                <div className="mt-4">
                  {instances === null ? (
                    <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                      {copy.loading}
                    </div>
                  ) : instances.length === 0 ? (
                    <p className="py-4 text-sm leading-relaxed text-muted-foreground">
                      {copy.noConnector}
                    </p>
                  ) : (
                    <div className="space-y-3">
                      {instances.length > 1 && (
                        <SearchableSelect
                          value={instanceId}
                          onValueChange={setInstanceId}
                          items={instances.map((i) => ({
                            value: i.id,
                            label: i.label,
                            hint: i.connectedEmail ?? undefined,
                          }))}
                          placeholder={copy.account}
                          aria-label={copy.account}
                        />
                      )}
                      <SearchableSelect
                        value={repoFullName}
                        onValueChange={setRepoFullName}
                        items={repos.map((r) => ({
                          value: r.fullName,
                          label: r.fullName,
                          hint: r.private ? copy.privateRepo : undefined,
                        }))}
                        placeholder={copy.repoPlaceholder}
                        aria-label={copy.repo}
                      />

                      {repoFullName && (
                        <div className="rounded-lg border border-border">
                          {/* Breadcrumb */}
                          <div className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-2 text-xs text-muted-foreground">
                            <button
                              type="button"
                              className="transition-colors hover:text-foreground"
                              onClick={() => void browse("")}
                            >
                              {copy.root}
                            </button>
                            {crumbs.map((seg, i) => (
                              <React.Fragment key={i}>
                                <ChevronRight className="size-3" aria-hidden />
                                <button
                                  type="button"
                                  className="transition-colors hover:text-foreground"
                                  onClick={() =>
                                    void browse(crumbs.slice(0, i + 1).join("/"))
                                  }
                                >
                                  {seg}
                                </button>
                              </React.Fragment>
                            ))}
                          </div>

                          {canImportFolder && (
                            <div className="border-b border-border px-3 py-2">
                              <Button
                                variant="default"
                                size="sm"
                                disabled={busy}
                                onClick={() => {
                                  const source = githubSource(path);
                                  if (source) void runImport(source);
                                }}
                              >
                                {busy ? copy.importing : copy.importFolder}
                              </Button>
                            </div>
                          )}

                          <div className="max-h-56 overflow-y-auto">
                            {browseLoading ? (
                              <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
                                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                                {copy.loading}
                              </div>
                            ) : entries && entries.length > 0 ? (
                              entries.map((entry) => (
                                <button
                                  key={entry.path}
                                  type="button"
                                  disabled={busy}
                                  onClick={() => {
                                    if (entry.type === "dir") {
                                      void browse(entry.path);
                                    } else {
                                      const source = githubSource(entry.path);
                                      if (source) void runImport(source);
                                    }
                                  }}
                                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-muted disabled:opacity-50"
                                >
                                  {entry.type === "dir" ? (
                                    <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                                  ) : (
                                    <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                                  )}
                                  <span className="truncate">{entry.name}</span>
                                </button>
                              ))
                            ) : (
                              <p className="px-3 py-4 text-xs text-muted-foreground">
                                {copy.emptyDir}
                              </p>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {error && (
                <p role="alert" className="mt-3 text-xs leading-relaxed text-red-500">
                  {error}
                </p>
              )}

              <div className="mt-6 flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={onClose}>
                  {copy.cancel}
                </Button>
                {tab === "url" && (
                  <Button
                    variant="default"
                    size="sm"
                    disabled={!url.trim() || busy}
                    onClick={() => void runImport({ kind: "url", url: url.trim() })}
                  >
                    {busy ? copy.importing : copy.importCta}
                  </Button>
                )}
              </div>
            </>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
