"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useT } from "@/lib/i18n/client";
import { useDurableDraft } from "@/lib/offline/use-durable-draft";
import { useLeasedResource } from "@/lib/offline/surface-content-cache";
import { projectHarnessCacheKey } from "@/lib/surface-prefetch";
import { harnessScopeKey, type HarnessScope, type HarnessRun, type HarnessRevision, type HarnessApproval, type CreateHarnessRun, type ResultStatus } from "@/lib/api/project-harness";
import { checklistResult, type ChecklistAnswer } from "./harness-model";
import { HarnessSkeleton, harnessInputClass, type HarnessContext } from "./project-harness";

type RunForm = { scenarioKey: string; buildId: string; deploymentId: string; environmentId: string; url: string; locale: string; timezone: string; width: string; height: string };
const emptyForm: RunForm = { scenarioKey: "", buildId: "", deploymentId: "", environmentId: "", url: "", locale: "en", timezone: "UTC", width: "1280", height: "720" };
function stored<T>(raw: string, fallback: T): T { try { return { ...fallback, ...JSON.parse(raw) }; } catch { return fallback; } }
export function createRunInput(form: RunForm, approvalId: string): CreateHarnessRun | null {
  try {
    const url = new URL(form.url);
    if (url.protocol !== "https:" || url.username || url.password || form.url.includes("?") || form.url.includes("#") || url.href !== form.url || url.hostname.includes("*")) return null;
    if (![form.scenarioKey, form.buildId, form.deploymentId, form.environmentId, form.locale, form.timezone].every(v => v.trim())) return null;
    const width = Number(form.width), height = Number(form.height);
    if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 16384)) return null;
    return { approvalId, scenarioKey: form.scenarioKey, executor: "human", build: { buildId: form.buildId.trim(), deploymentId: form.deploymentId.trim() }, target: { url: url.href, permittedOrigins: [url.origin] }, environment: { environmentId: form.environmentId.trim(), locale: form.locale, timezone: form.timezone, viewport: { width, height } } };
  } catch { return null; }
}
export function HarnessRuns({ context: c, scope, revision, approval, runs, refresh }: { context: HarnessContext; scope: HarnessScope; revision: HarnessRevision | null; approval: HarnessApproval | null; runs: HarnessRun[]; refresh: () => Promise<unknown> }) {
  const t = useT().projectHarness;
  const [raw, setRaw, storageFailed] = useDurableDraft(c.workspaceId, `harness:${c.projectId}:${harnessScopeKey(scope)}:run-form`, c.viewerId);
  const form = stored(raw, emptyForm);
  const [selectedRun, selectRun] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const canStart = c.participant && !c.archived && !!approval && !!revision && approval.revisionId === revision.id;
  function change(key: keyof RunForm, value: string) { setRaw(JSON.stringify({ ...form, [key]: value })); setInvalid(false); }
  async function start() {
    if (!canStart || !approval) return;
    const input = createRunInput(form, approval.id);
    if (!input || !revision?.definition.acceptanceScenarios.some(s => s.key === input.scenarioKey)) { setInvalid(true); return; }
    if (await c.mutate(async () => { const { run } = await c.api.createRun(input); selectRun(run.id); })) await refresh();
  }
  const status = (run: HarnessRun) => run.status === "failed" ? t.failedStatus : t[run.status];
  return <section className="min-w-0 space-y-3"><h4 className="font-medium">{t.runs}</h4><p className="text-sm">{t.humanNotice}</p><p className="text-sm text-muted-foreground">{t.automationHelp}</p>
    {!approval && <p>{t.needsApproval}</p>}
    {storageFailed && <p role="alert">{t.draftFailed}</p>}
    {canStart && <div className="space-y-3 rounded-lg border border-border p-3">
      <label className="grid gap-2">{t.scenarios}<Select value={form.scenarioKey} onValueChange={value => change("scenarioKey", value ?? "")} disabled={c.busy}>
        <SelectTrigger className="min-h-11 w-full"><SelectValue placeholder={t.scenarios} /></SelectTrigger><SelectContent>{revision!.definition.acceptanceScenarios.map(s => <SelectItem key={s.key} value={s.key}>{s.title}</SelectItem>)}</SelectContent>
      </Select></label>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">{(["buildId", "deploymentId", "environmentId", "url", "locale", "timezone", "width", "height"] as const).map(key => <label key={key} className="grid min-w-0 gap-1 text-sm">{t[key]}<input className={harnessInputClass} value={form[key]} disabled={c.busy} inputMode={key === "width" || key === "height" ? "numeric" : undefined} onChange={e => change(key, e.target.value)} /></label>)}</div>
      {invalid && <p role="alert">{t.invalidRun}</p>}
      <Button className="min-h-11 h-auto whitespace-normal" disabled={c.busy} onClick={() => void start()}>{t.startHuman}</Button>
    </div>}
    {!runs.length && <p>{t.empty}</p>}
    <div className="flex flex-wrap gap-2">{runs.map(run => <Button key={run.id} variant={selectedRun === run.id ? "secondary" : "outline"} className="min-h-11 h-auto max-w-full whitespace-normal break-all" onClick={() => selectRun(run.id)}>{run.preview.scenario.title} · {status(run)} · {run.createdAt}</Button>)}</div>
    {selectedRun && <HarnessRunDetail key={selectedRun} context={c} runId={selectedRun} />}
  </section>;
}

export function HarnessRunDetail({ context: c, runId }: { context: HarnessContext; runId: string }) {
  const t = useT().projectHarness;
  const resource = useLeasedResource(projectHarnessCacheKey(c.workspaceId, c.projectId, c.viewerId, `run:${runId}`), () => c.protect(async () => {
    const [run, evidence] = await Promise.all([c.api.run(runId), c.api.evidence(runId)]);
    return { ...run, ...evidence };
  }));
  const [raw, setRaw, storageFailed] = useDurableDraft(c.workspaceId, `harness:${c.projectId}:run:${runId}:answers`, c.viewerId);
  const answers = stored<Record<string, ChecklistAnswer>>(raw, {});
  const [textsRaw, setTextsRaw, textsFailed] = useDurableDraft(c.workspaceId, `harness:${c.projectId}:run:${runId}:evidence`, c.viewerId);
  const texts = stored<Record<string, string>>(textsRaw, {});
  if (!resource.data) return <>{!!resource.error && <p role="alert">{t.failed}</p>}<HarnessSkeleton /></>;
  const { run, evidence } = resource.data;
  const live = (run.status === "pending" || run.status === "running") && Date.parse(run.expiresAt) > Date.now();
  const canManage = c.participant && !c.archived && live && !c.busy && run.requestedBy === c.viewerId;
  const editable = canManage && run.executor === "human" && run.requestedBy === c.viewerId;
  const result = checklistResult(run, answers, evidence);
  const statusLabel = (status: ResultStatus | HarnessRun["status"]) => status === "failed" ? t.failedStatus : t[status];
  async function action(work: () => Promise<unknown>) { if (await c.mutate(work)) await resource.refresh(); }
  return <div className="min-w-0 space-y-3 rounded-lg border border-border p-3">
    {!!resource.error && <p role="alert">{t.failed}</p>}
    <h5 className="break-words font-medium">{run.preview.scenario.title} · {statusLabel(run.status)}</h5>
    <p className="break-all text-sm">{t.revision}: {run.preview.specification.revision} · {run.revisionId}</p>
    <p className="break-all text-sm">{t.buildId}: {run.preview.build.buildId} · {t.deploymentId}: {run.preview.build.deploymentId}</p>
    <p className="break-all text-sm">{t.environmentId}: {run.preview.environment.environmentId} · {run.preview.target.url}</p>
    <h6>{t.preconditions}</h6><ul className="list-disc space-y-1 pl-5">{run.preview.scenario.preconditions.map((s, i) => <li key={i} className="break-words">{s}</li>)}</ul>
    <h6>{t.steps}</h6><ol className="list-decimal space-y-1 pl-5">{run.preview.scenario.steps.map((s, i) => <li key={i} className="break-words">{s}</li>)}</ol>
    {(storageFailed || textsFailed) && <p role="alert">{t.draftFailed}</p>}
    {run.preview.scenario.criteria.map(criterion => <div key={criterion.key} className="min-w-0 space-y-2 border-t border-border pt-3">
      <p className="break-words"><strong>{criterion.key}</strong>: {criterion.observation}</p><p className="break-words text-sm">{t.evidence}: {criterion.evidence}</p>
      {evidence.filter(e => e.criterionKey === criterion.key).map(e => <div key={e.id} className="rounded bg-muted p-2"><p className="text-xs">{t[e.provenance]} · {e.createdAt}</p>{e.text && <p className="whitespace-pre-wrap break-words">{e.text}</p>}{e.kind === "screenshot" && e.base64 && <img src={`data:image/png;base64,${e.base64}`} alt={criterion.observation} className="h-auto max-w-full" />}</div>)}
      {editable && <>
        <label className="grid gap-1">{t.evidence}<textarea className={harnessInputClass} maxLength={8000} value={texts[criterion.key] ?? ""} onChange={e => setTextsRaw(JSON.stringify({ ...texts, [criterion.key]: e.target.value }))} /></label>
        <Button variant="outline" className="min-h-11" disabled={!texts[criterion.key]?.trim()} onClick={async () => {
          if (await c.mutate(() => c.api.addEvidence(runId, criterion.key, texts[criterion.key].trim()))) { setTextsRaw(current => JSON.stringify({ ...stored<Record<string, string>>(current, {}), [criterion.key]: "" })); await resource.refresh(); }
        }}>{t.addEvidence}</Button>
        <div className="flex flex-wrap gap-2">{(["passed", "failed", "blocked", "inconclusive"] as const).map(status => <Button key={status} variant={answers[criterion.key]?.status === status ? "secondary" : "outline"} className="min-h-11" aria-pressed={answers[criterion.key]?.status === status} onClick={() => setRaw(JSON.stringify({ ...answers, [criterion.key]: { status, reason: answers[criterion.key]?.reason ?? "" } }))}>{statusLabel(status)}</Button>)}</div>
        <label className="grid gap-1">{t.reason}<textarea className={harnessInputClass} maxLength={4000} value={answers[criterion.key]?.reason ?? ""} onChange={e => setRaw(JSON.stringify({ ...answers, [criterion.key]: { status: answers[criterion.key]?.status ?? "inconclusive", reason: e.target.value } }))} /></label>
      </>}
      {run.result?.criteria.filter(r => r.criterionKey === criterion.key).map(r => <p key={r.criterionKey} className="break-words">{statusLabel(r.status)} · {r.reason}</p>)}
    </div>)}
    {editable && <><p className="text-sm">{t.incomplete}</p><Button className="min-h-11 h-auto whitespace-normal" disabled={!result} onClick={async () => { if (result && await c.mutate(() => c.api.result(runId, result))) { setRaw(""); await resource.refresh(); } }}>{t.complete}</Button></>}
    <p className="text-sm">{t.humanNotice}</p>
    {run.executor === "agent" && <p className="text-sm text-muted-foreground">{t.automationHelp}</p>}
    {canManage && <Button variant="outline" className="min-h-11" onClick={() => void action(() => c.api.cancel(runId))}>{t.cancel}</Button>}
  </div>;
}
