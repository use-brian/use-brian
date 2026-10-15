"use client";

/**
 * Invoice preparation: the form that prepares or revises a complete
 * preparation version (deals, service period, lines, allocations and the
 * per-invoice values the operation allows), and the panel that shows one
 * preparation with its state, server-computed totals, resolved fields, open
 * questions, Office draft, and the ready / issue / retry / void lifecycle.
 *
 * Money is shown exactly as the server computed it; the browser never adds,
 * rounds or converts an amount. Issue, retry and void are owner/admin
 * actions. Issued means numbered and released, never sent or paid.
 *
 * Spec: docs/architecture/features/crm-commercial-operations.md -> "Invoice preparation".
 * [COMP:app-web/crm-commercial-operations]
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  getCrmPreparation,
  type CrmCommercialCommand,
  type CrmCommercialFieldEntry,
  type CrmCommercialFields,
  type CrmCommercialReferenceKind,
  type CrmFieldBinding,
  type CrmInvoiceState,
  type CrmOperationDefinition,
  type CrmPreparationContent,
  type CrmPreparationDetail,
} from "@/lib/api/crm-commercial";
import { listCrmBillingRequests, type CrmBillingRequest } from "@/lib/api/crm-governed";
import { CrmReferenceRequestError, newCrmOperationId } from "@/lib/api/crm-references";
import { readOfficeReleasedFile } from "@/lib/office/api";
import { useT } from "@/lib/i18n/client";
import type { Dictionary } from "@/lib/i18n/dictionaries/en";
import {
  CommercialInput,
  CommercialSelect,
  CommercialTextarea,
  IssueList,
  QuestionGroups,
  RefusalLine,
  ResolvedFieldList,
  UUID_PATTERN,
  UncertainWrite,
  describeCommercialRefusal,
  isCalendarDate,
  useCommercialCommand,
  type CommercialCopy,
} from "./commercial-shared";
import { describeGovernedRefusal, type GovernedCopy } from "./governed-shared";

type InvoiceCopy = Dictionary["crmPage"]["invoices"];
type DealOption = { id: string; name: string };

const DECIMAL_PATTERN = /^-?\d{1,18}(\.\d{1,6})?$/;
const MAX_LINES = 30;
const REFERENCE_KINDS: readonly CrmCommercialReferenceKind[] = ["company", "deal", "person", "account", "seller", "page", "file"];
/** Re-read delays while an issue is pending or a draft is rendering; then the user refreshes. */
const POLL_DELAYS_MS = [1500, 3000, 6000, 12000];

/** Group the whole part of a server decimal string. No arithmetic. */
export function formatInvoiceMoney(amount: string | null | undefined, currency: string | null | undefined): string {
  if (amount === null || amount === undefined) return "";
  const negative = amount.startsWith("-");
  const [whole, fraction] = (negative ? amount.slice(1) : amount).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${currency ? `${currency} ` : ""}${negative ? "-" : ""}${grouped}${fraction !== undefined ? `.${fraction}` : ""}`;
}

/** A fraction such as "0.075" shown as "7.5", by moving the decimal point in the string. */
function percentFromFraction(rate: string): string {
  const [whole, fraction = ""] = rate.split(".");
  const padded = fraction.padEnd(2, "0");
  const integer = `${whole}${padded.slice(0, 2)}`.replace(/^0+(?=\d)/, "");
  const rest = padded.slice(2).replace(/0+$/, "");
  return rest ? `${integer}.${rest}` : integer;
}

function todayLocal(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** A truthful sentence for a definite refusal on an invoice command. */
function describeInvoiceRefusal(error: CrmReferenceRequestError, t: InvoiceCopy, commercial: CommercialCopy, governed: GovernedCopy): string {
  const reason = error.reason;
  if (reason === "stale_version") return t.refusals.stale_version.replace("{version}", String(error.details.currentVersion ?? ""));
  if (reason && reason in t.refusals) return t.refusals[reason as keyof InvoiceCopy["refusals"]];
  if (reason && reason in governed.refusals) return describeGovernedRefusal(error, governed, commercial);
  if (error.code === "invalid_transition") return t.refusals.invalid_transition;
  return describeCommercialRefusal(error, commercial);
}

export const NO_BILLING_REQUEST = "__none__";

/** Ready-to-bill requests on the given deals; empty when they cannot be read. */
export function useReadyBillingRequests(workspaceId: string, dealIds: readonly string[]): CrmBillingRequest[] {
  const [requests, setRequests] = useState<CrmBillingRequest[]>([]);
  const key = dealIds.join(",");
  useEffect(() => {
    if (!key) { setRequests([]); return; }
    let cancelled = false;
    const wanted = new Set(key.split(","));
    void listCrmBillingRequests(workspaceId, { state: "ready_to_bill" })
      .then((rows) => { if (!cancelled) setRequests(rows.filter((row) => wanted.has(row.dealId))); })
      .catch(() => { if (!cancelled) setRequests([]); });
    return () => { cancelled = true; };
  }, [workspaceId, key]);
  return requests;
}

/** Options for one allocation's optional billing request: only ready-to-bill requests on that deal. */
export function billingRequestOptions(requests: readonly CrmBillingRequest[], dealId: string, noneLabel: string) {
  return [
    { value: NO_BILLING_REQUEST, label: noneLabel },
    ...requests.filter((request) => request.dealId === dealId).map((request) => ({
      value: request.id,
      label: `${formatInvoiceMoney(request.amount, request.currency)} · ${request.description}`,
    })),
  ];
}

const STATE_TONE: Record<CrmInvoiceState, string> = {
  draft: "bg-muted text-muted-foreground",
  ready: "bg-sky-500/15 text-sky-800 dark:text-sky-200",
  issue_pending: "bg-amber-500/15 text-amber-800 dark:text-amber-200",
  issue_failed: "bg-destructive/10 text-destructive",
  issued: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200",
  voided: "bg-muted text-muted-foreground line-through",
};

export function InvoiceStateBadge({ state }: { state: CrmInvoiceState }) {
  const t = useT().crmPage.invoices;
  return (
    <span data-invoice-state={state} className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${STATE_TONE[state]}`}>
      {t.stateLabels[state]}
    </span>
  );
}

// ── Preparation form ───────────────────────────────────────────────

type LineRow = { rowId: number; description: string; quantity: string; unitPrice: string; dealId: string | null };
type ValueDraft = { value: string; referenceKind: CrmCommercialReferenceKind };

let lineSequence = 0;
const nextLineId = () => { lineSequence += 1; return lineSequence; };
const emptyLine = (): LineRow => ({ rowId: nextLineId(), description: "", quantity: "1", unitPrice: "", dealId: null });

function draftFromEntry(entry: CrmCommercialFieldEntry | undefined): ValueDraft {
  if (!entry || entry.value === null) return { value: "", referenceKind: "company" };
  if (typeof entry.value === "boolean") return { value: entry.value ? "true" : "false", referenceKind: "company" };
  if (typeof entry.value === "object") return { value: entry.value.id, referenceKind: entry.value.kind };
  return { value: entry.value, referenceKind: "company" };
}

function validValue(binding: CrmFieldBinding, raw: string): boolean {
  const value = raw.trim();
  if (!value) return true;
  switch (binding.type) {
    case "string": return value.length <= 500;
    case "text": return value.length <= 5000;
    case "date": return isCalendarDate(value);
    case "decimal": return DECIMAL_PATTERN.test(value);
    case "currency": return /^[A-Z]{3}$/.test(value);
    case "percent": return DECIMAL_PATTERN.test(value) && !value.startsWith("-") && (Number(value) <= 1);
    case "boolean": return value === "true" || value === "false";
    case "reference": return UUID_PATTERN.test(value);
  }
}

function entryFromDraft(binding: CrmFieldBinding, draft: ValueDraft): CrmCommercialFieldEntry {
  const value = draft.value.trim();
  if (binding.type === "boolean") return { type: binding.type, value: value === "true" };
  if (binding.type === "reference") return { type: binding.type, value: { kind: draft.referenceKind, id: value } };
  return { type: binding.type, value };
}

/**
 * Prepare a new invoice, or revise an existing preparation. Both send the
 * complete content; a revision names the version the user read.
 */
export function InvoicePreparationForm({ workspaceId, accountId, deals, operations, existing, onSaved, onCancel }: {
  workspaceId: string;
  accountId: string;
  deals: readonly DealOption[];
  /** Invoice operations with an accepted version. */
  operations: readonly CrmOperationDefinition[];
  existing?: { preparationId: string; version: number; operationVersionId: string; content: CrmPreparationContent };
  onSaved: (preparationId: string, version: number | null) => void;
  onCancel: () => void;
}) {
  const t = useT().crmPage.invoices;
  const commercial = useT().crmPage.commercial;
  const governed = useT().crmPage.governed;
  const initial = existing?.content;
  const [operationKey, setOperationKey] = useState(() => operations[0]?.operationKey ?? "");
  const [title, setTitle] = useState("");
  const [dealIds, setDealIds] = useState<string[]>(() => initial?.dealIds ?? (deals.length === 1 ? [deals[0].id] : []));
  const [periodStart, setPeriodStart] = useState(initial?.servicePeriodStart ?? "");
  const [periodEnd, setPeriodEnd] = useState(initial?.servicePeriodEnd ?? "");
  const [lines, setLines] = useState<LineRow[]>(() => initial?.lines.length
    ? initial.lines.map((line) => ({ rowId: nextLineId(), ...line, dealId: line.dealId ?? null }))
    : [emptyLine()]);
  const [allocations, setAllocations] = useState<Record<string, string>>(() =>
    Object.fromEntries((initial?.allocations ?? []).map((allocation) => [allocation.dealId, allocation.amount])));
  const [allocationRequests, setAllocationRequests] = useState<Record<string, string>>(() =>
    Object.fromEntries((initial?.allocations ?? []).filter((allocation) => allocation.billingRequestId)
      .map((allocation) => [allocation.dealId, allocation.billingRequestId!])));
  const [values, setValues] = useState<Record<string, ValueDraft>>(() =>
    Object.fromEntries(Object.entries(initial?.values ?? {}).map(([key, entry]) => [key, draftFromEntry(entry)])));
  const [refusal, setRefusal] = useState<string | null>(null);
  const writer = useCommercialCommand(workspaceId);
  const locked = writer.busy || writer.uncertain !== null;

  const versionId = existing?.operationVersionId
    ?? operations.find((operation) => operation.operationKey === operationKey)?.currentVersionId ?? null;
  const operationVersion = operations.flatMap((operation) => operation.versions).find((version) => version.id === versionId);
  const overridable = (operationVersion?.fieldBindings ?? []).filter((binding) => binding.overridable);
  const dealName = (id: string) => deals.find((deal) => deal.id === id)?.name ?? id;
  const dealOptions = [...new Set([...deals.map((deal) => deal.id), ...dealIds])];
  const readyRequests = useReadyBillingRequests(workspaceId, dealOptions);
  const requestFor = (dealId: string) => {
    const id = allocationRequests[dealId];
    return id && id !== NO_BILLING_REQUEST ? id : null;
  };
  const singleRequest = dealIds.length === 1 ? requestFor(dealIds[0]) : null;
  const showAllocations = dealIds.length > 1
    || (dealIds.length === 1 && (readyRequests.some((request) => request.dealId === dealIds[0]) || singleRequest !== null));

  const issues: string[] = [];
  if (!existing && !operationKey) issues.push(t.issues.operation);
  if (lines.some((line) => !line.description.trim() || !DECIMAL_PATTERN.test(line.quantity.trim()) || !DECIMAL_PATTERN.test(line.unitPrice.trim()))) {
    issues.push(t.issues.line);
  }
  if (lines.length > MAX_LINES) issues.push(t.issues.tooManyLines);
  if ((periodStart && !isCalendarDate(periodStart)) || (periodEnd && !isCalendarDate(periodEnd))
    || (periodStart && periodEnd && periodEnd < periodStart)) issues.push(t.issues.period);
  if (dealIds.length > 1 && dealIds.some((id) => !DECIMAL_PATTERN.test((allocations[id] ?? "").trim()))) issues.push(t.issues.allocation);
  if (singleRequest && !DECIMAL_PATTERN.test((allocations[dealIds[0]] ?? "").trim())) issues.push(t.issues.allocation);
  for (const binding of overridable) {
    if (!validValue(binding, values[binding.fieldKey]?.value ?? "")) {
      issues.push(t.issues.value.replace("{field}", binding.label).replace("{type}", commercial.fieldTypes[binding.type]));
    }
  }

  const toggleDeal = (id: string) => setDealIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const updateLine = (rowId: number, patch: Partial<LineRow>) =>
    setLines((current) => current.map((line) => line.rowId === rowId ? { ...line, ...patch } : line));
  const setValue = (fieldKey: string, patch: Partial<ValueDraft>) =>
    setValues((current) => ({ ...current, [fieldKey]: { ...(current[fieldKey] ?? { value: "", referenceKind: "company" }), ...patch } }));

  async function send(command: CrmCommercialCommand) {
    setRefusal(null);
    const outcome = await writer.run(command);
    if (outcome.ok) {
      const record = outcome.result.record as { preparation?: { id?: unknown }; version?: { version?: unknown } } | null;
      const id = typeof record?.preparation?.id === "string" ? record.preparation.id : existing?.preparationId;
      if (id) onSaved(id, typeof record?.version?.version === "number" ? record.version.version : null);
      return;
    }
    if (!outcome.error.uncertain) setRefusal(describeInvoiceRefusal(outcome.error, t, commercial, governed));
  }

  function pickRequest(dealId: string, value: string) {
    setAllocationRequests((current) => ({ ...current, [dealId]: value }));
    const request = readyRequests.find((item) => item.id === value);
    if (request) setAllocations((current) => ({ ...current, [dealId]: request.amount }));
  }

  function submit() {
    if (issues.length || locked) return;
    const chosen = dealIds.filter((id) => UUID_PATTERN.test(id));
    const fieldValues: CrmCommercialFields = {};
    for (const binding of overridable) {
      const draft = values[binding.fieldKey];
      if (draft && draft.value.trim()) fieldValues[binding.fieldKey] = entryFromDraft(binding, draft);
    }
    const content: CrmPreparationContent = {
      dealIds: chosen,
      servicePeriodStart: periodStart || null,
      servicePeriodEnd: periodEnd || null,
      lines: lines.map((line) => ({
        description: line.description.trim(),
        quantity: line.quantity.trim(),
        unitPrice: line.unitPrice.trim(),
        dealId: line.dealId && chosen.includes(line.dealId) ? line.dealId : null,
      })),
      values: fieldValues,
      allocations: chosen.length > 1 || (chosen.length === 1 && requestFor(chosen[0]))
        ? chosen.map((dealId) => {
          const billingRequestId = requestFor(dealId);
          return { dealId, amount: (allocations[dealId] ?? "").trim(), ...(billingRequestId ? { billingRequestId } : {}) };
        })
        : [],
    };
    void send(existing
      ? { kind: "revise_commercial_preparation", operationId: newCrmOperationId(), preparationId: existing.preparationId, expectedVersion: existing.version, ...content }
      : { kind: "prepare_commercial_document", operationId: newCrmOperationId(), operationKey, accountId, ...(title.trim() ? { title: title.trim() } : {}), ...content });
  }

  const lineDealOptions = [{ value: "none", label: t.lineNoDeal }, ...dealIds.map((id) => ({ value: id, label: dealName(id) }))];

  return (
    <div className="mt-2 space-y-3 rounded-lg bg-muted/30 p-3" data-invoice-form={existing ? "revise" : "prepare"}>
      <div className="text-xs font-medium">{existing ? t.reviseTitle.replace("{version}", String(existing.version)) : t.prepareTitle}</div>
      {existing && <p className="text-[11px] text-muted-foreground">{t.reviseHelp}</p>}
      <fieldset disabled={locked} className="min-w-0 space-y-3">
        {!existing && (
          <div className="grid gap-2 sm:grid-cols-2">
            <CommercialSelect label={t.operation} value={operationKey} placeholder={t.pickOperation}
              options={operations.map((operation) => ({ value: operation.operationKey, label: operation.label }))}
              onChange={setOperationKey} />
            <CommercialInput label={t.titleOptional} value={title} maxLength={300} onChange={setTitle} />
          </div>
        )}
        <div>
          <div className="mb-1 text-xs font-medium">{t.deals}</div>
          {dealOptions.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">{t.noDeals}</p>
          ) : (
            <>
              <div className="flex flex-wrap gap-1" data-invoice-deals>
                {dealOptions.map((id) => (
                  <Button key={id} size="xs" variant={dealIds.includes(id) ? "default" : "outline"} className="max-md:min-h-11"
                    aria-pressed={dealIds.includes(id)} onClick={() => toggleDeal(id)}>
                    {dealName(id)}
                  </Button>
                ))}
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">{t.dealsHelp}</p>
            </>
          )}
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <CommercialInput label={t.servicePeriodStart} type="date" value={periodStart} onChange={setPeriodStart} />
          <CommercialInput label={t.servicePeriodEnd} type="date" value={periodEnd} onChange={setPeriodEnd} />
        </div>
        <div>
          <div className="mb-1 text-xs font-medium">{t.lines}</div>
          <ul className="divide-y divide-border" data-invoice-lines>
            {lines.map((line) => (
              <li key={line.rowId} className="grid items-end gap-2 py-2 sm:grid-cols-[minmax(0,3fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)_auto]" data-invoice-line>
                <CommercialInput label={t.lineDescription} value={line.description} maxLength={500}
                  onChange={(description) => updateLine(line.rowId, { description })} />
                <CommercialInput label={t.lineQuantity} value={line.quantity} maxLength={26}
                  onChange={(quantity) => updateLine(line.rowId, { quantity: quantity.trim() })} />
                <CommercialInput label={t.lineUnitPrice} value={line.unitPrice} maxLength={26}
                  onChange={(unitPrice) => updateLine(line.rowId, { unitPrice: unitPrice.trim() })} />
                <CommercialSelect label={t.lineDeal} value={line.dealId && dealIds.includes(line.dealId) ? line.dealId : "none"}
                  options={lineDealOptions} onChange={(value) => updateLine(line.rowId, { dealId: value === "none" ? null : value })} />
                <Button size="icon-xs" variant="ghost" className="max-md:size-11" aria-label={t.removeLine} disabled={lines.length <= 1}
                  onClick={() => setLines((current) => current.filter((item) => item.rowId !== line.rowId))}>
                  <Trash2 aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
          <Button size="sm" variant="outline" disabled={lines.length >= MAX_LINES}
            onClick={() => setLines((current) => [...current, emptyLine()])}>
            <Plus aria-hidden />{t.addLine}
          </Button>
        </div>
        {showAllocations && (
          <div data-invoice-allocations>
            <div className="mb-1 text-xs font-medium">{t.allocations}</div>
            <p className="mb-1 text-[11px] text-muted-foreground">{dealIds.length > 1 ? t.allocationsHelp : governed.singleAllocationHelp}</p>
            <ul className="space-y-2">
              {dealIds.map((id) => (
                <li key={id} className="grid min-w-0 gap-2 sm:grid-cols-2" data-invoice-allocation={id}>
                  {(dealIds.length > 1 || requestFor(id)) && (
                    <CommercialInput label={t.allocationAmount.replace("{deal}", dealName(id))} value={allocations[id] ?? ""} maxLength={26}
                      disabled={requestFor(id) !== null}
                      onChange={(amount) => setAllocations((current) => ({ ...current, [id]: amount.trim() }))} />
                  )}
                  <CommercialSelect label={governed.billingRequestFor.replace("{deal}", dealName(id))} value={allocationRequests[id] ?? NO_BILLING_REQUEST}
                    options={billingRequestOptions(readyRequests, id, governed.noBillingRequest)}
                    onChange={(value) => pickRequest(id, value)} />
                </li>
              ))}
            </ul>
          </div>
        )}
        {overridable.length > 0 && (
          <div data-invoice-values>
            <div className="mb-1 text-xs font-medium">{t.values}</div>
            <p className="mb-1 text-[11px] text-muted-foreground">{t.valuesHelp}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {overridable.map((binding) => {
                const draft = values[binding.fieldKey] ?? { value: "", referenceKind: "company" as const };
                if (binding.type === "boolean") {
                  return (
                    <CommercialSelect key={binding.fieldKey} label={binding.label} value={draft.value || "unset"}
                      options={[{ value: "unset", label: t.notSet }, { value: "true", label: t.yes }, { value: "false", label: t.no }]}
                      onChange={(value) => setValue(binding.fieldKey, { value: value === "unset" ? "" : value })} />
                  );
                }
                if (binding.type === "text") {
                  return <CommercialTextarea key={binding.fieldKey} label={binding.label} value={draft.value} maxLength={5000}
                    onChange={(value) => setValue(binding.fieldKey, { value })} />;
                }
                if (binding.type === "reference") {
                  return (
                    <div key={binding.fieldKey} className="grid gap-2 sm:col-span-2 sm:grid-cols-2">
                      <CommercialSelect label={`${binding.label}: ${t.referenceKind}`} value={draft.referenceKind}
                        options={REFERENCE_KINDS.map((kind) => ({ value: kind, label: commercial.referenceKinds[kind] }))}
                        onChange={(kind) => setValue(binding.fieldKey, { referenceKind: kind as CrmCommercialReferenceKind })} />
                      <CommercialInput label={`${binding.label}: ${t.referenceId}`} value={draft.value}
                        onChange={(value) => setValue(binding.fieldKey, { value: value.trim() })} />
                    </div>
                  );
                }
                return (
                  <CommercialInput key={binding.fieldKey} label={binding.label} type={binding.type === "date" ? "date" : "text"}
                    value={draft.value} maxLength={binding.type === "string" ? 500 : 64}
                    onChange={(value) => setValue(binding.fieldKey, { value: binding.type === "currency" ? value.trim().toUpperCase() : value })} />
                );
              })}
            </div>
          </div>
        )}
      </fieldset>
      <IssueList issues={[...new Set(issues)]} />
      <RefusalLine text={refusal} />
      <UncertainWrite writer={writer} onRetry={(command) => void send(command)} onDiscard={onCancel} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={writer.busy} onClick={onCancel}>{t.cancel}</Button>
        <Button size="sm" disabled={issues.length > 0 || locked} onClick={submit}>
          {writer.busy ? t.saving : existing ? t.submitRevise : t.submitPrepare}
        </Button>
      </div>
    </div>
  );
}

// ── Preparation panel ──────────────────────────────────────────────

async function downloadReleasedFile(workspaceId: string, fileId: string, filename: string) {
  const blob = await readOfficeReleasedFile(workspaceId, fileId);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * One preparation and its invoice. Reads again on every change; while an
 * issue is pending or the draft is rendering it re-reads a few times with
 * backoff, then leaves a manual Refresh.
 */
export function InvoicePreparationPanel({ workspaceId, preparationId, canIssue, deals, operations, onChanged }: {
  workspaceId: string;
  preparationId: string;
  /** Owner or admin: may issue, retry and void. */
  canIssue: boolean;
  deals: readonly DealOption[];
  operations: readonly CrmOperationDefinition[];
  onChanged: () => void;
}) {
  const t = useT().crmPage.invoices;
  const commercial = useT().crmPage.commercial;
  const governed = useT().crmPage.governed;
  const [detail, setDetail] = useState<CrmPreparationDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [polls, setPolls] = useState(0);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [issueDate, setIssueDate] = useState(todayLocal);
  const [voidReason, setVoidReason] = useState("");
  const [downloadError, setDownloadError] = useState(false);
  const [pendingMessage, setPendingMessage] = useState("");
  const writer = useCommercialCommand(workspaceId);
  const locked = writer.busy || writer.uncertain !== null;

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    void getCrmPreparation(workspaceId, preparationId)
      .then((found) => { if (!cancelled) setDetail(found); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [workspaceId, preparationId, attempt]);

  useEffect(() => {
    setDetail(null);
    setEditing(false);
    setNotice(null);
    setRefusal(null);
    setPolls(0);
  }, [workspaceId, preparationId]);

  const preparation = detail?.preparation ?? null;
  const current = detail?.current ?? null;
  const invoice = detail?.invoice ?? null;
  const state: CrmInvoiceState | null = invoice?.state ?? preparation?.state ?? null;
  const draftRendering = Boolean(preparation && current?.draftReady && !preparation.draftRenderError
    && preparation.state === "draft" && (preparation.officeBinding?.version ?? null) !== preparation.version);
  const pending = state === "issue_pending" || draftRendering;

  useEffect(() => {
    if (!pending || polls >= POLL_DELAYS_MS.length) return;
    const timer = window.setTimeout(() => {
      setPolls((value) => value + 1);
      setAttempt((value) => value + 1);
    }, POLL_DELAYS_MS[polls]);
    return () => window.clearTimeout(timer);
  }, [pending, polls, detail]);

  const refresh = () => { setPolls(0); setAttempt((value) => value + 1); };
  const after = (message: string) => { setNotice(message); setRefusal(null); refresh(); onChanged(); };

  async function send(command: CrmCommercialCommand, message: string) {
    setRefusal(null);
    setNotice(null);
    setPendingMessage(message);
    const outcome = await writer.run(command);
    if (outcome.ok) { after(message); return; }
    if (!outcome.error.uncertain) {
      setRefusal(describeInvoiceRefusal(outcome.error, t, commercial, governed));
      refresh();
    }
  }

  if (failed && !detail) {
    return (
      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-destructive">
        <span>{t.loadFailed}</span>
        <Button size="sm" variant="ghost" onClick={refresh}>{t.retry}</Button>
      </div>
    );
  }
  if (!detail || !preparation || !state) return <div className="mt-2 text-xs text-muted-foreground">{t.loading}</div>;

  const bindings = operations.flatMap((operation) => operation.versions).find((version) => version.id === preparation.operationVersionId)?.fieldBindings ?? [];
  const labelFor = (fieldKey: string) => bindings.find((binding) => binding.fieldKey === fieldKey)?.label ?? fieldKey;
  const dealName = (id: string) => deals.find((deal) => deal.id === id)?.name ?? id;
  const frozen = invoice && invoice.state !== "draft" && invoice.state !== "ready" && invoice.total !== null;
  const totals = current?.totals?.invoice ?? null;
  const currency = frozen ? invoice.currency : totals?.currency ?? null;
  const totalText = frozen ? formatInvoiceMoney(invoice.total, invoice.currency) : totals ? formatInvoiceMoney(totals.total, totals.currency) : "";
  const allocations = frozen ? invoice.allocations : current?.totals?.allocations ?? [];
  const canRevise = (state === "draft" || state === "ready") && current !== null;

  async function markReady() {
    if (!preparation || locked) return;
    await send({ kind: "mark_preparation_ready", operationId: newCrmOperationId(), preparationId: preparation.id, expectedVersion: preparation.version },
      t.markedReady.replace("{version}", String(preparation.version)));
  }

  async function issue() {
    if (!preparation || locked || !isCalendarDate(issueDate)) return;
    const confirmed = await confirmDialog({
      title: t.issueConfirmTitle,
      description: t.issueConfirmDescription.replace("{total}", totalText).replace("{date}", issueDate),
      confirmLabel: t.issueConfirm,
      cancelLabel: t.cancel,
    });
    if (!confirmed) return;
    await send({ kind: "issue_invoice", operationId: newCrmOperationId(), preparationId: preparation.id, expectedVersion: preparation.version, issueDate },
      t.issueStarted);
  }

  async function retryIssue() {
    if (locked) return;
    setRefusal(null);
    setNotice(null);
    let fresh: CrmPreparationDetail;
    try {
      fresh = await getCrmPreparation(workspaceId, preparationId);
    } catch {
      setFailed(true);
      return;
    }
    setDetail(fresh);
    if (!fresh.invoice || fresh.invoice.state !== "issue_failed") {
      setNotice(t.retryChanged);
      return;
    }
    await send({ kind: "retry_invoice_issue", operationId: newCrmOperationId(), invoiceId: fresh.invoice.id, expectedVersion: fresh.invoice.version },
      t.retryStarted);
  }

  async function voidInvoice() {
    if (!invoice || locked || !voidReason.trim()) return;
    const confirmed = await confirmDialog({
      title: t.voidConfirmTitle.replace("{number}", invoice.number ?? ""),
      description: t.voidConfirmDescription,
      confirmLabel: t.voidConfirm,
      cancelLabel: t.cancel,
      variant: "destructive",
    });
    if (!confirmed) return;
    await send({ kind: "void_invoice", operationId: newCrmOperationId(), invoiceId: invoice.id, expectedVersion: invoice.version, reason: voidReason.trim() },
      t.voided);
  }

  async function download(fileId: string, extension: "xlsx" | "pdf") {
    setDownloadError(false);
    try {
      await downloadReleasedFile(workspaceId, fileId, `${(invoice?.number ?? preparation?.title ?? "invoice").replace(/[^\w.-]+/g, "_")}.${extension}`);
    } catch {
      setDownloadError(true);
    }
  }

  return (
    <div className="mt-2 min-w-0 space-y-3 border-l border-border pl-3" data-invoice-panel={preparation.id}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 break-words text-sm font-medium">{preparation.title}</span>
        <InvoiceStateBadge state={state} />
        <span className="text-[11px] text-muted-foreground">{t.version.replace("{version}", String(preparation.version))}</span>
        <Button size="xs" variant="ghost" className="ml-auto max-md:min-h-11" onClick={refresh}>{t.refresh}</Button>
      </div>
      <p className="text-[11px] text-muted-foreground" data-invoice-state-note>
        {t.stateNotes[state].replace("{version}", String(preparation.readyVersion ?? preparation.version))}
      </p>
      {invoice?.voidReason && <p className="text-[11px] text-muted-foreground">{t.voidReasonLabel.replace("{reason}", invoice.voidReason)}</p>}
      {pending && polls >= POLL_DELAYS_MS.length && state === "issue_pending" && (
        <p role="status" className="text-[11px] text-amber-700 dark:text-amber-300">{t.stillIssuing}</p>
      )}
      {notice && <p role="status" className="text-xs text-emerald-700 dark:text-emerald-300">{notice}</p>}

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs sm:grid-cols-4">
        <div className="min-w-0">
          <dt className="text-[11px] text-muted-foreground">{t.number}</dt>
          <dd className="break-words font-mono" data-invoice-number>{invoice?.number ?? t.numberAtIssue}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[11px] text-muted-foreground">{t.issueDate}</dt>
          <dd>{invoice?.issueDate ?? t.numberAtIssue}</dd>
        </div>
      </dl>

      <div data-invoice-totals>
        <div className="text-xs font-medium">{t.totals}</div>
        {!frozen && !totals ? (
          <p className="text-[11px] text-muted-foreground">{t.totalsUnavailable}</p>
        ) : (
          <dl className="mt-1 divide-y divide-border/60 text-xs">
            {(frozen ? invoice.lines : totals!.lines).map((line, index) => (
              <div key={index} className="flex flex-wrap justify-between gap-x-3 py-1" data-invoice-total-line>
                <dt className="min-w-0 break-words">
                  {line.description}
                  <span className="ml-1 text-[11px] text-muted-foreground">
                    {t.lineAmount.replace("{quantity}", line.quantity).replace("{unitPrice}", line.unitPrice)}
                  </span>
                </dt>
                <dd className="tabular-nums">{formatInvoiceMoney(line.amount, currency)}</dd>
              </div>
            ))}
            <div className="flex justify-between gap-x-3 py-1">
              <dt className="text-muted-foreground">{t.subtotal}</dt>
              <dd className="tabular-nums">{formatInvoiceMoney(frozen ? invoice.subtotal : totals!.subtotal, currency)}</dd>
            </div>
            <div className="flex justify-between gap-x-3 py-1">
              <dt className="text-muted-foreground">
                {t.tax.replace("{rate}", percentFromFraction((frozen ? invoice.taxRate : totals!.taxRate) ?? "0"))}
              </dt>
              <dd className="tabular-nums">{formatInvoiceMoney(frozen ? invoice.taxAmount : totals!.taxAmount, currency)}</dd>
            </div>
            <div className="flex justify-between gap-x-3 py-1 font-medium">
              <dt>{t.total}</dt>
              <dd className="tabular-nums" data-invoice-total>{totalText}</dd>
            </div>
          </dl>
        )}
        {allocations.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
            {allocations.map((allocation) => (
              <li key={allocation.dealId}>
                {t.allocatedTo.replace("{deal}", dealName(allocation.dealId))}: {formatInvoiceMoney(allocation.amount, currency)}
              </li>
            ))}
          </ul>
        )}
      </div>

      {state !== "issued" && state !== "voided" && (
        <div data-invoice-draft>
          <div className="text-xs font-medium">{t.draftTitle}</div>
          {preparation.draftRenderError ? (
            <div role="alert" className="mt-1 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive" data-invoice-draft-error>
              <p>{t.draftRenderFailed}</p>
              <p className="mt-1 break-words font-mono text-[11px]">{preparation.draftRenderError}</p>
            </div>
          ) : draftRendering ? (
            <p className="text-[11px] text-muted-foreground">{t.draftRendering}</p>
          ) : !preparation.officeArtifactId ? (
            <p className="text-[11px] text-muted-foreground">{t.draftNotYet}</p>
          ) : null}
          {preparation.officeArtifactId && (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Link href={`/w/${workspaceId}/office/${preparation.officeArtifactId}`}
                className="inline-flex items-center rounded-md px-2 py-1 text-xs font-medium text-primary underline-offset-2 hover:underline max-md:min-h-11"
                data-invoice-office-link>
                {t.openInOffice}
              </Link>
              {(state === "draft" || state === "ready") && <span className="text-[11px] text-muted-foreground">{t.draftMarkers}</span>}
            </div>
          )}
        </div>
      )}

      {current && (
        <div>
          <div className="text-xs font-medium">{t.resolvedFields}</div>
          <ResolvedFieldList fields={current.resolution.fields} labelFor={labelFor} />
        </div>
      )}
      {current && (state === "draft" || state === "ready") && (
        <div data-invoice-questions>
          <div className="text-xs font-medium">{t.questions}</div>
          <QuestionGroups questions={current.questions} />
        </div>
      )}

      {editing && current ? (
        <InvoicePreparationForm
          workspaceId={workspaceId}
          accountId={preparation.accountId}
          deals={deals}
          operations={operations}
          existing={{ preparationId: preparation.id, version: preparation.version, operationVersionId: preparation.operationVersionId, content: current.content }}
          onCancel={() => { setEditing(false); refresh(); }}
          onSaved={(_id, version) => {
            setEditing(false);
            after(t.prepared.replace("{version}", String(version ?? "")));
          }}
        />
      ) : (
        <div className="flex flex-wrap gap-2" data-invoice-actions>
          {canRevise && (
            <Button size="sm" variant="outline" disabled={locked} onClick={() => { setNotice(null); setRefusal(null); setEditing(true); }}>{t.revise}</Button>
          )}
          {state === "draft" && (
            <Button size="sm" variant="outline" disabled={locked || !current?.issueReady} onClick={() => void markReady()}>{t.markReady}</Button>
          )}
          {canIssue && invoice?.state === "issue_failed" && (
            <Button size="sm" disabled={locked} onClick={() => void retryIssue()}>{t.retryIssue}</Button>
          )}
        </div>
      )}
      {!editing && state === "draft" && current && !current.issueReady && (
        <p className="text-[11px] text-muted-foreground">{t.markReadyHint}</p>
      )}

      {!editing && canIssue && state === "ready" && (
        <div className="space-y-2" data-invoice-issue>
          <p className="text-[11px] text-muted-foreground">{t.issueHelp}</p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-full sm:w-48">
              <CommercialInput label={t.issueDate} type="date" value={issueDate} disabled={locked} onChange={setIssueDate} />
            </div>
            <Button size="sm" disabled={locked || !isCalendarDate(issueDate)} onClick={() => void issue()}>{t.issueAction}</Button>
          </div>
        </div>
      )}

      {!editing && canIssue && invoice && (invoice.state === "issued" || invoice.state === "issue_failed") && (
        <div className="space-y-2" data-invoice-void>
          <CommercialTextarea label={t.voidReason} value={voidReason} maxLength={2000} onChange={setVoidReason} />
          <div className="flex justify-end">
            <Button size="sm" variant="destructive" disabled={locked || !voidReason.trim()} onClick={() => void voidInvoice()}>{t.void}</Button>
          </div>
        </div>
      )}
      {!canIssue && (state === "ready" || state === "issued" || state === "issue_failed") && (
        <p className="text-[11px] text-muted-foreground">{t.issuedOnly}</p>
      )}

      <RefusalLine text={refusal} />
      <UncertainWrite writer={writer} onRetry={(command) => void send(command, pendingMessage)}
        onDiscard={refresh} />

      {invoice && invoice.state === "issued" && (invoice.xlsxFileId || invoice.pdfFileId) && (
        <div data-invoice-files>
          <div className="text-xs font-medium">{t.files}</div>
          <div className="mt-1 flex flex-wrap gap-2">
            {invoice.xlsxFileId && (
              <Button size="sm" variant="outline" onClick={() => void download(invoice.xlsxFileId!, "xlsx")}>{t.downloadXlsx}</Button>
            )}
            {invoice.pdfFileId && (
              <Button size="sm" variant="outline" onClick={() => void download(invoice.pdfFileId!, "pdf")}>{t.downloadPdf}</Button>
            )}
          </div>
          {downloadError && <p role="alert" className="mt-1 text-[11px] text-destructive">{t.downloadFailed}</p>}
        </div>
      )}

      {invoice && invoice.attempts.length > 0 && (
        <div data-invoice-attempts>
          <div className="text-xs font-medium">{t.attempts}</div>
          <ul className="mt-1 divide-y divide-border/60 text-xs">
            {invoice.attempts.map((item) => (
              <li key={item.attempt} className="py-1" data-invoice-attempt={item.attempt}>
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium">{t.attempt.replace("{attempt}", String(item.attempt))}</span>
                  <span className={item.state === "failed" ? "text-destructive" : "text-muted-foreground"}>{t.attemptStates[item.state]}</span>
                  <span className="text-[11px] text-muted-foreground">{new Date(item.createdAt).toLocaleString()}</span>
                </div>
                {(item.errorCode || item.errorDetail) && (
                  <p className="mt-0.5 break-words font-mono text-[11px] text-muted-foreground">
                    {[item.errorCode, item.errorDetail].filter(Boolean).join(": ")}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
