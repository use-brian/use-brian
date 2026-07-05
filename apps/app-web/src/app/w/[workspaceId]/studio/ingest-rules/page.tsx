"use client";

/**
 * Studio → Ingestion control plane (app-web).
 *
 * Ported from `apps/web/src/app/(app)/studio/ingest-rules/page.tsx` for the
 * app consolidation (docs/plans/doc-web-app-consolidation.md §9 #5,
 * CHUNK 4). Rendered inside the Studio full-page layout, NOT the doc
 * three-column page shell.
 *
 * Lists the active workspace's ingest-capable connectors, grouped by status —
 * Needs attention / Ingesting / Connected / Available — and lets the user
 * enable/disable ingestion per connector. Enabling seeds DEFAULT_INGEST_RULES
 * server-side; the rules are surfaced read-only. GitHub sources additionally
 * expose a repository picker. The "Available" section lists ingest-capable
 * providers not yet connected and links out to Studio ▸ Connectors to connect
 * them.
 *
 * app-web deltas vs apps/web:
 *   - `activeId` comes from the app-web `useWorkspaces()` adapter.
 *   - Cross-links to Connectors are workspace-scoped
 *     (`/w/[workspaceId]/studio/connectors`).
 *
 * Backend: GET/POST/PUT /api/ingest/sources — packages/api/src/routes/ingest.ts.
 * Spec: docs/plans/company-brain/ingest.md → "Ingestion control plane".
 *
 * [COMP:app-web/studio-ingest]
 */

import { useState, useEffect, useCallback, useMemo, type ReactNode } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { authFetch } from "@/lib/auth-fetch";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import { WhatsappEventSource } from "@/components/ingest/whatsapp-groups";
import { IngestRuleEditor, type EditableRule } from "@/components/ingest/rule-editor";
import { useWorkspaces } from "@/contexts/workspace-context";
import { ingestSourceNotice } from "@/lib/ingest-source-notice";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

type IngestRule = EditableRule;

/** Signal-density profile — noisy → event-rich → high-signal. */
type IngestNature = "noisy" | "events" | "signal";

type IngestSource = {
  instanceId: string;
  provider: string;
  /** Ingest engine source key (`slack` / `github` / `calendar` / `fathom`). */
  source: string;
  /** Ownership scope — drives the per-row scope badge. */
  scope: "user" | "workspace";
  /** Owning workspace's name for workspace-scoped sources; null for user-scoped. */
  workspaceName: string | null;
  label: string;
  connectedEmail: string | null;
  connected: boolean;
  ingestionEnabled: boolean;
  nature: IngestNature;
  rules: IngestRule[];
};

/** An ingest-capable provider this workspace has not connected yet. */
type AvailableProvider = {
  provider: string;
  source: string;
  name: string;
  nature: IngestNature;
};

type RepoOption = { fullName: string; private: boolean };

type ReposCopy = ReturnType<typeof useT>["studioPage"]["ingestRules"]["repos"];

// ── GitHub repository picker ──────────────────────────────────
//
// The poller polls `config.repos` when set, else the PAT owner's top-30
// recently-pushed repos. This panel edits that set; saving an empty
// selection reverts to the automatic default.

function GithubRepoPicker({
  instanceId,
  copy,
}: {
  instanceId: string;
  copy: ReposCopy;
}) {
  const [available, setAvailable] = useState<RepoOption[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    setAvailable(null);
    setLoadError(false);
    setQuery("");
    authFetch(`${API_URL}/api/ingest/sources/${instanceId}/github/repos`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then((data: { available: RepoOption[]; selected: string[] }) => {
        if (cancelled) return;
        setAvailable(data.available);
        setChecked(new Set(data.selected));
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [instanceId]);

  const filtered = useMemo(() => {
    if (!available) return null;
    const q = query.trim().toLowerCase();
    if (!q) return available;
    return available.filter((r) => r.fullName.toLowerCase().includes(q));
  }, [available, query]);

  function toggle(fullName: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(fullName)) next.delete(fullName);
      else next.add(fullName);
      return next;
    });
    setSaved(false);
  }

  // True when every filtered repo is already selected — flips the bulk
  // button between "select all (filtered)" and "deselect all (filtered)".
  const allFilteredSelected =
    !!filtered && filtered.length > 0 && filtered.every((r) => checked.has(r.fullName));

  function toggleAllFiltered() {
    if (!filtered || filtered.length === 0) return;
    setChecked((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const r of filtered) next.delete(r.fullName);
      } else {
        for (const r of filtered) next.add(r.fullName);
      }
      return next;
    });
    setSaved(false);
  }

  async function save() {
    setSaving(true);
    setSaveError(false);
    try {
      const res = await authFetch(
        `${API_URL}/api/ingest/sources/${instanceId}/github/repos`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repos: [...checked] }),
        },
      );
      if (!res.ok) throw new Error();
      setSaved(true);
    } catch {
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border-t border-border bg-muted/20 px-5 py-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {copy.title}
        </div>
        {checked.size > 0 && (
          <div className="text-[11px] text-muted-foreground">
            {format(copy.selectedCount, { n: checked.size })}
          </div>
        )}
      </div>
      {available === null && !loadError ? (
        <div className="text-xs text-muted-foreground py-2">{copy.loading}</div>
      ) : loadError ? (
        <div className="text-xs text-destructive py-2">{copy.loadError}</div>
      ) : available && available.length === 0 ? (
        <div className="text-xs text-muted-foreground py-2">{copy.empty}</div>
      ) : (
        available &&
        filtered && (
          <>
            <div className="flex items-center gap-2 mb-2">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={copy.searchPlaceholder}
                className="flex-1 min-w-0 text-xs bg-background border border-border rounded-md px-2.5 py-1.5 placeholder:text-muted-foreground/70 focus:outline-none focus:ring-1 focus:ring-primary/40 focus:border-primary/40"
              />
              {filtered.length > 0 && (
                <button
                  type="button"
                  onClick={toggleAllFiltered}
                  className="text-xs font-medium border border-border px-2.5 py-1.5 rounded-md shrink-0 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                >
                  {allFilteredSelected ? copy.deselectAll : copy.selectAll}
                </button>
              )}
            </div>
            {filtered.length === 0 ? (
              <div className="text-xs text-muted-foreground py-2">
                {copy.noMatches}
              </div>
            ) : (
              <ul className="flex flex-col gap-0.5 max-h-64 overflow-y-auto">
                {filtered.map((repo) => (
                  <li key={repo.fullName}>
                    <label className="flex items-center gap-2 text-xs cursor-pointer py-0.5">
                      <input
                        type="checkbox"
                        checked={checked.has(repo.fullName)}
                        onChange={() => toggle(repo.fullName)}
                        className="accent-primary"
                      />
                      <span className="font-medium truncate">
                        {repo.fullName}
                      </span>
                      {repo.private && (
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground bg-muted px-1 py-0.5 rounded shrink-0">
                          {copy.privateBadge}
                        </span>
                      )}
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[11px] text-muted-foreground mt-2">
              {copy.defaultNote}
            </p>
            <div className="flex items-center gap-2 mt-2">
              <button
                onClick={save}
                disabled={saving}
                className="relative text-xs font-medium bg-primary text-primary-foreground px-3 py-1 rounded-lg hover:bg-primary/90 disabled:opacity-60 transition-colors"
              >
                <span className={saving ? "invisible" : undefined}>
                  {copy.save}
                </span>
                {saving && (
                  <span className="absolute inset-0 flex items-center justify-center">
                    {copy.saving}
                  </span>
                )}
              </button>
              {saved && (
                <span className="text-[11px] text-primary">{copy.saved}</span>
              )}
              {saveError && (
                <span className="text-[11px] text-destructive">
                  {copy.saveError}
                </span>
              )}
            </div>
          </>
        )
      )}
    </div>
  );
}

// ── Status section wrapper ────────────────────────────────────
//
// Each section is one status bucket — empty buckets are not rendered, so
// the page only ever shows sections that have something in them.

function IngestSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
        {title}
        <span className="font-normal text-muted-foreground/50">{count}</span>
      </h2>
      <ul className="flex flex-col gap-3">{children}</ul>
    </section>
  );
}

export default function StudioIngestRulesPage() {
  const t = useT();
  const copy = t.studioPage.ingestRules;
  const { activeId, active } = useWorkspaces();
  const activeName = active?.name ?? copy.scopeWorkspace;
  const params = useParams<{ workspaceId: string }>();
  const workspaceId = params?.workspaceId ?? "";
  const connectorsHref = `/w/${workspaceId}/studio/connectors`;

  const [sources, setSources] = useState<IngestSource[] | null>(null);
  const [available, setAvailable] = useState<AvailableProvider[]>([]);
  // Whether the active workspace is the caller's OWNED personal workspace —
  // the API's `ownedPersonal`, the only placement truth the notices may use.
  // Never derive this from the workspace's bare `isPersonal` flag: a legacy
  // personal-flagged team workspace is not the viewer's personal workspace.
  const [ownedPersonal, setOwnedPersonal] = useState<boolean | undefined>(undefined);
  const [loadError, setLoadError] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [pickerId, setPickerId] = useState<string | null>(null);
  // WhatsApp ingest is a bespoke source (group toggles, not generic rules) and
  // self-hides when the workspace has no WhatsApp number. Track its presence so
  // the generic "no sources" empty state doesn't show alongside it.
  const [waPresent, setWaPresent] = useState(false);

  const fetchSources = useCallback(() => {
    // The list is workspace-scoped server-side — don't fetch until the
    // active workspace is known, and refetch whenever it changes so a
    // workspace switch never leaves another workspace's connectors shown.
    if (!activeId) return;
    setLoadError(false);
    authFetch(
      `${API_URL}/api/ingest/sources?workspaceId=${encodeURIComponent(activeId)}`,
    )
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then(
        (data: {
          sources: IngestSource[];
          available: AvailableProvider[];
          ownedPersonal?: boolean;
        }) => {
          setSources(data.sources);
          setAvailable(data.available ?? []);
          setOwnedPersonal(
            typeof data.ownedPersonal === "boolean" ? data.ownedPersonal : undefined,
          );
        },
      )
      .catch(() => {
        setSources([]);
        setAvailable([]);
        setOwnedPersonal(undefined);
        setLoadError(true);
      });
  }, [activeId]);

  useEffect(() => {
    fetchSources();
  }, [fetchSources]);

  async function handleToggle(s: IngestSource) {
    setBusyId(s.instanceId);
    setToggleError(null);
    const action = s.ingestionEnabled ? "disable" : "enable";
    try {
      const res = await authFetch(
        `${API_URL}/api/ingest/sources/${s.instanceId}/${action}`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { source: IngestSource };
      setSources(
        (prev) =>
          prev?.map((x) => (x.instanceId === s.instanceId ? data.source : x)) ??
          null,
      );
    } catch {
      setToggleError(copy.toggleError);
    } finally {
      setBusyId(null);
    }
  }

  const natureLabel = (nature: IngestNature): string =>
    nature === "noisy"
      ? copy.natureNoisy
      : nature === "signal"
        ? copy.natureSignal
        : copy.natureEvents;

  // One connector row — reused across the Needs attention / Ingesting /
  // Connected sections (the status grouping happens in the render below).
  function renderSource(s: IngestSource) {
    const busy = busyId === s.instanceId;
    const showPicker = pickerId === s.instanceId && s.provider === "github";
    return (
      <li
        key={s.instanceId}
        className="border border-border rounded-xl bg-card overflow-hidden"
      >
        <div className="flex items-center gap-3 px-5 py-4">
          <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center shrink-0">
            <ConnectorIcon connectorId={s.provider} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium truncate">{s.label}</span>
              <span className="text-[10px] font-medium bg-muted text-muted-foreground px-1.5 py-0.5 rounded shrink-0">
                {s.scope === "workspace"
                  ? (s.workspaceName ?? copy.scopeWorkspace)
                  : copy.scopePersonal}
              </span>
            </div>
            <div className="text-[11px] text-muted-foreground truncate">
              {s.connectedEmail
                ? `${s.connectedEmail} · ${natureLabel(s.nature)}`
                : natureLabel(s.nature)}
            </div>
          </div>
          <span
            className={`text-xs font-medium px-2 py-0.5 rounded-full shrink-0 ${
              s.ingestionEnabled
                ? "text-primary bg-primary/10"
                : "text-muted-foreground bg-muted"
            }`}
          >
            {s.ingestionEnabled ? copy.statusOn : copy.statusOff}
          </span>
          {s.provider === "github" && s.connected && (
            <button
              onClick={() =>
                setPickerId((prev) =>
                  prev === s.instanceId ? null : s.instanceId,
                )
              }
              className={`text-xs font-medium px-3 py-1.5 rounded-lg shrink-0 border transition-colors ${
                showPicker
                  ? "border-primary/40 text-primary bg-primary/5"
                  : "border-border text-muted-foreground hover:bg-muted"
              }`}
            >
              {copy.repos.action}
            </button>
          )}
          <button
            onClick={() => handleToggle(s)}
            disabled={busy || !s.connected}
            className={`text-xs font-medium px-3 py-1.5 rounded-lg shrink-0 transition-colors disabled:opacity-40 ${
              s.ingestionEnabled
                ? "border border-border text-muted-foreground hover:text-destructive hover:border-destructive/30"
                : "bg-primary text-primary-foreground hover:bg-primary/90"
            }`}
          >
            {busy
              ? copy.working
              : s.ingestionEnabled
                ? copy.disableAction
                : copy.enableAction}
          </button>
        </div>

        {!s.connected && (
          <div className="px-5 pb-3 text-[11px] text-amber-600 dark:text-amber-400">
            {copy.reconnectNote}
          </div>
        )}

        {/* Personal (scope='user') sources are account-level. The API only
            returns them when this page IS the caller's owned personal
            workspace (placement rule), so normally just the global-toggle
            note renders; the routing warning stays as a defensive branch for
            a stale client against an older API.
            `ingest-source-notice.ts` / docs ingest-pipeline.md. */}
        {(() => {
          const notice = ingestSourceNotice(s.scope, ownedPersonal);
          if (!notice.globalToggle && !notice.routesToPersonal) return null;
          return (
            <div className="px-5 pb-3 text-[11px] text-muted-foreground leading-relaxed">
              {notice.routesToPersonal && (
                <p>
                  {format(copy.personalRoutingNote, { workspace: activeName })}{" "}
                  <Link
                    href={connectorsHref}
                    className="font-medium text-primary hover:underline"
                  >
                    {format(copy.personalAddSourceCta, { workspace: activeName })}
                  </Link>
                </p>
              )}
              {notice.globalToggle && <p>{copy.personalGlobalNote}</p>}
            </div>
          );
        })()}

        {showPicker && (
          <GithubRepoPicker instanceId={s.instanceId} copy={copy.repos} />
        )}

        {s.connected && (
          <div className="border-t border-border bg-muted/20 px-5 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">
              {copy.rulesTitle}
            </div>
            <IngestRuleEditor
              instanceId={s.instanceId}
              source={s.source}
              rules={s.rules}
              onChange={(next) => {
                setSources((prev) =>
                  prev?.map((x) =>
                    x.instanceId === s.instanceId ? { ...x, rules: next } : x,
                  ) ?? null,
                );
              }}
            />
          </div>
        )}
      </li>
    );
  }

  // One "available to connect" row — a provider with no instance yet.
  function renderAvailable(a: AvailableProvider) {
    return (
      <li
        key={a.provider}
        className="border border-border rounded-xl bg-card flex items-center gap-3 px-5 py-4"
      >
        <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center shrink-0">
          <ConnectorIcon connectorId={a.provider} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate">{a.name}</div>
          <div className="text-[11px] text-muted-foreground truncate">
            {natureLabel(a.nature)}
          </div>
        </div>
        <Link
          href={connectorsHref}
          className="text-xs font-medium border border-border px-3 py-1.5 rounded-lg shrink-0 text-muted-foreground hover:bg-muted transition-colors"
        >
          {copy.connectAction}
        </Link>
      </li>
    );
  }

  // Status buckets — a source is in exactly one. `!connected` means the
  // connection is broken (creds missing/revoked) and needs a reconnect.
  const list = sources ?? [];
  const attention = list.filter((s) => !s.connected);
  const ingesting = list.filter((s) => s.connected && s.ingestionEnabled);
  const off = list.filter((s) => s.connected && !s.ingestionEnabled);

  return (
    <div className="flex flex-col gap-6">
      {/* Intro row — the topbar breadcrumb names the section
          (docs/architecture/features/studio.md → "Page headers"). */}
      <header>
        <p className="text-[13px] text-muted-foreground max-w-prose">
          {t.studioPage.sectionDescriptions.ingestRules}
        </p>
      </header>

      <section className="border border-dashed border-border rounded-md bg-muted/30 p-4 text-xs text-muted-foreground leading-relaxed">
        {copy.statusNote}
      </section>

      {toggleError && (
        <div className="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
          {toggleError}
        </div>
      )}

      {/* WhatsApp ingest source — bespoke card (group toggles), self-hides when
          the workspace has no WhatsApp number. Always mounted so it can report
          presence regardless of the generic sources' load state. */}
      <WhatsappEventSource workspaceId={workspaceId} onPresence={setWaPresent} />

      {sources === null ? (
        <div className="text-sm text-muted-foreground py-10 text-center">
          {copy.loading}
        </div>
      ) : loadError ? (
        <div className="text-sm text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-3 text-center">
          {copy.loadError}
        </div>
      ) : sources.length === 0 && available.length === 0 && !waPresent ? (
        <section className="border border-border rounded-xl bg-card/50 p-8 flex flex-col items-center gap-2 text-center">
          <div className="font-medium text-sm">{copy.emptyTitle}</div>
          <p className="text-sm text-muted-foreground max-w-sm">
            {copy.emptyBody}
          </p>
          <Link
            href={connectorsHref}
            className="mt-2 text-sm font-medium bg-primary text-primary-foreground px-4 py-2 rounded-lg hover:bg-primary/90 transition-colors"
          >
            {copy.emptyCta}
          </Link>
        </section>
      ) : (
        <div className="flex flex-col gap-6">
          {attention.length > 0 && (
            <IngestSection
              title={copy.sectionAttention}
              count={attention.length}
            >
              {attention.map(renderSource)}
            </IngestSection>
          )}
          {ingesting.length > 0 && (
            <IngestSection
              title={copy.sectionIngesting}
              count={ingesting.length}
            >
              {ingesting.map(renderSource)}
            </IngestSection>
          )}
          {off.length > 0 && (
            <IngestSection title={copy.sectionConnected} count={off.length}>
              {off.map(renderSource)}
            </IngestSection>
          )}
          {available.length > 0 && (
            <IngestSection
              title={copy.sectionAvailable}
              count={available.length}
            >
              {available.map(renderAvailable)}
            </IngestSection>
          )}
        </div>
      )}
    </div>
  );
}
