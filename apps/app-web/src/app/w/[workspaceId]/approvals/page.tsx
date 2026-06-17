"use client";

/**
 * Approvals page — `/w/[workspaceId]/approvals` (app-web).
 *
 * Ported from `apps/web/src/app/(app)/approvals/page.tsx` as the second
 * surface migration of the app consolidation
 * (docs/plans/doc-web-app-consolidation.md §5a, after KB-gaps).
 *
 * One cross-cutting surface over `pending_approvals` (all kinds).
 * `workflow_step`, `tool_invocation`, and `staged_write` resolve in place —
 * singly or as a batch (`staged_write` executes its staged tool server-side
 * on approve; a 502 keeps the row pending for retry). The other kinds
 * (distribution_draft, staged_skill_creation, staged_skill_update) list for
 * visibility and carry a hint deep-linking to the surface that actions them
 * (feed, web) — `approvals.ts` 422s them by design. Filterable by kind /
 * assistant / age.
 *
 * app-web is single-workspace-per-route (no chrome workspace switcher),
 * so the queue scopes to the route workspace via `activeId` from the
 * `useWorkspaces()` adapter (`[COMP:app-web/workspaces-adapter]`). The
 * web version is multi-workspace via a chrome switcher; scoping to the route
 * workspace is the intended app-web adaptation. The page renders
 * full-width inside the `/w/[workspaceId]` layout's `<main>` (its own chrome,
 * not the doc page shell).
 *
 * Spec: docs/architecture/features/workflow.md → Unified approvals.
 * [COMP:app-web/approvals]
 */

import { useEffect, useMemo, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { useWorkspaces } from "@/contexts/workspace-context";
import {
  listApprovals,
  respondToApproval,
  type ApprovalKind,
  type PendingApprovalRow,
} from "@/lib/api/approvals";
import { listAssistants } from "@/lib/api/studio";
import { requestApprovalsRefresh } from "@/lib/approvals-events";
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
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export default function ApprovalsPage() {
  const t = useT();
  const { activeId } = useWorkspaces();
  const [rows, setRows] = useState<PendingApprovalRow[] | null>(null);
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

  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    setRows(null);
    setAssistantNames({});
    setSelected(new Set());
    setFilter(NO_FILTER);
    setBatchError(null);
    void (async () => {
      const list = await listApprovals(activeId);
      if (!cancelled) setRows(list);
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
      const result = await respondToApproval(
        row.id,
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
  selectable,
  selected,
  batchBusy,
  onToggleSelect,
  onResolved,
}: {
  row: PendingApprovalRow;
  selectable: boolean;
  selected: boolean;
  batchBusy: boolean;
  onToggleSelect: (id: string) => void;
  onResolved: (id: string) => void;
}) {
  const t = useT();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const actionable = isActionable(row.kind);
  // staged_write rows always title on the staged tool's name — the
  // arguments preview + provenance line below carry the detail.
  const headline =
    row.kind === "staged_write"
      ? row.toolName
      : row.approvalPayload.description?.trim() || row.toolName;

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

  async function respond(decision: "approved" | "rejected") {
    setBusy(true);
    setError(null);
    const result = await respondToApproval(
      row.id,
      decision,
      reason.trim() || undefined,
    );
    if (result.ok) {
      onResolved(row.id);
      return;
    }
    setBusy(false);
    setError("error" in result ? result.error : t.approvalsPage.respondError);
  }

  // tool_invocation and staged_write now resolve in place, so the hint
  // branch is only reached by distribution_draft (feed) and the
  // staged_skill_* kinds (web).
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
            {row.approvalPayload.displayLines?.map((line, i) => (
              <div key={i} className="text-xs text-muted-foreground truncate">
                {line}
              </div>
            ))}
            {row.kind === "staged_write" && (
              <>
                <pre className="mt-1.5 text-[11px] font-mono bg-muted/50 border border-border rounded px-2 py-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-all max-w-2xl">
                  {JSON.stringify(row.arguments, null, 2)}
                </pre>
                <div className="text-xs text-muted-foreground mt-1.5">
                  {format(t.approvalsPage.stagedWrite.provenance, {
                    surface: stagedSurface ?? "",
                    origin: stagedOrigin,
                  })}
                </div>
              </>
            )}
            <div className="text-xs text-muted-foreground mt-0.5">
              {format(t.approvalsPage.age, {
                when: new Date(row.createdAt).toLocaleString(),
              })}
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
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={busy || batchBusy}
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
            </div>
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
