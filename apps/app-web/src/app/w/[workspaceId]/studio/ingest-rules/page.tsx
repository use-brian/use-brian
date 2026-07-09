"use client";

/**
 * Studio → Events — the ingestion control plane (app-web), master-detail.
 *
 * Mirrors Studio → Connectors' layout (docs/architecture/integrations/mcp.md
 * → "Unified connectors — the master-detail Studio surface"): a left rail
 * groups every ingest source by status — Needs attention / Ingesting /
 * Connected (not ingesting) / Available to connect — and the selected row's
 * management panel renders beside it (status, enable/disable, personal-source
 * notices, GitHub repository picker, routing-rule editor). Bucketing is the
 * pure helper `@/lib/ingest-rail-groups` ([COMP:app-web/ingest-rail-groups]).
 *
 * WhatsApp (BYO number) joins the rail as a page-level pseudo-row — it has no
 * `connector_instance` row in the generic sources list; the page fetches its
 * status itself and its panel hosts the seen-group enable list
 * (`WhatsappGroupManager`, [COMP:app-web/studio-whatsapp-ingest]). Pairing
 * stays on Studio → Channels.
 *
 * Enabling a source seeds DEFAULT_INGEST_RULES server-side; rules are edited
 * in place via `IngestRuleEditor`. "Available" rows link out to Studio →
 * Connectors to connect first.
 *
 * Backend: GET/POST/PUT /api/ingest/sources — packages/api/src/routes/ingest.ts.
 * Spec: docs/architecture/brain/ingest-pipeline.md → "Ingestion control plane".
 *
 * [COMP:app-web/studio-ingest]
 */

import { useState, useEffect, useCallback, useMemo, type ReactNode } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { authFetch } from "@/lib/auth-fetch";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import { WhatsappGroupManager } from "@/components/ingest/whatsapp-groups";
import { IngestRuleEditor, type EditableRule } from "@/components/ingest/rule-editor";
import { useWorkspaces } from "@/contexts/workspace-context";
import { ingestSourceNotice } from "@/lib/ingest-source-notice";
import {
  groupIngestRail,
  type IngestRailGroupId,
} from "@/lib/ingest-rail-groups";
import {
  getWhatsappIngest,
  type WhatsappIngestStatus,
} from "@/lib/api/whatsapp-ingest";
import { cn } from "@/lib/utils";
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
  /** Ownership scope — drives the detail header's scope badge. */
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

type RepoOption = {
  fullName: string;
  private: boolean;
  ownerLogin?: string | null;
  ownerType?: string | null;
};
type OrgOption = { login: string; repoCount: number };

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
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [checkedOrgs, setCheckedOrgs] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    setAvailable(null);
    setOrgs([]);
    setCheckedOrgs(new Set());
    setLoadError(false);
    setQuery("");
    authFetch(`${API_URL}/api/ingest/sources/${instanceId}/github/repos`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then(
        (data: {
          available: RepoOption[];
          selected: string[];
          orgs?: OrgOption[];
          selectedOrgs?: string[];
        }) => {
          if (cancelled) return;
          setAvailable(data.available);
          setChecked(new Set(data.selected));
          setOrgs(data.orgs ?? []);
          setCheckedOrgs(new Set(data.selectedOrgs ?? []));
        },
      )
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

  function toggleOrg(login: string) {
    setCheckedOrgs((prev) => {
      const next = new Set(prev);
      if (next.has(login)) next.delete(login);
      else next.add(login);
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
          body: JSON.stringify({ repos: [...checked], orgs: [...checkedOrgs] }),
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
    <div className="rounded-lg border border-border px-4 py-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-[13px] font-medium">{copy.title}</div>
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
            {orgs.length > 0 && (
              <div className="mb-3">
                <div className="text-[12px] font-medium mb-1.5">
                  {copy.orgsTitle}
                </div>
                <ul className="flex flex-col gap-0.5">
                  {orgs.map((org) => (
                    <li key={org.login}>
                      <label className="flex items-center gap-2 text-xs cursor-pointer py-0.5">
                        <input
                          type="checkbox"
                          checked={checkedOrgs.has(org.login)}
                          onChange={() => toggleOrg(org.login)}
                          className="accent-primary"
                        />
                        <span className="font-medium truncate">
                          {format(copy.orgAllRepos, { org: org.login })}
                        </span>
                        <span className="text-[10px] text-muted-foreground shrink-0">
                          {format(copy.orgRepoCount, { n: org.repoCount })}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
                <p className="text-[11px] text-muted-foreground mt-1.5">
                  {copy.orgNote}
                </p>
              </div>
            )}
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
                {filtered.map((repo) => {
                  // A repo whose owning org is selected is already covered —
                  // show it checked+disabled rather than as a separate pick.
                  const covered =
                    !!repo.ownerLogin && checkedOrgs.has(repo.ownerLogin);
                  return (
                    <li key={repo.fullName}>
                      <label
                        className={`flex items-center gap-2 text-xs py-0.5 ${covered ? "opacity-50 cursor-default" : "cursor-pointer"}`}
                      >
                        <input
                          type="checkbox"
                          checked={covered || checked.has(repo.fullName)}
                          disabled={covered}
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
                        {covered && (
                          <span className="text-[10px] uppercase tracking-wide text-muted-foreground bg-muted px-1 py-0.5 rounded shrink-0">
                            {copy.orgCoveredBadge}
                          </span>
                        )}
                      </label>
                    </li>
                  );
                })}
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

/** Amber inline banner — broken-connection notices in the detail panel. */
function AttentionBanner({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-600 dark:text-amber-400">
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="shrink-0 mt-0.5"
      >
        <path d="M8 5v3m0 2.5v.5" strokeLinecap="round" />
        <circle cx="8" cy="8" r="6.5" />
      </svg>
      <div className="min-w-0">{children}</div>
    </div>
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
  const channelsHref = `/w/${workspaceId}/studio/channels`;

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
  // WhatsApp ingest is a bespoke source (group toggles, not generic rules) with
  // no row in the generic sources list. The page fetches its status itself to
  // place it in the rail; null = never paired (no row) or still loading.
  const [waStatus, setWaStatus] = useState<WhatsappIngestStatus | null>(null);
  // Master-detail selection — a rail row key (instance UUID, "whatsapp", or
  // `available:<provider>`); null / stale keys resolve to the first rail row.
  const [selected, setSelected] = useState<string | null>(null);

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

  useEffect(() => {
    if (!workspaceId) return;
    getWhatsappIngest(workspaceId)
      .then(setWaStatus)
      .catch(() => setWaStatus(null));
  }, [workspaceId]);

  async function handleToggle(s: IngestSource) {
    setBusyId(s.instanceId);
    setToggleError(null);
    const action = s.ingestionEnabled ? "disable" : "enable";
    try {
      // The active workspace is the ingest target: a personal connector exposed
      // here routes its episodes to THIS workspace (exposed-connector ingestion).
      const res = await authFetch(
        `${API_URL}/api/ingest/sources/${s.instanceId}/${action}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId: activeId }),
        },
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

  // ── Rail bucketing + selection resolution ─────────────────────
  //
  // A WhatsApp integration exists once a number has ever been paired
  // (connected now, or revoked but still on file). Never-connected
  // workspaces get no row.
  const waPresent =
    waStatus !== null && (waStatus.connected || waStatus.connectedNumber !== null);
  const waEnabledGroups = waStatus?.groups.filter((g) => g.enabled).length ?? 0;

  const list = sources ?? [];
  const railGroups = groupIngestRail({
    sources: list,
    available,
    whatsapp:
      waPresent && waStatus
        ? { connected: waStatus.connected, enabledGroups: waEnabledGroups }
        : null,
  });
  const groupLabels: Record<IngestRailGroupId, string> = {
    attention: copy.sectionAttention,
    ingesting: copy.sectionIngesting,
    off: copy.sectionConnected,
    available: copy.sectionAvailable,
  };
  const railOrder = railGroups.flatMap((g) => g.rows);
  const sel = railOrder.find((r) => r.key === selected) ?? railOrder[0] ?? null;
  const selKey = sel?.key ?? null;

  // ── Detail panels ─────────────────────────────────────────────

  const pillCls = (tone: "on" | "off" | "attention") =>
    cn(
      "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
      tone === "attention"
        ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
        : tone === "on"
          ? "bg-primary/10 text-primary"
          : "bg-muted text-muted-foreground",
    );

  const scopeBadgeCls =
    "shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground";

  function renderSourceDetail(s: IngestSource) {
    const busy = busyId === s.instanceId;
    const showPicker = pickerId === s.instanceId && s.provider === "github";
    const notice = ingestSourceNotice(s.scope, ownedPersonal);
    return (
      <div key={s.instanceId} className="space-y-4">
        {/* Header — icon, name + scope badge, account/nature line, status pill. */}
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
            <ConnectorIcon connectorId={s.provider} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <h2 className="truncate text-[15px] font-semibold tracking-tight">
                {s.label}
              </h2>
              <span className={scopeBadgeCls}>
                {s.scope === "workspace"
                  ? (s.workspaceName ?? copy.scopeWorkspace)
                  : copy.scopePersonal}
              </span>
            </div>
            <p className="truncate text-[12px] text-muted-foreground">
              {s.connectedEmail
                ? `${s.connectedEmail} · ${natureLabel(s.nature)}`
                : natureLabel(s.nature)}
            </p>
          </div>
          <span
            className={pillCls(
              !s.connected ? "attention" : s.ingestionEnabled ? "on" : "off",
            )}
          >
            {!s.connected
              ? copy.sectionAttention
              : s.ingestionEnabled
                ? copy.statusOn
                : copy.statusOff}
          </span>
        </div>

        {/* Broken connection — reconnect lives on the Connectors page. */}
        {!s.connected && (
          <AttentionBanner>
            <div>{copy.reconnectNote}</div>
            <Link
              href={connectorsHref}
              className="mt-1 inline-block font-medium underline underline-offset-2 hover:opacity-80"
            >
              {copy.emptyCta}
            </Link>
          </AttentionBanner>
        )}

        {/* Personal (scope='user') sources are account-level. The API only
            returns them when this page IS the caller's owned personal
            workspace (placement rule), so normally just the global-toggle
            note renders; the routing warning stays as a defensive branch for
            a stale client against an older API.
            `ingest-source-notice.ts` / docs ingest-pipeline.md. */}
        {(notice.globalToggle || notice.routesToPersonal) && (
          <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-[12px] leading-relaxed text-muted-foreground">
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
        )}

        {/* Actions — enable/disable, plus the GitHub repo-picker toggle. */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => handleToggle(s)}
            disabled={busy || !s.connected}
            className={cn(
              "text-xs font-medium px-3 py-1 rounded-lg shrink-0 transition-colors disabled:opacity-40",
              s.ingestionEnabled
                ? "border border-border text-muted-foreground hover:text-destructive hover:border-destructive/30"
                : "bg-primary text-primary-foreground hover:bg-primary/90",
            )}
          >
            {busy
              ? copy.working
              : s.ingestionEnabled
                ? copy.disableAction
                : copy.enableAction}
          </button>
          {s.provider === "github" && s.connected && (
            <button
              onClick={() =>
                setPickerId((prev) =>
                  prev === s.instanceId ? null : s.instanceId,
                )
              }
              className={cn(
                "text-xs font-medium px-3 py-1 rounded-lg shrink-0 border transition-colors",
                showPicker
                  ? "border-primary/40 text-primary bg-primary/5"
                  : "border-border text-muted-foreground hover:bg-muted",
              )}
            >
              {copy.repos.action}
            </button>
          )}
        </div>

        {showPicker && (
          <GithubRepoPicker instanceId={s.instanceId} copy={copy.repos} />
        )}

        {/* Routing rules — a plain section label; each rule is its own
            standalone card (RuleCard), not rows nested inside one card. */}
        {s.connected && (
          <div className="space-y-2">
            <div className="text-[13px] font-medium">{copy.rulesTitle}</div>
            <IngestRuleEditor
              instanceId={s.instanceId}
              source={s.source}
              rules={s.rules}
              onChange={(next) => {
                setSources(
                  (prev) =>
                    prev?.map((x) =>
                      x.instanceId === s.instanceId ? { ...x, rules: next } : x,
                    ) ?? null,
                );
              }}
            />
          </div>
        )}
      </div>
    );
  }

  function renderWhatsappDetail() {
    if (!waStatus) return null;
    const wa = copy.whatsapp;
    return (
      <div key="whatsapp" className="space-y-4">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
            <ConnectorIcon connectorId="whatsapp" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <h2 className="truncate text-[15px] font-semibold tracking-tight">
                {wa.sourceLabel}
              </h2>
              <span className={scopeBadgeCls}>{wa.readOnlyBadge}</span>
              <span className={scopeBadgeCls}>{copy.scopeWorkspace}</span>
            </div>
            <p className="truncate text-[12px] text-muted-foreground">
              {waStatus.connectedNumber ?? copy.natureEvents}
            </p>
          </div>
          <span
            className={pillCls(
              !waStatus.connected
                ? "attention"
                : waEnabledGroups > 0
                  ? "on"
                  : "off",
            )}
          >
            {!waStatus.connected
              ? copy.sectionAttention
              : waEnabledGroups > 0
                ? copy.statusOn
                : copy.statusOff}
          </span>
        </div>

        {/* Device logged out — pairing lives on the Channels card. */}
        {!waStatus.connected ? (
          <AttentionBanner>
            <div>{wa.reconnectInChannels}</div>
            <Link
              href={channelsHref}
              className="mt-1 inline-block font-medium underline underline-offset-2 hover:opacity-80"
            >
              {wa.reconnectInChannelsCta}
            </Link>
          </AttentionBanner>
        ) : (
          <div className="rounded-lg border border-border px-4 py-3">
            <WhatsappGroupManager workspaceId={workspaceId} />
          </div>
        )}
      </div>
    );
  }

  function renderAvailableDetail(a: AvailableProvider) {
    return (
      <div key={`available:${a.provider}`} className="space-y-4">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
            <ConnectorIcon connectorId={a.provider} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[15px] font-semibold tracking-tight">
              {a.name}
            </h2>
            <p className="truncate text-[12px] text-muted-foreground">
              {natureLabel(a.nature)}
            </p>
          </div>
          <span className={pillCls("off")}>{copy.availablePill}</span>
        </div>
        <div className="rounded-lg border border-border px-4 py-3">
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            {copy.availableNote}
          </p>
          <Link
            href={connectorsHref}
            className="mt-2 inline-block rounded-lg bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            {copy.connectAction}
          </Link>
        </div>
      </div>
    );
  }

  // ── Rail row presentation ─────────────────────────────────────

  function railRowButton(row: (typeof railOrder)[number]) {
    const isSel = selKey === row.key;
    let iconId: string;
    let label: string;
    let subtitle: string | null = null;
    let dot: "on" | "attention" | null = null;
    if (row.kind === "source") {
      const s = row.source;
      iconId = s.provider;
      label = s.label;
      subtitle = s.connectedEmail;
      dot = !s.connected ? "attention" : s.ingestionEnabled ? "on" : null;
    } else if (row.kind === "whatsapp") {
      iconId = "whatsapp";
      label = copy.whatsapp.sourceLabel;
      subtitle = waStatus?.connectedNumber ?? null;
      dot =
        waStatus && !waStatus.connected
          ? "attention"
          : waEnabledGroups > 0
            ? "on"
            : null;
    } else {
      iconId = row.provider.provider;
      label = row.provider.name;
    }
    return (
      <li key={row.key}>
        <button
          type="button"
          onClick={() => setSelected(row.key)}
          aria-current={isSel ? "true" : undefined}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
            isSel
              ? "bg-muted font-medium text-foreground"
              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
          )}
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted">
            <ConnectorIcon connectorId={iconId} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate">{label}</span>
            {subtitle && (
              <span className="block truncate text-[11px] font-normal text-muted-foreground">
                {subtitle}
              </span>
            )}
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

      {sources === null ? (
        <div className="text-sm text-muted-foreground py-10 text-center">
          {copy.loading}
        </div>
      ) : loadError ? (
        <div className="text-sm text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-3 text-center">
          {copy.loadError}
        </div>
      ) : railOrder.length === 0 ? (
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
        /* ── Master-detail: status-grouped rail + selected source panel ── */
        <div className="flex flex-col gap-6 md:flex-row">
          <aside className="w-full md:w-64 shrink-0 self-start">
            <nav aria-label={copy.railAriaLabel} className="flex flex-col gap-3">
              {railGroups.map((g) => (
                <div key={g.id}>
                  <div className="flex items-center gap-1.5 px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {groupLabels[g.id]}
                    <span className="font-normal text-muted-foreground/50">
                      {g.rows.length}
                    </span>
                  </div>
                  <ul className="flex flex-col gap-0.5">
                    {g.rows.map(railRowButton)}
                  </ul>
                </div>
              ))}
            </nav>
          </aside>

          {/* Detail — the selected source's management panel. */}
          <div className="min-w-0 flex-1">
            {!sel ? (
              <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
                {copy.selectPrompt}
              </div>
            ) : sel.kind === "source" ? (
              renderSourceDetail(sel.source)
            ) : sel.kind === "whatsapp" ? (
              renderWhatsappDetail()
            ) : (
              renderAvailableDetail(sel.provider)
            )}
          </div>
        </div>
      )}
    </div>
  );
}
