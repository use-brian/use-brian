"use client";

/**
 * Business references on a company or deal record: current and former values,
 * per-reference history, and Assign / Replace / Retire through the versioned
 * reference commands. Preview never reserves a number; a write whose outcome
 * is unknown is retried only by the user, with the same operation id.
 *
 * Spec: docs/architecture/features/crm-commercial-operations.md -> "Business references" -> "UI".
 * [COMP:app-web/crm-commercial-operations]
 */

import { useEffect, useState } from "react";
import { Hash } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  CrmReferenceRequestError,
  executeCrmReferenceCommand,
  getCrmReferenceHistory,
  listCrmReferenceDefinitions,
  listCrmReferencesForTarget,
  newCrmOperationId,
  previewCrmReference,
  type CrmBusinessReference,
  type CrmReferenceCommand,
  type CrmReferenceCommandResult,
  type CrmReferenceDefinition,
  type CrmReferenceHistoryEntry,
  type CrmReferencePreview,
  type CrmReferenceTargetKind,
} from "@/lib/api/crm-references";
import { useT } from "@/lib/i18n/client";
import type { Dictionary } from "@/lib/i18n/dictionaries/en";

type ReferenceCopy = Dictionary["crmPage"]["references"];

export const referenceInputClass =
  "h-11 w-full min-w-0 rounded-lg border border-border bg-background px-3 text-[16px] outline-none disabled:opacity-60 md:h-9 md:text-sm";

/** A localized, truthful sentence for a definite refusal. */
export function describeReferenceRefusal(error: CrmReferenceRequestError, t: ReferenceCopy): string {
  const reason = error.reason;
  if (reason && reason in t.refusals) return t.refusals[reason as keyof ReferenceCopy["refusals"]];
  if (error.code === "not_authorized" || error.status === 403) return t.notAuthorized;
  return error.message && error.message !== error.code ? `${t.writeFailed} ${error.message}` : t.writeFailed;
}

/**
 * One write lane. A new intent passes a command with a fresh operation id; a
 * failure the server never answered keeps that exact command so Retry resends
 * it unchanged (same id, same fingerprint). A definite answer clears it.
 */
export function useReferenceCommand(workspaceId: string) {
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState<CrmReferenceCommand | null>(null);
  async function run(command: CrmReferenceCommand): Promise<
    { ok: true; result: CrmReferenceCommandResult } | { ok: false; error: CrmReferenceRequestError }
  > {
    setBusy(true);
    try {
      const result = await executeCrmReferenceCommand(workspaceId, command);
      setUncertain(null);
      return { ok: true, result };
    } catch (cause) {
      const error = cause instanceof CrmReferenceRequestError
        ? cause
        : new CrmReferenceRequestError("network_error", null);
      setUncertain(error.uncertain ? command : null);
      return { ok: false, error };
    } finally {
      setBusy(false);
    }
  }
  return { busy, uncertain, run, discard: () => setUncertain(null) };
}

function referenceValueOf(result: CrmReferenceCommandResult): string | null {
  const record = result.record as { reference?: { value?: unknown } } | null;
  return typeof record?.reference?.value === "string" ? record.reference.value : null;
}

type Loaded = { definitions: CrmReferenceDefinition[]; references: CrmBusinessReference[] };
type Notice = { tone: "success" | "error"; text: string };

export function CrmRecordReferences({
  workspaceId,
  recordKind,
  recordId,
  canConfigure,
}: {
  workspaceId: string;
  recordKind: CrmReferenceTargetKind;
  recordId: string;
  canConfigure: boolean;
}) {
  const t = useT().crmPage.references;
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [assigning, setAssigning] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const writer = useReferenceCommand(workspaceId);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    void Promise.all([
      listCrmReferenceDefinitions(workspaceId),
      listCrmReferencesForTarget(workspaceId, recordId),
    ])
      .then(([definitions, references]) => {
        if (!cancelled) setData({ definitions, references });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => { cancelled = true; };
  }, [workspaceId, recordId, attempt]);

  useEffect(() => {
    setData(null);
    setAssigning(null);
    setNotice(null);
  }, [workspaceId, recordId]);

  /** Re-read current state. Never repeats a write. */
  const reread = () => setAttempt((value) => value + 1);

  async function submit(command: CrmReferenceCommand, success: (result: CrmReferenceCommandResult) => string) {
    setNotice(null);
    const outcome = await writer.run(command);
    if (outcome.ok) {
      setNotice({ tone: "success", text: success(outcome.result) });
      setAssigning(null);
      reread();
      return true;
    }
    if (!outcome.error.uncertain) {
      setNotice({ tone: "error", text: describeReferenceRefusal(outcome.error, t) });
    }
    return false;
  }

  const assignSuccess = (result: CrmReferenceCommandResult) => {
    const value = referenceValueOf(result) ?? "";
    return (result.duplicate ? t.alreadyAssigned : t.assignedNew).replace("{value}", value);
  };

  async function retryUncertain() {
    const command = writer.uncertain;
    if (!command) return;
    await submit(command, (result) => {
      if (command.kind === "assign_business_reference") return assignSuccess(result);
      if (command.kind === "retire_business_reference") return t.retiredDone;
      return t.replacedDone.replace("{value}", referenceValueOf(result) ?? "");
    });
  }

  const definitionById = new Map((data?.definitions ?? []).map((definition) => [definition.id, definition]));
  const applicable = (data?.definitions ?? []).filter((definition) =>
    definition.targetKinds.includes(recordKind));
  const current = (data?.references ?? []).filter((reference) => reference.status === "active");
  const former = (data?.references ?? []).filter((reference) => reference.status !== "active");
  const assignable = applicable.filter((definition) =>
    definition.status === "active"
    && definition.assignmentEvent === "explicit"
    && !current.some((reference) => reference.definitionId === definition.id));

  // A workspace that numbers nothing for this kind of record sees no panel.
  if (data && applicable.length === 0 && data.references.length === 0) return null;

  const locked = writer.busy || writer.uncertain !== null;

  return (
    <section className="mt-4 border-t border-border/60 pt-4" data-crm-record-references>
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/60">
        <Hash className="size-3.5" aria-hidden />{t.panelTitle}
      </div>
      {writer.uncertain && (
        <div role="alert" className="mb-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          <p>{t.uncertainWrite}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={writer.busy} onClick={() => void retryUncertain()}>{t.retryWrite}</Button>
            <Button size="sm" variant="ghost" disabled={writer.busy} onClick={() => { writer.discard(); setAssigning(null); reread(); }}>{t.discardAndReload}</Button>
          </div>
        </div>
      )}
      {notice && (
        <div role={notice.tone === "error" ? "alert" : "status"} className={notice.tone === "error" ? "mb-2 text-xs text-destructive" : "mb-2 text-xs text-emerald-700 dark:text-emerald-300"}>
          {notice.text}
        </div>
      )}
      {failed ? (
        <div className="flex items-center justify-between gap-2 text-xs text-destructive">
          <span>{t.panelFailed}</span>
          <Button size="sm" variant="ghost" onClick={reread}>{t.retry}</Button>
        </div>
      ) : !data ? (
        <div className="text-xs text-muted-foreground">{t.panelLoading}</div>
      ) : (
        <>
          {current.length === 0 && <div className="text-xs text-muted-foreground">{t.panelEmpty}</div>}
          <ul className="space-y-2">
            {current.map((reference) => (
              <ReferenceRow
                key={reference.id}
                workspaceId={workspaceId}
                reference={reference}
                definition={definitionById.get(reference.definitionId) ?? null}
                canConfigure={canConfigure}
                locked={locked}
                onSubmit={submit}
              />
            ))}
          </ul>
          {former.length > 0 && (
            <div className="mt-3">
              <div className="mb-1 text-[11px] text-muted-foreground">{t.formerValues}</div>
              <ul className="space-y-1">
                {former.map((reference) => (
                  <ReferenceRow
                    key={reference.id}
                    workspaceId={workspaceId}
                    reference={reference}
                    definition={definitionById.get(reference.definitionId) ?? null}
                    canConfigure={false}
                    locked={locked}
                    onSubmit={submit}
                  />
                ))}
              </ul>
            </div>
          )}
          {assignable.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {assignable.map((definition) => (
                <Button
                  key={definition.id}
                  size="sm"
                  variant={assigning === definition.definitionKey ? "default" : "outline"}
                  disabled={locked}
                  onClick={() => { setNotice(null); setAssigning((value) => value === definition.definitionKey ? null : definition.definitionKey); }}
                >
                  {t.assign.replace("{label}", definition.label)}
                </Button>
              ))}
            </div>
          )}
          {assigning && (() => {
            const definition = assignable.find((candidate) => candidate.definitionKey === assigning);
            return definition ? (
              <AssignForm
                key={definition.id}
                workspaceId={workspaceId}
                definition={definition}
                recordKind={recordKind}
                recordId={recordId}
                locked={locked}
                busy={writer.busy}
                onCancel={() => setAssigning(null)}
                onSubmit={(command) => submit(command, assignSuccess)}
              />
            ) : null;
          })()}
        </>
      )}
    </section>
  );
}

function ReferenceRow({
  workspaceId,
  reference,
  definition,
  canConfigure,
  locked,
  onSubmit,
}: {
  workspaceId: string;
  reference: CrmBusinessReference;
  definition: CrmReferenceDefinition | null;
  canConfigure: boolean;
  locked: boolean;
  onSubmit: (command: CrmReferenceCommand, success: (result: CrmReferenceCommandResult) => string) => Promise<boolean>;
}) {
  const t = useT().crmPage.references;
  const [showHistory, setShowHistory] = useState(false);
  const [changing, setChanging] = useState<"replace" | "retire" | null>(null);
  const isCurrent = reference.status === "active";
  return (
    <li data-reference-status={reference.status} className={isCurrent ? "rounded-lg border border-border p-2" : "px-2 text-muted-foreground"}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={isCurrent ? "font-mono text-sm font-medium" : "font-mono text-xs line-through decoration-muted-foreground/50"}>{reference.value}</span>
        <span className="text-[11px] text-muted-foreground">
          {definition?.label ?? reference.definitionKey} · {t.originLabels[reference.origin]}
          {!isCurrent ? ` · ${t.referenceStatus[reference.status]}` : ""}
        </span>
        <div className="ml-auto flex flex-wrap gap-1">
          <Button size="xs" variant="ghost" className="max-md:min-h-11" onClick={() => setShowHistory((value) => !value)}>
            {showHistory ? t.hideHistory : t.history}
          </Button>
          {isCurrent && canConfigure && definition?.changePolicy === "correctable" && (
            <Button size="xs" variant="ghost" className="max-md:min-h-11" disabled={locked} onClick={() => setChanging((value) => value === "replace" ? null : "replace")}>{t.replace}</Button>
          )}
          {isCurrent && canConfigure && (
            <Button size="xs" variant="ghost" className="max-md:min-h-11" disabled={locked} onClick={() => setChanging((value) => value === "retire" ? null : "retire")}>{t.retire}</Button>
          )}
        </div>
      </div>
      {changing && definition && (
        <ChangeForm
          mode={changing}
          reference={reference}
          definition={definition}
          locked={locked}
          onCancel={() => setChanging(null)}
          onSubmit={async (command) => {
            const done = await onSubmit(command, (result) => command.kind === "retire_business_reference"
              ? t.retiredDone
              : t.replacedDone.replace("{value}", referenceValueOf(result) ?? ""));
            if (done) setChanging(null);
          }}
        />
      )}
      {showHistory && <ReferenceHistory workspaceId={workspaceId} referenceId={reference.id} />}
    </li>
  );
}

function ReferenceHistory({ workspaceId, referenceId }: { workspaceId: string; referenceId: string }) {
  const t = useT().crmPage.references;
  const [history, setHistory] = useState<CrmReferenceHistoryEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setHistory(null);
    void getCrmReferenceHistory(workspaceId, referenceId)
      .then((body) => { if (!cancelled) setHistory(body.history); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [workspaceId, referenceId, attempt]);
  if (failed) {
    return (
      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-destructive">
        <span>{t.historyFailed}</span>
        <Button size="sm" variant="ghost" onClick={() => setAttempt((value) => value + 1)}>{t.retry}</Button>
      </div>
    );
  }
  if (!history) return <div className="mt-2 text-xs text-muted-foreground">{t.historyLoading}</div>;
  if (history.length === 0) return <div className="mt-2 text-xs text-muted-foreground">{t.historyEmpty}</div>;
  return (
    <ol className="mt-2 space-y-1 border-l border-border pl-3 text-[11px] text-muted-foreground" data-reference-history>
      {history.map((entry) => (
        <li key={entry.id}>
          <div className="flex flex-wrap justify-between gap-x-3">
            <span className="font-medium text-foreground/80">
              {t.historyActions[entry.action]}
              {entry.formerValue && entry.newValue
                ? ` · ${t.historyChange.replace("{from}", entry.formerValue).replace("{to}", entry.newValue)}`
                : entry.newValue ? ` · ${entry.newValue}` : entry.formerValue ? ` · ${entry.formerValue}` : ""}
            </span>
            <time dateTime={entry.effectiveAt}>{new Date(entry.effectiveAt).toLocaleString()}</time>
          </div>
          {entry.reason && <div>{t.historyReason.replace("{reason}", entry.reason)}</div>}
        </li>
      ))}
    </ol>
  );
}

function AssignForm({
  workspaceId,
  definition,
  recordKind,
  recordId,
  locked,
  busy,
  onCancel,
  onSubmit,
}: {
  workspaceId: string;
  definition: CrmReferenceDefinition;
  recordKind: CrmReferenceTargetKind;
  recordId: string;
  locked: boolean;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (command: CrmReferenceCommand) => Promise<boolean>;
}) {
  const t = useT().crmPage.references;
  const [preview, setPreview] = useState<CrmReferencePreview | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [businessDate, setBusinessDate] = useState("");
  const [categoryKey, setCategoryKey] = useState("");
  const [value, setValue] = useState("");
  const [provider, setProvider] = useState("");
  const [remoteId, setRemoteId] = useState("");

  useEffect(() => {
    let cancelled = false;
    setPreviewFailed(false);
    void previewCrmReference(workspaceId, {
      definitionKey: definition.definitionKey,
      targetId: recordId,
      ...(businessDate ? { businessDate } : {}),
      ...(categoryKey ? { categoryKey } : {}),
    })
      .then((next) => { if (!cancelled) setPreview(next); })
      .catch(() => { if (!cancelled) setPreviewFailed(true); });
    return () => { cancelled = true; };
  }, [workspaceId, definition.definitionKey, recordId, businessDate, categoryKey, previewAttempt]);

  const mode = preview?.assignmentMode ?? definition.assignmentMode;
  const needsDate = preview?.needsBusinessDate ?? false;
  const needsCategory = preview?.needsCategory ?? false;
  const categories = preview?.categories?.length ? preview.categories : definition.categories;
  const ready = preview !== null
    && (!needsDate || /^\d{4}-\d{2}-\d{2}$/.test(businessDate))
    && (!needsCategory || Boolean(categoryKey))
    && (mode === "native" || value.trim().length > 0)
    && (mode !== "external" || (provider.trim().length > 0 && remoteId.trim().length > 0));

  function submit() {
    if (!ready || locked) return;
    void onSubmit({
      kind: "assign_business_reference",
      operationId: newCrmOperationId(),
      definitionKey: definition.definitionKey,
      target: { kind: recordKind, id: recordId },
      ...(businessDate ? { businessDate } : {}),
      ...(categoryKey ? { categoryKey } : {}),
      ...(mode !== "native" ? { value: value.trim() } : {}),
      ...(mode === "external" ? { external: { provider: provider.trim(), remoteId: remoteId.trim() } } : {}),
    });
  }

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-border bg-muted/20 p-3" data-reference-assign-form>
      <div className="text-xs font-medium">{t.assignTitle.replace("{label}", definition.label)}</div>
      {previewFailed ? (
        <div className="flex items-center justify-between gap-2 text-xs text-destructive">
          <span>{t.previewFailed}</span>
          <Button size="sm" variant="ghost" onClick={() => setPreviewAttempt((attempt) => attempt + 1)}>{t.retry}</Button>
        </div>
      ) : !preview ? (
        <div className="text-xs text-muted-foreground">{t.previewLoading}</div>
      ) : preview.explanation ? (
        <div className="rounded-md bg-background px-3 py-2">
          <div className="text-[11px] text-muted-foreground">{t.expectedShape}</div>
          <div className="font-mono text-sm" data-reference-masked-example>{preview.explanation.maskedExample}</div>
          <div className="mt-1 text-[11px] text-muted-foreground">{t.notReserved}</div>
        </div>
      ) : null}
      <fieldset disabled={locked} className="grid gap-2 sm:grid-cols-2">
        {needsDate && (
          <label className="text-xs">
            <span className="mb-1 block text-muted-foreground">{t.businessDate}</span>
            <input type="date" value={businessDate} onChange={(event) => setBusinessDate(event.target.value)} className={referenceInputClass} />
          </label>
        )}
        {needsCategory && (
          <label className="text-xs">
            <span className="mb-1 block text-muted-foreground">{t.category}</span>
            <Select
              items={categories.map((category) => ({ value: category.key, label: category.label }))}
              value={categoryKey || null}
              onValueChange={(next) => setCategoryKey((next as string | null) ?? "")}
            >
              <SelectTrigger className="h-11 w-full md:h-9" aria-label={t.category}><SelectValue placeholder={t.pickCategory} /></SelectTrigger>
              <SelectContent>
                {categories.map((category) => <SelectItem key={category.key} value={category.key}>{category.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
        )}
        {mode !== "native" && (
          <label className="text-xs">
            <span className="mb-1 block text-muted-foreground">{t.value}</span>
            <input value={value} maxLength={128} onChange={(event) => setValue(event.target.value)} className={referenceInputClass} />
          </label>
        )}
        {mode === "external" && (
          <>
            <label className="text-xs">
              <span className="mb-1 block text-muted-foreground">{t.provider}</span>
              <input value={provider} onChange={(event) => setProvider(event.target.value)} className={referenceInputClass} />
            </label>
            <label className="text-xs">
              <span className="mb-1 block text-muted-foreground">{t.remoteId}</span>
              <input value={remoteId} onChange={(event) => setRemoteId(event.target.value)} className={referenceInputClass} />
            </label>
          </>
        )}
      </fieldset>
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>{t.cancel}</Button>
        <Button size="sm" disabled={!ready || locked} onClick={submit}>{busy ? t.assigning : t.confirmAssign}</Button>
      </div>
    </div>
  );
}

function ChangeForm({
  mode,
  reference,
  definition,
  locked,
  onCancel,
  onSubmit,
}: {
  mode: "replace" | "retire";
  reference: CrmBusinessReference;
  definition: CrmReferenceDefinition;
  locked: boolean;
  onCancel: () => void;
  onSubmit: (command: CrmReferenceCommand) => Promise<void>;
}) {
  const t = useT().crmPage.references;
  const [reason, setReason] = useState("");
  const [value, setValue] = useState("");
  const [provider, setProvider] = useState("");
  const [remoteId, setRemoteId] = useState("");
  const supplied = mode === "replace" && definition.assignmentMode !== "native";
  const external = supplied && definition.assignmentMode === "external";
  const ready = reason.trim().length > 0 && (!supplied || value.trim().length > 0)
    && (!external || (provider.trim().length > 0 && remoteId.trim().length > 0));

  async function submit() {
    if (!ready || locked) return;
    const confirmed = await confirmDialog({
      title: (mode === "replace" ? t.replaceTitle : t.retireTitle).replace("{value}", reference.value),
      description: (mode === "retire"
        ? t.retireDescription
        : supplied ? t.replaceSuppliedDescription : t.replaceNativeDescription).replace("{value}", reference.value),
      confirmLabel: mode === "replace" ? t.replace : t.retire,
      cancelLabel: t.cancel,
      variant: "destructive",
    });
    if (!confirmed) return;
    await onSubmit(mode === "retire"
      ? { kind: "retire_business_reference", operationId: newCrmOperationId(), referenceId: reference.id, expectedVersion: reference.version, reason: reason.trim() }
      : { kind: "replace_business_reference", operationId: newCrmOperationId(), referenceId: reference.id, expectedVersion: reference.version, reason: reason.trim(), ...(supplied ? { value: value.trim() } : {}), ...(external ? { external: { provider: provider.trim(), remoteId: remoteId.trim() } } : {}) });
  }

  return (
    <fieldset disabled={locked} className="mt-2 grid gap-2 rounded-md bg-muted/20 p-2 sm:grid-cols-2">
      <label className="text-xs sm:col-span-2">
        <span className="mb-1 block text-muted-foreground">{t.reason}</span>
        <input value={reason} maxLength={500} placeholder={t.reasonPlaceholder} onChange={(event) => setReason(event.target.value)} className={referenceInputClass} />
      </label>
      {supplied && (
        <label className="text-xs sm:col-span-2">
          <span className="mb-1 block text-muted-foreground">{t.newValue}</span>
          <input value={value} maxLength={128} onChange={(event) => setValue(event.target.value)} className={referenceInputClass} />
        </label>
      )}
      {external && (
        <>
          <label className="text-xs">
            <span className="mb-1 block text-muted-foreground">{t.provider}</span>
            <input value={provider} onChange={(event) => setProvider(event.target.value)} className={referenceInputClass} />
          </label>
          <label className="text-xs">
            <span className="mb-1 block text-muted-foreground">{t.remoteId}</span>
            <input value={remoteId} onChange={(event) => setRemoteId(event.target.value)} className={referenceInputClass} />
          </label>
        </>
      )}
      <div className="flex flex-wrap justify-end gap-2 sm:col-span-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>{t.cancel}</Button>
        <Button size="sm" variant="destructive" disabled={!ready || locked} onClick={() => void submit()}>{t.submitChange}</Button>
      </div>
    </fieldset>
  );
}
