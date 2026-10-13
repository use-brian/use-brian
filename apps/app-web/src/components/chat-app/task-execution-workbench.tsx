"use client";

/**
 * Task execution workbench (chat-app.md -> "Task execution workbench"): the
 * admitted execution of one assistant-executed task, with its plan and source
 * basis, readiness, branches, WIP, allowance, last control and external
 * sessions, plus a task-bound steering input and Pause / Continue.
 *
 * Viewing only reads: it never starts an attempt and never renews. Every
 * control carries the displayed control revision and a fresh intervention id;
 * a stale receipt reloads the card instead of retrying. The server derives the
 * actor and decides renewal; the disclosure says what continuing does.
 *
 * Freshness rides the event spine (`task-execution:` marks stale on every
 * brain refresh). A 404 means the viewer can no longer see it: the fetch
 * resolves to a `notFound` value that REPLACES any cached projection, so
 * revoked protected data is never left on screen (and nothing loops).
 *
 * [COMP:app-web/task-execution-workbench]
 */
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/skeleton";
import { format, useT } from "@/lib/i18n/client";
import {
  controlTaskExecution,
  fetchTaskExecution,
  remainingAllowance,
  TaskExecutionError,
  type ControlAction,
  type TaskExecution,
} from "@/lib/api/task-execution";
import { requestBrainRefresh } from "@/lib/brain-events";
import { mutateSurfaceCache, useCachedResource } from "@/lib/surface-cache";
import { taskExecutionCacheKey } from "@/lib/surface-prefetch";

type ExecT = ReturnType<typeof useT>["chatApp"]["taskExecution"];

const money = (n: number) => `$${n.toFixed(2)}`;

type NotFound = { notFound: true };
const NOT_FOUND: NotFound = { notFound: true };

function newInterventionId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function TaskExecutionWorkbench({ workspaceId, taskId }: { workspaceId: string; taskId: string }) {
  const t = useT().chatApp.taskExecution;
  const key = taskExecutionCacheKey(workspaceId, taskId);
  const { data: entry, error, loading, refresh } = useCachedResource<TaskExecution | NotFound>(key, async () => {
    try {
      return await fetchTaskExecution(workspaceId, taskId);
    } catch (err) {
      // Revoked or never visible: the authoritative answer replaces any cached
      // protected projection (an eviction that cannot re-trigger a load loop).
      if (err instanceof TaskExecutionError && err.status === 404) return NOT_FOUND;
      throw err;
    }
  });
  const data = entry && !("notFound" in entry) ? entry : undefined;
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const inputId = useId();
  const notFound = Boolean(entry && "notFound" in entry);

  async function send(action: ControlAction) {
    if (!data) return;
    setBusy(true);
    setNotice(null);
    try {
      const r = await controlTaskExecution(workspaceId, data.id, {
        action, expectedRevision: data.controlRevision, interventionId: newInterventionId(),
        instruction: action === "steer" ? instruction.trim() : undefined,
      });
      mutateSurfaceCache<TaskExecution | NotFound>(key, () => r.execution);
      if (r.outcome === "stale") setNotice(t.stale);
      else if (r.outcome === "blocked") setNotice(format(t.refused, { reason: r.receipt.reason ?? "" }));
      else {
        setNotice(t.applied);
        if (action === "steer") setInstruction("");
      }
      requestBrainRefresh(workspaceId);
    } catch (err) {
      if (err instanceof TaskExecutionError && err.status === 403) setNotice(t.denied);
      else if (err instanceof TaskExecutionError && err.status === 404) { mutateSurfaceCache<TaskExecution | NotFound>(key, () => NOT_FOUND); setNotice(t.notAvailable); }
      else setNotice(t.unavailable);
    } finally {
      setBusy(false);
    }
  }

  if (loading && !data) {
    return <div aria-label={t.loading} className="mt-2 space-y-2" data-testid="task-execution-loading"><Skeleton className="h-10 w-full rounded-lg" /></div>;
  }
  if (notFound) return <p className="mt-2 text-sm text-muted-foreground" data-testid="task-execution-none">{t.notAvailable}</p>;
  if (!data) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm" data-testid="task-execution-unavailable">
        <p role="alert" className="text-destructive">{t.unavailable}</p>
        <Button variant="outline" size="sm" className="max-sm:min-h-11" onClick={() => void refresh()}>{t.retry}</Button>
      </div>
    );
  }
  return <ExecutionDetail t={t} data={data} stale={Boolean(error)} busy={busy} notice={notice} inputId={inputId}
    instruction={instruction} setInstruction={setInstruction} send={send} retry={() => void refresh()} />;
}

function ExecutionDetail({ t, data, stale, busy, notice, inputId, instruction, setInstruction, send, retry }: {
  t: ExecT; data: TaskExecution; stale: boolean; busy: boolean; notice: string | null; inputId: string
  instruction: string; setInstruction: (v: string) => void; send: (a: ControlAction) => Promise<void>; retry: () => void
}) {
  const left = remainingAllowance(data.allowance);
  const reasons = data.plan.readiness?.reasons ?? [];
  const nextStep = data.checkpoint?.nextStep ?? data.plan.nextStep ?? null;
  const terminal = data.phase === "done" || data.phase === "retired";
  const reasonText = (kind: string, subject: string) =>
    format((t.reasons as Record<string, string>)[kind] ?? `${kind}: {subject}`, { subject });

  return (
    <div className="mt-2 space-y-3 text-sm" data-testid="task-execution-workbench" data-phase={data.phase} data-revision={data.controlRevision}>
      {stale ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="status" className="text-muted-foreground">{t.unavailable}</p>
          <Button variant="outline" size="sm" className="max-sm:min-h-11" onClick={retry}>{t.retry}</Button>
        </div>
      ) : null}
      <p className="text-muted-foreground">
        <span className="font-medium text-foreground">{(t.phase as Record<string, string>)[data.phase] ?? data.phase}</span>
        {" · "}
        {format(t.executor, { name: data.executor?.kind === "person" ? t.executorPerson : data.executor ? data.executor.id.slice(0, 8) : "-" })}
      </p>
      {data.blocker ? <p data-testid="task-execution-blocker">{format(t.blocker, { reason: data.blocker.detail ? reasonText(data.blocker.reason, data.blocker.detail) : data.blocker.reason })}</p> : null}
      {nextStep ? <p>{format(t.nextStep, { step: nextStep })}</p> : null}
      {reasons.length > 0 ? (
        <div>
          <h5 className="font-medium">{t.readiness}</h5>
          <ul className="mt-1 list-disc pl-5">{reasons.map((r, i) => <li key={i}>{reasonText(r.kind, r.subject)}</li>)}</ul>
        </div>
      ) : null}
      {data.plan.steps && data.plan.steps.length > 0 ? (
        <div>
          <h5 className="font-medium">{t.plan}</h5>
          <ol className="mt-1 list-decimal pl-5">{data.plan.steps.map((s, i) => <li key={i}>{s.title}</li>)}</ol>
        </div>
      ) : null}
      {data.plan.completionEvidence && data.plan.completionEvidence.length > 0 ? (
        <div>
          <h5 className="font-medium">{t.evidence}</h5>
          <ul className="mt-1 list-disc pl-5">{data.plan.completionEvidence.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </div>
      ) : null}
      {data.plan.sourceBasis && data.plan.sourceBasis.length > 0 ? (
        <p className="text-muted-foreground">{t.sources}: {data.plan.sourceBasis.map(s => s.label ?? s.kind).join(", ")}</p>
      ) : null}
      {data.checkpoint && (data.checkpoint.artifacts.length > 0 || data.checkpoint.uncertainEffects.length > 0) ? (
        <div>
          <h5 className="font-medium">{t.workInProgress}</h5>
          <ul className="mt-1 list-disc pl-5">
            {data.checkpoint.artifacts.map((a, i) => <li key={`a${i}`}>{a.kind}: {a.ref}</li>)}
            {data.checkpoint.uncertainEffects.map((u, i) => <li key={`u${i}`}>{format(t.uncertain, { operation: u.operation, ref: u.ref })}</li>)}
          </ul>
        </div>
      ) : null}
      {data.children.length > 0 ? (
        <div>
          <h5 className="font-medium">{t.branches}</h5>
          <ul className="mt-1 space-y-1">{data.children.map(c => (
            <li key={c.id} data-branch-phase={c.phase}>{c.childKey ?? c.id.slice(0, 8)}: {(t.phase as Record<string, string>)[c.phase] ?? c.phase}{c.nextStep ? ` · ${c.nextStep}` : ""}</li>
          ))}</ul>
        </div>
      ) : null}
      <p className="text-muted-foreground" data-testid="task-execution-allowance">{format(t.allowance, {
        iterations: left.iterations === null ? t.unbounded : left.iterations,
        spend: left.spend === null ? t.unbounded : money(left.spend),
        lifetimeIterations: data.allowance.lifetime.iterations, lifetimeSpend: money(data.allowance.lifetime.spent),
      })}</p>
      {data.lastControl ? <p className="text-muted-foreground">{format(t.lastControl, { kind: data.lastControl.kind, revision: data.lastControl.revision ?? data.controlRevision })}</p> : null}
      {data.external.length > 0 ? (
        <div>
          <h5 className="font-medium">{t.external}</h5>
          <ul className="mt-1 space-y-1">{data.external.map(e => (
            <li key={e.id} data-freshness={e.freshness}>{e.externalExecutionId}{e.harness ? ` (${e.harness})` : ""}: {e.phase}, {(t.freshness as Record<string, string>)[e.freshness]}</li>
          ))}</ul>
        </div>
      ) : null}
      {!terminal && data.canControl ? (
        <div className="space-y-2 border-t border-border pt-2">
          <label htmlFor={inputId} className="block font-medium">{t.steerLabel}</label>
          <textarea id={inputId} value={instruction} onChange={e => setInstruction(e.target.value)} rows={2} placeholder={t.steerPlaceholder}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[16px] md:text-sm" />
          <p className="text-xs text-muted-foreground">{t.renewalNotice}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" className="max-sm:min-h-11" disabled={busy || !instruction.trim()} onClick={() => void send("steer")}>{t.send}</Button>
            {data.phase === "paused" || data.phase === "blocked" ? (
              <Button size="sm" variant="outline" className="max-sm:min-h-11" disabled={busy} onClick={() => void send("continue")}>{t.continue}</Button>
            ) : (
              <Button size="sm" variant="outline" className="max-sm:min-h-11" disabled={busy} onClick={() => void send("pause")}>{t.pause}</Button>
            )}
          </div>
        </div>
      ) : !terminal ? <p className="text-muted-foreground">{t.viewOnly}</p> : null}
      {notice ? <p role="status" data-testid="task-execution-notice">{notice}</p> : null}
    </div>
  );
}
