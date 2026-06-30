"use client";

/**
 * Preflight headers editor for a custom MCP connector's Settings tab.
 *
 * Non-secret operational headers (tenant, tracing, routing) persisted to the
 * connector's `config.preflightHeaders` and merged over its auth headers at
 * injection time. Self-contained: holds the editable rows, validates via the
 * pure helper, and delegates persistence to `onSave` (the page's `saveConfig`).
 * Mount it with `key={connectorId}` and a loaded `initial` so switching
 * connectors resets the rows.
 *
 * Spec: docs/architecture/engine/tool-hooks.md.
 */

import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import {
  buildPreflightHeadersPayload,
  type PreflightHeaderRow,
  type PreflightHeadersError,
} from "@/lib/connector-preflight-headers";

const FIELD =
  "flex-1 min-w-0 text-sm bg-background border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30";

export function PreflightHeadersSection({
  initial,
  onSave,
}: {
  initial: PreflightHeaderRow[];
  onSave: (rows: PreflightHeaderRow[]) => Promise<void>;
}) {
  const t = useT();
  const tc = t.settings.connectors;
  const [rows, setRows] = useState<PreflightHeaderRow[]>(initial);
  const [error, setError] = useState<{ index: number; key: PreflightHeadersError } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  function setRow(i: number, patch: Partial<PreflightHeaderRow>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
    setError(null);
    setSaved(false);
  }
  function addRow() {
    setRows((prev) => [...prev, { name: "", value: "" }]);
    setSaved(false);
  }
  function removeRow(i: number) {
    setRows((prev) => prev.filter((_, idx) => idx !== i));
    setError(null);
    setSaved(false);
  }
  async function save() {
    const built = buildPreflightHeadersPayload(rows);
    if (!built.ok) {
      setError({ index: built.index, key: built.error });
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await onSave(built.payload);
      setRows(built.payload);
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  const errorText = error
    ? error.key === "invalidName"
      ? tc.preflightErrInvalidName
      : error.key === "duplicateName"
        ? tc.preflightErrDuplicate
        : tc.preflightErrEmptyValue
    : null;

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <div>
        <div className="text-sm font-medium">{tc.preflightTitle}</div>
        <div className="text-[11px] text-muted-foreground mt-0.5">{tc.preflightDesc}</div>
      </div>

      {rows.length === 0 && (
        <div className="text-[11px] text-muted-foreground">{tc.preflightEmpty}</div>
      )}

      {rows.map((row, i) => (
        <div key={i} className="space-y-1">
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder={tc.preflightNamePlaceholder}
              value={row.name}
              onChange={(e) => setRow(i, { name: e.target.value })}
              className={FIELD}
            />
            <input
              type="text"
              placeholder={tc.preflightValuePlaceholder}
              value={row.value}
              onChange={(e) => setRow(i, { value: e.target.value })}
              className={FIELD}
            />
            <button
              type="button"
              onClick={() => removeRow(i)}
              className="text-xs font-medium border border-border px-3 py-1.5 rounded-lg text-muted-foreground hover:bg-muted transition-colors shrink-0"
            >
              {tc.preflightRemove}
            </button>
          </div>
          {error?.index === i && errorText && (
            <div className="text-[11px] text-destructive">{errorText}</div>
          )}
        </div>
      ))}

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={addRow}
          className="text-xs font-medium border border-border px-3 py-1.5 rounded-lg text-muted-foreground hover:bg-muted transition-colors"
        >
          {tc.preflightAddRow}
        </button>
        <div className="flex items-center gap-2">
          {saved && (
            <span className="text-[11px] text-emerald-600 dark:text-emerald-400">{tc.preflightSaved}</span>
          )}
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="text-xs font-medium bg-primary text-primary-foreground px-4 py-1.5 rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {tc.preflightSave}
          </button>
        </div>
      </div>
    </div>
  );
}
