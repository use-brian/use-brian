"use client";

/**
 * The CRM review queue: submitted change requests with a current-versus-
 * proposed table for their latest revision, and billing requests waiting in
 * review with their step (reviewer, then finance where the policy has one).
 *
 * Decision controls are shown to owners and admins. Every refusal is the
 * server's answer, said plainly: the author cannot review their own request,
 * the finance step needs a different reviewer, and a record that changed
 * after submission must be returned so the author resubmits.
 *
 * Spec: docs/architecture/features/crm-commercial-operations.md -> "Governed engagement and billing".
 * [COMP:app-web/crm-commercial-operations]
 */

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import type { CrmCommercialCommand } from "@/lib/api/crm-commercial";
import {
  getCrmChangeRequest,
  getCrmGovernance,
  listCrmBillingRequests,
  listCrmChangeRequests,
  type CrmBillingRequest,
  type CrmChangeRequest,
  type CrmChangeRequestDetail,
  type CrmGovernance,
} from "@/lib/api/crm-governed";
import { newCrmOperationId } from "@/lib/api/crm-references";
import { useT } from "@/lib/i18n/client";
import { CommercialTextarea, RefusalLine, UncertainWrite, useCommercialCommand } from "./commercial-shared";
import { ChangeDiffTable } from "./change-requests";
import {
  BillingStateBadge,
  ChangeRequestStateBadge,
  describeGovernedRefusal,
  memberLabel,
  type GovernedMember,
} from "./governed-shared";
import { formatInvoiceMoney } from "./invoice-preparation";

type Loaded = { changes: CrmChangeRequest[]; billing: CrmBillingRequest[]; governance: CrmGovernance | null };

export function CrmReviewQueue({ workspaceId, canDecide, members, recordName }: {
  workspaceId: string;
  /** Owner or admin: shows Approve, Return and Reject. */
  canDecide: boolean;
  members: readonly GovernedMember[];
  /** A company or deal display name, when the surface knows it. */
  recordName: (id: string) => string | null;
}) {
  const g = useT().crmPage.governed;
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    void Promise.all([
      listCrmChangeRequests(workspaceId, { reviewable: true }),
      listCrmBillingRequests(workspaceId, { state: "review" }),
      getCrmGovernance(workspaceId).catch(() => null),
    ])
      .then(([changes, billing, governance]) => { if (!cancelled) setData({ changes, billing, governance }); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [workspaceId, attempt]);

  const reload = () => setAttempt((value) => value + 1);
  const decided = (message: string) => { setNotice(message); reload(); };

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-4 md:px-6" data-crm-review-queue>
      <div className="mx-auto w-full min-w-0 max-w-3xl space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{g.reviewsTitle}</h2>
            <p className="text-xs text-muted-foreground">{g.reviewsHelp}</p>
          </div>
          <Button size="sm" variant="ghost" onClick={reload}>{g.refresh}</Button>
        </div>
        {!canDecide && <p className="text-xs text-muted-foreground">{g.reviewsReadOnly}</p>}
        {notice && <p role="status" className="text-xs text-emerald-700 dark:text-emerald-300">{notice}</p>}
        {failed && !data ? (
          <div className="flex items-center justify-between gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <span>{g.loadFailed}</span>
            <Button size="sm" variant="ghost" onClick={reload}>{g.retry}</Button>
          </div>
        ) : !data ? (
          <div className="text-xs text-muted-foreground">{g.loading}</div>
        ) : (
          <>
            <section className="min-w-0" data-review-changes>
              <h3 className="mb-1 text-xs font-semibold">{g.changeReviewsTitle}</h3>
              {data.changes.length === 0 ? (
                <p className="text-xs text-muted-foreground">{g.noChangeReviews}</p>
              ) : (
                <ul className="divide-y divide-border">
                  {data.changes.map((request) => (
                    <ChangeReviewItem key={request.id} workspaceId={workspaceId} request={request} canDecide={canDecide} members={members}
                      governance={data.governance} recordName={recordName} onDecided={decided} onReload={reload} />
                  ))}
                </ul>
              )}
            </section>
            <section className="min-w-0" data-review-billing>
              <h3 className="mb-1 text-xs font-semibold">{g.billingReviewsTitle}</h3>
              {data.billing.length === 0 ? (
                <p className="text-xs text-muted-foreground">{g.noBillingReviews}</p>
              ) : (
                <ul className="divide-y divide-border">
                  {data.billing.map((request) => (
                    <BillingReviewItem key={request.id} workspaceId={workspaceId} request={request} canDecide={canDecide} members={members}
                      recordName={recordName} onDecided={decided} onReload={reload} />
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function ChangeReviewItem({ workspaceId, request, canDecide, members, governance, recordName, onDecided, onReload }: {
  workspaceId: string;
  request: CrmChangeRequest;
  canDecide: boolean;
  members: readonly GovernedMember[];
  governance: CrmGovernance | null;
  recordName: (id: string) => string | null;
  onDecided: (message: string) => void;
  onReload: () => void;
}) {
  const g = useT().crmPage.governed;
  const commercial = useT().crmPage.commercial;
  const [detail, setDetail] = useState<CrmChangeRequestDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [reason, setReason] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pendingMessage, setPendingMessage] = useState("");
  const writer = useCommercialCommand(workspaceId);
  const locked = writer.busy || writer.uncertain !== null;

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    void getCrmChangeRequest(workspaceId, request.id)
      .then((found) => { if (!cancelled) setDetail(found); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [workspaceId, request.id, request.revision]);

  const latest = detail?.revisions.find((revision) => revision.revision === request.revision) ?? detail?.revisions[detail.revisions.length - 1] ?? null;
  const target = request.targetId ? recordName(request.targetId) : null;
  const author = memberLabel(members, request.authorUserId) ?? g.authorUnknown;

  async function send(command: CrmCommercialCommand, message: string) {
    setRefusal(null);
    setPendingMessage(message);
    const outcome = await writer.run(command);
    if (outcome.ok) { onDecided(message); return; }
    if (!outcome.error.uncertain) setRefusal(describeGovernedRefusal(outcome.error, g, commercial));
  }

  async function decide(decision: "approve" | "return" | "reject") {
    if (locked) return;
    if (decision !== "approve" && !reason.trim()) return;
    if (decision !== "approve") {
      const confirmed = await confirmDialog({
        title: decision === "return" ? g.returnConfirmTitle : g.rejectConfirmTitle,
        description: decision === "return" ? g.returnConfirmDescription : g.rejectConfirmDescription,
        confirmLabel: decision === "return" ? g.returnAction : g.rejectAction,
        cancelLabel: g.cancel,
        variant: decision === "reject" ? "destructive" : "default",
      });
      if (!confirmed) return;
    }
    await send({
      kind: "decide_change_request",
      operationId: newCrmOperationId(),
      requestId: request.id,
      expectedRevision: request.revision,
      decision,
      ...(decision !== "approve" ? { reason: reason.trim() } : {}),
    }, g.decided[decision]);
  }

  return (
    <li className="min-w-0 py-3" data-review-change={request.id}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <ChangeRequestStateBadge state={request.state} />
        <span className="font-medium">{g.targetKinds[request.targetKind]}</span>
        <span className="min-w-0 break-words">{target ?? (request.targetId ? request.targetId : g.newRecord)}</span>
        <span className="text-[11px] text-muted-foreground">{g.policySubjects[request.policySubject]}</span>
      </div>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        {g.submittedBy.replace("{author}", author).replace("{revision}", String(request.revision))}
      </p>
      {request.note && <p className="mt-0.5 break-words text-[11px] text-muted-foreground">{g.noteLabel.replace("{note}", request.note)}</p>}
      <div className="mt-2">
        {failed ? (
          <p className="text-[11px] text-destructive">{g.loadFailed}</p>
        ) : !latest ? (
          <p className="text-[11px] text-muted-foreground">{g.loading}</p>
        ) : (
          <ChangeDiffTable changes={latest.changes} snapshot={latest.currentSnapshot} isNew={request.targetId === null} members={members} governance={governance} />
        )}
      </div>
      {canDecide && (
        <div className="mt-2 space-y-2" data-review-decision>
          <CommercialTextarea label={g.decisionReason} value={reason} maxLength={2000} onChange={setReason} />
          <p className="text-[11px] text-muted-foreground">{g.decisionReasonHelp}</p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="ghost" disabled={locked || !reason.trim()} onClick={() => void decide("reject")}>{g.rejectAction}</Button>
            <Button size="sm" variant="outline" disabled={locked || !reason.trim()} onClick={() => void decide("return")}>{g.returnAction}</Button>
            <Button size="sm" disabled={locked || !latest} onClick={() => void decide("approve")}>{g.approveAction}</Button>
          </div>
        </div>
      )}
      <RefusalLine text={refusal} />
      <UncertainWrite writer={writer} onRetry={(command) => void send(command, pendingMessage)} onDiscard={onReload} />
    </li>
  );
}

function BillingReviewItem({ workspaceId, request, canDecide, members, recordName, onDecided, onReload }: {
  workspaceId: string;
  request: CrmBillingRequest;
  canDecide: boolean;
  members: readonly GovernedMember[];
  recordName: (id: string) => string | null;
  onDecided: (message: string) => void;
  onReload: () => void;
}) {
  const g = useT().crmPage.governed;
  const commercial = useT().crmPage.commercial;
  const [reason, setReason] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pendingMessage, setPendingMessage] = useState("");
  const writer = useCommercialCommand(workspaceId);
  const locked = writer.busy || writer.uncertain !== null;
  const author = memberLabel(members, request.authorUserId) ?? g.authorUnknown;
  const reviewer = memberLabel(members, request.reviewedByUserId);

  async function send(command: CrmCommercialCommand, message: string) {
    setRefusal(null);
    setPendingMessage(message);
    const outcome = await writer.run(command);
    if (outcome.ok) {
      const record = outcome.result.record as { request?: { state?: unknown; reviewStep?: unknown } } | null;
      onDecided(record?.request?.state === "review" && record.request.reviewStep === "finance" ? g.movedToFinance : message);
      return;
    }
    if (!outcome.error.uncertain) setRefusal(describeGovernedRefusal(outcome.error, g, commercial));
  }

  async function decide(decision: "approve" | "return") {
    if (locked) return;
    if (decision === "return") {
      if (!reason.trim()) return;
      const confirmed = await confirmDialog({
        title: g.returnBillingConfirmTitle,
        description: g.returnBillingConfirmDescription,
        confirmLabel: g.returnAction,
        cancelLabel: g.cancel,
      });
      if (!confirmed) return;
    }
    await send({
      kind: "decide_billing_request",
      operationId: newCrmOperationId(),
      requestId: request.id,
      expectedVersion: request.version,
      decision,
      ...(decision === "return" ? { reason: reason.trim() } : {}),
    }, decision === "approve" ? g.billingApproved : g.billingReturned);
  }

  return (
    <li className="min-w-0 py-3 text-xs" data-review-billing-request={request.id}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="tabular-nums font-medium">{formatInvoiceMoney(request.amount, request.currency)}</span>
        <BillingStateBadge state={request.state} step={request.reviewStep} />
        <span className="min-w-0 break-words">{recordName(request.dealId) ?? request.dealId}</span>
      </div>
      <p className="mt-0.5 break-words text-muted-foreground">{request.description}</p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        {g.billingRequestedBy.replace("{author}", author)}
        {request.reviewStep === "finance" && reviewer ? ` ${g.billingReviewedBy.replace("{reviewer}", reviewer)}` : ""}
      </p>
      {canDecide && (
        <div className="mt-2 space-y-2" data-review-billing-decision>
          <CommercialTextarea label={g.returnReason} value={reason} maxLength={2000} onChange={setReason} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="outline" disabled={locked || !reason.trim()} onClick={() => void decide("return")}>{g.returnAction}</Button>
            <Button size="sm" disabled={locked} onClick={() => void decide("approve")}>
              {request.reviewStep === "finance" ? g.approveFinance : g.approveAction}
            </Button>
          </div>
        </div>
      )}
      <RefusalLine text={refusal} />
      <UncertainWrite writer={writer} onRetry={(command) => void send(command, pendingMessage)} onDiscard={onReload} />
    </li>
  );
}
