"use client";

/**
 * Approvals panel — the unified approvals queue, rendered as a **doc-shell
 * panel tab** (`/w/[workspaceId]/p?panel=approvals`), NOT its own top-level
 * route. Opened from the home dock's "Approvals waiting" card; the doc tab
 * strip, sidebar, and chat dock persist around it. The legacy
 * `/w/[workspaceId]/approvals` route now redirects here. Spec:
 * docs/architecture/features/doc.md → "Top bar" (panel tabs).
 *
 * Originally ported from `apps/web/src/app/(app)/approvals/page.tsx`
 * (docs/architecture/features/doc.md §5a).
 *
 * One cross-cutting surface over `pending_approvals` (all kinds).
 * `workflow_step`, `tool_invocation`, and `staged_write` resolve in place —
 * singly or as a batch (`staged_write` executes its staged tool server-side
 * on approve; a 502 keeps the row pending for retry). The staged_skill_*
 * kinds (skill-curator proposals) also resolve here, routed by
 * `respondByKind` to the dedicated `/api/skills/approvals` endpoints; their
 * cards render the proposed umbrella, or a current-vs-proposed line diff
 * (`lib/line-diff.ts`) built from the `listSkillApprovalDetails`
 * target-skill snapshot — with the first changed lines previewed inline
 * on the collapsed card (`previewChanges`), the target skill's slug, a
 * shrink warning against fragment patches that would clobber the body,
 * and approve blocked when the target skill is gone. Every card carries a
 * provenance meta line (proposing assistant, raised time, expiry when
 * set); `workflow_step`/`tool_invocation` cards name the exact tool and
 * expose the frozen tool input behind a toggle (`ToolCallBody`). Tool
 * calls the queue recognises render a rich per-tool preview instead of
 * the JSON view (`lib/approval-previews.ts` parses, `ToolPreview` in
 * `approval-tool-previews.tsx` renders — first: `gmailSendMessage` as a
 * mail-client-style email card), with the raw input kept one toggle away
 * and the generic view as the fallback for everything else. Only
 * `distribution_draft` (feed) and `question` (chat) still list with a
 * native-surface hint — the unified respond route 422s them by design.
 * Filterable by kind / assistant / age.
 *
 * app-web is single-workspace-per-route (no chrome workspace switcher),
 * so the queue scopes to the route workspace via `activeId` from the
 * `useWorkspaces()` adapter (`[COMP:app-web/workspaces-adapter]`). The
 * web version is multi-workspace via a chrome switcher; scoping to the route
 * workspace is the intended app-web adaptation.
 *
 * Spec: docs/architecture/features/workflow.md → Unified approvals.
 * [COMP:app-web/approvals]
 */

import { useEffect, useMemo, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import Link from "next/link";
import { useWorkspaces } from "@/contexts/workspace-context";
import { feedPath } from "@/lib/feed-nav";
import {
  isSkillApprovalKind,
  listApprovals,
  listSkillApprovalDetails,
  respondByKind,
  type ApprovalKind,
  type PendingApprovalRow,
  type SkillApprovalDetail,
} from "@/lib/api/approvals";
import { listAssistants } from "@/lib/api/studio";
import {
  APPROVALS_REFRESH_EVENT,
  requestApprovalsRefresh,
  type ApprovalsRefreshDetail,
} from "@/lib/approvals-events";
import {
  collapseContext,
  diffLines,
  diffStats,
  previewChanges,
  type DiffRow,
} from "@/lib/line-diff";
import {
  filterApprovals,
  isActionable,
  isFilterActive,
  NO_FILTER,
  presentAssistantIds,
  presentKinds,
  type AgeFilter,
  type ApprovalFilter,
} from "@/lib/approvals-filter";
import {
  extractAttachmentLines,
  parseToolPreview,
  type ToolPreviewData,
} from "@/lib/approval-previews";
import { ToolPreview } from "./approval-tool-previews";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function ApprovalsPanel() {
  const t = useT();
  const { activeId } = useWorkspaces();
  const [rows, setRows] = useState<PendingApprovalRow[] | null>(null);
  // Target-skill snapshots for staged_skill_* cards, keyed by approval id.
  // null = not fetched yet; {} = fetched (possibly failed — cards degrade).
  const [skillDetails, setSkillDetails] = useState<Record<
    string,
    SkillApprovalDetail
  > | null>(null);
  const [assistantNames, setAssistantNames] = useState<Record<string, string>>(
    {},
  );
  const [filter, setFilter] = useState<ApprovalFilter>(NO_FILTER);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [batchReason, setBatchReason] = useState("");
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);

  // Pinned once at mount — the age filter buckets relative to "now", and
  // a stable reference keeps `filtered` from churning every render.
  const [now] = useState(() => Date.now());

  // Bumped by the approvals event bus (same-tab respond actions AND the
  // shell's server leg: an assistant staging an approval, an executor
  // pause, another tab responding). Drives the SILENT refetch below —
  // never the full reset the workspace-switch effect performs.
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (!activeId) return;
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<ApprovalsRefreshDetail>).detail;
      if (detail?.workspaceId && detail.workspaceId !== activeId) return;
      setRefreshTick((n) => n + 1);
    };
    window.addEventListener(APPROVALS_REFRESH_EVENT, handler);
    return () => window.removeEventListener(APPROVALS_REFRESH_EVENT, handler);
  }, [activeId]);

  useEffect(() => {
    if (!activeId || refreshTick === 0) return;
    let cancelled = false;
    void (async () => {
      const list = await listApprovals(activeId);
      if (cancelled) return;
      setRows(list);
      if (list.some((r) => isSkillApprovalKind(r.kind))) {
        const details = await listSkillApprovalDetails(activeId);
        if (!cancelled) setSkillDetails(details);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId, refreshTick]);

  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    setRows(null);
    setSkillDetails(null);
    setAssistantNames({});
    setSelected(new Set());
    setFilter(NO_FILTER);
    setBatchError(null);
    void (async () => {
      const list = await listApprovals(activeId);
      if (cancelled) return;
      setRows(list);
      // Skill cards render a diff against the target skill's current body —
      // one snapshot fetch for the whole queue, only when skill rows exist.
      if (list.some((r) => isSkillApprovalKind(r.kind))) {
        const details = await listSkillApprovalDetails(activeId);
        if (!cancelled) setSkillDetails(details);
      } else {
        setSkillDetails({});
      }
    })();
    // Assistant names back the assistant filter labels — non-critical, so
    // fetched independently: a failure here must not block the queue.
    void (async () => {
      const assistants = await listAssistants(activeId);
      if (!cancelled) {
        setAssistantNames(
          Object.fromEntries(assistants.map((a) => [a.id, a.name])),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  const filtered = useMemo(
    () => filterApprovals(rows ?? [], filter, now),
    [rows, filter, now],
  );
  const actionableIds = useMemo(
    () => filtered.filter((r) => isActionable(r.kind)).map((r) => r.id),
    [filtered],
  );
  const kindOptions = useMemo(() => presentKinds(rows ?? []), [rows]);
  const assistantOptions = useMemo(
    () =>
      presentAssistantIds(rows ?? []).map((id) => ({
        id,
        name:
          assistantNames[id] ??
          format(t.approvalsPage.filters.assistantFallback, {
            id: id.slice(0, 8),
          }),
      })),
    [rows, assistantNames, t],
  );

  const allSelected =
    actionableIds.length > 0 && actionableIds.every((id) => selected.has(id));
  const selectedCount = actionableIds.reduce(
    (n, id) => (selected.has(id) ? n + 1 : n),
    0,
  );

  function handleResolved(id: string) {
    setRows((prev) => (prev ? prev.filter((r) => r.id !== id) : prev));
    setSelected((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    // Tell the chrome ApprovalsPill its count dropped.
    requestApprovalsRefresh(activeId);
  }

  function toggleSelect(id: string) {
    setBatchError(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setBatchError(null);
    setSelected(allSelected ? new Set() : new Set(actionableIds));
  }

  function clearSelection() {
    setSelected(new Set());
    setBatchReason("");
    setBatchError(null);
  }

  function updateFilter(patch: Partial<ApprovalFilter>) {
    setFilter((f) => ({ ...f, ...patch }));
    clearSelection();
  }

  function clearFilters() {
    setFilter(NO_FILTER);
    clearSelection();
  }

  async function runBatch(decision: "approved" | "rejected") {
    const targets = filtered.filter(
      (r) => isActionable(r.kind) && selected.has(r.id),
    );
    if (targets.length === 0) return;
    setBatchBusy(true);
    setBatchError(null);
    const failed = new Set<string>();
    for (const row of targets) {
      const result = await respondByKind(
        row,
        decision,
        batchReason.trim() || undefined,
      );
      if (result.ok) {
        setRows((prev) => (prev ? prev.filter((r) => r.id !== row.id) : prev));
      } else {
        failed.add(row.id);
      }
    }
    setSelected(failed);
    setBatchBusy(false);
    // Refresh the chrome pill if at least one resolved.
    if (failed.size < targets.length) {
      requestApprovalsRefresh(activeId);
    }
    if (failed.size > 0) {
      setBatchError(
        format(t.approvalsPage.batch.partialError, {
          failed: failed.size,
          total: targets.length,
        }),
      );
    } else {
      setBatchReason("");
    }
  }

  const hasRows = rows !== null && rows.length > 0;

  return (
    <div className="h-full w-full px-8 py-6 flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold flex items-center gap-2">
          {t.approvalsPage.title}
          {rows && rows.length > 0 && (
            <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400">
              {format(t.approvalsPage.pendingBadge, { count: rows.length })}
            </span>
          )}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t.approvalsPage.description}
        </p>
      </header>

      {hasRows && (
        <FilterBar
          filter={filter}
          kinds={kindOptions}
          assistants={assistantOptions}
          onChange={updateFilter}
          onClear={clearFilters}
        />
      )}

      {hasRows && actionableIds.length > 0 && (
        <SelectionToolbar
          allSelected={allSelected}
          selectedCount={selectedCount}
          busy={batchBusy}
          error={batchError}
          reason={batchReason}
          onToggleAll={toggleAll}
          onReasonChange={setBatchReason}
          onApprove={() => void runBatch("approved")}
          onReject={() => void runBatch("rejected")}
          onClear={clearSelection}
        />
      )}

      {rows === null ? (
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
          {t.approvalsPage.loading}
        </div>
      ) : rows.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center gap-3 border border-border rounded-md bg-card/50">
          <svg
            width="40"
            height="40"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
            className="text-muted-foreground/40"
          >
            <path d="M9 12l2 2 4-4" />
            <circle cx="12" cy="12" r="9" />
          </svg>
          <div className="font-medium">{t.approvalsPage.emptyTitle}</div>
          <p className="text-sm text-muted-foreground max-w-md">
            {t.approvalsPage.emptyBody}
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center gap-3 border border-border rounded-md bg-card/50">
          <div className="font-medium">
            {t.approvalsPage.filters.noMatchTitle}
          </div>
          <p className="text-sm text-muted-foreground max-w-md">
            {t.approvalsPage.filters.noMatchBody}
          </p>
          <button
            type="button"
            onClick={clearFilters}
            className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-muted"
          >
            {t.approvalsPage.filters.clear}
          </button>
        </div>
      ) : (
        <ul className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-2">
          {filtered.map((row) => (
            <ApprovalCard
              key={row.id}
              row={row}
              skillDetail={skillDetails?.[row.id]}
              skillDetailsLoaded={skillDetails !== null}
              assistantNames={assistantNames}
              selectable={isActionable(row.kind)}
              selected={selected.has(row.id)}
              batchBusy={batchBusy}
              onToggleSelect={toggleSelect}
              onResolved={handleResolved}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function FilterBar({
  filter,
  kinds,
  assistants,
  onChange,
  onClear,
}: {
  filter: ApprovalFilter;
  kinds: ApprovalKind[];
  assistants: { id: string; name: string }[];
  onChange: (patch: Partial<ApprovalFilter>) => void;
  onClear: () => void;
}) {
  const t = useT();
  const kindLabel = (value: string): string =>
    value === "all"
      ? t.approvalsPage.filters.allKinds
      : t.approvalsPage.kind[value as ApprovalKind];
  const assistantLabel = (value: string): string =>
    value === "all"
      ? t.approvalsPage.filters.allAssistants
      : (assistants.find((a) => a.id === value)?.name ?? value);
  const ageLabel = (value: string): string => {
    switch (value) {
      case "24h":
        return t.approvalsPage.filters.age24h;
      case "7d":
        return t.approvalsPage.filters.age7d;
      case "older":
        return t.approvalsPage.filters.ageOlder;
      default:
        return t.approvalsPage.filters.anyAge;
    }
  };
  return (
    <div className="flex flex-wrap items-end gap-3">
      <FilterSelect
        label={t.approvalsPage.filters.kindLabel}
        value={filter.kind}
        renderValue={kindLabel}
        onChange={(v) => onChange({ kind: v as ApprovalKind | "all" })}
        options={[
          { value: "all", label: t.approvalsPage.filters.allKinds },
          ...kinds.map((k) => ({ value: k, label: t.approvalsPage.kind[k] })),
        ]}
      />
      <FilterSelect
        label={t.approvalsPage.filters.assistantLabel}
        value={filter.assistant}
        renderValue={assistantLabel}
        onChange={(v) => onChange({ assistant: v })}
        options={[
          { value: "all", label: t.approvalsPage.filters.allAssistants },
          ...assistants.map((a) => ({ value: a.id, label: a.name })),
        ]}
      />
      <FilterSelect
        label={t.approvalsPage.filters.ageLabel}
        value={filter.age}
        renderValue={ageLabel}
        onChange={(v) => onChange({ age: v as AgeFilter })}
        options={[
          { value: "all", label: t.approvalsPage.filters.anyAge },
          { value: "24h", label: t.approvalsPage.filters.age24h },
          { value: "7d", label: t.approvalsPage.filters.age7d },
          { value: "older", label: t.approvalsPage.filters.ageOlder },
        ]}
      />
      {isFilterActive(filter) && (
        <button
          type="button"
          onClick={onClear}
          className="text-xs px-2 py-1.5 text-muted-foreground hover:text-foreground"
        >
          {t.approvalsPage.filters.clear}
        </button>
      )}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  renderValue,
  onChange,
  options,
}: {
  label: string;
  value: string;
  renderValue: (value: string) => string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <Select
        value={value}
        onValueChange={(v) => {
          if (typeof v === "string") onChange(v);
        }}
      >
        <SelectTrigger size="sm" className="min-w-[8rem] text-xs">
          <SelectValue>{renderValue(value)}</SelectValue>
        </SelectTrigger>
        <SelectContent align="start">
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value} className="text-xs">
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}

function SelectionToolbar({
  allSelected,
  selectedCount,
  busy,
  error,
  reason,
  onToggleAll,
  onReasonChange,
  onApprove,
  onReject,
  onClear,
}: {
  allSelected: boolean;
  selectedCount: number;
  busy: boolean;
  error: string | null;
  reason: string;
  onToggleAll: () => void;
  onReasonChange: (v: string) => void;
  onApprove: () => void;
  onReject: () => void;
  onClear: () => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-3 border border-border rounded-md bg-card/50 px-3 py-2">
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={allSelected}
          onChange={onToggleAll}
          disabled={busy}
        />
        <span>{t.approvalsPage.batch.selectAll}</span>
      </label>
      {selectedCount > 0 && (
        <>
          <span className="text-xs text-muted-foreground">
            {format(t.approvalsPage.batch.selected, { count: selectedCount })}
          </span>
          <input
            type="text"
            value={reason}
            onChange={(e) => onReasonChange(e.target.value)}
            placeholder={t.approvalsPage.batch.reasonPlaceholder}
            disabled={busy}
            className="text-xs px-2 py-1.5 rounded border border-border bg-background flex-1 min-w-[10rem] max-w-xs"
          />
          <button
            type="button"
            disabled={busy}
            onClick={onApprove}
            className="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {t.approvalsPage.batch.approveSelected}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onReject}
            className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-muted disabled:opacity-50"
          >
            {t.approvalsPage.batch.rejectSelected}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onClear}
            className="text-xs px-2 py-1.5 text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            {t.approvalsPage.batch.clearSelection}
          </button>
          {error && (
            <span className="text-xs text-red-500 w-full">{error}</span>
          )}
        </>
      )}
    </div>
  );
}

function ApprovalCard({
  row,
  skillDetail,
  skillDetailsLoaded,
  assistantNames,
  selectable,
  selected,
  batchBusy,
  onToggleSelect,
  onResolved,
}: {
  row: PendingApprovalRow;
  skillDetail?: SkillApprovalDetail;
  skillDetailsLoaded: boolean;
  assistantNames: Record<string, string>;
  selectable: boolean;
  selected: boolean;
  batchBusy: boolean;
  onToggleSelect: (id: string) => void;
  onResolved: (id: string) => void;
}) {
  const t = useT();
  // Route-derived workspace for the Feed-inbox deep link on
  // `distribution_draft` rows; null only outside a workspace route, where
  // the plain native hint still covers it.
  const { activeId: activeWorkspaceId } = useWorkspaces();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const actionable = isActionable(row.kind);
  // staged_write rows always title on the staged tool's name — the
  // arguments preview + provenance line below carry the detail. Skill rows
  // title on the skill name (the kind chip already names the action);
  // creation carries the name in its arguments, update needs the fetched
  // target snapshot and falls back to the kind label while it loads.
  const stagedCreationName =
    row.kind === "staged_skill_creation"
      ? (row.arguments as { umbrella?: { name?: string } }).umbrella?.name
      : undefined;
  const headline =
    row.kind === "staged_write"
      ? row.toolName
      : row.kind === "staged_skill_creation"
        ? stagedCreationName || t.approvalsPage.kind[row.kind]
        : row.kind === "staged_skill_update"
          ? skillDetail?.targetSkill?.name || t.approvalsPage.kind[row.kind]
          : row.approvalPayload.description?.trim() || row.toolName;

  // A staged update can only be applied while its target skill exists —
  // block approve (reject stays available) when the snapshot says it's gone
  // or hasn't loaded yet, so nobody approves a body rewrite blind.
  const approveBlocked =
    row.kind === "staged_skill_update" && !skillDetail?.targetSkill;

  // Tool-specific rich preview (an email as an email), for the kinds whose
  // `arguments` are a frozen tool input. Null → the generic raw-input view.
  // When a preview renders, the payload displayLines are suppressed — they
  // narrate the same call the preview already shows.
  const toolPreview: ToolPreviewData | null =
    row.kind === "tool_invocation" ||
    row.kind === "workflow_step" ||
    row.kind === "staged_write"
      ? parseToolPreview(row.toolName, row.arguments)
      : null;

  // Provenance for agent-origin staged writes: which credential class the
  // agent acted through, plus a human label (or credential-id prefix).
  const stagedSurface =
    row.kind === "staged_write" && row.approvalPayload.surface
      ? t.approvalsPage.stagedWrite.surface[row.approvalPayload.surface]
      : null;
  const stagedOrigin =
    row.approvalPayload.originLabel ??
    (row.approvalPayload.credentialId
      ? `${row.approvalPayload.credentialId.slice(0, 8)}…`
      : "");

  // Card meta: who proposed it, when it was raised, when it lapses. The
  // assistant-name map is the same one backing the filter labels; a name
  // still loading falls back to the id-prefix label.
  const proposerName = row.originatingAssistantId
    ? (assistantNames[row.originatingAssistantId] ??
      format(t.approvalsPage.filters.assistantFallback, {
        id: row.originatingAssistantId.slice(0, 8),
      }))
    : null;
  const metaLine = [
    ...(proposerName
      ? [format(t.approvalsPage.proposedBy, { assistant: proposerName })]
      : []),
    format(t.approvalsPage.age, {
      when: new Date(row.createdAt).toLocaleString(),
    }),
    ...(row.expiresAt
      ? [
          format(t.approvalsPage.expires, {
            when: new Date(row.expiresAt).toLocaleString(),
          }),
        ]
      : []),
  ].join(" · ");

  async function respond(
    decision: "approved" | "rejected",
    extra?: { grantAlways?: boolean },
  ) {
    setBusy(true);
    setError(null);
    const result = await respondByKind(
      row,
      decision,
      reason.trim() || undefined,
      extra,
    );
    if (result.ok) {
      onResolved(row.id);
      return;
    }
    setBusy(false);
    setError("error" in result ? result.error : t.approvalsPage.respondError);
  }

  // Everything except distribution_draft (feed) and question (chat) now
  // resolves in place, so only those two reach the hint branch.
  const surfaceLabel =
    row.kind === "distribution_draft"
      ? t.approvalsPage.surface.feed
      : t.approvalsPage.surface.web;

  return (
    <li className="border border-border rounded-md bg-card px-4 py-3">
      <div className="flex items-start gap-3">
        {selectable && (
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect(row.id)}
            disabled={busy || batchBusy}
            aria-label={headline}
            className="mt-1 shrink-0"
          />
        )}
        <span
          className={cn(
            "text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide shrink-0 mt-0.5",
            actionable
              ? "bg-primary/15 text-primary"
              : "bg-muted text-muted-foreground",
          )}
        >
          {t.approvalsPage.kind[row.kind]}
        </span>
        <div className="flex-1 min-w-0 flex flex-col gap-2">
          <div>
            <div className="text-sm font-medium truncate">{headline}</div>
            {!toolPreview &&
              row.approvalPayload.displayLines?.map((line, i) => (
                <div key={i} className="text-xs text-muted-foreground truncate">
                  {line}
                </div>
              ))}
            {row.kind === "staged_write" && (
              <>
                {toolPreview ? (
                  <div className="flex flex-col items-start gap-1">
                    <ToolPreview
                      preview={toolPreview}
                      attachmentLines={extractAttachmentLines(
                        row.approvalPayload.displayLines,
                      )}
                    />
                    <RawInputToggle args={row.arguments} />
                  </div>
                ) : (
                  <pre className="mt-1.5 text-[11px] font-mono bg-muted/50 border border-border rounded px-2 py-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-all max-w-2xl">
                    {JSON.stringify(row.arguments, null, 2)}
                  </pre>
                )}
                <div className="text-xs text-muted-foreground mt-1.5">
                  {format(t.approvalsPage.stagedWrite.provenance, {
                    surface: stagedSurface ?? "",
                    origin: stagedOrigin,
                  })}
                </div>
              </>
            )}
            {(row.kind === "workflow_step" ||
              row.kind === "tool_invocation") && (
              <ToolCallBody row={row} preview={toolPreview} />
            )}
            {row.kind === "staged_skill_creation" && (
              <SkillCreationBody row={row} />
            )}
            {row.kind === "staged_skill_update" && (
              <SkillUpdateBody
                row={row}
                detail={skillDetail}
                detailsLoaded={skillDetailsLoaded}
              />
            )}
            {row.kind === "browser_skill_send" && (
              <BrowserSkillSendBody row={row} />
            )}
            <div className="text-xs text-muted-foreground mt-0.5">
              {metaLine}
            </div>
          </div>

          {actionable ? (
            <div className="flex flex-col gap-2">
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t.approvalsPage.reasonPlaceholder}
                disabled={busy || batchBusy}
                className="text-xs px-2 py-1.5 rounded border border-border bg-background w-full max-w-md"
              />
              {row.kind === "browser_skill_send" ? (
                // The R2-2 three-button card: Deny / Allow once / Allow always
                // for this block+profile. "Allow always" mints the standing
                // grant (the grant IS the review) — never offered on
                // verb-ceiling sends.
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={busy || batchBusy}
                    onClick={() => respond("rejected")}
                    className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-muted disabled:opacity-50"
                  >
                    {t.approvalsPage.browserSkillSend.deny}
                  </button>
                  <button
                    type="button"
                    disabled={busy || batchBusy}
                    onClick={() => respond("approved")}
                    className="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
                  >
                    {t.approvalsPage.browserSkillSend.allowOnce}
                  </button>
                  {!row.approvalPayload.ceiling && (
                    <button
                      type="button"
                      disabled={busy || batchBusy}
                      onClick={() => respond("approved", { grantAlways: true })}
                      className="text-xs px-3 py-1.5 rounded-md border border-primary/50 text-primary hover:bg-primary/10 disabled:opacity-50"
                    >
                      {format(t.approvalsPage.browserSkillSend.allowAlways, {
                        skill: row.approvalPayload.skillName ?? "",
                        profile: row.approvalPayload.profileName ?? "",
                      })}
                    </button>
                  )}
                  {error && <span className="text-xs text-red-500">{error}</span>}
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={busy || batchBusy || approveBlocked}
                    onClick={() => respond("approved")}
                    className="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
                  >
                    {t.approvalsPage.approveAction}
                  </button>
                  <button
                    type="button"
                    disabled={busy || batchBusy}
                    onClick={() => respond("rejected")}
                    className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-muted disabled:opacity-50"
                  >
                    {t.approvalsPage.rejectAction}
                  </button>
                  {error && <span className="text-xs text-red-500">{error}</span>}
                </div>
              )}
            </div>
          ) : row.kind === "distribution_draft" && activeWorkspaceId ? (
            // Feed drafts resolve in the in-app Feed inbox now
            // (docs/plans/feed-web-consolidation.md §9) — deep-link instead
            // of the plain "open it elsewhere" hint.
            <Link
              href={feedPath(activeWorkspaceId, { segment: "inbox" })}
              className="text-xs text-primary hover:underline w-fit"
            >
              {t.approvalsPage.openInFeed}
            </Link>
          ) : (
            <p className="text-xs text-muted-foreground">
              {format(t.approvalsPage.nativeHint, { surface: surfaceLabel })}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}

/** Detail body for `browser_skill_send` cards (computer-use R2-5): which
 *  block wants to send, as which profile, on which site — plus the ceiling /
 *  drift badges that explain why "Allow always" is (not) on offer. The
 *  effect-contract summary is the review artifact the grant decision reads. */
function BrowserSkillSendBody({ row }: { row: PendingApprovalRow }) {
  const t = useT();
  const p = row.approvalPayload;
  return (
    <div className="mt-1 flex flex-col gap-1">
      <div className="text-xs text-muted-foreground">
        {format(t.approvalsPage.browserSkillSend.context, {
          skill: p.skillName ?? "",
          profile: p.profileName ?? "",
          site: p.site ?? "",
        })}
      </div>
      {p.label ? (
        <div className="text-xs text-muted-foreground truncate">
          {format(t.approvalsPage.browserSkillSend.target, { label: p.label })}
        </div>
      ) : null}
      {p.contractSummary ? (
        <div className="text-xs text-muted-foreground">{p.contractSummary}</div>
      ) : null}
      {p.ceiling ? (
        <span className="w-fit text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide bg-destructive/15 text-destructive">
          {format(t.approvalsPage.browserSkillSend.ceiling, { reason: p.ceiling })}
        </span>
      ) : null}
      {p.drift ? (
        <span className="w-fit text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide bg-amber-500/15 text-amber-600 dark:text-amber-400">
          {format(t.approvalsPage.browserSkillSend.drift, { reason: p.drift })}
        </span>
      ) : null}
    </div>
  );
}

/** Detail body for `workflow_step` / `tool_invocation` cards — the exact
 *  tool that will run (shown when the headline is a human description, so
 *  the ident is never lost), a tool-specific rich preview when the queue
 *  recognises the action (an outgoing email as an email), and the frozen
 *  input it will run with, behind a toggle to keep the queue scannable. */
function ToolCallBody({
  row,
  preview,
}: {
  row: PendingApprovalRow;
  preview: ToolPreviewData | null;
}) {
  const hasInput = Object.keys(row.arguments ?? {}).length > 0;
  const described = Boolean(row.approvalPayload.description?.trim());
  if (!(described && row.toolName) && !hasInput) return null;
  return (
    <div className="flex flex-col items-start gap-1 mt-0.5">
      {described && row.toolName && (
        <div className="text-[11px] font-mono text-muted-foreground/80">
          {row.toolName}
        </div>
      )}
      {preview && (
        <ToolPreview
          preview={preview}
          attachmentLines={extractAttachmentLines(
            row.approvalPayload.displayLines,
          )}
        />
      )}
      {hasInput && <RawInputToggle args={row.arguments} />}
    </div>
  );
}

/** "View tool input" toggle over the frozen arguments JSON — the ground
 *  truth under every preview, and the whole view when no preview exists. */
function RawInputToggle({ args }: { args: Record<string, unknown> }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (Object.keys(args ?? {}).length === 0) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-xs text-primary hover:underline"
      >
        {open ? t.approvalsPage.hideToolInput : t.approvalsPage.viewToolInput}
      </button>
      {open && (
        <pre className="w-full text-[11px] font-mono bg-muted/50 border border-border rounded px-2 py-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-all max-w-2xl">
          {JSON.stringify(args, null, 2)}
        </pre>
      )}
    </>
  );
}

/** Proposal body for a `staged_skill_creation` card — the umbrella's
 *  description, slug, support-file count, and a toggleable full content
 *  preview. Everything lives in `row.arguments`; no detail fetch needed. */
function SkillCreationBody({ row }: { row: PendingApprovalRow }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const umbrella = (
    row.arguments as {
      umbrella?: {
        slug?: string;
        description?: string;
        content?: string;
        supportFiles?: Array<{ name?: string }>;
      };
    }
  ).umbrella;
  if (!umbrella) return null;
  const fileCount = umbrella.supportFiles?.length ?? 0;
  return (
    <div className="flex flex-col items-start gap-1 mt-0.5">
      {umbrella.description && (
        <div className="text-xs text-muted-foreground">
          {umbrella.description}
        </div>
      )}
      {umbrella.slug && (
        <div className="text-[11px] font-mono text-muted-foreground/80">
          {umbrella.slug}
        </div>
      )}
      {fileCount > 0 && (
        <div className="text-xs text-muted-foreground">
          {format(t.approvalsPage.skill.addsFiles, { count: fileCount })}
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-xs text-primary hover:underline"
      >
        {open
          ? t.approvalsPage.skill.hideContent
          : t.approvalsPage.skill.viewContent}
      </button>
      {open && (
        <pre className="w-full text-[11px] font-mono bg-muted/50 border border-border rounded px-2 py-1.5 max-h-72 overflow-auto whitespace-pre-wrap break-words max-w-2xl">
          {umbrella.content ?? ""}
        </pre>
      )}
    </div>
  );
}

/** Proposal body for a `staged_skill_update` card — the target skill's
 *  slug, added support files, an added/removed summary, a shrink warning
 *  against fragment patches that would clobber the body, an inline preview
 *  of the first changed lines (so the substance is visible without a
 *  click), and a toggleable full current-vs-proposed line diff built from
 *  the fetched target snapshot. */
function SkillUpdateBody({
  row,
  detail,
  detailsLoaded,
}: {
  row: PendingApprovalRow;
  detail?: SkillApprovalDetail;
  detailsLoaded: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const patch = (
    row.arguments as {
      patch?: {
        newContent?: string;
        diff?: string;
        addedFiles?: Array<{ kind?: string; name?: string }>;
      };
    }
  ).patch;
  const target = detail?.targetSkill ?? null;
  const proposed = patch?.newContent;

  const diff = useMemo(
    () =>
      target && proposed !== undefined
        ? diffLines(target.content, proposed)
        : null,
    [target, proposed],
  );
  const stats = useMemo(() => (diff ? diffStats(diff) : null), [diff]);
  const diffRows = useMemo(() => (diff ? collapseContext(diff) : null), [diff]);
  // First few changed lines, shown inline while the full diff is closed —
  // the reviewer sees what the proposal actually says at a glance.
  const preview = useMemo(() => (diff ? previewChanges(diff) : null), [diff]);
  // A proposal much shorter than the current body usually means the curator
  // sent a fragment — approving would replace the whole skill with it.
  const shrinkPercent =
    target && proposed !== undefined && target.content.length > 0
      ? Math.round((1 - proposed.length / target.content.length) * 100)
      : 0;
  const addedFiles = (patch?.addedFiles ?? []).filter(Boolean);
  const hasBodyProposal = proposed !== undefined || patch?.diff !== undefined;

  return (
    <div className="flex flex-col items-start gap-1 mt-0.5">
      {target?.slug && (
        <div className="text-[11px] font-mono text-muted-foreground/80">
          {target.slug}
        </div>
      )}
      {!detailsLoaded ? (
        <div className="text-xs text-muted-foreground">
          {t.approvalsPage.skill.updateTargetLoading}
        </div>
      ) : !target ? (
        <div className="text-xs text-amber-600 dark:text-amber-400">
          {detail
            ? t.approvalsPage.skill.targetMissing
            : t.approvalsPage.skill.detailError}
        </div>
      ) : null}
      {addedFiles.length > 0 && (
        <div className="text-xs text-muted-foreground">
          {format(t.approvalsPage.skill.addsFiles, {
            count: addedFiles.length,
          })}{" "}
          <span className="font-mono text-[11px]">
            {addedFiles
              .map((f) => f.name ?? "")
              .filter(Boolean)
              .join(", ")}
          </span>
        </div>
      )}
      {stats && (
        <div className="text-xs text-muted-foreground">
          {format(t.approvalsPage.skill.proposalSummary, {
            added: stats.added,
            removed: stats.removed,
          })}
        </div>
      )}
      {shrinkPercent >= 40 && (
        <div className="text-xs text-amber-600 dark:text-amber-400">
          {format(t.approvalsPage.skill.shrinkWarning, {
            percent: shrinkPercent,
          })}
        </div>
      )}
      {!open && preview && preview.rows.length > 0 && (
        <>
          <DiffView rows={preview.rows} />
          {preview.moreChanges > 0 && (
            <div className="text-[11px] text-muted-foreground/70">
              {format(t.approvalsPage.skill.moreChanges, {
                count: preview.moreChanges,
              })}
            </div>
          )}
        </>
      )}
      {hasBodyProposal && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-xs text-primary hover:underline"
        >
          {open
            ? t.approvalsPage.skill.hideChanges
            : preview && preview.rows.length > 0
              ? t.approvalsPage.skill.viewAllChanges
              : t.approvalsPage.skill.viewChanges}
        </button>
      )}
      {open && diffRows ? (
        <DiffView rows={diffRows} />
      ) : open && hasBodyProposal ? (
        // No target snapshot to diff against — show the raw proposal.
        <pre className="w-full text-[11px] font-mono bg-muted/50 border border-border rounded px-2 py-1.5 max-h-72 overflow-auto whitespace-pre-wrap break-words max-w-2xl">
          {proposed ?? patch?.diff ?? ""}
        </pre>
      ) : null}
    </div>
  );
}

/** Unified diff rendering: del lines red, add lines green, long unchanged
 *  runs collapsed into count rows. */
function DiffView({ rows }: { rows: DiffRow[] }) {
  const t = useT();
  return (
    <div className="w-full text-[11px] font-mono bg-muted/30 border border-border rounded max-h-72 overflow-auto max-w-2xl">
      {rows.map((r, i) =>
        r.type === "gap" ? (
          <div
            key={i}
            className="px-2 py-0.5 text-muted-foreground/60 select-none"
          >
            {format(t.approvalsPage.skill.unchangedGap, { count: r.count })}
          </div>
        ) : (
          <div
            key={i}
            className={cn(
              "px-2 whitespace-pre-wrap break-words",
              r.type === "add" &&
                "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
              r.type === "del" &&
                "bg-red-500/10 text-red-600 dark:text-red-400",
            )}
          >
            <span className="select-none opacity-60">
              {r.type === "add" ? "+ " : r.type === "del" ? "- " : "  "}
            </span>
            {r.text || " "}
          </div>
        ),
      )}
    </div>
  );
}
