"use client";

/**
 * The shared Brief pane (project-briefs.md -> "User experience"). One surface
 * for a shared Project's or a Department's Brief on existing surfaces (Project
 * detail, the Department Brief entry): accepted Direction (read only),
 * Current context, pending proposals with Apply / Dismiss, the owner's
 * autosaved draft with Apply direction, history with Restore, Department rule
 * selection and Repair. Every action calls the same service as Brian.
 * Apply direction IS the explicit acceptance: no second confirmation dialog.
 *
 * [COMP:app-web/brief-journey]
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/skeleton";
import { format, useLocale, useT } from "@/lib/i18n/client";
import {
  applyBriefDirection,
  BriefRequestError,
  dismissBriefProposal,
  ensureBrief,
  getBriefByOwner,
  listBriefRevisions,
  listDepartmentBriefs,
  proposeBriefChange,
  repairBrief,
  restoreBriefRevision,
  saveBriefDraft,
  selectBriefDepartments,
  type BriefDirectionSection,
  type BriefOwnerKind,
  type BriefRevision,
  type BriefSections,
  type BriefView,
  type DepartmentBriefOption,
} from "@/lib/api/briefs";

const DIRECTION: BriefDirectionSection[] = ["outcome", "rules", "decisions"];
const CONTEXT = ["findings", "questions", "references"] as const;
const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);
const toLines = (text: string) => text.split("\n").map(line => line.trim()).filter(Boolean);

export function BriefPane({ workspaceId, ownerKind, ownerId, pageHref }: {
  workspaceId: string; ownerKind: BriefOwnerKind; ownerId: string; pageHref?: (pageId: string) => string;
}) {
  const t = useT().briefs;
  const locale = useLocale();
  const [brief, setBrief] = useState<BriefView | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Record<BriefDirectionSection, string> | null>(null);
  const [draftState, setDraftState] = useState<"idle" | "saving" | "saved">("idle");
  const [continueActive, setContinueActive] = useState(false);
  const [history, setHistory] = useState<BriefRevision[] | null>(null);
  const [departments, setDepartments] = useState<DepartmentBriefOption[] | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const message = useCallback((err: unknown) => {
    const code = err instanceof BriefRequestError ? err.code : "";
    const map: Record<string, string> = {
      brief_revision_stale: t.errorStale, brief_page_changed: t.errorStale, brief_owner_required: t.errorOwner,
      brief_not_found: t.errorNotFound, brief_unavailable: t.errorUnavailable, brief_ops_invalid: t.errorInvalid,
      brief_proposal_closed: t.errorClosed, brief_requires_shared_project: t.errorLegacy,
    };
    return map[code] ?? t.errorGeneric;
  }, [t]);

  const load = useCallback(async () => {
    try {
      const next = await getBriefByOwner(workspaceId, ownerKind, ownerId);
      setBrief(next);
      setSelection(next?.selections ?? []);
      setError(null);
    } catch (err) {
      setError(message(err));
      setBrief(null);
    }
  }, [workspaceId, ownerKind, ownerId, message]);

  useEffect(() => { void load(); }, [load]);

  // Seed the draft editor once per Brief from the owner's draft or the accepted direction.
  const seeded = useRef<string | null>(null);
  useEffect(() => {
    if (!brief || seeded.current === brief.binding.id) return;
    seeded.current = brief.binding.id;
    setDraft(Object.fromEntries(DIRECTION.map(key => [key, (brief.direction?.[key] ?? []).join("\n")])) as Record<BriefDirectionSection, string>);
  }, [brief]);

  useEffect(() => () => { if (draftTimer.current) clearTimeout(draftTimer.current); }, []);

  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await work();
      await load();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  const sectionsOf = (value: Record<BriefDirectionSection, string>): BriefSections =>
    Object.fromEntries(DIRECTION.map(key => [key, toLines(value[key])])) as BriefSections;

  function editDraft(key: BriefDirectionSection, value: string) {
    if (!draft || !brief) return;
    const next = { ...draft, [key]: value };
    setDraft(next);
    if (draftTimer.current) clearTimeout(draftTimer.current);
    // Autosave: a draft is never accepted direction.
    draftTimer.current = setTimeout(() => {
      setDraftState("saving");
      saveBriefDraft(workspaceId, brief.binding.id, sectionsOf(next))
        .then(() => setDraftState("saved"))
        .catch(() => setDraftState("idle"));
    }, 800);
  }

  if (brief === undefined) {
    return <div aria-busy="true" aria-label={t.loading} className="space-y-3"><Skeleton className="h-24 w-full rounded-xl" /></div>;
  }
  if (brief === null) {
    return <section className="rounded-xl border border-dashed border-border p-4 text-sm">
      <p className="text-muted-foreground">{t.createHint}</p>
      {error ? <p role="alert" className="mt-2 text-destructive">{error}</p> : null}
      <Button className="mt-3 max-sm:min-h-11" disabled={busy}
        onClick={() => void run(() => ensureBrief(workspaceId, ownerKind, ownerId, locale))}>{t.create}</Button>
    </section>;
  }

  const owner = brief.role === "owner";
  const writer = owner || brief.role === "participant";
  const revisionLabel = brief.binding.directionRevision > 0 ? format(t.revision, { revision: String(brief.binding.directionRevision) }) : t.noRevision;
  const labels: Record<string, string> = { outcome: t.outcome, rules: t.rules, decisions: t.decisions, findings: t.findings, questions: t.questions, references: t.references };
  const kinds: Record<BriefRevision["kind"], string> = { created: t.kindCreated, apply: t.kindApply, restore: t.kindRestore, repair: t.kindRepair, selection: t.kindSelection };
  const expected = { expectedDirectionRevision: brief.binding.directionRevision, expectedSelectionRevision: brief.binding.selectionRevision };

  return <div className="space-y-4" data-testid="brief-pane">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm text-muted-foreground">{revisionLabel}</p>
      {brief.pageId && pageHref ? <a className="text-sm underline" href={pageHref(brief.pageId)}>{t.openPage}</a> : null}
    </div>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    {brief.role === "oversight" ? <p className="text-sm text-muted-foreground">{t.oversight}</p> : null}
    {brief.missing ? <section className="rounded-xl border border-border p-4 text-sm">
      <p>{t.missing}</p>
      {owner ? <Button className="mt-2 max-sm:min-h-11" disabled={busy} onClick={() => void run(() => repairBrief(workspaceId, brief.binding.id))}>{t.repair}</Button> : null}
    </section> : null}

    <section aria-labelledby="brief-direction" className="rounded-xl border border-border p-4">
      <h3 id="brief-direction" className="font-medium">{t.direction}</h3>
      {!brief.established ? <p className="mt-1 text-sm text-muted-foreground">{t.notEstablished}</p> : null}
      <dl className="mt-2 space-y-2 text-sm">
        {DIRECTION.map(key => <div key={key}>
          <dt className="text-muted-foreground">{labels[key]}</dt>
          <dd>{brief.direction?.[key]?.length ? <ul className="list-disc pl-5">{brief.direction[key].map((line, i) => <li key={i}>{line}</li>)}</ul> : t.empty}</dd>
        </div>)}
      </dl>
    </section>

    <section aria-labelledby="brief-context" className="rounded-xl border border-border p-4">
      <h3 id="brief-context" className="font-medium">{t.context}</h3>
      <dl className="mt-2 space-y-2 text-sm">
        {CONTEXT.map(key => <div key={key}>
          <dt className="text-muted-foreground">{labels[key]}</dt>
          <dd>{brief.context?.[key]?.length ? <ul className="list-disc pl-5">{brief.context[key].map(block => <li key={block.id}>{block.text}</li>)}</ul> : t.empty}</dd>
        </div>)}
      </dl>
    </section>

    {writer && draft ? <section aria-labelledby="brief-draft" className="rounded-xl border border-border p-4">
      <h3 id="brief-draft" className="font-medium">{t.draftTitle}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{t.draftHint}</p>
      {DIRECTION.map(key => <label key={key} className="mt-3 block text-sm">
        <span className="text-muted-foreground">{labels[key]}</span>
        <textarea value={draft[key]} onChange={event => editDraft(key, event.target.value)} rows={3}
          className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-[16px] md:text-sm" />
      </label>)}
      <p role="status" className="mt-2 text-xs text-muted-foreground">{draftState === "saving" ? t.draftSaving : draftState === "saved" ? t.draftSaved : ""}</p>
      {owner ? <>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <Checkbox checked={continueActive} onCheckedChange={value => setContinueActive(value === true)} />
          <span>{t.continueActive}</span>
        </label>
        <p className="mt-2 text-xs text-muted-foreground">{t.applyHint}</p>
        <Button className="mt-2 max-sm:min-h-11" disabled={busy} onClick={() => void run(() => applyBriefDirection(workspaceId, brief.binding.id, {
          sections: sectionsOf(draft), ...expected, activeWork: continueActive ? "continue" : "pause", idempotencyKey: newKey(),
        }))}>{t.apply}</Button>
      </> : <>
        <p className="mt-2 text-xs text-muted-foreground">{t.ownerOnly} {t.proposeHint}</p>
        <Button variant="outline" className="mt-2 max-sm:min-h-11" disabled={busy} onClick={() => void run(() =>
          proposeBriefChange(workspaceId, brief.binding.id, sectionsOf(draft), [{ kind: "human", label: "Brief pane" }]))}>{t.propose}</Button>
      </>}
    </section> : null}

    <section aria-labelledby="brief-proposals" className="rounded-xl border border-border p-4">
      <h3 id="brief-proposals" className="font-medium">{t.proposals}</h3>
      {brief.proposals.length ? <ul className="mt-2 space-y-3">{brief.proposals.map(p => <li key={p.id} className="rounded-lg border border-border p-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{t.pendingBadge}</span>
          {p.stale ? <span className="text-xs text-muted-foreground">{t.staleBadge}</span> : null}
        </div>
        {p.summary ? <p className="mt-1">{p.summary}</p> : null}
        {p.evidence.length ? <p className="mt-1 text-xs text-muted-foreground">{t.evidence}: {p.evidence.map(e => e.passage ?? e.label ?? e.kind).join("; ")}</p> : null}
        <div className="mt-2 flex gap-2">
          {owner ? <Button className="max-sm:min-h-11" disabled={busy || p.stale} onClick={() => void run(() => applyBriefDirection(workspaceId, brief.binding.id, {
            proposalId: p.id, ...expected, activeWork: continueActive ? "continue" : "pause", idempotencyKey: newKey(),
          }))}>{t.applyProposal}</Button> : null}
          {owner || writer ? <Button variant="outline" className="max-sm:min-h-11" disabled={busy}
            onClick={() => void run(() => dismissBriefProposal(workspaceId, brief.binding.id, p.id))}>{t.dismiss}</Button> : null}
        </div>
      </li>)}</ul> : <p className="mt-1 text-sm text-muted-foreground">{t.noProposals}</p>}
    </section>

    {ownerKind === "project" ? <section aria-labelledby="brief-departments" className="rounded-xl border border-border p-4">
      <h3 id="brief-departments" className="font-medium">{t.departments}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{brief.selections.length ? format(t.rulesBasis, { count: String(brief.selections.length) }) : t.noRulesBasis}</p>
      {owner ? <>
        <p className="mt-1 text-xs text-muted-foreground">{t.departmentsHint}</p>
        {departments === null ? <Button variant="outline" className="mt-2 max-sm:min-h-11" disabled={busy}
          onClick={() => void listDepartmentBriefs(workspaceId).then(setDepartments).catch(err => setError(message(err)))}>{t.departments}</Button> : <>
          <ul className="mt-2 space-y-1">
            {departments.map(d => <li key={d.bindingId}><label className="flex items-center gap-2 text-sm">
              <Checkbox checked={selection.includes(d.bindingId)} onCheckedChange={value =>
                setSelection(current => value === true ? [...current, d.bindingId] : current.filter(id => id !== d.bindingId))} />
              <span>{d.name ?? d.departmentId}</span>
            </label></li>)}
            {selection.filter(id => !departments.some(d => d.bindingId === id)).map(id => <li key={id} className="text-sm text-muted-foreground">{t.departmentUnavailable}</li>)}
          </ul>
          <Button className="mt-2 max-sm:min-h-11" disabled={busy} onClick={() => void run(() => selectBriefDepartments(workspaceId, brief.binding.id, {
            departmentBindingIds: selection, expectedSelectionRevision: brief.binding.selectionRevision,
            activeWork: continueActive ? "continue" : "pause", idempotencyKey: newKey(),
          }))}>{t.saveDepartments}</Button>
        </>}
      </> : null}
    </section> : null}

    <section aria-labelledby="brief-history" className="rounded-xl border border-border p-4">
      <h3 id="brief-history" className="font-medium">{t.history}</h3>
      {history === null ? <Button variant="outline" className="mt-2 max-sm:min-h-11" disabled={busy}
        onClick={() => void listBriefRevisions(workspaceId, brief.binding.id).then(setHistory).catch(err => setError(message(err)))}>{t.history}</Button>
        : <ul className="mt-2 space-y-1 text-sm">{history.map(r => <li key={r.id} className="flex flex-wrap items-center justify-between gap-2">
          <span>{kinds[r.kind]} · {format(t.revision, { revision: String(r.directionRevision) })} · <time dateTime={r.createdAt}>{new Date(r.createdAt).toLocaleString()}</time></span>
          {owner && (r.kind === "apply" || r.kind === "restore") && r.directionRevision < brief.binding.directionRevision ? <Button variant="outline" className="max-sm:min-h-11" disabled={busy}
            onClick={() => void run(async () => { await restoreBriefRevision(workspaceId, brief.binding.id, r.id); setHistory(null); })}>{t.restore}</Button> : null}
        </li>)}</ul>}
    </section>
  </div>;
}
