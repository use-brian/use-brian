"use client";


import { publicRuntimeConfig } from "@/lib/runtime-public-config";
/**
 * Assistant -> Brain -> Knowledge sub-tab (app-web).
 *
 * Ported from `apps/web/src/components/knowledge-tab.tsx`
 * (app consolidation §9 #5). Read-only viewer over the assistant's knowledge
 * sources + entries; source CRUD lives at Studio -> Knowledge. Strings flow
 * through `t.workspace.brain.*`.
 *
 * The Studio -> Knowledge deep links are workspace-scoped in-app routes
 * (`/w/<workspaceId>/studio/knowledge`); they only render when a
 * `workspaceId` is present.
 *
 * [COMP:app-web/knowledge-tab]
 */

import { useState, useCallback } from "react";
import { authFetch } from "@/lib/auth-fetch";
import { SensitivityBadge, type Sensitivity } from "@/components/sensitivity-badge";
import { Skeleton } from "@/components/skeleton";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n";
import { mutateSurfaceCache, useCachedResource } from "@/lib/surface-cache";
import { kbTabCacheKey } from "@/lib/surface-prefetch";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";

type KnowledgeEntry = {
  id: string;
  path: string;
  title: string;
  summary: string | null;
  tags: string[];
  sensitivity: Sensitivity;
  childCount?: number;
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
  enabled: boolean;
};

/** The tab's landing data: the sources plus the ROOT entry listing. */
export type KbTabSnapshot = {
  sources: KnowledgeSource[];
  entries: KnowledgeEntry[];
};

/**
 * Both landing reads in parallel (instant-navigation N7); either one failing
 * degrades to an empty list, the way the tab always behaved.
 */
async function fetchKbTabSnapshot(assistantId: string): Promise<KbTabSnapshot> {
  const [sources, entries] = await Promise.all([
    authFetch(`${API_URL}/api/assistants/${assistantId}/knowledge/sources`)
      .then(async (res) => (res.ok ? ((await res.json()).sources ?? []) : []))
      .catch(() => []),
    authFetch(`${API_URL}/api/assistants/${assistantId}/knowledge/entries?path=`)
      .then(async (res) => (res.ok ? ((await res.json()).entries ?? []) : []))
      .catch(() => []),
  ]);
  return { sources, entries };
}

/** Geometry-matched cold state: two source rows, four entry rows (N4). */
function KnowledgeTabSkeleton() {
  return (
    <div className="space-y-6" data-testid="knowledge-tab-skeleton">
      <div className="rounded-xl border border-border px-5 py-4 space-y-3">
        {[0, 1].map((i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="size-4 rounded" />
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="ml-auto h-5 w-9 rounded-full" />
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-border px-5 py-4 space-y-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-3 px-3 py-2">
            <Skeleton className="size-5 rounded" />
            <Skeleton className="h-3.5" style={{ width: `${30 + ((i * 17) % 40)}%` }} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function KnowledgeTab({
  assistantId,
  workspaceId,
}: {
  assistantId: string;
  workspaceId: string | null;
}) {
  const t = useT();
  // Sources + the root entry listing read the assistant's cached key
  // (instant-navigation N1): re-opening the tab paints on the first frame.
  // Browsing into a folder or searching replaces the listing LOCALLY
  // (`browsed`); null means "show the cached root".
  const tabKey = kbTabCacheKey(assistantId);
  const root = useCachedResource<KbTabSnapshot>(tabKey, () => fetchKbTabSnapshot(assistantId));
  const sources = root.data?.sources ?? [];
  const [browsed, setEntries] = useState<KnowledgeEntry[] | null>(null);
  const entries = browsed ?? root.data?.entries ?? [];
  const cold = root.data === undefined && root.error === undefined;
  const setSources = useCallback(
    (updater: (prev: KnowledgeSource[]) => KnowledgeSource[]) => {
      mutateSurfaceCache<KbTabSnapshot>(tabKey, (prev) => ({
        ...prev,
        sources: updater(prev.sources),
      }));
    },
    [tabKey],
  );
  const [currentPath, setCurrentPath] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [expandedEntryId, setExpandedEntryId] = useState<string | null>(null);
  const [expandedContent, setExpandedContent] = useState<string | null>(null);

  // Per-source sync state — viewer-only; source CRUD lives at /studio/knowledge.
  const [syncingId, setSyncingId] = useState<string | null>(null);

  // Per-source enablement toggle state.
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    type: "error";
    message: string;
  } | null>(null);

  function showError(message: string) {
    setFeedback({ type: "error", message });
    setTimeout(() => setFeedback(null), 3000);
  }

  async function toggleEnabled(sourceId: string, enabled: boolean) {
    setTogglingId(sourceId);
    // Optimistic update.
    setSources((prev) =>
      prev.map((s) => (s.id === sourceId ? { ...s, enabled } : s))
    );
    try {
      const res = await authFetch(
        `${API_URL}/api/assistants/${assistantId}/knowledge/sources/${sourceId}/enablement`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        }
      );
      if (!res.ok) throw new Error("enablement failed");
    } catch {
      // Revert on failure.
      setSources((prev) =>
        prev.map((s) => (s.id === sourceId ? { ...s, enabled: !enabled } : s))
      );
      showError(t.workspace.brain.enablementFailed);
    } finally {
      setTogglingId(null);
    }
  }

  // Revalidate the cached sources (after a sync) - the same key the tab
  // painted from, so the next visit sees the refreshed rows too.
  const fetchSources = root.refresh;

  const fetchEntries = useCallback(
    async (path = "") => {
      try {
        const res = await authFetch(
          `${API_URL}/api/assistants/${assistantId}/knowledge/entries?path=${encodeURIComponent(path)}`
        );
        if (res.ok) {
          const data = await res.json();
          setEntries(data.entries ?? []);
        }
      } catch {
        // ignore
      }
    },
    [assistantId]
  );

  async function handleSearch() {
    if (!searchQuery.trim()) {
      fetchEntries(currentPath);
      return;
    }
    setSearching(true);
    try {
      const res = await authFetch(
        `${API_URL}/api/assistants/${assistantId}/knowledge/entries?q=${encodeURIComponent(searchQuery)}`
      );
      if (res.ok) {
        const data = await res.json();
        setEntries(data.entries ?? []);
      }
    } catch {
      // ignore
    } finally {
      setSearching(false);
    }
  }

  async function handleBrowse(path: string) {
    setCurrentPath(path);
    setSearchQuery("");
    setExpandedEntryId(null);
    setExpandedContent(null);
    await fetchEntries(path);
  }

  async function handleReadEntry(entryId: string) {
    if (expandedEntryId === entryId) {
      setExpandedEntryId(null);
      setExpandedContent(null);
      return;
    }
    try {
      const res = await authFetch(
        `${API_URL}/api/assistants/${assistantId}/knowledge/entries/${entryId}`
      );
      if (res.ok) {
        const data = await res.json();
        setExpandedEntryId(entryId);
        setExpandedContent(data.content ?? "");
      }
    } catch {
      // ignore
    }
  }

  async function handleSync(sourceId: string) {
    setSyncingId(sourceId);
    try {
      await authFetch(
        `${API_URL}/api/assistants/${assistantId}/knowledge/sources/${sourceId}/sync`,
        { method: "POST" }
      );
      // Refresh after a brief delay to allow sync to process
      setTimeout(() => {
        void fetchSources();
        void fetchEntries(currentPath);
        setSyncingId(null);
      }, 2000);
    } catch {
      setSyncingId(null);
    }
  }

  if (cold) {
    // Nothing cached for this assistant yet: skeleton rows hold the
    // geometry (N4), never a "Loading..." sentence. A failed first load
    // falls through to the empty states below.
    return <KnowledgeTabSkeleton />;
  }

  // Breadcrumb path segments
  const pathParts = currentPath ? currentPath.split("/") : [];
  const breadcrumbs = pathParts.map((part, i) => ({
    label: part,
    path: pathParts.slice(0, i + 1).join("/"),
  }));

  return (
    <div className="space-y-6">
      {/* Error feedback toast */}
      {feedback && (
        <div className="text-[13px] px-4 py-2.5 rounded-lg border border-destructive/30 bg-destructive/10 text-destructive">
          {feedback.message}
        </div>
      )}

      {/* Sources section — viewer only. Source CRUD lives at /studio/knowledge. */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[13px] font-semibold tracking-tight uppercase text-muted-foreground">
            {t.workspace.brain.knowledgeTitle}
          </h2>
          {workspaceId && (
            <a
              href={`/w/${workspaceId}/studio/knowledge`}
              className="text-[12px] text-muted-foreground hover:text-foreground"
            >
              {t.workspace.brain.manage}
            </a>
          )}
        </div>
        <div className="rounded-xl border border-border overflow-hidden">
          <div className="px-5 py-4 space-y-3">
            {sources.length === 0 ? (
              <div className="text-[13px] text-muted-foreground">
                {workspaceId ? (
                  <>{t.workspace.brain.noKnowledgeSourcesConnected} <a href={`/w/${workspaceId}/studio/knowledge`} className="text-primary hover:underline">{t.workspace.brain.manageInTeamSettings}</a>.</>
                ) : (
                  t.workspace.brain.addToTeamFirst
                )}
              </div>
            ) : (
              sources.map((s) => (
                <div
                  key={s.id}
                  className="flex items-start justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <GitHubIcon />
                      <span className="text-[14px] font-medium">
                        {s.repo}
                      </span>
                      <span className="text-[11px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                        {s.branch}
                      </span>
                    </div>
                    <div className="text-[11px] text-muted-foreground mt-1 space-x-3">
                      {s.lastSyncedAt && (
                        <span>
                          {format(t.workspace.brain.lastSynced, { time: new Date(s.lastSyncedAt).toLocaleString() })}
                        </span>
                      )}
                      {s.lastSyncedSha && (
                        <span className="font-mono">
                          {s.lastSyncedSha.slice(0, 7)}
                        </span>
                      )}
                      {!s.lastSyncedAt && (
                        <span className="text-amber-400">{t.workspace.brain.neverSynced}</span>
                      )}
                    </div>
                    {s.syncError && (
                      <div className="text-[11px] text-red-400 mt-1">
                        {s.syncError}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <div
                      className="flex items-center gap-2"
                      title={t.workspace.brain.enabledHelp}
                    >
                      <span className="text-[12px] text-muted-foreground">
                        {t.workspace.brain.enabledLabel}
                      </span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={s.enabled}
                        aria-label={t.workspace.brain.enabledLabel}
                        disabled={togglingId === s.id}
                        onClick={() => toggleEnabled(s.id, !s.enabled)}
                        className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 sm:h-5 sm:w-9 ${s.enabled ? "bg-primary" : "bg-muted"}`}
                      >
                        <span
                          className={`pointer-events-none inline-block size-6 rounded-full bg-background shadow-sm transition-transform duration-200 sm:size-4 ${s.enabled ? "translate-x-5 sm:translate-x-4" : "translate-x-0"}`}
                        />
                      </button>
                    </div>
                    <button
                      onClick={() => handleSync(s.id)}
                      disabled={syncingId === s.id}
                      className="inline-flex h-9 items-center text-[12px] font-medium border border-border px-2.5 rounded-lg text-muted-foreground hover:bg-muted transition-colors disabled:opacity-50 shrink-0 sm:h-7"
                    >
                      {syncingId === s.id ? t.workspace.brain.syncNow + "…" : t.workspace.brain.syncNow}
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      {/* Entries section */}
      <section>
        <div className="mb-3">
          <h2 className="text-[13px] font-semibold tracking-tight uppercase text-muted-foreground">
            {t.workspace.brain.entriesTitle}
          </h2>
        </div>
        <div className="rounded-xl border border-border overflow-hidden">
          <div className="px-5 py-4 space-y-4">
            {/* Search */}
            <div className="flex gap-2">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                placeholder={t.workspace.brain.searchPlaceholder}
                className="flex-1 text-[16px] md:text-sm bg-muted/50 border border-border rounded-lg px-3 py-2"
              />
              <button
                onClick={handleSearch}
                disabled={searching}
                className="text-sm font-medium bg-muted hover:bg-muted/80 px-3 py-2 rounded-lg transition-colors disabled:opacity-50"
              >
                {searching ? "..." : t.workspace.brain.search}
              </button>
              {searchQuery && (
                <button
                  onClick={() => {
                    setSearchQuery("");
                    fetchEntries(currentPath);
                  }}
                  className="text-sm text-muted-foreground hover:text-foreground"
                >
                  {t.workspace.brain.clear}
                </button>
              )}
            </div>

            {/* Breadcrumb navigation */}
            <div className="flex items-center gap-1 text-[12px] text-muted-foreground">
              <button
                onClick={() => handleBrowse("")}
                className={`hover:text-foreground transition-colors ${
                  !currentPath ? "text-foreground font-medium" : ""
                }`}
              >
                {t.workspace.brain.root}
              </button>
              {breadcrumbs.map((b, i) => (
                <span key={b.path} className="flex items-center gap-1">
                  <span>/</span>
                  <button
                    onClick={() => handleBrowse(b.path)}
                    className={`hover:text-foreground transition-colors ${
                      i === breadcrumbs.length - 1
                        ? "text-foreground font-medium"
                        : ""
                    }`}
                  >
                    {b.label}
                  </button>
                </span>
              ))}
            </div>

            {/* Entry list */}
            {entries.length === 0 ? (
              <div className="text-[13px] text-muted-foreground py-4 text-center">
                {searchQuery
                  ? t.workspace.brain.noEntriesMatch
                  : sources.length === 0
                    ? t.workspace.brain.noEntriesYet
                    : t.workspace.brain.noEntriesAtPath}
              </div>
            ) : (() => {
              const isFolder = (e: KnowledgeEntry) => (e.childCount ?? 0) > 0;
              const folders = entries.filter((e) => !searchQuery && isFolder(e));
              const files = entries.filter((e) => searchQuery || !isFolder(e));
              return (
                <div className="space-y-1">
                  {/* Folders */}
                  {folders.length > 0 && (
                    <>
                      {folders.map((entry) => (
                        <button
                          key={entry.id}
                          onClick={() => handleBrowse(entry.path)}
                          className="w-full flex items-center gap-3 py-2.5 px-3 rounded-lg hover:bg-primary/5 border border-transparent hover:border-primary/10 transition-all text-left group"
                        >
                          <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center text-primary shrink-0">
                            <FolderIcon />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-[13px] font-medium group-hover:text-primary transition-colors">{entry.title}</div>
                            {entry.summary && <div className="text-[11px] text-muted-foreground truncate">{entry.summary}</div>}
                          </div>
                          {entry.tags.length > 0 && (
                            <div className="flex gap-1 shrink-0">
                              {entry.tags.slice(0, 2).map((t) => (
                                <span key={t} className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">{t}</span>
                              ))}
                            </div>
                          )}
                          {entry.sensitivity && entry.sensitivity !== "internal" && (
                            <SensitivityBadge tier={entry.sensitivity} size="xs" />
                          )}
                          {(entry.childCount ?? 0) > 0 && <span className="text-[11px] text-muted-foreground shrink-0">{entry.childCount}</span>}
                          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground shrink-0"><path d="M6 4l4 4-4 4" /></svg>
                        </button>
                      ))}
                      {files.length > 0 && <div className="border-t border-border/50 my-2" />}
                    </>
                  )}

                  {/* Files */}
                  {files.map((entry) => {
                    const isExpanded = expandedEntryId === entry.id;
                    return (
                      <div key={entry.id}>
                        <div className="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-muted/30 transition-colors">
                          <div className="w-5 h-5 flex items-center justify-center text-muted-foreground/50 shrink-0">
                            <FileIcon />
                          </div>
                          <div className="flex-1 min-w-0">
                            <button onClick={() => handleReadEntry(entry.id)} className="text-[13px] font-medium hover:underline text-left truncate block w-full">{entry.title}</button>
                            {entry.summary && <div className="text-[11px] text-muted-foreground truncate">{entry.summary}</div>}
                          </div>
                          {searchQuery && <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded font-mono shrink-0">{entry.path}</span>}
                          {entry.tags.length > 0 && (
                            <div className="flex gap-1 shrink-0">
                              {entry.tags.slice(0, 2).map((t) => (
                                <span key={t} className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">{t}</span>
                              ))}
                            </div>
                          )}
                          {entry.sensitivity && entry.sensitivity !== "internal" && (
                            <SensitivityBadge tier={entry.sensitivity} size="xs" />
                          )}
                          <button onClick={() => handleReadEntry(entry.id)} className="text-muted-foreground shrink-0">
                            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${isExpanded ? "rotate-180" : ""}`}><path d="M4 6l4 4 4-4" /></svg>
                          </button>
                        </div>
                        {isExpanded && expandedContent && (
                          <div className="ml-8 mr-3 mb-2 p-3 rounded-lg bg-muted/30">
                            <pre className="text-[12px] text-foreground/80 whitespace-pre-wrap font-mono leading-relaxed max-h-96 overflow-y-auto">{expandedContent}</pre>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })()}

            {/* Entry count */}
            {entries.length > 0 && (
              <div className="text-[11px] text-muted-foreground pt-2 border-t border-border/50">
                {entries.length} {entries.length === 1 ? "entry" : "entries"}
                {searchQuery && ` matching "${searchQuery}"`}
                {currentPath && !searchQuery && ` at ${currentPath}/`}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

// ── Icons ──────────────────────────────────────────────────────

function GitHubIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="currentColor"
      className="text-muted-foreground"
    >
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12Z" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 4v8a1 1 0 001 1h10a1 1 0 001-1V6a1 1 0 00-1-1H8L6.5 3.5A1 1 0 005.8 3H3a1 1 0 00-1 1z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 2H4a1 1 0 00-1 1v10a1 1 0 001 1h8a1 1 0 001-1V6L9 2z" />
      <path d="M9 2v4h4" />
    </svg>
  );
}
