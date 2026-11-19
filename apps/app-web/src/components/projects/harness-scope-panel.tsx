"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { useT } from "@/lib/i18n/client";
import { useDurableDraft } from "@/lib/offline/use-durable-draft";
import { useLeasedResource } from "@/lib/offline/surface-content-cache";
import { projectHarnessCacheKey } from "@/lib/surface-prefetch";
import { harnessScopeKey, type HarnessDefinition, type HarnessScope, type HarnessOrigin } from "@/lib/api/project-harness";
import { applyPatch, rebaseAuthoredPatch, extendAuthoredPatch, canApprove, definitionText, emptyDefinition, parseDefinition, readPatch } from "./harness-model";
import { HarnessSkeleton, harnessInputClass, type HarnessContext } from "./project-harness";
import { HarnessRuns } from "./harness-runs";

export function HarnessScopePanel({ context: c, scope }: { context: HarnessContext; scope: HarnessScope }) {
  const t = useT().projectHarness;
  const scopeKey = harnessScopeKey(scope);
  const resource = useLeasedResource(projectHarnessCacheKey(c.workspaceId, c.projectId, c.viewerId, scopeKey), () => c.protect(async () => {
    const [definition, history, effective, approvals, runs] = await Promise.all([c.api.definition(scope), c.api.history(scope), c.api.effective(scope), c.api.approvals(scope), c.api.runs(scope)]);
    return { ...definition, ...history, ...effective, ...approvals, ...runs };
  }));
  const [draft, setDraft, draftFailed] = useDurableDraft(c.workspaceId, `harness:${c.projectId}:${scopeKey}:definition`, c.viewerId);
  const [reviewReason, setReviewReason, reasonFailed] = useDurableDraft(c.workspaceId, `harness:${c.projectId}:${scopeKey}:review`, c.viewerId);
  const [localError, setLocalError] = useState(false);
  const [rebaseFailed, setRebaseFailed] = useState(false);
  const patch = readPatch(draft);
  const data = resource.data;
  if (!data) return <>{!!resource.error && <p role="alert">{t.failed}</p>}<HarnessSkeleton /></>;
  const head = data.definition;
  const baseRevision = patch ? patch.revision : head?.revision ?? 0;
  const base = patch ? data.revisions.find(r => r.id === patch.revisionId && r.revision === patch.revision) ?? (head?.id === patch.revisionId ? head : null) : head;
  const baseMissing = !!draft && (!patch || (patch.revision !== 0 && !base));
  const baseText = definitionText(base?.definition ?? emptyDefinition);
  const text = patch && !baseMissing ? applyPatch(baseText, patch) : baseText;
  const parsed = parseDefinition(text);
  const editable = c.owner && !c.archived && !c.busy && !baseMissing;
  function change(next: string) {
    setLocalError(false);
    setDraft(next === baseText ? "" : JSON.stringify(extendAuthoredPatch(baseText, next, baseRevision, base?.id ?? null, patch)));
  }
  function append(field: "rules" | "codeChecks" | "acceptanceScenarios") {
    if (!parsed) { setLocalError(true); return; }
    const suffix = parsed[field].length + 1;
    const item = field === "rules" ? { key: `rule-${suffix}`, kind: "default", value: t.ruleTemplate, override: false }
      : field === "codeChecks" ? { key: `check-${suffix}`, kind: "unit", instructions: t.checkTemplate }
      : { key: `scenario-${suffix}`, title: t.scenarioTemplate, preconditions: [t.preconditionTemplate], steps: [t.stepTemplate], criteria: [{ key: "outcome", observation: t.observationTemplate, evidence: t.evidenceTemplate }] };
    change(definitionText({ ...parsed, [field]: [...parsed[field], item] } as HarnessDefinition));
  }
  async function save() {
    if (!parsed || !editable) { setLocalError(true); return; }
    const submitted = draft;
    if (await c.mutate(() => c.api.save(scope, baseRevision, parsed))) {
      setDraft(current => current === submitted ? "" : current);
      await resource.refresh();
    }
  }
  function origin(o: HarnessOrigin) { return `${t[o.scope.kind]} · ${harnessScopeKey(o.scope)} · ${t.revision} ${o.revision}`; }
  const approval = data.approvals.find(a => a.revisionId === head?.id);
  return <div className="min-w-0 space-y-4" aria-label={t[scope.kind]}>
    {!!resource.error && <p role="alert">{t.failed}</p>}
    <h3 className="font-medium">{t[scope.kind]} · {t.revision}: {head?.revision ?? 0}</h3>
    {c.archived && <p>{t.archived}</p>}
    <p className="text-sm text-muted-foreground">{t.ruleHelp}</p>
    {(draftFailed || reasonFailed) && <p role="alert">{t.draftFailed}</p>}
    {draft && <div className="space-y-2"><p>{t.draft} · {t.revision}: {baseRevision}</p>
      {baseMissing || rebaseFailed ? <><p role="alert">{baseMissing ? t.draftMissing : t.rebaseBlocked}</p><pre className="whitespace-pre-wrap break-all text-sm">{patch ? [patch, ...(patch.edits ?? [])].map(edit => edit.inserted).join("\n") : draft}</pre></> : null}
      <Button variant="outline" className="min-h-11" disabled={c.busy} onClick={async () => { if (await confirmDialog({ title: t.discard, description: t.draft, confirmLabel: t.discard, cancelLabel: t.cancel })) setDraft(""); }}>{t.discard}</Button>
      {!baseMissing && baseRevision !== (head?.revision ?? 0) && <>
        <p role="alert">{t.conflict}</p>
        <Button variant="outline" className="min-h-11 h-auto whitespace-normal" disabled={!editable} onClick={async () => {
          if (!patch || !await confirmDialog({ title: t.rebase, description: t.rebaseConfirm, confirmLabel: t.rebase, cancelLabel: t.cancel })) return;
          const rebased = rebaseAuthoredPatch(baseText, definitionText(head?.definition ?? emptyDefinition), patch, head?.revision ?? 0, head?.id ?? null);
          setRebaseFailed(!rebased);
          if (rebased) setDraft(current => current === draft ? JSON.stringify(rebased) : current);
        }}>{t.rebase}</Button>
      </>}
    </div>}
    {!baseMissing && <>
      <label className="grid min-w-0 gap-2 text-sm">{t.editor}<textarea aria-label={t.editor} className={`${harnessInputClass} min-h-72 font-mono`} spellCheck={false} value={text} readOnly={!editable} onChange={e => change(e.target.value)} /></label>
      {c.owner && !c.archived && <div className="flex flex-wrap gap-2">
        <Button variant="outline" className="min-h-11" disabled={!editable} onClick={() => append("rules")}>{t.addRule}</Button>
        <Button variant="outline" className="min-h-11" disabled={!editable} onClick={() => append("codeChecks")}>{t.addCheck}</Button>
        <Button variant="outline" className="min-h-11 h-auto whitespace-normal" disabled={!editable} onClick={() => append("acceptanceScenarios")}>{t.addScenario}</Button>
        <Button className="min-h-11" disabled={!editable || !draft || !parsed || baseRevision !== (head?.revision ?? 0)} onClick={() => void save()}>{t.save}</Button>
      </div>}
    </>}
    {(localError || !parsed) && <p role="alert">{t.invalid}</p>}
    <details className="min-w-0 rounded-lg border border-border p-3" open={data.effective.status === "conflicted"}>
      <summary className="min-h-11 cursor-pointer py-2">{t.effective}</summary>
      <p>{data.effective.status === "resolved" ? t.resolved : t.conflicted}</p>
      {data.effective.conflicts.map((conflict, i) => <div key={i} role="alert" className="my-2 break-words border-l-2 border-destructive pl-2"><strong>{conflict.key}</strong>: {t[conflict.reason]}<p>{t.origin}: {origin(conflict.origin)}</p>{conflict.inheritedFrom && <p>{origin(conflict.inheritedFrom)}</p>}</div>)}
      {(["rules", "codeChecks", "acceptanceScenarios"] as const).map(field => <div key={field} className="mt-3"><h4>{field === "rules" ? t.rules : field === "codeChecks" ? t.checks : t.scenarios}</h4>
        {data.effective[field].map((item, i) => <div key={i} className="my-2 min-w-0 rounded border border-border p-2"><p className="break-all text-xs">{t.origin}: {origin(item.origin)}</p><pre className="whitespace-pre-wrap break-all text-sm">{JSON.stringify(item, null, 2)}</pre></div>)}
      </div>)}
    </details>
    <details className="min-w-0 rounded-lg border border-border p-3"><summary className="min-h-11 cursor-pointer py-2">{t.history}</summary>
      {data.revisions.map(revision => <details key={revision.id}><summary className="min-h-11 cursor-pointer break-all py-2">{t.revision} {revision.revision} · {revision.createdAt} · {revision.createdBy}</summary><pre className="whitespace-pre-wrap break-all text-sm">{definitionText(revision.definition)}</pre></details>)}
    </details>
    <section className="space-y-2"><h4 className="font-medium">{t.review}</h4>
      {head?.createdBy === c.viewerId && <p>{t.sameAuthor}</p>}
      {approval && <p className="break-words">{t.approved}: {approval.approvedBy} · {approval.approvedAt} · {approval.reason}</p>}
      {canApprove(head, c.viewerId, c.owner, c.archived) && !approval && <>
        <label className="grid gap-2">{t.reviewReason}<textarea className={harnessInputClass} maxLength={1000} disabled={c.busy} value={reviewReason} onChange={e => setReviewReason(e.target.value)} /></label>
        <Button className="min-h-11" disabled={c.busy || !reviewReason.trim() || !!draft || data.effective.status === "conflicted"} onClick={async () => { if (head && await c.mutate(() => c.api.approve(head.id, head.revision, reviewReason.trim()))) { setReviewReason(""); await resource.refresh(); } }}>{t.approve}</Button>
      </>}
    </section>
    <HarnessRuns context={c} scope={scope} revision={head} approval={approval ?? null} runs={data.runs} refresh={resource.refresh} />
  </div>;
}
