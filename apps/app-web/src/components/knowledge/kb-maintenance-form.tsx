"use client";

/**
 * Self-maintain agent config — the mandatory-field enable form on the focused
 * knowledge source (Studio → Knowledge master-detail, plan D5/D6).
 *
 * Every field is part of the anti-slop contract (charter, path scope, signal,
 * update-over-create threshold, style contract, sensitivity ceiling, weekly
 * proposal budget) and the server rejects a config without them. Saving
 * PUTs `/sources/:id/maintenance`, which (re)materializes the managed
 * workflow; proposals land in the Approvals inbox (suggestion-first).
 *
 * Spec: docs/architecture/features/knowledge-base.md → "Self-maintain agents".
 * [COMP:app-web/kb-maintenance-form]
 */

import { useCallback, useEffect, useState } from "react";
import { authFetch } from "@/lib/auth-fetch";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { Switch } from "@/components/ui/switch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

type Sensitivity = "public" | "internal" | "confidential";

type MaintenanceAgent = {
  id: string;
  sourceId: string;
  workflowId: string | null;
  enabled: boolean;
  charter: string;
  pathScope: string[];
  signals: { mode: "events" } | { mode: "daily"; time: string };
  similarityThreshold: number;
  styleContract: string;
  sensitivityCeiling: Sensitivity;
  weeklyProposalBudget: number;
};

type MaintenanceResponse = {
  agent: MaintenanceAgent | null;
  attemptsThisWeek?: number;
  writable: boolean;
};

const SENSITIVITY_TIERS: Sensitivity[] = ["public", "internal", "confidential"];

export function KbMaintenanceForm({
  workspaceId,
  sourceId,
}: {
  workspaceId: string;
  sourceId: string;
}) {
  const t = useT();
  const copy = t.studioPage.knowledgePage.maintenance;

  const [loaded, setLoaded] = useState(false);
  const [agent, setAgent] = useState<MaintenanceAgent | null>(null);
  const [attempts, setAttempts] = useState(0);
  const [writable, setWritable] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Form state
  const [enabled, setEnabled] = useState(true);
  const [charter, setCharter] = useState("");
  const [pathScope, setPathScope] = useState("");
  const [signalMode, setSignalMode] = useState<"events" | "daily">("events");
  const [dailyTime, setDailyTime] = useState("09:00");
  const [thresholdPct, setThresholdPct] = useState(80);
  const [styleContract, setStyleContract] = useState("");
  const [ceiling, setCeiling] = useState<Sensitivity>("internal");
  const [budget, setBudget] = useState(5);

  const load = useCallback(async () => {
    try {
      const res = await authFetch(
        `${API_URL}/api/workspaces/${workspaceId}/knowledge/sources/${sourceId}/maintenance`,
      );
      if (!res.ok) {
        setLoaded(true);
        return;
      }
      const data = (await res.json()) as MaintenanceResponse;
      setAgent(data.agent);
      setAttempts(data.attemptsThisWeek ?? 0);
      setWritable(data.writable);
      setLoaded(true);
    } catch {
      setLoaded(true);
    }
  }, [workspaceId, sourceId]);

  useEffect(() => {
    setLoaded(false);
    setAgent(null);
    setEditing(false);
    setSaveError(null);
    void load();
  }, [load]);

  const beginEdit = useCallback(() => {
    if (agent) {
      setEnabled(agent.enabled);
      setCharter(agent.charter);
      setPathScope(agent.pathScope.join("\n"));
      setSignalMode(agent.signals.mode);
      setDailyTime(agent.signals.mode === "daily" ? agent.signals.time : "09:00");
      setThresholdPct(Math.round(agent.similarityThreshold * 100));
      setStyleContract(agent.styleContract);
      setCeiling(agent.sensitivityCeiling);
      setBudget(agent.weeklyProposalBudget);
    } else {
      setEnabled(true);
      setCharter("");
      setPathScope("");
      setSignalMode("events");
      setDailyTime("09:00");
      setThresholdPct(80);
      setStyleContract(copy.styleContractDefault);
      setCeiling("internal");
      setBudget(5);
    }
    setSaveError(null);
    setEditing(true);
  }, [agent, copy.styleContractDefault]);

  const save = useCallback(async () => {
    const scope = pathScope
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    setSaving(true);
    setSaveError(null);
    try {
      const res = await authFetch(
        `${API_URL}/api/workspaces/${workspaceId}/knowledge/sources/${sourceId}/maintenance`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            enabled,
            charter: charter.trim(),
            pathScope: scope,
            signals:
              signalMode === "daily"
                ? { mode: "daily", time: dailyTime }
                : { mode: "events" },
            similarityThreshold: thresholdPct / 100,
            styleContract: styleContract.trim(),
            sensitivityCeiling: ceiling,
            weeklyProposalBudget: budget,
          }),
        },
      );
      if (res.ok) {
        setEditing(false);
        await load();
      } else {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setSaveError(err.error ?? copy.saveError);
      }
    } catch {
      setSaveError(copy.saveError);
    } finally {
      setSaving(false);
    }
  }, [
    budget, ceiling, charter, copy.saveError, dailyTime, enabled, load,
    pathScope, signalMode, sourceId, styleContract, thresholdPct, workspaceId,
  ]);

  const remove = useCallback(async () => {
    const ok = await confirmDialog({
      description: copy.removeConfirm,
      confirmLabel: copy.removeAction,
      cancelLabel: copy.cancel,
      variant: "destructive",
    });
    if (!ok) return;
    try {
      const res = await authFetch(
        `${API_URL}/api/workspaces/${workspaceId}/knowledge/sources/${sourceId}/maintenance`,
        { method: "DELETE" },
      );
      if (res.ok) {
        setAgent(null);
        setEditing(false);
      }
    } catch {
      /* surfaced on next load */
    }
  }, [copy.cancel, copy.removeAction, copy.removeConfirm, sourceId, workspaceId]);

  const toggleEnabled = useCallback(
    async (next: boolean) => {
      if (!agent) return;
      // Optimistic flip; the PUT re-materializes with the stored config.
      setAgent({ ...agent, enabled: next });
      try {
        const res = await authFetch(
          `${API_URL}/api/workspaces/${workspaceId}/knowledge/sources/${sourceId}/maintenance`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              enabled: next,
              charter: agent.charter,
              pathScope: agent.pathScope,
              signals: agent.signals,
              similarityThreshold: agent.similarityThreshold,
              styleContract: agent.styleContract,
              sensitivityCeiling: agent.sensitivityCeiling,
              weeklyProposalBudget: agent.weeklyProposalBudget,
            }),
          },
        );
        if (!res.ok) setAgent({ ...agent, enabled: !next });
      } catch {
        setAgent({ ...agent, enabled: !next });
      }
    },
    [agent, sourceId, workspaceId],
  );

  if (!loaded) {
    return <div className="text-xs text-muted-foreground">{copy.loading}</div>;
  }

  // ── Summary view (agent exists, not editing) ─────────────────
  if (agent && !editing) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium">
                {agent.enabled ? copy.statusOn : copy.statusOff}
              </span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {copy.suggestionFirstBadge}
              </span>
            </div>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {format(copy.budgetUsage, {
                used: String(attempts),
                budget: String(agent.weeklyProposalBudget),
              })}
            </p>
          </div>
          <Switch checked={agent.enabled} onCheckedChange={(v) => void toggleEnabled(v)} />
        </div>
        <p className="text-[12px] leading-relaxed text-muted-foreground line-clamp-3 whitespace-pre-wrap">
          {agent.charter}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {agent.pathScope.map((p) => (
            <span key={p} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              {p}
            </span>
          ))}
          <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {agent.signals.mode === "daily"
              ? format(copy.signalDailyChip, { time: agent.signals.time })
              : copy.signalEventsChip}
          </span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {format(copy.ceilingChip, { tier: t.studioPage.knowledgePage.tiers[agent.sensitivityCeiling] })}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={beginEdit}
            className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted"
          >
            {copy.editAction}
          </button>
          <button
            onClick={() => void remove()}
            className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-destructive/30 hover:text-destructive"
          >
            {copy.removeAction}
          </button>
        </div>
      </div>
    );
  }

  // ── Empty state (no agent, not editing) ──────────────────────
  if (!editing) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          {copy.intro}
        </p>
        {!writable ? (
          <p className="text-[12px] leading-relaxed text-amber-600 dark:text-amber-400">
            {copy.notWritable}
          </p>
        ) : (
          <div>
            <button
              onClick={beginEdit}
              className="rounded-lg bg-action px-3 py-1.5 text-xs font-medium text-action-foreground transition-colors hover:bg-action/90"
            >
              {copy.setUpAction}
            </button>
          </div>
        )}
      </div>
    );
  }

  // ── Edit form ────────────────────────────────────────────────
  const scopeCount = pathScope.split(/[\n,]/).map((s) => s.trim()).filter(Boolean).length;
  const valid =
    charter.trim().length >= 40 &&
    scopeCount >= 1 &&
    styleContract.trim().length >= 20 &&
    budget >= 1 && budget <= 100 &&
    thresholdPct >= 50 && thresholdPct <= 100 &&
    (signalMode !== "daily" || /^\d{2}:\d{2}$/.test(dailyTime));

  return (
    <div className="flex flex-col gap-3">
      <Field label={copy.charterLabel} help={copy.charterHelp}>
        <textarea
          value={charter}
          onChange={(e) => setCharter(e.target.value)}
          rows={3}
          placeholder={copy.charterPlaceholder}
          className={fieldCls}
        />
        {charter.trim().length > 0 && charter.trim().length < 40 && (
          <span className="text-[11px] text-amber-600 dark:text-amber-400">{copy.charterTooShort}</span>
        )}
      </Field>

      <Field label={copy.scopeLabel} help={copy.scopeHelp}>
        <textarea
          value={pathScope}
          onChange={(e) => setPathScope(e.target.value)}
          rows={2}
          placeholder={copy.scopePlaceholder}
          className={cn(fieldCls, "font-mono")}
        />
      </Field>

      <Field label={copy.signalLabel} help={copy.signalHelp}>
        <div className="flex items-center gap-2">
          <SegButton active={signalMode === "events"} onClick={() => setSignalMode("events")}>
            {copy.signalEvents}
          </SegButton>
          <SegButton active={signalMode === "daily"} onClick={() => setSignalMode("daily")}>
            {copy.signalDaily}
          </SegButton>
          {signalMode === "daily" && (
            <input
              type="time"
              value={dailyTime}
              onChange={(e) => setDailyTime(e.target.value)}
              className="rounded-lg border border-border bg-muted/50 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          )}
        </div>
      </Field>

      <Field label={copy.thresholdLabel} help={copy.thresholdHelp}>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={50}
            max={100}
            step={5}
            value={thresholdPct}
            onChange={(e) => setThresholdPct(Number(e.target.value))}
            className="w-40 accent-primary"
          />
          <span className="text-xs tabular-nums text-muted-foreground">{thresholdPct}%</span>
        </div>
      </Field>

      <Field label={copy.styleLabel} help={copy.styleHelp}>
        <textarea
          value={styleContract}
          onChange={(e) => setStyleContract(e.target.value)}
          rows={4}
          className={fieldCls}
        />
      </Field>

      <Field label={copy.ceilingLabel} help={copy.ceilingHelp}>
        <div className="flex items-center gap-2">
          {SENSITIVITY_TIERS.map((tier) => (
            <SegButton key={tier} active={ceiling === tier} onClick={() => setCeiling(tier)}>
              {t.studioPage.knowledgePage.tiers[tier]}
            </SegButton>
          ))}
        </div>
      </Field>

      <Field label={copy.budgetLabel} help={copy.budgetHelp}>
        <input
          type="number"
          min={1}
          max={100}
          value={budget}
          onChange={(e) => setBudget(Math.floor(Number(e.target.value)))}
          className={cn(fieldCls, "w-24 tabular-nums")}
        />
      </Field>

      {saveError && (
        <div className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
          {saveError}
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          onClick={() => setEditing(false)}
          disabled={saving}
          className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
        >
          {copy.cancel}
        </button>
        <button
          onClick={() => void save()}
          disabled={saving || !valid}
          className="rounded-lg bg-action px-3 py-1.5 text-xs font-medium text-action-foreground transition-colors hover:bg-action/90 disabled:opacity-50"
        >
          {saving ? copy.saving : copy.save}
        </button>
      </div>
    </div>
  );
}

const fieldCls =
  "w-full rounded-lg border border-border bg-muted/50 px-3 py-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-primary/30";

function Field({
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

function SegButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-lg px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? "bg-action text-action-foreground"
          : "border border-border text-muted-foreground hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}
