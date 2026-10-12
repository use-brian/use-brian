"use client";

/**
 * Governed record changes: the "Propose change" form for a company (name,
 * domain) or a deal's governed engagement fields (name, service category,
 * service period, financial period), and the list of a record's change
 * requests with their author's Withdraw and Resubmit actions.
 *
 * A proposal is saved and then submitted, each with its own operation id; an
 * uncertain step is retried with that exact command. The server decides
 * whether the change applied directly or waits for review, and the UI says
 * which one happened.
 *
 * Spec: docs/architecture/features/crm-commercial-operations.md -> "Governed engagement and billing".
 * [COMP:app-web/crm-commercial-operations]
 */

import { useEffect, useState } from "react";
import { GitPullRequestArrow, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import type { CrmCommercialCommand } from "@/lib/api/crm-commercial";
import {
  getCrmChangeRequest,
  listCrmChangeRequests,
  type CrmChangeRequest,
  type CrmChangeRequestDetail,
  type CrmChangeSet,
  type CrmEngagementChanges,
  type CrmGovernance,
} from "@/lib/api/crm-governed";
import { newCrmOperationId } from "@/lib/api/crm-references";
import { useT } from "@/lib/i18n/client";
import {
  CommercialInput,
  CommercialSelect,
  CommercialTextarea,
  IssueList,
  RefusalLine,
  UncertainWrite,
  isCalendarDate,
  useCommercialCommand,
} from "./commercial-shared";
import {
  ChangeRequestStateBadge,
  describeGovernedRefusal,
  formatGovernedValue,
  governedFieldLabel,
  type GovernedMember,
} from "./governed-shared";

const NOT_SET = "__not_set__";

type CompanyCurrent = { kind: "company"; id: string; name: string; domain: string | null };
type DealCurrent = {
  kind: "deal";
  id: string;
  name: string;
  serviceCategory: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  financialPeriod: string | null;
};

/** The changed fields only; an untouched field is never part of the proposal. */
function changeSetFor(current: CompanyCurrent | DealCurrent, draft: Record<string, string>): CrmChangeSet {
  const changes: CrmChangeSet = { assignReferences: [] };
  const name = (draft.name ?? "").trim();
  if (name && name !== current.name) changes.name = name;
  if (current.kind === "company") {
    const domain = (draft.domain ?? "").trim().toLowerCase();
    if (domain !== (current.domain ?? "")) changes.domain = domain || null;
    return changes;
  }
  const engagement: CrmEngagementChanges = {};
  const category = draft.serviceCategory === NOT_SET ? null : draft.serviceCategory ?? current.serviceCategory;
  if (category !== current.serviceCategory) engagement.serviceCategory = category;
  for (const key of ["periodStart", "periodEnd", "financialPeriod"] as const) {
    const value = (draft[key] ?? "").trim() || null;
    if (value !== current[key]) engagement[key] = value;
  }
  if (Object.keys(engagement).length) changes.engagement = engagement;
  return changes;
}

export function ProposeChangeForm({ workspaceId, current, governance, onDone, onCancel }: {
  workspaceId: string;
  current: CompanyCurrent | DealCurrent;
  governance: CrmGovernance | null;
  /** `applied`: the policy let this actor apply directly. */
  onDone: (outcome: { applied: boolean }) => void;
  onCancel: () => void;
}) {
  const g = useT().crmPage.governed;
  const commercial = useT().crmPage.commercial;
  const [draft, setDraft] = useState<Record<string, string>>((): Record<string, string> => current.kind === "company"
    ? { name: current.name, domain: current.domain ?? "" }
    : {
      name: current.name,
      serviceCategory: current.serviceCategory ?? NOT_SET,
      periodStart: current.periodStart ?? "",
      periodEnd: current.periodEnd ?? "",
      financialPeriod: current.financialPeriod ?? "",
    });
  const [note, setNote] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const writer = useCommercialCommand(workspaceId);
  const locked = writer.busy || writer.uncertain !== null;
  const set = (key: string, value: string) => setDraft((prev) => ({ ...prev, [key]: value }));

  const changes = changeSetFor(current, draft);
  const changed = changes.name !== undefined || changes.domain !== undefined || changes.engagement !== undefined;
  const issues: string[] = [];
  if (!(draft.name ?? "").trim()) issues.push(g.issues.name);
  if (current.kind === "company" && draft.domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(draft.domain.trim())) issues.push(g.issues.domain);
  if (current.kind === "deal") {
    const start = draft.periodStart ?? "";
    const end = draft.periodEnd ?? "";
    if ((start && !isCalendarDate(start)) || (end && !isCalendarDate(end)) || (start && end && end < start)) issues.push(g.issues.period);
  }

  const categories = (governance?.catalogs.find((item) => item.catalog === "service_category")?.entries ?? [])
    .filter((entry) => !entry.archived || (current.kind === "deal" && entry.key === current.serviceCategory));

  async function send(command: CrmCommercialCommand) {
    setRefusal(null);
    const outcome = await writer.run(command);
    if (!outcome.ok) {
      if (!outcome.error.uncertain) setRefusal(describeGovernedRefusal(outcome.error, g, commercial));
      return;
    }
    const record = outcome.result.record as { request?: { id?: unknown; version?: unknown; state?: unknown }; applied?: unknown } | null;
    if (command.kind === "save_change_request") {
      const id = record?.request?.id;
      const version = record?.request?.version;
      if (typeof id !== "string" || typeof version !== "number") { setRefusal(commercial.writeFailed); return; }
      await send({ kind: "submit_change_request", operationId: newCrmOperationId(), requestId: id, expectedVersion: version });
      return;
    }
    onDone({ applied: record?.applied === true || record?.request?.state === "approved" });
  }

  function submit() {
    if (!changed || issues.length || locked) return;
    void send({
      kind: "save_change_request",
      operationId: newCrmOperationId(),
      target: { kind: current.kind, id: current.id },
      changes,
      ...(note.trim() ? { note: note.trim() } : {}),
    });
  }

  return (
    <div className="mt-2 min-w-0 space-y-3 rounded-lg bg-muted/30 p-3" data-propose-change={current.kind}>
      <div className="text-xs font-medium">{g.proposeTitle}</div>
      <p className="text-[11px] text-muted-foreground">{g.proposeHelp}</p>
      <fieldset disabled={locked} className="grid min-w-0 gap-2 sm:grid-cols-2">
        <CommercialInput label={g.fields.name} value={draft.name ?? ""} maxLength={512} onChange={(value) => set("name", value)} />
        {current.kind === "company" ? (
          <CommercialInput label={g.fields.domain} value={draft.domain ?? ""} maxLength={253} onChange={(value) => set("domain", value)} />
        ) : (
          <>
            <CommercialSelect label={g.fields.serviceCategory} value={draft.serviceCategory ?? NOT_SET}
              options={[{ value: NOT_SET, label: g.notSet }, ...categories.map((entry) => ({ value: entry.key, label: entry.label }))]}
              onChange={(value) => set("serviceCategory", value)} />
            <CommercialInput label={g.fields.periodStart} type="date" value={draft.periodStart ?? ""} onChange={(value) => set("periodStart", value)} />
            <CommercialInput label={g.fields.periodEnd} type="date" value={draft.periodEnd ?? ""} onChange={(value) => set("periodEnd", value)} />
            <CommercialInput label={g.fields.financialPeriod} value={draft.financialPeriod ?? ""} maxLength={40} onChange={(value) => set("financialPeriod", value)} />
          </>
        )}
        <div className="sm:col-span-2">
          <CommercialTextarea label={g.noteOptional} value={note} maxLength={2000} onChange={setNote} />
        </div>
      </fieldset>
      {!changed && <p className="text-[11px] text-muted-foreground">{g.noChanges}</p>}
      <IssueList issues={issues} />
      <RefusalLine text={refusal} />
      <UncertainWrite writer={writer} onRetry={(command) => void send(command)} onDiscard={onCancel} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={writer.busy} onClick={onCancel}>{g.cancel}</Button>
        <Button size="sm" disabled={!changed || issues.length > 0 || locked} onClick={submit}>{writer.busy ? g.submitting : g.submitProposal}</Button>
      </div>
    </div>
  );
}

/** The touched fields of a request, for its one-line summary. */
function touchedFields(request: CrmChangeRequest): string[] {
  const changes = request.draftChanges ?? {};
  const fields = Object.keys(changes).filter((key) => key !== "engagement" && key !== "assignReferences");
  for (const key of Object.keys(changes.engagement ?? {})) fields.push(`engagement.${key}`);
  return fields;
}

/**
 * A record's change requests, newest as the server lists them. The author
 * may withdraw an open request (with a reason) or resubmit a draft or
 * returned one; the decision history shows why a request was returned.
 */
export function ChangeRequestList({ workspaceId, targetId, currentUserId, members, governance, reloadKey, onChanged }: {
  workspaceId: string;
  targetId: string;
  currentUserId: string | null;
  members: readonly GovernedMember[];
  governance: CrmGovernance | null;
  reloadKey: number;
  onChanged: () => void;
}) {
  const g = useT().crmPage.governed;
  const [requests, setRequests] = useState<CrmChangeRequest[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    void listCrmChangeRequests(workspaceId, { targetId })
      .then((rows) => { if (!cancelled) setRequests(rows); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [workspaceId, targetId, attempt, reloadKey]);

  const reload = () => { setAttempt((value) => value + 1); onChanged(); };

  if (failed && !requests) {
    return (
      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-destructive">
        <span>{g.loadFailed}</span>
        <Button size="sm" variant="ghost" onClick={() => setAttempt((value) => value + 1)}>{g.retry}</Button>
      </div>
    );
  }
  if (!requests) return <div className="mt-2 text-xs text-muted-foreground">{g.loading}</div>;
  if (requests.length === 0) return <p className="mt-1 text-[11px] text-muted-foreground">{g.noChangeRequests}</p>;
  return (
    <ul className="mt-1 divide-y divide-border/60" data-change-request-list>
      {requests.map((request) => (
        <ChangeRequestRow key={request.id} workspaceId={workspaceId} request={request} own={Boolean(currentUserId) && request.authorUserId === currentUserId}
          members={members} governance={governance} onChanged={reload} />
      ))}
    </ul>
  );
}

function ChangeRequestRow({ workspaceId, request, own, members, governance, onChanged }: {
  workspaceId: string;
  request: CrmChangeRequest;
  own: boolean;
  members: readonly GovernedMember[];
  governance: CrmGovernance | null;
  onChanged: () => void;
}) {
  const g = useT().crmPage.governed;
  const commercial = useT().crmPage.commercial;
  const [withdrawing, setWithdrawing] = useState(false);
  const [reason, setReason] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [history, setHistory] = useState<CrmChangeRequestDetail | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [pendingMessage, setPendingMessage] = useState("");
  const writer = useCommercialCommand(workspaceId);
  const locked = writer.busy || writer.uncertain !== null;
  const open = request.state === "draft" || request.state === "submitted" || request.state === "returned";
  const fields = touchedFields(request);

  useEffect(() => {
    if (!historyOpen) return;
    let cancelled = false;
    setHistoryFailed(false);
    void getCrmChangeRequest(workspaceId, request.id)
      .then((found) => { if (!cancelled) setHistory(found); })
      .catch(() => { if (!cancelled) setHistoryFailed(true); });
    return () => { cancelled = true; };
  }, [historyOpen, workspaceId, request.id, request.version]);

  async function send(command: CrmCommercialCommand, message: string) {
    setRefusal(null);
    setNotice(null);
    setPendingMessage(message);
    const outcome = await writer.run(command);
    if (outcome.ok) {
      const record = outcome.result.record as { applied?: unknown } | null;
      setNotice(command.kind === "submit_change_request" && record?.applied === true ? g.appliedDirect : message);
      setWithdrawing(false);
      onChanged();
      return;
    }
    if (!outcome.error.uncertain) setRefusal(describeGovernedRefusal(outcome.error, g, commercial));
  }

  async function withdraw() {
    if (!reason.trim() || locked) return;
    const confirmed = await confirmDialog({
      title: g.withdrawConfirmTitle,
      description: g.withdrawConfirmDescription,
      confirmLabel: g.withdraw,
      cancelLabel: g.cancel,
      variant: "destructive",
    });
    if (!confirmed) return;
    await send({ kind: "withdraw_change_request", operationId: newCrmOperationId(), requestId: request.id, expectedVersion: request.version, reason: reason.trim() },
      g.withdrawn);
  }

  return (
    <li className="min-w-0 py-2" data-change-request={request.id}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <ChangeRequestStateBadge state={request.state} />
        <span className="text-[11px] text-muted-foreground">{g.revisionLabel.replace("{revision}", String(request.revision))}</span>
        <span className="text-[11px] text-muted-foreground">{new Date(request.updatedAt).toLocaleDateString()}</span>
        <div className="ml-auto flex flex-wrap gap-1">
          <Button size="xs" variant={historyOpen ? "secondary" : "ghost"} className="max-md:min-h-11" aria-pressed={historyOpen}
            onClick={() => setHistoryOpen((value) => !value)}>{g.history}</Button>
          {own && (request.state === "draft" || request.state === "returned") && (
            <Button size="xs" variant="outline" className="max-md:min-h-11" disabled={locked}
              onClick={() => void send({ kind: "submit_change_request", operationId: newCrmOperationId(), requestId: request.id, expectedVersion: request.version }, g.submittedForReview)}>
              {g.resubmit}
            </Button>
          )}
          {own && open && !withdrawing && (
            <Button size="xs" variant="ghost" className="max-md:min-h-11" disabled={locked} onClick={() => { setRefusal(null); setWithdrawing(true); }}>{g.withdraw}</Button>
          )}
        </div>
      </div>
      <p className="mt-0.5 break-words text-[11px] text-muted-foreground">
        {fields.length ? fields.map((field) => governedFieldLabel(field, g)).join(", ") : g.noFieldsTouched}
      </p>
      {request.note && <p className="mt-0.5 break-words text-[11px] text-muted-foreground">{g.noteLabel.replace("{note}", request.note)}</p>}
      {withdrawing && (
        <div className="mt-2 space-y-2" data-change-request-withdraw>
          <CommercialTextarea label={g.withdrawReason} value={reason} maxLength={2000} onChange={setReason} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="ghost" disabled={writer.busy} onClick={() => setWithdrawing(false)}>{g.cancel}</Button>
            <Button size="sm" variant="destructive" disabled={locked || !reason.trim()} onClick={() => void withdraw()}>{g.withdraw}</Button>
          </div>
        </div>
      )}
      {notice && <p role="status" className="mt-1 text-xs text-emerald-700 dark:text-emerald-300">{notice}</p>}
      <RefusalLine text={refusal} />
      <UncertainWrite writer={writer} onRetry={(command) => void send(command, pendingMessage)} onDiscard={onChanged} />
      {historyOpen && (historyFailed ? (
        <p className="mt-1 text-[11px] text-destructive">{g.loadFailed}</p>
      ) : !history ? (
        <p className="mt-1 text-[11px] text-muted-foreground">{g.loading}</p>
      ) : (
        <ChangeRequestHistory detail={history} members={members} governance={governance} />
      ))}
    </li>
  );
}

function ChangeRequestHistory({ detail, members, governance }: {
  detail: CrmChangeRequestDetail;
  members: readonly GovernedMember[];
  governance: CrmGovernance | null;
}) {
  const g = useT().crmPage.governed;
  const latest = detail.revisions[detail.revisions.length - 1] ?? null;
  return (
    <div className="mt-2 space-y-2 border-l border-border pl-3" data-change-request-history>
      {latest && <ChangeDiffTable changes={latest.changes} snapshot={latest.currentSnapshot} isNew={detail.request.targetId === null} members={members} governance={governance} />}
      {detail.decisions.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">{g.noDecisions}</p>
      ) : (
        <ul className="space-y-0.5 text-[11px]">
          {detail.decisions.map((decision, index) => (
            <li key={`${decision.revision}-${index}`} data-change-decision={decision.decision}>
              <span className="font-medium">{g.decisions[decision.decision]}</span>
              <span className="ml-1 text-muted-foreground">{g.revisionLabel.replace("{revision}", String(decision.revision))}</span>
              {decision.reason && <span className="ml-1 break-words">{decision.reason}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Rows of one revision: the field, its current value at submit, and the proposed value. */
function diffRows(changes: Partial<CrmChangeSet>, snapshot: Record<string, unknown>): Array<{ field: string; current: unknown; proposed: unknown }> {
  const rows: Array<{ field: string; current: unknown; proposed: unknown }> = [];
  for (const [key, value] of Object.entries(changes)) {
    if (key === "engagement" || key === "assignReferences") continue;
    rows.push({ field: key, current: snapshot[key], proposed: value });
  }
  for (const [key, value] of Object.entries(changes.engagement ?? {})) {
    const field = `engagement.${key}`;
    rows.push({ field, current: snapshot[field], proposed: value });
  }
  return rows;
}

/** Current vs proposed for each touched field of the latest revision. */
export function ChangeDiffTable({ changes, snapshot, isNew, members, governance }: {
  changes: Partial<CrmChangeSet>;
  snapshot: Record<string, unknown>;
  isNew: boolean;
  members: readonly GovernedMember[];
  governance: CrmGovernance | null;
}) {
  const g = useT().crmPage.governed;
  const rows = diffRows(changes, snapshot);
  const context = { g, members, governance };
  const references = changes.assignReferences ?? [];
  return (
    <div className="min-w-0" data-change-diff>
      {isNew && <p className="mb-1 text-[11px] text-muted-foreground">{g.newRecord}</p>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-0 table-fixed text-left text-xs">
          <thead>
            <tr className="text-[11px] text-muted-foreground">
              <th className="w-1/3 py-1 pr-2 font-normal">{g.diffField}</th>
              <th className="w-1/3 py-1 pr-2 font-normal">{g.diffCurrent}</th>
              <th className="w-1/3 py-1 font-normal">{g.diffProposed}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {rows.map((row) => (
              <tr key={row.field} data-diff-row={row.field} className="align-top">
                <td className="break-words py-1 pr-2 font-medium">{governedFieldLabel(row.field, g)}</td>
                <td className="break-words py-1 pr-2 text-muted-foreground" data-diff-current>{formatGovernedValue(row.field, isNew ? undefined : row.current, context)}</td>
                <td className="break-words py-1" data-diff-proposed>{formatGovernedValue(row.field, row.proposed, context)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {references.length > 0 && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          {g.assignReferences.replace("{keys}", references.map((reference) => reference.definitionKey).join(", "))}
        </p>
      )}
    </div>
  );
}

/** A company's governed changes: Propose change (name, domain) and the company's change requests. */
export function CrmCompanyChangeRequests({ workspaceId, companyId, companyName, domain, currentUserId, members, onRecordChanged }: {
  workspaceId: string;
  companyId: string;
  companyName: string;
  domain: string | null;
  currentUserId: string | null;
  members: readonly GovernedMember[];
  /** The company itself may have changed (a direct application or a resubmission). */
  onRecordChanged?: () => void;
}) {
  const g = useT().crmPage.governed;
  const [proposing, setProposing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    setProposing(false);
    setNotice(null);
  }, [workspaceId, companyId]);

  return (
    <section className="mt-4 min-w-0 border-t border-border/60 pt-4" data-crm-company-changes>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/60">
          <GitPullRequestArrow className="size-3.5" aria-hidden />{g.changesTitle}
        </div>
        {!proposing && (
          <Button size="xs" variant="ghost" className="max-md:min-h-11" onClick={() => { setNotice(null); setProposing(true); }}>
            <Plus aria-hidden />{g.proposeChange}
          </Button>
        )}
      </div>
      {notice && <p role="status" className="mb-2 text-xs text-emerald-700 dark:text-emerald-300">{notice}</p>}
      {proposing && (
        <ProposeChangeForm
          workspaceId={workspaceId}
          current={{ kind: "company", id: companyId, name: companyName, domain }}
          governance={null}
          onCancel={() => setProposing(false)}
          onDone={({ applied }) => {
            setProposing(false);
            setNotice(applied ? g.appliedDirect : g.submittedForReview);
            setReloadKey((value) => value + 1);
            if (applied) onRecordChanged?.();
          }}
        />
      )}
      <ChangeRequestList workspaceId={workspaceId} targetId={companyId} currentUserId={currentUserId} members={members}
        governance={null} reloadKey={reloadKey} onChanged={() => onRecordChanged?.()} />
    </section>
  );
}
