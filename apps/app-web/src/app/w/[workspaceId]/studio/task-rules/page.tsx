"use client";

/**
 * Studio → Task rules — the review list for the task admission gate.
 *
 * Spec: docs/architecture/features/task-guardrails.md
 *
 * Rules are AUTHORED in conversation ("stop making tasks out of standup
 * chatter"); the assistant compiles each into a stored predicate plus the
 * user's own sentence. This page is where those rows become inspectable: read
 * what is enforced, turn a rule on or off, delete one, and activate a rule the
 * system PROPOSED after repeated rejections. There is no create form on
 * purpose - the natural-language path is the authoring surface, and a second
 * one would drift from it.
 *
 * The rejection log below the rules is the other half of the memory: every
 * "not a task, because…" the workspace has recorded, each removable when a
 * lesson stops applying.
 *
 * [COMP:app-web/studio-task-rules]
 */

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Trash2 } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  deleteTaskRule,
  deleteTaskTombstone,
  describeTaskRulePredicate,
  loadTaskRules,
  loadTaskTombstones,
  setTaskRuleStatus,
  type TaskRule,
  type TaskTombstone,
} from "@/lib/api/task-guardrails";

export default function StudioTaskRulesPage() {
  const params = useParams<{ workspaceId: string }>();
  const workspaceId = params?.workspaceId ?? "";
  const t = useT().tasksPage.guardrails;

  const [rules, setRules] = useState<TaskRule[] | null>(null);
  const [tombstones, setTombstones] = useState<TaskTombstone[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const [r, ts] = await Promise.all([
        loadTaskRules(workspaceId),
        loadTaskTombstones(workspaceId),
      ]);
      setRules(r);
      setTombstones(ts);
      setError(null);
    } catch {
      setRules([]);
      setError(t.rulesLoadFailed);
    }
  }, [workspaceId, t.rulesLoadFailed]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = useCallback(
    async (rule: TaskRule, next: "active" | "disabled") => {
      setBusyId(rule.id);
      try {
        const updated = await setTaskRuleStatus(workspaceId, rule.id, next);
        setRules((prev) =>
          (prev ?? []).map((r) => (r.id === rule.id ? updated : r)),
        );
      } catch {
        setError(t.rulesLoadFailed);
      } finally {
        setBusyId(null);
      }
    },
    [workspaceId, t.rulesLoadFailed],
  );

  const remove = useCallback(
    async (rule: TaskRule) => {
      const ok = await confirmDialog({
        title: t.ruleDelete,
        description: rule.nlClause ?? describeTaskRulePredicate(rule.predicate),
        confirmLabel: t.ruleDelete,
        cancelLabel: t.cancel,
        variant: "destructive",
      });
      if (!ok) return;
      setBusyId(rule.id);
      try {
        await deleteTaskRule(workspaceId, rule.id);
        setRules((prev) => (prev ?? []).filter((r) => r.id !== rule.id));
      } catch {
        setError(t.rulesLoadFailed);
      } finally {
        setBusyId(null);
      }
    },
    [workspaceId, t.ruleDelete, t.cancel, t.rulesLoadFailed],
  );

  const forget = useCallback(
    async (tombstone: TaskTombstone) => {
      const ok = await confirmDialog({
        title: t.rejectionForget,
        description: tombstone.title,
        confirmLabel: t.rejectionForget,
        cancelLabel: t.cancel,
        variant: "destructive",
      });
      if (!ok) return;
      try {
        await deleteTaskTombstone(workspaceId, tombstone.id);
        setTombstones((prev) => prev.filter((x) => x.id !== tombstone.id));
      } catch {
        setError(t.rulesLoadFailed);
      }
    },
    [workspaceId, t.rejectionForget, t.cancel, t.rulesLoadFailed],
  );

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-6">
      <section>
        <h1 className="text-base font-medium text-foreground">
          {t.rulesTitle}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t.rulesSubtitle}</p>

        {error ? (
          <p className="mt-3 text-sm text-destructive">{error}</p>
        ) : null}

        {rules !== null && rules.length === 0 ? (
          <p className="mt-4 rounded-md border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
            {t.rulesEmpty}
          </p>
        ) : null}

        <ul className="mt-4 flex flex-col gap-2">
          {(rules ?? []).map((rule) => {
            const guidanceOnly = isGuidanceOnly(rule);
            return (
              <li
                key={rule.id}
                className="rounded-md border border-border px-3 py-2.5"
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        {rule.effect === "deny" ? t.ruleDeny : t.ruleRequire}
                      </span>
                      {rule.status === "proposed" ? (
                        <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-700 dark:text-amber-400">
                          {t.ruleProposed}
                        </span>
                      ) : null}
                      {guidanceOnly ? (
                        <span
                          title={t.ruleGuidanceHint}
                          className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                        >
                          {t.ruleGuidanceOnly}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-sm text-foreground">
                      {rule.nlClause ??
                        describeTaskRulePredicate(rule.predicate)}
                    </p>
                    {rule.nlClause ? (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {describeTaskRulePredicate(rule.predicate)}
                      </p>
                    ) : null}
                    {rule.status === "proposed" ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t.ruleProposedHint}
                        {rule.reason ? ` ${rule.reason}` : ""}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    {rule.status === "active" ? (
                      <button
                        type="button"
                        disabled={busyId === rule.id}
                        onClick={() => void toggle(rule, "disabled")}
                        className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
                      >
                        {t.ruleDisable}
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busyId === rule.id}
                        onClick={() => void toggle(rule, "active")}
                        className="rounded bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50"
                      >
                        {rule.status === "proposed"
                          ? t.ruleActivate
                          : t.ruleEnable}
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label={t.ruleDelete}
                      disabled={busyId === rule.id}
                      onClick={() => void remove(rule)}
                      className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-50"
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section>
        <h2 className="text-sm font-medium text-foreground">
          {t.rejectionsTitle}
        </h2>
        {tombstones.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            {t.rejectionsEmpty}
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1.5">
            {tombstones.map((ts) => (
              <li
                key={ts.id}
                className="flex items-start gap-3 rounded-md border border-border/60 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-foreground">{ts.title}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {ts.reason}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void forget(ts)}
                  className="shrink-0 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
                >
                  {t.rejectionForget}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * A rule with no machine-checkable condition can only ride the extraction
 * prompt, so the list says so rather than implying a guarantee it cannot make.
 */
function isGuidanceOnly(rule: TaskRule): boolean {
  const p = rule.predicate;
  return (
    !p.source_kinds?.length &&
    !p.lanes?.length &&
    !p.title_matches?.length &&
    !p.channel_refs?.length
  );
}
