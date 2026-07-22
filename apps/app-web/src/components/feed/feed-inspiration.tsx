"use client";

/**
 * Per-platform inspiration feed — ported faithfully from
 * `apps/feed-web/src/app/w/[workspaceId]/[platform]/inspiration/page.tsx`
 * (docs/plans/feed-web-consolidation.md §7.5): keyword-scan candidates
 * worth replying to / quoting, the on-demand scan trigger, the shared
 * keywords + result-count config modal, and the per-candidate
 * "Draft reply" / "Draft inspired post" seeds into a new draft session.
 *
 * Port deltas (disposition rules §6):
 *   - `useWorkspaceContext()` → `useFeedWorkspace()`; inline `authFetch`
 *     RPCs → the feed SDK inspiration wrappers (`fetchFeedInspiration` /
 *     `saveFeedInspirationConfig` / `runFeedInspirationScan`) +
 *     `createFeedDraftSession` for the candidate seeds.
 *   - hrefs via `feedPath()`: the X reconnect warning links to
 *     `/feed/twitter/settings`; the `!profile` connect-first state links
 *     to the feed home (connect onboarding lives there), not feed-web's
 *     `/onboarding`; the created session opens under
 *     `/feed/[platform]/draft-sessions/:id`.
 *   - All copy via `useT().feedPage` (`inspiration` + shared
 *     `platformLabels` / `draftSessions.connectFirst*` / `home.time*` keys).
 *   - The config overlay stays feed-web's custom Escape/backdrop modal
 *     (not a native dialog); the result-count slider stays a native
 *     `<input type="range">` — neither is on the banned-primitives list.
 *
 * [COMP:app-web/feed-inspiration]
 */

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useFeedWorkspace } from "@/contexts/feed-profiles-context";
import {
  createFeedDraftSession,
  fetchFeedInspiration,
  runFeedInspirationScan,
  saveFeedInspirationConfig,
  type FeedDraftSessionSeed,
  type FeedInspirationCandidate,
  type FeedInspirationConfig,
  type FeedInspirationConnection,
  type FeedInspirationScanWarning,
} from "@/lib/api/feed";
import { feedPath, type FeedPlatform } from "@/lib/feed-nav";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";

type FeedPageDict = ReturnType<typeof useT>["feedPage"];
type InspirationDict = FeedPageDict["inspiration"];

const DEFAULT_CONFIG: FeedInspirationConfig = { keywords: [], resultCount: 5 };

/**
 * The `{ ...DEFAULT_CONFIG, ...body.config }` normalisation feed-web
 * applied to every config the server returns — missing fields fall back
 * to the defaults and a missing keyword list becomes `[]`.
 */
// exported for tests
export function normalizeInspirationConfig(
  raw: FeedInspirationConfig | undefined,
): FeedInspirationConfig {
  return { ...DEFAULT_CONFIG, ...raw, keywords: raw?.keywords ?? [] };
}

/**
 * The keyword-add rule: trim, cap at 100 chars, reject empties,
 * duplicates, and a list already at 20. Returns the next list, or null
 * when the input is rejected (the form leaves the input untouched).
 */
// exported for tests
export function applyAddKeyword(
  keywords: string[],
  raw: string,
): string[] | null {
  const kw = raw.trim().slice(0, 100);
  if (!kw || keywords.includes(kw) || keywords.length >= 20) return null;
  return [...keywords, kw];
}

/** Map a scan candidate onto the draft-session seed the backend parses. */
// exported for tests
export function buildInspirationSeed(
  kind: "inspiration-reply" | "inspiration-original",
  platform: FeedPlatform,
  candidate: Pick<FeedInspirationCandidate, "externalId" | "text" | "author">,
): FeedDraftSessionSeed {
  return {
    kind,
    candidate: {
      platform,
      externalId: candidate.externalId,
      text: candidate.text,
      authorHandle: candidate.author.handle,
    },
  };
}

// ── Main dispatcher ─────────────────────────────────────────────

export function FeedInspiration() {
  const params = useParams<{ platform: string }>();
  // The /feed/[platform] guard layout 404s junk platforms before this
  // renders, so the segment is always a known platform here.
  const platform = params.platform as FeedPlatform;
  if (platform === "threads") return <ThreadsInspirationPage />;
  return <TwitterInspirationPage />;
}

// ── Shared page skeleton ─────────────────────────────────────────

type InspirationPageProps = {
  platform: FeedPlatform;
  assistantId: string;
  workspaceId: string;
  canEdit: boolean;
  renderConnectionWarning?: (config: FeedInspirationConfig) => React.ReactNode;
};

function InspirationPageLayout({
  platform,
  assistantId,
  workspaceId,
  canEdit,
  renderConnectionWarning,
}: InspirationPageProps) {
  const t = useT().feedPage;
  const td = t.inspiration;
  const platformLabel = t.platformLabels[platform];

  const [candidates, setCandidates] = useState<FeedInspirationCandidate[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanWarnings, setScanWarnings] = useState<FeedInspirationScanWarning[]>(
    [],
  );
  const [lastScanAt, setLastScanAt] = useState<number | null>(null);

  const [showConfig, setShowConfig] = useState(false);
  const [config, setConfig] = useState<FeedInspirationConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configSaving, setConfigSaving] = useState(false);
  const [configSavedAt, setConfigSavedAt] = useState<number | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const body = await fetchFeedInspiration(assistantId, platform);
        if (!cancelled) setConfig(normalizeInspirationConfig(body.config));
      } catch {
        if (!cancelled) setConfigError(td.configLoadFailed);
      } finally {
        if (!cancelled) setConfigLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistantId, platform]);

  async function runScan() {
    if (scanning) return;
    setScanning(true);
    setScanError(null);
    setScanWarnings([]);
    try {
      const result = await runFeedInspirationScan(assistantId, platform);
      if (!result.ok) {
        throw new Error(result.error ?? td.scanFailed);
      }
      setCandidates(result.candidates);
      setScanWarnings(result.warnings);
      setLastScanAt(Date.now());
    } catch (err) {
      setScanError(err instanceof Error ? err.message : td.scanFailed);
    } finally {
      setScanning(false);
    }
  }

  async function saveConfig(next: FeedInspirationConfig) {
    setConfigSaving(true);
    setConfigError(null);
    setConfigSavedAt(null);
    try {
      const saved = await saveFeedInspirationConfig(assistantId, platform, next);
      setConfig(normalizeInspirationConfig(saved));
      setConfigSavedAt(Date.now());
    } catch {
      setConfigError(td.saveFailed);
    } finally {
      setConfigSaving(false);
    }
  }

  const noKeywords = (config?.keywords?.length ?? 0) === 0;

  return (
    <div className="px-4 md:px-6 py-5 max-w-7xl mx-auto space-y-5">
      <header className="flex items-start sm:items-center justify-between gap-4 flex-wrap">
        <div className="space-y-1.5">
          <h1
            className="text-[15px] font-semibold"          >
            {format(td.heading, { platform: platformLabel })}
          </h1>
          <p className="text-xs text-muted-foreground">
            {lastScanAt
              ? format(
                  candidates.length === 1 ? td.lastScannedOne : td.lastScanned,
                  {
                    time: timeAgo(t.home, lastScanAt),
                    count: candidates.length,
                  },
                )
              : noKeywords
                ? td.subtitleNoKeywords
                : td.subtitleReady}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setShowConfig(true)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 h-9 text-sm text-muted-foreground hover:text-foreground hover:bg-accent hover:border-primary/40 active:bg-accent/80 transition-colors press"
          >
            <GearIcon />
            {td.configButton}
          </button>
          <button
            type="button"
            onClick={runScan}
            disabled={scanning || noKeywords}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary text-primary-foreground px-3 h-8 text-[12.5px] font-medium hover:bg-primary/90 active:bg-primary/85 disabled:opacity-50 transition-colors press"
          >
            {scanning ? <SpinnerIcon /> : <PlayIcon />}
            {scanning ? td.scanning : td.runButton}
          </button>
        </div>
      </header>

      {renderConnectionWarning?.(config ?? DEFAULT_CONFIG)}

      {scanError ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {scanError}
        </div>
      ) : null}

      {scanWarnings.length > 0 ? (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200/80 space-y-1">
          <p className="font-medium">{td.keywordsFailedHeading}</p>
          <ul className="list-disc list-inside space-y-0.5">
            {scanWarnings.map((w) => (
              <li key={w.keyword}>
                <span className="font-mono">{w.keyword}</span>: {w.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {scanning ? (
        <ScanningState />
      ) : noKeywords ? (
        <NoKeywordsState
          td={td}
          onOpenConfig={() => setShowConfig(true)}
          canEdit={canEdit}
        />
      ) : candidates.length === 0 ? (
        <EmptyState
          td={td}
          platformLabel={platformLabel}
          onRun={runScan}
        />
      ) : (
        <ul className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-3">
          {candidates.map((c) => (
            <CandidateCard
              key={c.externalId}
              t={t}
              candidate={c}
              workspaceId={workspaceId}
              assistantId={assistantId}
              platform={platform}
            />
          ))}
        </ul>
      )}

      {showConfig ? (
        <ConfigModal td={td} onClose={() => setShowConfig(false)}>
          {configLoading ? (
            <p className="text-sm text-muted-foreground">{td.configLoading}</p>
          ) : !config ? (
            <p className="text-sm text-destructive">
              {configError ?? td.configLoadFailed}
            </p>
          ) : (
            <InspirationConfigForm
              td={td}
              config={config}
              onChange={setConfig}
              onSave={saveConfig}
              saving={configSaving}
              savedAt={configSavedAt}
              error={configError}
              canEdit={canEdit}
            />
          )}
        </ConfigModal>
      ) : null}
    </div>
  );
}

// ── Twitter ─────────────────────────────────────────────────────

function TwitterInspirationPage() {
  const team = useFeedWorkspace();
  const t = useT().feedPage;
  const profile = team.profiles.find((p) => p.platform === "twitter");
  const canEdit = team.canDraft;

  const [connection, setConnection] = useState<FeedInspirationConnection | null>(
    null,
  );

  useEffect(() => {
    if (!profile) return;
    fetchFeedInspiration(profile.assistantId, "twitter")
      .then((body) => {
        if (body.connection) setConnection(body.connection);
      })
      .catch(() => null);
  }, [profile]);

  if (!profile) {
    return (
      <NotConnectedState
        t={t}
        platform="twitter"
        workspaceId={team.workspaceId}
      />
    );
  }

  return (
    <InspirationPageLayout
      platform="twitter"
      assistantId={profile.assistantId}
      workspaceId={team.workspaceId}
      canEdit={canEdit}
      renderConnectionWarning={() =>
        connection?.connected === true && !connection.hasListReadScope ? (
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200/80">
            {t.inspiration.reconnectScope}{" "}
            <Link
              href={feedPath(team.workspaceId, {
                platform: "twitter",
                segment: "settings",
              })}
              className="underline"
            >
              {t.inspiration.openSettings}
            </Link>
          </div>
        ) : null
      }
    />
  );
}

// ── Threads ─────────────────────────────────────────────────────

function ThreadsInspirationPage() {
  const team = useFeedWorkspace();
  const t = useT().feedPage;
  const profile = team.profiles.find((p) => p.platform === "threads");
  const canEdit = team.canDraft;

  if (!profile) {
    return (
      <NotConnectedState
        t={t}
        platform="threads"
        workspaceId={team.workspaceId}
      />
    );
  }

  return (
    <InspirationPageLayout
      platform="threads"
      assistantId={profile.assistantId}
      workspaceId={team.workspaceId}
      canEdit={canEdit}
    />
  );
}

// ── Config form ─────────────────────────────────────────────────

function InspirationConfigForm({
  td,
  config,
  onChange,
  onSave,
  saving,
  savedAt,
  error,
  canEdit,
}: {
  td: InspirationDict;
  config: FeedInspirationConfig;
  onChange: (c: FeedInspirationConfig) => void;
  onSave: (c: FeedInspirationConfig) => void;
  saving: boolean;
  savedAt: number | null;
  error: string | null;
  canEdit: boolean;
}) {
  const [input, setInput] = useState("");

  function addKeyword(raw: string) {
    const next = applyAddKeyword(config.keywords, raw);
    if (!next) return;
    onChange({ ...config, keywords: next });
    setInput("");
  }

  function removeKeyword(kw: string) {
    onChange({ ...config, keywords: config.keywords.filter((k) => k !== kw) });
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-sm font-medium mb-1">{td.topicsHeading}</h2>
        <p className="text-xs text-muted-foreground mb-3">{td.topicsHint}</p>

        {config.keywords.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 mb-3">
            {config.keywords.map((kw) => (
              <span
                key={kw}
                className="inline-flex items-center gap-1 rounded-full border border-border bg-accent px-2.5 py-1 text-xs font-medium"
              >
                {kw}
                {canEdit ? (
                  <button
                    type="button"
                    onClick={() => removeKeyword(kw)}
                    className="text-muted-foreground hover:text-foreground ml-0.5"
                    aria-label={format(td.removeKeywordAria, { keyword: kw })}
                  >
                    <XSmallIcon />
                  </button>
                ) : null}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground mb-3">
            {td.noKeywordsYet}
          </p>
        )}

        {canEdit ? (
          <div className="flex gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addKeyword(input);
                }
              }}
              placeholder={td.keywordPlaceholder}
              className="flex-1 rounded-xl border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <button
              type="button"
              onClick={() => addKeyword(input)}
              disabled={!input.trim()}
              className="rounded-xl border border-border px-3 py-2 text-sm hover:bg-accent disabled:opacity-40"
            >
              {td.addButton}
            </button>
          </div>
        ) : null}
      </div>

      <ResultCountSlider
        td={td}
        value={config.resultCount}
        onChange={(v) => onChange({ ...config, resultCount: v })}
        disabled={!canEdit}
      />

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      {canEdit ? (
        <div className="flex items-center gap-3 pt-1">
          <button
            type="button"
            onClick={() => onSave(config)}
            disabled={saving}
            className="rounded-xl bg-primary text-primary-foreground px-4 h-9 text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? td.saving : td.save}
          </button>
          {savedAt ? (
            <span className="text-xs text-emerald-400">{td.saved}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────

function CandidateCard({
  t,
  candidate: c,
  workspaceId,
  assistantId,
  platform,
}: {
  t: FeedPageDict;
  candidate: FeedInspirationCandidate;
  workspaceId: string;
  assistantId: string;
  platform: FeedPlatform;
}) {
  const td = t.inspiration;
  const router = useRouter();
  const preview = c.text.length > 280 ? `${c.text.slice(0, 280)}…` : c.text;
  const [creating, setCreating] = useState<"reply" | "original" | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  async function startDraft(kind: "inspiration-reply" | "inspiration-original") {
    if (creating) return;
    setCreating(kind === "inspiration-reply" ? "reply" : "original");
    setCreateError(null);
    try {
      const result = await createFeedDraftSession(assistantId, {
        platform,
        seed: buildInspirationSeed(kind, platform, c),
      });
      if (!result.ok) {
        throw new Error(result.error ?? td.createFailed);
      }
      const base = feedPath(workspaceId, {
        platform,
        segment: "draft-sessions",
      });
      router.push(`${base}/${result.session.id}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : td.createFailed);
      setCreating(null);
    }
  }

  return (
    <li className="group rounded-xl border border-border/60 bg-card p-4 space-y-3 shadow-xs hover:border-primary/30">
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground">@{c.author.handle}</span>
          <span className="rounded-full border border-border bg-background/60 px-2 py-0.5 text-[10px]">
            {c.source}
          </span>
        </div>
        <span className="tabular-nums">
          {timeAgo(t.home, new Date(c.publishedAt).getTime())}
        </span>
      </div>

      <p className="text-sm whitespace-pre-wrap leading-relaxed">{preview}</p>

      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground flex-wrap">
        <div className="flex items-center gap-3">
          {c.engagement.likes != null ? (
            <span className="flex items-center gap-1 tabular-nums">
              <HeartIcon /> {c.engagement.likes}
            </span>
          ) : null}
          {c.engagement.replies != null ? (
            <span className="flex items-center gap-1 tabular-nums">
              <ReplyIcon /> {c.engagement.replies}
            </span>
          ) : null}
          {c.engagement.reposts != null ? (
            <span className="flex items-center gap-1 tabular-nums">
              <RepostIcon /> {c.engagement.reposts}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void startDraft("inspiration-reply")}
            disabled={creating !== null}
            className="rounded-lg border border-border bg-background/60 px-3 h-8 text-xs font-medium text-foreground hover:bg-accent hover:border-primary/40 disabled:opacity-40 transition-colors"
          >
            {creating === "reply" ? td.opening : td.draftReply}
          </button>
          <button
            type="button"
            onClick={() => void startDraft("inspiration-original")}
            disabled={creating !== null}
            className="rounded-lg bg-primary text-primary-foreground px-3 h-8 text-xs font-medium hover:bg-primary/90 disabled:opacity-40 transition-colors"
          >
            {creating === "original" ? td.opening : td.draftInspiredPost}
          </button>
        </div>
      </div>

      {createError ? (
        <p className="text-[11px] text-destructive">{createError}</p>
      ) : null}

      {c.whyMatch ? (
        <p className="text-[11px] text-muted-foreground border-t border-border pt-2 italic">
          {c.whyMatch}
        </p>
      ) : null}
    </li>
  );
}

function NoKeywordsState({
  td,
  onOpenConfig,
  canEdit,
}: {
  td: InspirationDict;
  onOpenConfig: () => void;
  canEdit: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-8 text-center space-y-3">
      <p className="text-sm font-medium">{td.noKeywordsTitle}</p>
      <p className="text-xs text-muted-foreground max-w-sm mx-auto">
        {canEdit ? td.noKeywordsBodyCanEdit : td.noKeywordsBodyNoEdit}
      </p>
      {canEdit ? (
        <button
          type="button"
          onClick={onOpenConfig}
          className="inline-flex items-center gap-1.5 rounded-xl border border-border px-4 h-9 text-sm font-medium hover:bg-accent mt-1"
        >
          <GearIcon />
          {td.openConfig}
        </button>
      ) : null}
    </div>
  );
}

function EmptyState({
  td,
  platformLabel,
  onRun,
}: {
  td: InspirationDict;
  platformLabel: string;
  onRun: () => void;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-8 text-center space-y-3">
      <p className="text-sm font-medium">{td.emptyTitle}</p>
      <p className="text-xs text-muted-foreground max-w-sm mx-auto">
        {format(td.emptyBody, { platform: platformLabel })}
      </p>
      <button
        type="button"
        onClick={onRun}
        className="inline-flex items-center gap-1.5 rounded-xl bg-primary text-primary-foreground px-4 h-9 text-sm font-medium hover:bg-primary/90 mt-1"
      >
        <PlayIcon />
        {td.runAgain}
      </button>
    </div>
  );
}

function ScanningState() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-3">
      {[1, 2, 3, 4, 5, 6].map((i) => (
        <div
          key={i}
          className="rounded-xl border border-border bg-card p-4 animate-pulse space-y-3"
        >
          <div className="flex items-center gap-2">
            <div className="h-3 w-20 bg-muted rounded" />
            <div className="h-3 w-12 bg-muted rounded" />
          </div>
          <div className="space-y-1.5">
            <div className="h-3 w-full bg-muted rounded" />
            <div className="h-3 w-4/5 bg-muted rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}

function NotConnectedState({
  t,
  platform,
  workspaceId,
}: {
  t: FeedPageDict;
  platform: FeedPlatform;
  workspaceId: string;
}) {
  const label = t.platformLabels[platform];
  return (
    <div className="px-4 md:px-6 py-6 max-w-2xl space-y-4">
      <h1
        className="text-[15px] font-semibold"      >
        {format(t.draftSessions.connectFirstTitle, { platform: label })}
      </h1>
      <p className="text-sm text-muted-foreground">
        {format(t.inspiration.connectBody, { platform: label })}
      </p>
      <Link
        href={feedPath(workspaceId)}
        className="inline-flex items-center justify-center rounded-lg bg-primary px-3 h-8 text-[12.5px] font-medium text-primary-foreground hover:bg-primary/90"
      >
        {format(t.draftSessions.connectCta, { platform: label })}
      </Link>
    </div>
  );
}

function ConfigModal({
  td,
  onClose,
  children,
}: {
  td: InspirationDict;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-sm animate-fade-in"
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div className="relative w-full max-w-md mx-4 rounded-2xl border border-border bg-card shadow-2xl overflow-hidden animate-pop-in">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-sm font-semibold">{td.configModalTitle}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={td.closeAria}
            className="inline-flex items-center justify-center w-7 h-7 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <XIcon />
          </button>
        </div>
        <div className="px-5 py-4 max-h-[70vh] overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

function ResultCountSlider({
  td,
  value,
  onChange,
  disabled,
}: {
  td: InspirationDict;
  value: number;
  onChange: (v: number) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-2 rounded-xl border border-border bg-background/60 p-3">
      <label className="block text-sm font-medium">{td.resultCountLabel}</label>
      <p className="text-xs text-muted-foreground">{td.resultCountHint}</p>
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={1}
          max={20}
          step={1}
          value={value}
          onChange={(e) => onChange(parseInt(e.target.value, 10))}
          disabled={disabled}
          className="flex-1 accent-primary"
        />
        <span className="w-6 text-right text-sm font-mono">{value}</span>
      </div>
    </div>
  );
}

// ── Utilities ───────────────────────────────────────────────────

function timeAgo(t: FeedPageDict["home"], ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return t.timeJustNow;
  const min = Math.floor(diff / 60_000);
  if (min < 60) return format(t.timeMinutesAgo, { count: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return format(t.timeHoursAgo, { count: hr });
  return format(t.timeDaysAgo, { count: Math.floor(hr / 24) });
}

// ── Icons ────────────────────────────────────────────────────────

function GearIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      aria-hidden
      className="animate-spin"
    >
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function XSmallIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function HeartIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  );
}

function ReplyIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="9 17 4 12 9 7" />
      <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
    </svg>
  );
}

function RepostIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="17 1 21 5 17 9" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <polyline points="7 23 3 19 7 15" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </svg>
  );
}
