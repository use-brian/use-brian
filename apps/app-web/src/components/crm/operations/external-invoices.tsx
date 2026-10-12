"use client";

/**
 * Externally issued invoices on a customer account: "Record external
 * invoice" (provider, remote id, number, issue date, currency, total and the
 * per-deal allocations, each optionally closing a ready-to-bill request) and
 * "Correct reference" (a new number and/or billing requests to reopen, with a
 * reason). An external invoice belongs to its provider: it is never voided
 * or deleted here, only its reference corrected.
 *
 * The browser never adds amounts; the server refuses allocations that do not
 * match the total or a reviewed billing amount.
 *
 * Spec: docs/architecture/features/crm-commercial-operations.md -> "Governed engagement and billing".
 * [COMP:app-web/crm-commercial-operations]
 */

import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import type { CrmCommercialCommand, CrmInvoiceSummary } from "@/lib/api/crm-commercial";
import { listCrmBillingRequests, type CrmBillingRequest } from "@/lib/api/crm-governed";
import { newCrmOperationId } from "@/lib/api/crm-references";
import { useT } from "@/lib/i18n/client";
import {
  CommercialInput,
  CommercialSelect,
  CommercialTextarea,
  IssueList,
  RefusalLine,
  STABLE_KEY_PATTERN,
  UncertainWrite,
  isCalendarDate,
  useCommercialCommand,
} from "./commercial-shared";
import { describeGovernedRefusal } from "./governed-shared";
import { NO_BILLING_REQUEST, billingRequestOptions, formatInvoiceMoney, useReadyBillingRequests } from "./invoice-preparation";

type DealOption = { id: string; name: string };

const DECIMAL_PATTERN = /^-?\d{1,18}(\.\d{1,6})?$/;

type AllocationRow = { rowId: number; dealId: string; amount: string; billingRequestId: string };

let allocationSequence = 0;
const nextAllocationId = () => { allocationSequence += 1; return allocationSequence; };

export function RecordExternalInvoiceForm({ workspaceId, accountId, deals, onSaved, onCancel }: {
  workspaceId: string;
  accountId: string;
  deals: readonly DealOption[];
  onSaved: (message: string) => void;
  onCancel: () => void;
}) {
  const g = useT().crmPage.governed;
  const commercial = useT().crmPage.commercial;
  const [provider, setProvider] = useState("");
  const [remoteId, setRemoteId] = useState("");
  const [number, setNumber] = useState("");
  const [issueDate, setIssueDate] = useState("");
  const [currency, setCurrency] = useState("HKD");
  const [total, setTotal] = useState("");
  const [rows, setRows] = useState<AllocationRow[]>(() => [{ rowId: nextAllocationId(), dealId: deals[0]?.id ?? "", amount: "", billingRequestId: NO_BILLING_REQUEST }]);
  const [refusal, setRefusal] = useState<string | null>(null);
  const writer = useCommercialCommand(workspaceId);
  const locked = writer.busy || writer.uncertain !== null;
  const ready = useReadyBillingRequests(workspaceId, deals.map((deal) => deal.id));

  const issues: string[] = [];
  if (!STABLE_KEY_PATTERN.test(provider.trim())) issues.push(g.issues.provider);
  if (!remoteId.trim()) issues.push(g.issues.remoteId);
  if (!number.trim()) issues.push(g.issues.invoiceNumber);
  if (!isCalendarDate(issueDate)) issues.push(g.issues.issueDate);
  if (!/^[A-Z]{3}$/.test(currency.trim())) issues.push(g.issues.billingCurrency);
  if (!DECIMAL_PATTERN.test(total.trim())) issues.push(g.issues.total);
  if (rows.length === 0 || rows.some((row) => !row.dealId || !DECIMAL_PATTERN.test(row.amount.trim()))) issues.push(g.issues.allocations);

  const update = (rowId: number, patch: Partial<AllocationRow>) => setRows((current) => current.map((row) => row.rowId === rowId ? { ...row, ...patch } : row));
  const pickRequest = (row: AllocationRow, value: string) => {
    const request = ready.find((item) => item.id === value);
    update(row.rowId, { billingRequestId: value, ...(request ? { amount: request.amount } : {}) });
  };

  async function send(command: CrmCommercialCommand) {
    setRefusal(null);
    const outcome = await writer.run(command);
    if (outcome.ok) {
      onSaved(outcome.result.duplicate ? g.externalAlreadyRecorded : g.externalRecorded);
      return;
    }
    if (!outcome.error.uncertain) setRefusal(describeGovernedRefusal(outcome.error, g, commercial));
  }

  async function submit() {
    if (issues.length || locked) return;
    const confirmed = await confirmDialog({
      title: g.recordExternalConfirmTitle.replace("{number}", number.trim()),
      description: g.recordExternalConfirmDescription
        .replace("{provider}", provider.trim())
        .replace("{total}", formatInvoiceMoney(total.trim(), currency.trim())),
      confirmLabel: g.recordExternal,
      cancelLabel: g.cancel,
    });
    if (!confirmed) return;
    await send({
      kind: "record_external_invoice",
      operationId: newCrmOperationId(),
      accountId,
      provider: provider.trim(),
      remoteId: remoteId.trim(),
      number: number.trim(),
      issueDate,
      currency: currency.trim(),
      total: total.trim(),
      allocations: rows.map((row) => ({
        dealId: row.dealId,
        amount: row.amount.trim(),
        ...(row.billingRequestId !== NO_BILLING_REQUEST ? { billingRequestId: row.billingRequestId } : {}),
      })),
    });
  }

  const dealOptions = deals.map((deal) => ({ value: deal.id, label: deal.name }));

  return (
    <div className="mt-2 min-w-0 space-y-3 rounded-lg bg-muted/30 p-3" data-external-invoice-form>
      <div className="text-xs font-medium">{g.recordExternalTitle}</div>
      <p className="text-[11px] text-muted-foreground">{g.recordExternalHelp}</p>
      <fieldset disabled={locked} className="min-w-0 space-y-3">
        <div className="grid min-w-0 gap-2 sm:grid-cols-2">
          <CommercialInput label={g.provider} value={provider} maxLength={63} onChange={(value) => setProvider(value.trim().toLowerCase())} />
          <CommercialInput label={g.remoteId} value={remoteId} maxLength={500} onChange={setRemoteId} />
          <CommercialInput label={g.invoiceNumber} value={number} maxLength={128} onChange={setNumber} />
          <CommercialInput label={g.issueDate} type="date" value={issueDate} onChange={setIssueDate} />
          <CommercialInput label={g.billingCurrency} value={currency} maxLength={3} onChange={(value) => setCurrency(value.trim().toUpperCase())} />
          <CommercialInput label={g.invoiceTotal} value={total} maxLength={26} onChange={(value) => setTotal(value.trim())} />
        </div>
        <div className="min-w-0">
          <div className="mb-1 text-xs font-medium">{g.allocations}</div>
          <p className="mb-1 text-[11px] text-muted-foreground">{g.allocationsHelp}</p>
          {deals.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">{g.noDealsForAccount}</p>
          ) : (
            <ul className="divide-y divide-border" data-external-allocations>
              {rows.map((row) => (
                <li key={row.rowId} className="grid min-w-0 items-end gap-2 py-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,2fr)_auto]" data-external-allocation>
                  <CommercialSelect label={g.allocationDeal} value={row.dealId} options={dealOptions}
                    onChange={(dealId) => update(row.rowId, { dealId, billingRequestId: NO_BILLING_REQUEST })} />
                  <CommercialInput label={g.allocationAmount} value={row.amount} maxLength={26}
                    disabled={row.billingRequestId !== NO_BILLING_REQUEST} onChange={(amount) => update(row.rowId, { amount: amount.trim() })} />
                  <CommercialSelect label={g.billingRequestOptional} value={row.billingRequestId}
                    options={billingRequestOptions(ready, row.dealId, g.noBillingRequest)} onChange={(value) => pickRequest(row, value)} />
                  <Button size="icon-xs" variant="ghost" className="max-md:size-11" aria-label={g.removeAllocation} disabled={rows.length <= 1}
                    onClick={() => setRows((current) => current.filter((item) => item.rowId !== row.rowId))}>
                    <Trash2 aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {deals.length > 0 && (
            <Button size="sm" variant="outline" disabled={rows.length >= 50}
              onClick={() => setRows((current) => [...current, { rowId: nextAllocationId(), dealId: deals[0]?.id ?? "", amount: "", billingRequestId: NO_BILLING_REQUEST }])}>
              <Plus aria-hidden />{g.addAllocation}
            </Button>
          )}
        </div>
      </fieldset>
      <IssueList issues={issues} />
      <RefusalLine text={refusal} />
      <UncertainWrite writer={writer} onRetry={(command) => void send(command)} onDiscard={onCancel} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={writer.busy} onClick={onCancel}>{g.cancel}</Button>
        <Button size="sm" disabled={issues.length > 0 || locked} onClick={() => void submit()}>{writer.busy ? g.saving : g.recordExternal}</Button>
      </div>
    </div>
  );
}

/** Correct an external invoice's reference. The invoice itself is kept: never voided, never deleted. */
export function CorrectExternalReferenceForm({ workspaceId, invoice, onSaved, onCancel }: {
  workspaceId: string;
  invoice: CrmInvoiceSummary;
  onSaved: (message: string) => void;
  onCancel: () => void;
}) {
  const g = useT().crmPage.governed;
  const commercial = useT().crmPage.commercial;
  const [number, setNumber] = useState(invoice.number ?? "");
  const [reopen, setReopen] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [closed, setClosed] = useState<CrmBillingRequest[] | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const writer = useCommercialCommand(workspaceId);
  const locked = writer.busy || writer.uncertain !== null;

  useEffect(() => {
    let cancelled = false;
    void listCrmBillingRequests(workspaceId, { state: "invoiced" })
      .then((rows) => { if (!cancelled) setClosed(rows.filter((row) => row.invoiceId === invoice.id)); })
      .catch(() => { if (!cancelled) setClosed([]); });
    return () => { cancelled = true; };
  }, [workspaceId, invoice.id]);

  const numberChanged = number.trim() !== "" && number.trim() !== (invoice.number ?? "");
  const issues: string[] = [];
  if (!numberChanged && reopen.length === 0) issues.push(g.issues.correctionEmpty);
  if (!reason.trim()) issues.push(g.issues.correctionReason);

  async function send(command: CrmCommercialCommand) {
    setRefusal(null);
    const outcome = await writer.run(command);
    if (outcome.ok) { onSaved(g.referenceCorrected); return; }
    if (!outcome.error.uncertain) setRefusal(describeGovernedRefusal(outcome.error, g, commercial));
  }

  async function submit() {
    if (issues.length || locked) return;
    const confirmed = await confirmDialog({
      title: g.correctConfirmTitle.replace("{number}", invoice.number ?? ""),
      description: g.correctConfirmDescription,
      confirmLabel: g.correctReference,
      cancelLabel: g.cancel,
    });
    if (!confirmed) return;
    await send({
      kind: "correct_external_invoice_reference",
      operationId: newCrmOperationId(),
      invoiceId: invoice.id,
      expectedVersion: invoice.version,
      ...(numberChanged ? { number: number.trim() } : {}),
      reopenBillingRequestIds: reopen,
      reason: reason.trim(),
    });
  }

  const toggle = (id: string) => setReopen((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);

  return (
    <div className="mt-2 min-w-0 space-y-3 rounded-lg bg-muted/30 p-3" data-external-correction={invoice.id}>
      <div className="text-xs font-medium">{g.correctTitle.replace("{number}", invoice.number ?? "")}</div>
      <p className="text-[11px] text-muted-foreground">{g.correctHelp}</p>
      <fieldset disabled={locked} className="min-w-0 space-y-3">
        <CommercialInput label={g.newNumber} value={number} maxLength={128} onChange={setNumber} />
        <div className="min-w-0">
          <div className="mb-1 text-xs text-muted-foreground">{g.reopenRequests}</div>
          {closed === null ? (
            <p className="text-[11px] text-muted-foreground">{g.loading}</p>
          ) : closed.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">{g.noClosedRequests}</p>
          ) : (
            <div className="flex flex-wrap gap-1">
              {closed.map((request) => (
                <Button key={request.id} size="xs" variant={reopen.includes(request.id) ? "default" : "outline"} className="max-md:min-h-11"
                  aria-pressed={reopen.includes(request.id)} onClick={() => toggle(request.id)}>
                  {formatInvoiceMoney(request.amount, request.currency)} · {request.description}
                </Button>
              ))}
            </div>
          )}
        </div>
        <CommercialTextarea label={g.correctionReason} value={reason} maxLength={2000} onChange={setReason} />
      </fieldset>
      <IssueList issues={issues} />
      <RefusalLine text={refusal} />
      <UncertainWrite writer={writer} onRetry={(command) => void send(command)} onDiscard={onCancel} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={writer.busy} onClick={onCancel}>{g.cancel}</Button>
        <Button size="sm" disabled={issues.length > 0 || locked} onClick={() => void submit()}>{writer.busy ? g.saving : g.correctReference}</Button>
      </div>
    </div>
  );
}
