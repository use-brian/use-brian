"use client";

/**
 * Task rules settings — the review surface for the task admission gate.
 *
 * Rules are authored in conversation ("stop making tasks out of standup
 * chatter"). This infrequent management surface lives with the Tasks
 * operator app rather than occupying permanent Studio navigation: inspect
 * what is enforced, turn a rule on or off, delete one, activate a proposed
 * rule, and forget a rejection that no longer applies.
 *
 * Spec: docs/architecture/features/task-guardrails.md
 * [COMP:app-web/task-rules]
 */

import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, Trash2, X } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { ResizablePeek } from "@/components/operator/resizable-peek";
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

export function TaskRulesPanel({
  workspaceId,
  onClose,
}: {
  workspaceId: string;
  onClose: () => void;
}) {
  const tasksT = useT().tasksPage;
  const t = tasksT.guardrails;

  const [rules, setRules] = useState<TaskRule[] | null>(null);
  const [tombstones, setTombstones] = useState<TaskTombstone[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const [nextRules, nextTombstones] = await Promise.all([
        loadTaskRules(workspaceId),
        loadTaskTombstones(workspaceId),
      ]);
      setRules(nextRules);
      setTombstones(nextTombstones);
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
        setRules((previous) =>
          (previous ?? []).map((candidate) =>
            candidate.id === rule.id ? updated : candidate,
          ),
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
        setRules((previous) =>
          (previous ?? []).filter((candidate) => candidate.id !== rule.id),
        );
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
        setTombstones((previous) =>
          previous.filter((candidate) => candidate.id !== tombstone.id),
        );
      } catch {
        setError(t.rulesLoadFailed);
      }
    },
    [workspaceId, t.rejectionForget, t.cancel, t.rulesLoadFailed],
  );

  return (
    <ResizablePeek
      storageKey="operator:peek-width"
      ariaLabel={t.rulesTitle}
      onDismiss={onClose}
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <ShieldCheck className="size-4 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {t.rulesTitle}
        </span>
        <button
          type="button"
          aria-label={tasksT.closeDetail}
          onClick={onClose}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
          <section>
            <h1 className="text-base font-medium text-foreground">
              {t.rulesTitle}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t.rulesSubtitle}
            </p>

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
                            {rule.effect === "deny"
                              ? t.ruleDeny
                              : t.ruleRequire}
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
                            className="rounded bg-action px-2 py-1 text-xs text-action-foreground disabled:opacity-50"
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
                {tombstones.map((tombstone) => (
                  <li
                    key={tombstone.id}
                    className="flex items-start gap-3 rounded-md border border-border/60 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-foreground">
                        {tombstone.title}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {tombstone.reason}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void forget(tombstone)}
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
      </div>
    </ResizablePeek>
  );
}

/** A rule with no deterministic condition rides the extraction prompt. */
function isGuidanceOnly(rule: TaskRule): boolean {
  const predicate = rule.predicate;
  return (
    !predicate.source_kinds?.length &&
    !predicate.lanes?.length &&
    !predicate.title_matches?.length &&
    !predicate.channel_refs?.length
  );
}
