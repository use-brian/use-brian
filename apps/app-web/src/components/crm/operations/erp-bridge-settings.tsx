"use client";

/**
 * CRM configuration -> ERP bridge: one binding's status (writer state, record
 * classes, linked counts, capabilities), its staged import reports, its
 * cutover runs with their reconciliation, and the signed-in member's own ERP
 * identity.
 *
 * The ERP adapter stages imports and prepares cutovers; nothing here authors
 * records. Confirming binds to the exact report hash the reviewer read, and a
 * possible duplicate is reported, never merged. A commit is offered only when
 * the run reconciles and sends the run's recorded source as the final source.
 * Owners and admins confirm and commit; every member sees the same state
 * read-only and may link only their own ERP user.
 *
 * Spec: docs/architecture/features/crm-commercial-operations.md -> "ERP bridge".
 * [COMP:app-web/crm-commercial-operations]
 */

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeftRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import type { CrmCommercialCommand } from "@/lib/api/crm-commercial";
import {
  CRM_ERP_RECORD_CLASSES,
  getCrmErpBinding,
  getCrmErpCutover,
  getCrmErpImport,
  type CrmErpBindingStatus,
  type CrmErpCutoverDetail,
  type CrmErpCutoverState,
  type CrmErpImportDetail,
  type CrmErpImportState,
  type CrmErpRecordClass,
  type CrmErpRowAction,
  type CrmErpWriterState,
} from "@/lib/api/crm-erp";
import { newCrmOperationId, type CrmReferenceRequestError } from "@/lib/api/crm-references";
import { useT } from "@/lib/i18n/client";
import type { Dictionary } from "@/lib/i18n/dictionaries/en";
import {
  RefusalLine,
  STABLE_KEY_PATTERN,
  UncertainWrite,
  describeCommercialRefusal,
  useCommercialCommand,
  type CommercialCopy,
} from "./commercial-shared";
import { governedFieldLabel } from "./governed-shared";
import { referenceInputClass } from "./record-references";

type ErpCopy = Dictionary["crmPage"]["erpBridge"];
type Selection = { kind: "import" | "cutover"; id: string } | null;

const ROW_ACTIONS: readonly CrmErpRowAction[] = ["create", "update", "unchanged"];

/** A truthful sentence for a definite refusal on a bridge command. */
function describeErpRefusal(error: CrmReferenceRequestError, e: ErpCopy, commercial: CommercialCopy): string {
  const reason = error.reason;
  if (reason && reason in e.refusals) return e.refusals[reason as keyof ErpCopy["refusals"]];
  if (error.code === "invalid_transition") return e.refusals.invalid_transition;
  return describeCommercialRefusal(error, commercial);
}

const classLabel = (e: ErpCopy, kind: string) =>
  kind in e.recordClassLabels ? e.recordClassLabels[kind as CrmErpRecordClass] : kind;

const day = (value: string) => new Date(value).toLocaleDateString();

const WRITER_TONE: Record<CrmErpWriterState, string> = {
  legacy: "bg-muted text-muted-foreground",
  frozen: "bg-amber-500/15 text-amber-800 dark:text-amber-200",
  brian: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200",
};

const IMPORT_TONE: Record<CrmErpImportState, string> = {
  staged: "bg-sky-500/15 text-sky-800 dark:text-sky-200",
  confirmed: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200",
  superseded: "bg-muted text-muted-foreground line-through",
};

const CUTOVER_TONE: Record<CrmErpCutoverState, string> = {
  prepared: "bg-amber-500/15 text-amber-800 dark:text-amber-200",
  committed: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200",
  abandoned: "bg-muted text-muted-foreground line-through",
};

const badge = "rounded-full px-2 py-0.5 text-[10px] font-medium";

export function CrmErpBridgeSettings({ workspaceId, canConfigure }: { workspaceId: string; canConfigure: boolean }) {
  const e = useT().crmPage.erpBridge;
  const [keyInput, setKeyInput] = useState("");
  const [bindingKey, setBindingKey] = useState<string | null>(null);
  /** undefined while unread, null when no binding with this key is configured. */
  const [status, setStatus] = useState<CrmErpBindingStatus | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [selection, setSelection] = useState<Selection>(null);

  useEffect(() => {
    if (!bindingKey) return;
    let cancelled = false;
    setFailed(false);
    void getCrmErpBinding(workspaceId, bindingKey)
      .then((found) => { if (!cancelled) setStatus(found); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [workspaceId, bindingKey, attempt]);

  const reload = () => setAttempt((value) => value + 1);
  const candidate = keyInput.trim().toLowerCase();
  const validKey = STABLE_KEY_PATTERN.test(candidate);

  function load(event: FormEvent) {
    event.preventDefault();
    if (!validKey) return;
    if (candidate !== bindingKey) {
      setStatus(undefined);
      setSelection(null);
      setBindingKey(candidate);
    } else {
      reload();
    }
  }

  return (
    <section className="border-t border-border pt-5" data-crm-erp-bridge>
      <div className="mb-3 min-w-0">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold"><ArrowLeftRight className="size-3.5" aria-hidden />{e.title}</h3>
        <p className="text-xs text-muted-foreground">{e.description}</p>
      </div>
      {!canConfigure && <p className="mb-2 text-xs text-muted-foreground">{e.readOnly}</p>}
      <form className="flex min-w-0 flex-wrap items-end gap-2" onSubmit={load}>
        <label className="block min-w-0 flex-1 basis-48 text-xs">
          <span className="mb-1 block text-muted-foreground">{e.bindingKey}</span>
          <input value={keyInput} maxLength={63} aria-label={e.bindingKey} placeholder={e.bindingKeyPlaceholder}
            autoCapitalize="none" autoCorrect="off" spellCheck={false}
            onChange={(event) => setKeyInput(event.target.value)} className={referenceInputClass} />
        </label>
        <Button type="submit" size="sm" className="max-md:min-h-11" disabled={!validKey}>{e.load}</Button>
      </form>
      <div className="mt-3 min-w-0">
        {!bindingKey ? (
          <p className="text-xs text-muted-foreground">{e.enterKey}</p>
        ) : failed ? (
          <div className="flex items-center justify-between gap-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <span>{e.loadFailed}</span>
            <Button size="sm" variant="ghost" onClick={reload}>{e.retry}</Button>
          </div>
        ) : status === undefined ? (
          <div className="text-xs text-muted-foreground">{e.loading}</div>
        ) : status === null ? (
          <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground" data-erp-not-configured>
            {e.notConfigured.replace("{key}", bindingKey)}
          </p>
        ) : (
          <div className="space-y-5">
            <BindingStatus status={status} />
            {selection?.kind === "import" ? (
              <ImportDetail key={selection.id} workspaceId={workspaceId} importId={selection.id} canConfigure={canConfigure}
                writerState={status.binding.writerState} onClose={() => setSelection(null)} onChanged={reload} />
            ) : selection?.kind === "cutover" ? (
              <CutoverDetail key={selection.id} workspaceId={workspaceId} cutoverId={selection.id} canConfigure={canConfigure}
                onClose={() => setSelection(null)} onChanged={reload} />
            ) : (
              <>
                <ImportList status={status} onOpen={(id) => setSelection({ kind: "import", id })} />
                <CutoverList status={status} onOpen={(id) => setSelection({ kind: "cutover", id })} />
              </>
            )}
            <ErpIdentity workspaceId={workspaceId} bindingKey={status.binding.bindingKey}
              enrollment={status.viewerEnrollment} onChanged={reload} />
          </div>
        )}
      </div>
    </section>
  );
}

function BindingStatus({ status }: { status: CrmErpBindingStatus }) {
  const e = useT().crmPage.erpBridge;
  const { binding, capabilities, mapped } = status;
  return (
    <div className="min-w-0 rounded-lg border border-border p-3" data-erp-status>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h4 className="min-w-0 break-words text-xs font-semibold">{binding.label || binding.bindingKey}</h4>
        <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground">{binding.bindingKey}</span>
      </div>
      <dl className="mt-2 grid min-w-0 gap-3 text-xs sm:grid-cols-2">
        <div className="min-w-0 sm:col-span-2">
          <dt className="mb-1 text-muted-foreground">{e.writerState}</dt>
          <dd>
            <span data-erp-writer-state={binding.writerState} className={`${badge} ${WRITER_TONE[binding.writerState]}`}>
              {e.writerStates[binding.writerState]}
            </span>
            <p className="mt-1 text-[11px] text-muted-foreground">{e.writerStateHelp[binding.writerState]}</p>
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="mb-1 text-muted-foreground">{e.recordClasses}</dt>
          <dd className="break-words">{binding.recordClasses.map((kind) => classLabel(e, kind)).join(", ")}</dd>
        </div>
        <div className="min-w-0">
          <dt className="mb-1 text-muted-foreground">{e.mapped}</dt>
          <dd className="break-words" data-erp-mapped>
            {mapped.length ? mapped.map((row) => `${classLabel(e, row.legacyType)}: ${row.count.toLocaleString()}`).join(", ") : e.mappedNone}
          </dd>
        </div>
        <div className="min-w-0 sm:col-span-2">
          <dt className="mb-1 text-muted-foreground">{e.journeys}</dt>
          <dd className="flex flex-wrap gap-1" data-erp-journeys>
            {capabilities.journeys.map((journey) => (
              <span key={journey} className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                {journey in e.journeyLabels ? e.journeyLabels[journey as keyof ErpCopy["journeyLabels"]] : journey}
              </span>
            ))}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function ImportList({ status, onOpen }: { status: CrmErpBindingStatus; onOpen: (id: string) => void }) {
  const e = useT().crmPage.erpBridge;
  return (
    <div className="min-w-0" data-erp-imports>
      <h4 className="text-xs font-semibold">{e.importsTitle}</h4>
      <p className="mb-2 text-[11px] text-muted-foreground">{e.importsHelp}</p>
      {status.recentImports.length === 0 ? (
        <p className="text-xs text-muted-foreground">{e.importsEmpty}</p>
      ) : (
        <ul className="divide-y divide-border">
          {status.recentImports.map((item) => (
            <li key={item.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-2" data-erp-import={item.id}>
              <span className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
                <span className={`${badge} ${IMPORT_TONE[item.state]}`}>{e.importStates[item.state]}</span>
                <span className="text-muted-foreground">
                  {item.confirmedAt ? e.confirmedOn.replace("{date}", day(item.confirmedAt)) : e.stagedOn.replace("{date}", day(item.createdAt))}
                </span>
              </span>
              <Button size="xs" variant="outline" className="max-md:min-h-11" onClick={() => onOpen(item.id)}>{e.review}</Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CutoverList({ status, onOpen }: { status: CrmErpBindingStatus; onOpen: (id: string) => void }) {
  const e = useT().crmPage.erpBridge;
  return (
    <div className="min-w-0" data-erp-cutovers>
      <h4 className="text-xs font-semibold">{e.cutoversTitle}</h4>
      <p className="mb-2 text-[11px] text-muted-foreground">{e.cutoversHelp}</p>
      {status.recentCutovers.length === 0 ? (
        <p className="text-xs text-muted-foreground">{e.cutoversEmpty}</p>
      ) : (
        <ul className="divide-y divide-border">
          {status.recentCutovers.map((item) => (
            <li key={item.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-2" data-erp-cutover={item.id}>
              <span className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
                <span className={`${badge} ${CUTOVER_TONE[item.state]}`}>{e.cutoverStates[item.state]}</span>
                <span className="text-muted-foreground">
                  {item.committedAt ? e.committedOn.replace("{date}", day(item.committedAt)) : e.preparedOn.replace("{date}", day(item.createdAt))}
                </span>
              </span>
              <Button size="xs" variant="outline" className="max-md:min-h-11" onClick={() => onOpen(item.id)}>{e.review}</Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DetailHeader({ title, badgeNode, onClose }: { title: string; badgeNode: ReactNode; onClose: () => void }) {
  const e = useT().crmPage.erpBridge;
  return (
    <div className="flex min-w-0 items-center justify-between gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h4 className="text-xs font-semibold">{title}</h4>
        {badgeNode}
      </div>
      <Button size="icon-xs" variant="ghost" className="max-md:size-11" aria-label={e.close} onClick={onClose}><X aria-hidden /></Button>
    </div>
  );
}

function DetailFailed({ onRetry }: { onRetry: () => void }) {
  const e = useT().crmPage.erpBridge;
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
      <span>{e.detailLoadFailed}</span>
      <Button size="sm" variant="ghost" onClick={onRetry}>{e.retry}</Button>
    </div>
  );
}

function Subheading({ title, help }: { title: string; help?: string }) {
  return (
    <div className="mb-1 min-w-0">
      <div className="text-xs font-medium">{title}</div>
      {help && <p className="text-[11px] text-muted-foreground">{help}</p>}
    </div>
  );
}

function ImportDetail({ workspaceId, importId, canConfigure, writerState, onClose, onChanged }: {
  workspaceId: string;
  importId: string;
  canConfigure: boolean;
  writerState: CrmErpWriterState;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useT().crmPage;
  const e = t.erpBridge;
  const [detail, setDetail] = useState<CrmErpImportDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const writer = useCommercialCommand(workspaceId);
  const locked = writer.busy || writer.uncertain !== null;

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    void getCrmErpImport(workspaceId, importId)
      .then((found) => { if (!cancelled) setDetail(found); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [workspaceId, importId, attempt]);

  const refresh = () => { setAttempt((value) => value + 1); onChanged(); };

  async function send(command: CrmCommercialCommand) {
    setRefusal(null);
    setDone(false);
    const outcome = await writer.run(command);
    if (outcome.ok) { setDone(true); refresh(); return; }
    if (outcome.error.uncertain) return;
    setRefusal(describeErpRefusal(outcome.error, e, t.commercial));
    if (outcome.error.reason === "stale_import" || outcome.error.reason === "writer_retired") refresh();
  }

  if (failed) return <DetailFailed onRetry={() => setAttempt((value) => value + 1)} />;
  if (!detail) return <div className="text-xs text-muted-foreground">{e.loading}</div>;

  const { report } = detail;
  const classes = CRM_ERP_RECORD_CLASSES.filter((kind) => report.counts[kind]);
  const totals = ROW_ACTIONS.reduce<Record<CrmErpRowAction, number>>((sum, action) => {
    sum[action] = classes.reduce((count, kind) => count + (report.counts[kind]?.[action] ?? 0), 0);
    return sum;
  }, { create: 0, update: 0, unchanged: 0 });
  const changedRows = report.rows.filter((row) => row.action !== "unchanged");
  const staged = detail.state === "staged";
  const blocked = report.conflicts.length > 0 || writerState === "brian";

  async function confirmImport() {
    if (!detail || !staged || blocked || locked) return;
    const confirmed = await confirmDialog({
      title: e.confirmImportTitle,
      description: e.confirmImportDescription
        .replace("{create}", totals.create.toLocaleString())
        .replace("{update}", totals.update.toLocaleString())
        .replace("{unchanged}", totals.unchanged.toLocaleString()),
      confirmLabel: e.confirmImport,
      cancelLabel: e.cancel,
    });
    if (!confirmed) return;
    void send({ kind: "confirm_erp_import", operationId: newCrmOperationId(), importId: detail.id, expectedReportHash: detail.reportHash });
  }

  return (
    <div className="min-w-0 space-y-4 rounded-lg border border-border p-3" data-erp-import-detail={detail.id}>
      <DetailHeader title={e.importTitle} onClose={onClose}
        badgeNode={<span className={`${badge} ${IMPORT_TONE[detail.state]}`}>{e.importStates[detail.state]}</span>} />

      <div className="min-w-0">
        <Subheading title={e.countsTitle} />
        <div className="overflow-x-auto">
          <table className="w-full min-w-0 table-fixed text-left text-xs" data-erp-counts>
            <thead>
              <tr className="text-[11px] text-muted-foreground">
                <th className="py-1 pr-2 font-normal">{e.recordClass}</th>
                {ROW_ACTIONS.map((action) => <th key={action} className="py-1 pr-2 text-right font-normal">{e.actions[action]}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {classes.map((kind) => (
                <tr key={kind} data-erp-count-row={kind}>
                  <td className="break-words py-1 pr-2 font-medium">{classLabel(e, kind)}</td>
                  {ROW_ACTIONS.map((action) => (
                    <td key={action} className="py-1 pr-2 text-right tabular-nums" data-erp-count={action}>
                      {(report.counts[kind]?.[action] ?? 0).toLocaleString()}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="min-w-0" data-erp-fees>
        <Subheading title={e.feesTitle} help={e.feesHelp} />
        {report.fees.length === 0 ? <p className="text-xs text-muted-foreground">{e.feesNone}</p> : (
          <ul className="space-y-0.5 text-xs">
            {report.fees.map((fee) => (
              <li key={`${fee.kind}:${fee.currency}`} className="break-words tabular-nums">
                {e.feeLine
                  .replace("{kind}", fee.kind in e.feeKinds ? e.feeKinds[fee.kind as keyof ErpCopy["feeKinds"]] : fee.kind)
                  .replace("{currency}", fee.currency)
                  .replace("{total}", fee.total)
                  .replace("{count}", fee.engagements.toLocaleString())}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="min-w-0" data-erp-conflicts>
        <Subheading title={e.conflictsTitle} />
        {report.conflicts.length === 0 ? <p className="text-xs text-muted-foreground">{e.conflictsNone}</p> : (
          <ul className="space-y-1 text-xs">
            {report.conflicts.map((conflict, index) => (
              <li key={`${conflict.legacyType}:${conflict.legacyId}:${conflict.reason}:${index}`} className="min-w-0 break-words rounded-md bg-destructive/10 px-2 py-1 text-destructive">
                <span className="font-medium">{classLabel(e, conflict.legacyType)} {conflict.legacyId}</span>
                {": "}
                {conflict.reason in e.conflictReasons ? e.conflictReasons[conflict.reason as keyof ErpCopy["conflictReasons"]] : conflict.reason}
                {conflict.detail ? ` (${conflict.detail})` : ""}
              </li>
            ))}
          </ul>
        )}
      </div>

      {report.possibleDuplicates.length > 0 && (
        <div className="min-w-0" data-erp-duplicates>
          <Subheading title={e.duplicatesTitle} help={e.duplicatesHelp} />
          <ul className="space-y-1 text-xs">
            {report.possibleDuplicates.map((duplicate) => (
              <li key={`${duplicate.legacyType}:${duplicate.legacyId}`} className="min-w-0 break-words">
                <span className="font-medium">{classLabel(e, duplicate.legacyType)} {duplicate.legacyId}</span>
                {": "}
                <span className="break-all text-muted-foreground">{e.duplicateLine.replace("{target}", duplicate.existingTargetId)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="min-w-0" data-erp-rows>
        <Subheading title={e.rowsTitle} />
        {changedRows.length === 0 ? <p className="text-xs text-muted-foreground">{e.rowsNone}</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-0 table-fixed text-left text-xs">
              <thead>
                <tr className="text-[11px] text-muted-foreground">
                  <th className="w-1/4 py-1 pr-2 font-normal">{e.recordClass}</th>
                  <th className="w-1/4 py-1 pr-2 font-normal">{e.legacyId}</th>
                  <th className="w-1/4 py-1 pr-2 font-normal">{e.action}</th>
                  <th className="w-1/4 py-1 font-normal">{e.fields}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {changedRows.map((row) => (
                  <tr key={`${row.legacyType}:${row.legacyId}`} className="align-top" data-erp-row={row.legacyId}>
                    <td className="break-words py-1 pr-2">{classLabel(e, row.legacyType)}</td>
                    <td className="break-all py-1 pr-2 font-mono">{row.legacyId}</td>
                    <td className="break-words py-1 pr-2">
                      {e.actions[row.action]}
                      {row.recode && <span className="ml-1 rounded-full bg-amber-500/15 px-1.5 text-[10px] text-amber-800 dark:text-amber-200">{e.recode}</span>}
                    </td>
                    <td className="break-words py-1">
                      {row.action === "create" ? e.newRecord : row.changes.map((change) => governedFieldLabel(change, t.governed)).join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {done && <p role="status" className="text-xs text-emerald-700 dark:text-emerald-300">{e.importConfirmed}</p>}
      <RefusalLine text={refusal} />
      <UncertainWrite writer={writer} onRetry={(command) => void send(command)} onDiscard={refresh} />
      {canConfigure && staged && (
        <div className="space-y-1">
          {report.conflicts.length > 0 && <p className="text-[11px] text-amber-700 dark:text-amber-300">{e.importBlockedConflicts}</p>}
          {writerState === "brian" && <p className="text-[11px] text-amber-700 dark:text-amber-300">{e.refusals.writer_retired}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" className="max-md:min-h-11" disabled={blocked || locked} onClick={() => void confirmImport()}>
              {writer.busy ? e.confirming : e.confirmImport}
            </Button>
          </div>
        </div>
      )}
      {canConfigure && !staged && <p className="text-[11px] text-muted-foreground">{e.importNotStaged}</p>}
    </div>
  );
}

function CutoverDetail({ workspaceId, cutoverId, canConfigure, onClose, onChanged }: {
  workspaceId: string;
  cutoverId: string;
  canConfigure: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useT().crmPage;
  const e = t.erpBridge;
  const [run, setRun] = useState<CrmErpCutoverDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const writer = useCommercialCommand(workspaceId);
  const locked = writer.busy || writer.uncertain !== null;

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    void getCrmErpCutover(workspaceId, cutoverId)
      .then((found) => { if (!cancelled) setRun(found); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [workspaceId, cutoverId, attempt]);

  const refresh = () => { setAttempt((value) => value + 1); onChanged(); };

  async function send(command: CrmCommercialCommand) {
    setRefusal(null);
    setDone(false);
    const outcome = await writer.run(command);
    if (outcome.ok) { setDone(true); refresh(); return; }
    if (outcome.error.uncertain) return;
    setRefusal(describeErpRefusal(outcome.error, e, t.commercial));
    refresh();
  }

  if (failed) return <DetailFailed onRetry={() => setAttempt((value) => value + 1)} />;
  if (!run) return <div className="text-xs text-muted-foreground">{e.loading}</div>;

  const reconciliation = run.reconciliation;
  const prepared = run.state === "prepared";
  const reconciled = reconciliation?.reconciled === true;
  const classes = run.recordClasses.map((kind) => classLabel(e, kind)).join(", ");
  const unreconciled: string[] = [];
  if (reconciliation && !reconciliation.reconciled) {
    if (reconciliation.countMismatches.length) {
      unreconciled.push(e.unreconciledCounts.replace("{classes}", reconciliation.countMismatches.map((kind) => classLabel(e, kind)).join(", ")));
    }
    if (!reconciliation.exportHashMatches) unreconciled.push(e.unreconciledHash);
    if (reconciliation.pendingStagedImports > 0) {
      unreconciled.push(e.unreconciledPending.replace("{count}", reconciliation.pendingStagedImports.toLocaleString()));
    }
  }

  async function commit() {
    if (!run || !prepared || !reconciled || locked) return;
    const confirmed = await confirmDialog({
      title: e.commitCutoverTitle,
      description: e.commitCutoverDescription.replace("{classes}", classes),
      confirmLabel: e.commitCutover,
      cancelLabel: e.cancel,
      variant: "destructive",
    });
    if (!confirmed) return;
    void send({
      kind: "commit_erp_cutover",
      operationId: newCrmOperationId(),
      cutoverId: run.id,
      expectedVersion: run.version,
      finalSource: { counts: run.source.counts, exportHash: run.source.exportHash },
    });
  }

  return (
    <div className="min-w-0 space-y-4 rounded-lg border border-border p-3" data-erp-cutover-detail={run.id}>
      <DetailHeader title={e.cutoverTitle} onClose={onClose}
        badgeNode={<span className={`${badge} ${CUTOVER_TONE[run.state]}`}>{e.cutoverStates[run.state]}</span>} />
      <div className="min-w-0" data-erp-reconciliation>
        <Subheading title={e.reconciliationTitle} help={e.reconciliationHelp} />
        {!reconciliation ? <p className="text-xs text-muted-foreground">{e.noReconciliation}</p> : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-0 table-fixed text-left text-xs">
                <thead>
                  <tr className="text-[11px] text-muted-foreground">
                    <th className="py-1 pr-2 font-normal">{e.recordClass}</th>
                    <th className="py-1 pr-2 text-right font-normal">{e.crmCount}</th>
                    <th className="py-1 pr-2 text-right font-normal">{e.sourceCount}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {run.recordClasses.map((kind) => {
                    const mismatch = reconciliation.countMismatches.includes(kind);
                    return (
                      <tr key={kind} data-erp-reconcile-row={kind} data-mismatch={mismatch ? "true" : undefined}>
                        <td className="break-words py-1 pr-2 font-medium">
                          {classLabel(e, kind)}
                          {mismatch && <span className="ml-1 rounded-full bg-destructive/10 px-1.5 text-[10px] text-destructive">{e.countMismatch}</span>}
                        </td>
                        <td className="py-1 pr-2 text-right tabular-nums">{(reconciliation.brianCounts[kind] ?? 0).toLocaleString()}</td>
                        <td className="py-1 pr-2 text-right tabular-nums">{(reconciliation.sourceCounts[kind] ?? 0).toLocaleString()}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <dl className="mt-2 grid min-w-0 gap-2 text-xs sm:grid-cols-3">
              <div className="min-w-0">
                <dt className="text-muted-foreground">{e.exportHash}</dt>
                <dd data-erp-export-match>{reconciliation.exportHashMatches ? e.yes : e.no}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-muted-foreground">{e.pendingImports}</dt>
                <dd className="tabular-nums" data-erp-pending>{reconciliation.pendingStagedImports.toLocaleString()}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-muted-foreground">{e.reconciledLabel}</dt>
                <dd data-erp-reconciled={reconciled ? "true" : "false"}>{reconciled ? e.yes : e.no}</dd>
              </div>
            </dl>
            {unreconciled.length > 0 && (
              <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[11px] text-amber-700 dark:text-amber-300" data-erp-unreconciled>
                {unreconciled.map((line) => <li key={line}>{line}</li>)}
              </ul>
            )}
          </>
        )}
      </div>
      {done && <p role="status" className="text-xs text-emerald-700 dark:text-emerald-300">{e.cutoverCommitted}</p>}
      <RefusalLine text={refusal} />
      <UncertainWrite writer={writer} onRetry={(command) => void send(command)} onDiscard={refresh} />
      {canConfigure && prepared && (
        <div className="space-y-1">
          {!reconciled && <p className="text-[11px] text-muted-foreground">{e.commitBlocked}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="destructive" className="max-md:min-h-11" disabled={!reconciled || locked} onClick={() => void commit()}>
              {writer.busy ? e.committing : e.commitCutover}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ErpIdentity({ workspaceId, bindingKey, enrollment, onChanged }: {
  workspaceId: string;
  bindingKey: string;
  enrollment: { legacyUserId: string } | null;
  onChanged: () => void;
}) {
  const t = useT().crmPage;
  const e = t.erpBridge;
  const [legacyUserId, setLegacyUserId] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const writer = useCommercialCommand(workspaceId);
  const locked = writer.busy || writer.uncertain !== null;
  const candidate = legacyUserId.trim();

  async function send(command: CrmCommercialCommand) {
    setRefusal(null);
    setDone(false);
    const outcome = await writer.run(command);
    if (outcome.ok) { setDone(true); setLegacyUserId(""); onChanged(); return; }
    if (!outcome.error.uncertain) setRefusal(describeErpRefusal(outcome.error, e, t.commercial));
  }

  async function enroll(event: FormEvent) {
    event.preventDefault();
    if (!candidate || locked) return;
    const confirmed = await confirmDialog({
      title: e.enrollTitle.replace("{id}", candidate),
      description: e.enrollDescription,
      confirmLabel: e.enrollConfirm,
      cancelLabel: e.cancel,
    });
    if (!confirmed) return;
    void send({ kind: "enroll_erp_viewer", operationId: newCrmOperationId(), bindingKey, legacyUserId: candidate });
  }

  return (
    <div className="min-w-0 border-t border-border pt-4" data-erp-identity>
      <Subheading title={e.identityTitle} help={enrollment ? undefined : e.identityHelp} />
      {enrollment ? (
        <div className="text-xs" data-erp-enrolled>
          <p className="break-words">{e.identityLinked.replace("{id}", enrollment.legacyUserId)}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">{e.identityLinkedHelp}</p>
        </div>
      ) : (
        <form className="flex min-w-0 flex-wrap items-end gap-2" onSubmit={(event) => void enroll(event)}>
          <label className="block min-w-0 flex-1 basis-48 text-xs">
            <span className="mb-1 block text-muted-foreground">{e.legacyUserId}</span>
            <input value={legacyUserId} maxLength={200} aria-label={e.legacyUserId} disabled={locked}
              autoCapitalize="none" autoCorrect="off" spellCheck={false}
              onChange={(event) => setLegacyUserId(event.target.value)} className={referenceInputClass} />
          </label>
          <Button type="submit" size="sm" className="max-md:min-h-11" disabled={!candidate || locked}>
            {writer.busy ? e.enrolling : e.enroll}
          </Button>
        </form>
      )}
      {done && <p role="status" className="mt-2 text-xs text-emerald-700 dark:text-emerald-300">{e.enrolled}</p>}
      <RefusalLine text={refusal} />
      <UncertainWrite writer={writer} onRetry={(command) => void send(command)} onDiscard={onChanged} />
    </div>
  );
}
