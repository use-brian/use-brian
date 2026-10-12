/**
 * CRM governed-records SDK: change requests (proposal, review, history),
 * engagements (a deal plus its typed delivery tracking and protected
 * commercial values), billing requests, the per-currency unbilled balance,
 * the recurring-successor preview, and the governance catalogs and policies.
 *
 * Writes travel through the same commercial command lane
 * (`executeCrmCommercialCommand`), so a governed command carries a
 * caller-held `operationId` and an uncertain outcome is retried only with the
 * SAME command. Money arrives as decimal strings; the browser never computes
 * an amount. An absent or null amount is "not set", never zero.
 *
 * Spec: docs/architecture/features/crm-commercial-operations.md -> "Governed engagement and billing".
 * [COMP:app-web/crm-commercial-operations]
 */

import { CrmReferenceRequestError, crmOperationsRequest } from "@/lib/api/crm-references";

export type CrmGovernanceSubject = "client_change" | "engagement_change" | "commercial_values" | "billing_request";
export type CrmReviewMode = "direct" | "single_review" | "reviewer_then_finance";
export type CrmDirectRole = "owner" | "admin" | "member";
export type CrmCatalogKind = "service_category" | "work_status";
export type CrmCommercialValueKind = "quoted" | "confirmed" | "outsource";
export type CrmChangeRequestState = "draft" | "submitted" | "returned" | "approved" | "rejected" | "withdrawn";
export type CrmBillingRequestState = "draft" | "review" | "ready_to_bill" | "invoiced" | "returned" | "cancelled";
export type CrmCarryForward = "serviceCategory" | "owner" | "participants" | "quotedFee";

export const CRM_GOVERNANCE_SUBJECTS: readonly CrmGovernanceSubject[] = [
  "client_change", "engagement_change", "commercial_values", "billing_request",
];
export const CRM_COMMERCIAL_VALUE_KINDS: readonly CrmCommercialValueKind[] = ["quoted", "confirmed", "outsource"];

export type CrmReviewPolicy = {
  mode: CrmReviewMode;
  directRoles: CrmDirectRole[];
  reviewerDepartmentId: string | null;
  financeDepartmentId: string | null;
  allowSelfReview: boolean;
};

export type CrmCatalogEntry = { key: string; label: string; archived: boolean };

export type CrmGovernance = {
  catalogs: Array<{ catalog: CrmCatalogKind; entries: CrmCatalogEntry[]; version: number }>;
  policies: Array<{ subject: CrmGovernanceSubject; policy: CrmReviewPolicy; version: number; default?: boolean }>;
};

export type CrmEngagementChanges = {
  serviceCategory?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  financialPeriod?: string | null;
  workStatus?: string | null;
  deadline?: string | null;
  ownerUserId?: string | null;
  participantIds?: string[];
};

export type CrmChangeSet = {
  name?: string;
  companyId?: string;
  domain?: string | null;
  engagement?: CrmEngagementChanges;
  assignReferences: Array<{ definitionKey: string; categoryKey?: string; businessDate?: string }>;
};

export type CrmChangeRequest = {
  id: string;
  targetKind: "company" | "deal";
  targetId: string | null;
  appliedTargetId: string | null;
  policySubject: CrmGovernanceSubject;
  state: CrmChangeRequestState;
  revision: number;
  draftChanges: Partial<CrmChangeSet> | null;
  note: string | null;
  authorKind: string;
  authorUserId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

type CrmChangeRequestDecision = "approved" | "returned" | "rejected" | "withdrawn" | "applied_direct";

export type CrmChangeRequestDetail = {
  request: CrmChangeRequest;
  revisions: Array<{
    revision: number;
    changes: Partial<CrmChangeSet>;
    /** Current values of exactly the touched fields at submit; engagement fields keyed `engagement.<field>`. */
    currentSnapshot: Record<string, unknown>;
    policyVersion: number;
    actorKind: string;
    actorUserId: string | null;
    createdAt: string;
  }>;
  decisions: Array<{
    revision: number;
    decision: CrmChangeRequestDecision;
    reason: string | null;
    actorKind: string;
    actorUserId: string | null;
    createdAt: string;
  }>;
};

type CrmCommercialValue = {
  valueKind: CrmCommercialValueKind;
  version: number;
  /** A decimal string, or null for an explicit "not set". */
  amount: string | null;
  currency: string | null;
  evidence: { source?: string; reason?: string } | null;
};

export type CrmEngagement = {
  id: string;
  displayName: string;
  companyId: string | null;
  pipelineStage: string | null;
  serviceCategory: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  financialPeriod: string | null;
  workStatus: string | null;
  deadline: string | null;
  ownerUserId: string | null;
  participantIds: string[];
  recurrenceParentDealId: string | null;
  recurrencePeriodKey: string | null;
  /** 0 when the deal has no tracking yet. */
  trackingVersion: number;
  /** Present only when asked for, and only the values this viewer may see. */
  commercialValues?: CrmCommercialValue[];
};

export type CrmBillingRequest = {
  id: string;
  dealId: string;
  state: CrmBillingRequestState;
  reviewStep: "reviewer" | "finance" | null;
  amount: string;
  currency: string;
  description: string;
  authorUserId: string | null;
  reviewedByUserId: string | null;
  financeByUserId: string | null;
  invoiceId: string | null;
  returnReason: string | null;
  version: number;
};

export type CrmBillingBalance = {
  deals: Array<{
    dealId: string;
    displayName: string;
    confirmedFee: { amount: string; currency: string; version: number } | null;
    billed: Array<{ currency: string; amount: string }>;
    /** Null when there is no confirmed fee: never shown as zero. */
    unbilled: { currency: string; amount: string } | null;
  }>;
  unbilledByCurrency: Array<{ currency: string; unbilled: string }>;
};

export type CrmRecurringPreview = {
  periodKey: string;
  candidates: Array<{
    sourceDealId: string;
    outcome: "create" | "existing" | "stale";
    proposedName?: string;
    dealId?: string;
    reason?: string;
  }>;
};

/** The governed command kinds, sent through the commercial command lane. */
export type CrmGovernedCommand =
  | {
    kind: "save_change_request";
    operationId: string;
    requestId?: string;
    expectedVersion?: number;
    target: { kind: "company" | "deal"; id?: string };
    changes: CrmChangeSet;
    note?: string;
  }
  | { kind: "submit_change_request"; operationId: string; requestId: string; expectedVersion: number }
  | {
    kind: "decide_change_request";
    operationId: string;
    requestId: string;
    expectedRevision: number;
    decision: "approve" | "return" | "reject";
    reason?: string;
  }
  | { kind: "withdraw_change_request"; operationId: string; requestId: string; expectedVersion: number; reason: string }
  | {
    kind: "update_engagement_tracking";
    operationId: string;
    dealId: string;
    expectedVersion: number;
    tracking: Pick<CrmEngagementChanges, "workStatus" | "deadline" | "ownerUserId" | "participantIds">;
  }
  | {
    kind: "set_commercial_values";
    operationId: string;
    dealId: string;
    values: Array<{ valueKind: CrmCommercialValueKind; expectedVersion: number; amount: string | null; currency: string; rate: null }>;
    evidence: { source: string; reason: string };
  }
  | {
    kind: "commit_recurring_successors";
    operationId: string;
    sourceDealIds: string[];
    period: { key: string; periodStart: string; periodEnd: string; financialPeriod: string | null; deadline: string | null };
    carryForward: CrmCarryForward[];
  }
  | { kind: "save_governance_policy"; operationId: string; subject: CrmGovernanceSubject; expectedVersion: number; policy: CrmReviewPolicy }
  | { kind: "save_engagement_catalog"; operationId: string; catalog: CrmCatalogKind; expectedVersion: number; entries: CrmCatalogEntry[] }
  | {
    kind: "create_billing_request";
    operationId: string;
    dealId: string;
    amount: string;
    currency: string;
    description: string;
    submit: boolean;
    requestId?: string;
    expectedVersion?: number;
  }
  | { kind: "decide_billing_request"; operationId: string; requestId: string; expectedVersion: number; decision: "approve" | "return"; reason?: string }
  | { kind: "cancel_billing_request"; operationId: string; requestId: string; expectedVersion: number; reason: string }
  | {
    kind: "record_external_invoice";
    operationId: string;
    accountId: string;
    provider: string;
    remoteId: string;
    number: string;
    issueDate: string;
    currency: string;
    total: string;
    allocations: Array<{ dealId: string; amount: string; billingRequestId?: string }>;
  }
  | {
    kind: "correct_external_invoice_reference";
    operationId: string;
    invoiceId: string;
    expectedVersion: number;
    number?: string;
    reopenBillingRequestIds: string[];
    reason: string;
  };

const base = (workspaceId: string) => `/api/crm/${encodeURIComponent(workspaceId)}/operations`;

function requireArray<T>(value: T[] | undefined): T[] {
  if (!Array.isArray(value)) throw new CrmReferenceRequestError("invalid_response", 502);
  return value;
}

/** Every page of one list read, following continuation until `nextCursor` is null. */
async function readAllPages<T, K extends string>(path: string, key: K, params: URLSearchParams): Promise<T[]> {
  const rows: T[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = new URLSearchParams(params);
    page.set("limit", "100");
    if (cursor) page.set("cursor", cursor);
    const body = await crmOperationsRequest<Record<K, T[] | undefined> & { nextCursor?: string | null }>(`${path}?${page}`);
    rows.push(...requireArray(body[key]));
    const next = body.nextCursor ?? null;
    if (next !== null && (typeof next !== "string" || !next || seen.has(next))) {
      throw new CrmReferenceRequestError("invalid_response", 502);
    }
    cursor = next;
    if (cursor) seen.add(cursor);
  } while (cursor);
  return rows;
}

export function listCrmChangeRequests(
  workspaceId: string,
  input: { state?: CrmChangeRequestState; targetId?: string; reviewable?: boolean },
): Promise<CrmChangeRequest[]> {
  const params = new URLSearchParams();
  if (input.state) params.set("state", input.state);
  if (input.targetId) params.set("targetId", input.targetId);
  if (input.reviewable) params.set("reviewable", "true");
  return readAllPages<CrmChangeRequest, "requests">(`${base(workspaceId)}/change-requests`, "requests", params);
}

export function getCrmChangeRequest(workspaceId: string, requestId: string): Promise<CrmChangeRequestDetail> {
  return crmOperationsRequest(`${base(workspaceId)}/change-requests/${encodeURIComponent(requestId)}`);
}

/** One deal's engagement (returned even before it has tracking), with the protected values this viewer may see. */
export async function getCrmEngagement(workspaceId: string, dealId: string): Promise<CrmEngagement | null> {
  const params = new URLSearchParams({ dealId, includeCommercialValues: "true" });
  const rows = await readAllPages<CrmEngagement, "engagements">(`${base(workspaceId)}/engagements`, "engagements", params);
  return rows[0] ?? null;
}

export function listCrmBillingRequests(
  workspaceId: string,
  input: { state?: CrmBillingRequestState; dealId?: string },
): Promise<CrmBillingRequest[]> {
  const params = new URLSearchParams();
  if (input.state) params.set("state", input.state);
  if (input.dealId) params.set("dealId", input.dealId);
  return readAllPages<CrmBillingRequest, "requests">(`${base(workspaceId)}/billing-requests`, "requests", params);
}

export function getCrmBillingBalance(workspaceId: string, dealId: string): Promise<CrmBillingBalance> {
  return crmOperationsRequest(`${base(workspaceId)}/billing-balance?${new URLSearchParams({ dealId })}`);
}

/** Read-only: what committing successors for a period would do. Creates nothing. */
export function previewCrmRecurringSuccessors(
  workspaceId: string,
  input: { sourceDealIds: string[]; periodKey: string },
): Promise<CrmRecurringPreview> {
  const params = new URLSearchParams({ periodKey: input.periodKey });
  for (const id of input.sourceDealIds) params.append("sourceDealIds", id);
  return crmOperationsRequest(`${base(workspaceId)}/recurring-successors/preview?${params}`);
}

export async function getCrmGovernance(workspaceId: string): Promise<CrmGovernance> {
  const body = await crmOperationsRequest<Partial<CrmGovernance>>(`${base(workspaceId)}/governance`);
  return { catalogs: requireArray(body.catalogs), policies: requireArray(body.policies) };
}
