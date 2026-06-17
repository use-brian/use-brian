"use client";

/**
 * Inline editor for one connector instance's `ingest_rules` rows.
 *
 * Ported from `apps/web/src/components/ingest/rule-editor.tsx` for the app
 * consolidation (docs/plans/doc-web-app-consolidation.md §9 #5, CHUNK 4).
 *
 * app-web deltas vs apps/web:
 *   - Native `<select>`/`<option>` dropdowns are replaced with the project's
 *     `Select` primitive (root CLAUDE.md bans native selects outside the
 *     table-cell property editor).
 *   - `confirm()` is replaced with `confirmDialog()` (themed, Promise-returning).
 *
 * Backend surface: POST /api/ingest/sources/:instanceId/rules, PATCH
 * /api/ingest/rules/:ruleId, DELETE /api/ingest/rules/:ruleId
 * (packages/api/src/routes/ingest.ts). The filter_params field is a
 * free-form JSON object — its shape depends on filter_type and is
 * documented per filter in the placeholder hint.
 *
 * Spec: docs/architecture/brain/ingest-pipeline.md → "Rules engine" +
 * "Per-rule Episode sensitivity override".
 *
 * [COMP:app-web/studio-ingest-rule-editor]
 */

import { useState, useMemo } from "react";
import { authFetch } from "@/lib/auth-fetch";
import { useT } from "@/lib/i18n/client";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type EditableRule = {
  id: string;
  ruleOrder: number;
  filterType: string;
  filterParams: Record<string, unknown>;
  routingMode: "realtime" | "scheduled" | "drop";
  routingSchedule: string | null;
  routingTimezone: string;
  alert: boolean;
  episodeSensitivity: "public" | "internal" | "confidential" | null;
};

type DraftRule = {
  filterType: string;
  filterParamsText: string;
  routingMode: "realtime" | "scheduled" | "drop";
  routingSchedule: string;
  routingTimezone: string;
  alert: boolean;
  episodeSensitivity: "" | "public" | "internal" | "confidential";
  ruleOrder: string;
};

type Props = {
  instanceId: string;
  source: string;
  rules: EditableRule[];
  onChange: (next: EditableRule[]) => void;
};

const ROUTING_MODES = ["realtime", "scheduled", "drop"] as const;
const SENSITIVITY_OPTIONS = ["public", "internal", "confidential"] as const;

/**
 * Filter-type vocabulary per source. The engine + adapters define the
 * available filters; we surface the union of universal + source-specific
 * ones in the dropdown, with `always` always available as the catchall.
 * Unknown filter types still render — operators can type any string into
 * the input field below (the engine gracefully skips unknown ones).
 */
const FILTER_TYPES_BY_SOURCE: Record<string, string[]> = {
  slack: ["channel_match", "is_dm", "is_mention", "user_match", "always", "keyword_match", "mention_of", "user_flag"],
  gmail: ["sender_match", "sender_domain", "subject_contains", "to_match", "label_match", "always", "keyword_match", "user_flag"],
  github: ["event_type", "repo_match", "actor_match", "branch_match", "always"],
  calendar: ["attendee_match", "organizer_match", "subject_contains", "is_recurring", "always"],
  fathom: ["meeting_subject_contains", "attendee_match", "always"],
};

function defaultDraft(suggestedOrder: number): DraftRule {
  return {
    filterType: "always",
    filterParamsText: "{}",
    routingMode: "scheduled",
    routingSchedule: "0 9 * * 1-5",
    routingTimezone: "UTC",
    alert: false,
    episodeSensitivity: "",
    ruleOrder: String(suggestedOrder),
  };
}

function ruleToDraft(rule: EditableRule): DraftRule {
  return {
    filterType: rule.filterType,
    filterParamsText: JSON.stringify(rule.filterParams, null, 2),
    routingMode: rule.routingMode,
    routingSchedule: rule.routingSchedule ?? "",
    routingTimezone: rule.routingTimezone,
    alert: rule.alert,
    episodeSensitivity: rule.episodeSensitivity ?? "",
    ruleOrder: String(rule.ruleOrder),
  };
}

type DraftPayload = {
  filterType: string;
  filterParams: Record<string, unknown>;
  routingMode: "realtime" | "scheduled" | "drop";
  routingSchedule: string | null;
  routingTimezone: string;
  alert: boolean;
  episodeSensitivity: "public" | "internal" | "confidential" | null;
  ruleOrder?: number;
};

function parseDraft(
  draft: DraftRule,
  includeOrder: boolean,
): { ok: true; value: DraftPayload } | { ok: false; reason: string } {
  let filterParams: unknown;
  try {
    filterParams = JSON.parse(draft.filterParamsText || "{}");
  } catch {
    return { ok: false, reason: "filter-params-json" };
  }
  if (
    filterParams === null ||
    typeof filterParams !== "object" ||
    Array.isArray(filterParams)
  ) {
    return { ok: false, reason: "filter-params-shape" };
  }
  if (draft.routingMode === "scheduled" && !draft.routingSchedule.trim()) {
    return { ok: false, reason: "schedule-required" };
  }
  if (draft.routingMode !== "scheduled" && draft.routingSchedule.trim()) {
    return { ok: false, reason: "schedule-not-allowed" };
  }
  let ruleOrder: number | undefined;
  if (includeOrder) {
    const n = Number(draft.ruleOrder);
    if (!Number.isInteger(n) || n < 0) {
      return { ok: false, reason: "rule-order" };
    }
    ruleOrder = n;
  }
  return {
    ok: true,
    value: {
      filterType: draft.filterType,
      filterParams: filterParams as Record<string, unknown>,
      routingMode: draft.routingMode,
      routingSchedule:
        draft.routingMode === "scheduled" ? draft.routingSchedule.trim() : null,
      routingTimezone: draft.routingTimezone.trim() || "UTC",
      alert: draft.alert,
      episodeSensitivity: draft.episodeSensitivity === "" ? null : draft.episodeSensitivity,
      ruleOrder,
    },
  };
}

function paramsHint(filterType: string): string {
  switch (filterType) {
    case "channel_match":
      return '{"values":["C0ABC1234"]}';
    case "is_mention":
    case "user_match":
    case "actor_match":
    case "sender_match":
    case "mention_of":
    case "to_match":
    case "attendee_match":
    case "organizer_match":
      return '{"values":["U0XYZ987","alice@acme.com"]}';
    case "keyword_match":
    case "subject_contains":
    case "meeting_subject_contains":
      return '{"keywords":["urgent","asap"]}';
    case "event_type":
      return '{"values":["pull_request.merged"]}';
    case "user_flag":
      return '{"values":[":bookmark:","/save"]}';
    case "is_dm":
    case "is_recurring":
    case "always":
      return "{}";
    default:
      return "{}";
  }
}

export function IngestRuleEditor({ instanceId, source, rules, onChange }: Props) {
  const t = useT();
  const copy = t.studioPage.ingestRules.editor;

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftRule | null>(null);
  const [addingDraft, setAddingDraft] = useState<DraftRule | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filterTypeOptions = useMemo(
    () => FILTER_TYPES_BY_SOURCE[source] ?? ["always"],
    [source],
  );

  function startEdit(rule: EditableRule) {
    setEditingId(rule.id);
    setDraft(ruleToDraft(rule));
    setAddingDraft(null);
    setError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft(null);
    setError(null);
  }

  function startAdd() {
    const nextOrder = rules.length === 0 ? 0 : Math.max(...rules.map((r) => r.ruleOrder)) + 1;
    setAddingDraft(defaultDraft(nextOrder));
    setEditingId(null);
    setDraft(null);
    setError(null);
  }

  function cancelAdd() {
    setAddingDraft(null);
    setError(null);
  }

  function reasonToCopy(reason: string): string {
    switch (reason) {
      case "filter-params-json":
        return copy.errors.filterParamsJson;
      case "filter-params-shape":
        return copy.errors.filterParamsShape;
      case "schedule-required":
        return copy.errors.scheduleRequired;
      case "schedule-not-allowed":
        return copy.errors.scheduleNotAllowed;
      case "rule-order":
        return copy.errors.ruleOrder;
      default:
        return copy.errors.unknown;
    }
  }

  async function saveEdit() {
    if (!editingId || !draft) return;
    const parsed = parseDraft(draft, true);
    if (!parsed.ok) {
      setError(reasonToCopy(parsed.reason));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await authFetch(`${API_URL}/api/ingest/rules/${editingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.value),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: unknown };
        throw new Error(typeof body?.error === "string" ? body.error : copy.errors.unknown);
      }
      const data = (await res.json()) as { rule: EditableRule };
      onChange(
        rules
          .map((r) => (r.id === editingId ? data.rule : r))
          .sort((a, b) => a.ruleOrder - b.ruleOrder),
      );
      cancelEdit();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveAdd() {
    if (!addingDraft) return;
    const parsed = parseDraft(addingDraft, true);
    if (!parsed.ok) {
      setError(reasonToCopy(parsed.reason));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await authFetch(
        `${API_URL}/api/ingest/sources/${instanceId}/rules`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(parsed.value),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: unknown };
        throw new Error(typeof body?.error === "string" ? body.error : copy.errors.unknown);
      }
      const data = (await res.json()) as { rule: EditableRule };
      onChange([...rules, data.rule].sort((a, b) => a.ruleOrder - b.ruleOrder));
      cancelAdd();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteRule(ruleId: string) {
    const ok = await confirmDialog({
      description: copy.deleteConfirm,
      confirmLabel: copy.deleteAction,
      cancelLabel: copy.cancel,
      variant: "destructive",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const res = await authFetch(`${API_URL}/api/ingest/rules/${ruleId}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 204) {
        throw new Error(copy.errors.deleteFailed);
      }
      onChange(rules.filter((r) => r.id !== ruleId));
      if (editingId === ruleId) cancelEdit();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function renderDraftForm(
    current: DraftRule,
    update: (d: DraftRule) => void,
    onSave: () => void,
    onCancel: () => void,
  ) {
    return (
      <div className="flex flex-col gap-2 bg-background border border-border rounded-md p-3">
        <div className="grid grid-cols-2 gap-2 text-xs">
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">{copy.labels.ruleOrder}</span>
            <input
              type="number"
              min={0}
              value={current.ruleOrder}
              onChange={(e) => update({ ...current, ruleOrder: e.target.value })}
              className="bg-muted px-2 py-1 rounded border border-border focus:outline-none focus:border-primary/50"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">{copy.labels.filterType}</span>
            <Select
              value={current.filterType}
              onValueChange={(v) => {
                if (v) update({ ...current, filterType: v });
              }}
            >
              <SelectTrigger size="sm" className="text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {filterTypeOptions.map((ft) => (
                  <SelectItem key={ft} value={ft}>{ft}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        </div>

        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">{copy.labels.filterParams}</span>
          <textarea
            value={current.filterParamsText}
            onChange={(e) => update({ ...current, filterParamsText: e.target.value })}
            placeholder={paramsHint(current.filterType)}
            spellCheck={false}
            rows={3}
            className="bg-muted px-2 py-1 rounded border border-border font-mono text-[11px] focus:outline-none focus:border-primary/50"
          />
          <span className="text-[10px] text-muted-foreground/70">
            {copy.labels.filterParamsHint.replace("{example}", paramsHint(current.filterType))}
          </span>
        </label>

        <div className="grid grid-cols-2 gap-2 text-xs">
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">{copy.labels.routingMode}</span>
            <Select
              value={current.routingMode}
              onValueChange={(v) => {
                if (v === "realtime" || v === "scheduled" || v === "drop") {
                  update({
                    ...current,
                    routingMode: v,
                    routingSchedule:
                      v === "scheduled" ? current.routingSchedule : "",
                  });
                }
              }}
            >
              <SelectTrigger size="sm" className="text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROUTING_MODES.map((m) => (
                  <SelectItem key={m} value={m}>{m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">{copy.labels.sensitivity}</span>
            <Select
              value={current.episodeSensitivity || "__default__"}
              onValueChange={(v) =>
                update({
                  ...current,
                  episodeSensitivity:
                    v === "__default__" ? "" : (v as DraftRule["episodeSensitivity"]),
                })
              }
            >
              <SelectTrigger size="sm" className="text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__default__">{copy.sensitivityDefault}</SelectItem>
                {SENSITIVITY_OPTIONS.map((s) => (
                  <SelectItem key={s} value={s}>{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        </div>

        {current.routingMode === "scheduled" && (
          <div className="grid grid-cols-2 gap-2 text-xs">
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground">{copy.labels.routingSchedule}</span>
              <input
                type="text"
                value={current.routingSchedule}
                onChange={(e) => update({ ...current, routingSchedule: e.target.value })}
                placeholder="0 9 * * 1-5"
                className="bg-muted px-2 py-1 rounded border border-border font-mono text-[11px] focus:outline-none focus:border-primary/50"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground">{copy.labels.routingTimezone}</span>
              <input
                type="text"
                value={current.routingTimezone}
                onChange={(e) => update({ ...current, routingTimezone: e.target.value })}
                placeholder="UTC"
                className="bg-muted px-2 py-1 rounded border border-border focus:outline-none focus:border-primary/50"
              />
            </label>
          </div>
        )}

        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={current.alert}
            onChange={(e) => update({ ...current, alert: e.target.checked })}
            className="accent-primary"
          />
          <span className="text-muted-foreground">{copy.labels.alert}</span>
        </label>

        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={onSave}
            disabled={busy}
            className="text-xs font-medium bg-primary text-primary-foreground px-3 py-1 rounded-lg hover:bg-primary/90 disabled:opacity-40"
          >
            {busy ? copy.saving : copy.save}
          </button>
          <button
            onClick={onCancel}
            disabled={busy}
            className="text-xs font-medium border border-border text-muted-foreground px-3 py-1 rounded-lg hover:bg-muted disabled:opacity-40"
          >
            {copy.cancel}
          </button>
          {error && <span className="text-[11px] text-destructive">{error}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {rules.length === 0 && !addingDraft ? (
        <p className="text-[11px] text-muted-foreground italic">{copy.emptyRules}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {rules.map((rule) => (
            <li key={rule.id}>
              {editingId === rule.id && draft ? (
                renderDraftForm(draft, setDraft as (d: DraftRule) => void, saveEdit, cancelEdit)
              ) : (
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground/70 font-mono shrink-0 w-6 text-right">{rule.ruleOrder}</span>
                  <span className="font-medium shrink-0">{rule.filterType}</span>
                  <span className="text-muted-foreground/70 font-mono text-[10px] truncate flex-1">
                    {JSON.stringify(rule.filterParams)}
                  </span>
                  <span
                    className={`px-1.5 py-0.5 rounded shrink-0 ${
                      rule.routingMode === "realtime"
                        ? "text-primary bg-primary/10"
                        : rule.routingMode === "scheduled"
                          ? "text-blue-600 dark:text-blue-400 bg-blue-500/10"
                          : "text-muted-foreground bg-muted"
                    }`}
                  >
                    {rule.routingMode}
                  </span>
                  {rule.routingSchedule && (
                    <code className="text-[10px] text-muted-foreground/70 font-mono shrink-0">
                      {rule.routingSchedule}
                    </code>
                  )}
                  {rule.episodeSensitivity && (
                    <span className="text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-400 shrink-0">
                      {rule.episodeSensitivity}
                    </span>
                  )}
                  <button
                    onClick={() => startEdit(rule)}
                    disabled={busy}
                    className="text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40 shrink-0"
                  >
                    {copy.editAction}
                  </button>
                  <button
                    onClick={() => deleteRule(rule.id)}
                    disabled={busy}
                    className="text-[11px] text-muted-foreground hover:text-destructive disabled:opacity-40 shrink-0"
                  >
                    {copy.deleteAction}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {addingDraft ? (
        renderDraftForm(addingDraft, setAddingDraft as (d: DraftRule) => void, saveAdd, cancelAdd)
      ) : (
        <button
          onClick={startAdd}
          disabled={busy}
          className="self-start text-[11px] font-medium text-primary hover:underline disabled:opacity-40"
        >
          {copy.addAction}
        </button>
      )}
    </div>
  );
}
