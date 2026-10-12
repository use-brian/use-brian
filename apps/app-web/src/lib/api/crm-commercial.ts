/**
 * CRM commercial-context SDK: sellers, customer accounts, accepted commercial
 * profile versions, operation definitions, the read-only field resolution
 * preview, and the versioned commercial commands on
 * `/api/crm/:workspaceId/operations`.
 *
 * Shares the reference client's request and error contract: a write carries a
 * caller-held `operationId`; a 4xx is a definite refusal, a network failure
 * or a 5xx is `uncertain` and is retried only with the SAME command.
 *
 * Invoice preparation shares the same lane: the preparation, revision, ready,
 * issue, retry and void commands, plus the preparation and invoice reads.
 * Money arrives as decimal strings already rounded by the server; the browser
 * only formats them.
 *
 * Spec: docs/architecture/features/crm-commercial-operations.md -> "Commercial context", "Invoice preparation".
 * [COMP:app-web/crm-commercial-operations]
 */

import { CrmReferenceRequestError, crmOperationsRequest } from "@/lib/api/crm-references";

export type CrmSensitivity = "public" | "internal" | "confidential";
export type CrmCommercialStatus = "active" | "archived";
export type CrmCommercialFieldType =
  | "string" | "text" | "date" | "decimal" | "currency" | "percent" | "boolean" | "reference";
export type CrmCommercialReferenceKind = "company" | "deal" | "person" | "account" | "seller" | "page" | "file";
export type CrmCommercialSourceKind = "transaction" | "agreement" | "account" | "seller";
export type CrmCommercialEvidenceKind = "manual" | "page" | "file" | "office_artifact" | "external";

export const CRM_COMMERCIAL_FIELD_TYPES: readonly CrmCommercialFieldType[] = [
  "string", "text", "date", "decimal", "currency", "percent", "boolean", "reference",
];
export const CRM_COMMERCIAL_SOURCE_KINDS: readonly CrmCommercialSourceKind[] = [
  "transaction", "agreement", "account", "seller",
];

type CrmCommercialFieldValue = string | boolean | { kind: CrmCommercialReferenceKind; id: string };
/** `value: null` is an accepted decision that the fact does not apply. */
export type CrmCommercialFieldEntry = { type: CrmCommercialFieldType; value: CrmCommercialFieldValue | null };
export type CrmCommercialFields = Record<string, CrmCommercialFieldEntry>;

type CrmCommercialEvidence = {
  kind: CrmCommercialEvidenceKind;
  id?: string;
  revision?: string;
  note?: string;
};

export type CrmSellerProfile = {
  id: string;
  sellerKey: string;
  legalName: string;
  displayName: string;
  companyId: string | null;
  timezone: string;
  status: CrmCommercialStatus;
  sensitivity: CrmSensitivity;
  compartments?: string[];
  version: number;
};

export type CrmCustomerAccount = {
  id: string;
  sellerId: string;
  sellerKey: string;
  companyId: string;
  companyName: string | null;
  label: string;
  billingContactId: string | null;
  billingAddress: string | null;
  status: CrmCommercialStatus;
  sensitivity: CrmSensitivity;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type CrmCommercialProfile = {
  id: string;
  ownerKind: "seller" | "account" | "agreement";
  sellerId?: string | null;
  accountId?: string | null;
  agreementKey: string | null;
  dealIds: string[];
  version: number;
  status: "accepted" | "superseded";
  fields: CrmCommercialFields;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  evidence: Partial<CrmCommercialEvidence> & Record<string, unknown>;
  sensitivity: CrmSensitivity;
};

export type CrmFieldBinding = {
  fieldKey: string;
  label: string;
  type: CrmCommercialFieldType;
  requiredFor: "draft" | "issue" | "never";
  overridable: boolean;
  protected: boolean;
  sources: CrmCommercialSourceKind[];
  templateToken?: string;
};

export type CrmOperationVersionInput = {
  instructions: string;
  instructionSource: { pageId: string; revision: string } | null;
  fieldBindings: CrmFieldBinding[];
  templateBinding: { templateId: string; templateVersionId?: string; pdfPreset: "invoice" | "worksheet" } | null;
  reviewPolicy: "direct" | "exact_version_review";
  referenceDefinitionKey: string | null;
};

export type CrmOperationVersion = CrmOperationVersionInput & {
  id: string;
  versionNumber: number;
  state: "proposed" | "accepted";
  configHash: string;
  proposedByKind: string | null;
  acceptedByKind: string | null;
  acceptedAt: string | null;
  createdAt: string;
};

export type CrmOperationDefinition = {
  id: string;
  operationKey: string;
  operationKind: "invoice";
  label: string;
  currentVersionId: string | null;
  status: string;
  version: number;
  versions: CrmOperationVersion[];
};

export type CrmInvoiceState = "draft" | "ready" | "issue_pending" | "issue_failed" | "issued" | "voided";

export type CrmInvoiceLineInput = { description: string; quantity: string; unitPrice: string; dealId: string | null };

/** One complete preparation version: a revision always sends all of it, never a patch. */
export type CrmPreparationContent = {
  dealIds: string[];
  servicePeriodStart: string | null;
  servicePeriodEnd: string | null;
  lines: CrmInvoiceLineInput[];
  values: CrmCommercialFields;
  allocations: Array<{ dealId: string; amount: string }>;
};

export type CrmInvoiceTotals = {
  currency: string;
  minorUnits: number;
  lines: Array<CrmInvoiceLineInput & { amount: string }>;
  subtotal: string;
  taxRate: string;
  taxAmount: string;
  total: string;
};

type CrmIssueAttempt = {
  attempt: number;
  state: "pending" | "running" | "failed" | "succeeded";
  errorCode: string | null;
  errorDetail: string | null;
  createdAt: string;
  finishedAt?: string | null;
};

export type CrmInvoiceSummary = {
  id: string;
  state: CrmInvoiceState;
  number: string | null;
  issueDate: string | null;
  currency: string | null;
  minorUnits?: number | null;
  total: string | null;
  preparationId: string | null;
  accountId: string;
  version: number;
  issuedAt: string | null;
};

export type CrmInvoiceDetail = CrmInvoiceSummary & {
  subtotal: string | null;
  taxRate?: string | null;
  taxAmount: string | null;
  xlsxFileId: string | null;
  pdfFileId: string | null;
  pdfPageCount: number | null;
  voidedAt: string | null;
  voidReason: string | null;
  lines: Array<{ position?: number; description: string; quantity: string; unitPrice: string; amount: string | null; dealId: string | null }>;
  allocations: Array<{ dealId: string; amount: string | null }>;
  attempts: CrmIssueAttempt[];
};

export type CrmPreparationDetail = {
  preparation: {
    id: string;
    title: string;
    state: CrmInvoiceState;
    version: number;
    readyVersion: number | null;
    operationVersionId: string;
    accountId: string;
    officeArtifactId: string | null;
    officeVersion: number | null;
    officeBinding?: { version: number } | null;
    draftRenderError: string | null;
  };
  current: {
    version: number;
    content: CrmPreparationContent;
    resolution: Pick<CrmCommercialResolution, "fields"> & Partial<CrmCommercialResolution>;
    totals: { invoice: CrmInvoiceTotals | null; allocations?: Array<{ dealId: string; amount: string }> } | null;
    questions: CrmResolutionQuestion[];
    draftReady: boolean;
    issueReady: boolean;
  } | null;
  invoice: CrmInvoiceDetail | null;
};

type CrmResolvedField = {
  fieldKey: string;
  type: CrmCommercialFieldType;
  value: CrmCommercialFieldValue | null | undefined;
  source: { kind: CrmCommercialSourceKind; recordId: string | null; version: number | null; effectiveFrom: string | null } | null;
  overridden: boolean;
};

export type CrmResolutionQuestion = {
  fieldKey: string;
  label: string;
  kind: "missing" | "conflict" | "review_required";
  requiredFor: "draft" | "issue" | "never";
  question: string;
  candidates?: Array<{ source: CrmCommercialSourceKind; recordId: string | null; value: unknown }>;
};

export type CrmCommercialResolution = {
  operationVersionId: string;
  fields: Record<string, CrmResolvedField>;
  questions: CrmResolutionQuestion[];
  draftReady: boolean;
  issueReady: boolean;
  profileVersions: Array<{ id: string; ownerKind: string; version: number }>;
};

type Classification = { sensitivity?: CrmSensitivity; departmentId?: string | null };

export type CrmCommercialProfileOwner =
  | { kind: "seller"; sellerKey: string }
  | { kind: "account"; accountId: string }
  | { kind: "agreement"; accountId: string; agreementKey: string; dealIds: string[] };

export type CrmCommercialCommand =
  | {
    kind: "save_seller_profile";
    operationId: string;
    sellerId?: string;
    expectedVersion?: number;
    seller: { sellerKey: string; legalName: string; displayName: string; companyId: string | null; timezone: string; status: CrmCommercialStatus };
    classification?: Classification;
  }
  | {
    kind: "save_customer_account";
    operationId: string;
    accountId?: string;
    expectedVersion?: number;
    account: { sellerKey: string; companyId: string; label: string; billingContactId: string | null; billingAddress: string | null; status: CrmCommercialStatus };
    classification?: Classification;
  }
  | {
    kind: "accept_commercial_profile";
    operationId: string;
    owner: CrmCommercialProfileOwner;
    expectedCurrentVersion: number;
    fields: CrmCommercialFields;
    effectiveFrom: string | null;
    effectiveTo: string | null;
    evidence: CrmCommercialEvidence;
    classification?: Classification;
  }
  | {
    kind: "save_operation_definition";
    operationId: string;
    operationKey: string;
    operationKind: "invoice";
    label: string;
    expectedVersion: number;
    version: CrmOperationVersionInput;
  }
  | {
    kind: "accept_operation_version";
    operationId: string;
    operationKey: string;
    versionId: string;
    expectedVersion: number;
  }
  | ({ kind: "prepare_commercial_document"; operationId: string; operationKey: string; accountId: string; title?: string } & CrmPreparationContent)
  | ({ kind: "revise_commercial_preparation"; operationId: string; preparationId: string; expectedVersion: number } & CrmPreparationContent)
  | { kind: "mark_preparation_ready"; operationId: string; preparationId: string; expectedVersion: number }
  | { kind: "issue_invoice"; operationId: string; preparationId: string; expectedVersion: number; issueDate: string }
  | { kind: "retry_invoice_issue"; operationId: string; invoiceId: string; expectedVersion: number }
  | { kind: "void_invoice"; operationId: string; invoiceId: string; expectedVersion: number; reason: string };

export type CrmCommercialCommandResult = {
  command: string;
  record: unknown;
  created: boolean;
  duplicate: boolean;
  emittedEventIds: string[];
};

const base = (workspaceId: string) => `/api/crm/${encodeURIComponent(workspaceId)}/operations`;

function requireArray<T>(value: T[] | undefined): T[] {
  if (!Array.isArray(value)) throw new CrmReferenceRequestError("invalid_response", 502);
  return value;
}

export async function listCrmSellers(workspaceId: string): Promise<CrmSellerProfile[]> {
  const body = await crmOperationsRequest<{ sellers?: CrmSellerProfile[] }>(`${base(workspaceId)}/sellers`);
  return requireArray(body.sellers);
}

/** Every account of one company (current scope only), following continuation. */
export async function listCrmCustomerAccounts(
  workspaceId: string,
  input: { companyId: string; includeArchived?: boolean },
): Promise<CrmCustomerAccount[]> {
  const accounts: CrmCustomerAccount[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams({
      companyId: input.companyId,
      includeArchived: input.includeArchived ? "true" : "false",
      limit: "100",
    });
    if (cursor) params.set("cursor", cursor);
    const body: { accounts?: CrmCustomerAccount[]; nextCursor?: string | null } =
      await crmOperationsRequest(`${base(workspaceId)}/accounts?${params}`);
    accounts.push(...requireArray(body.accounts));
    const next = body.nextCursor ?? null;
    if (next !== null && (typeof next !== "string" || !next || seen.has(next))) {
      throw new CrmReferenceRequestError("invalid_response", 502);
    }
    cursor = next;
    if (cursor) seen.add(cursor);
  } while (cursor);
  return accounts;
}

export async function listCrmCommercialProfiles(
  workspaceId: string,
  owner: { sellerKey: string } | { accountId: string },
): Promise<CrmCommercialProfile[]> {
  const params = new URLSearchParams("sellerKey" in owner ? { sellerKey: owner.sellerKey } : { accountId: owner.accountId });
  const body = await crmOperationsRequest<{ profiles?: CrmCommercialProfile[] }>(`${base(workspaceId)}/commercial-profiles?${params}`);
  return requireArray(body.profiles);
}

/** Read-only resolution receipt. Never creates or reserves anything. */
export function resolveCrmCommercialFields(
  workspaceId: string,
  input: { operationKey: string; accountId: string; dealId?: string; businessDate?: string },
): Promise<CrmCommercialResolution> {
  const params = new URLSearchParams({ operationKey: input.operationKey, accountId: input.accountId });
  if (input.dealId) params.set("dealId", input.dealId);
  if (input.businessDate) params.set("businessDate", input.businessDate);
  return crmOperationsRequest(`${base(workspaceId)}/commercial-profiles/resolve?${params}`);
}

export async function listCrmOperationDefinitions(workspaceId: string): Promise<CrmOperationDefinition[]> {
  const body = await crmOperationsRequest<{ operations?: CrmOperationDefinition[] }>(`${base(workspaceId)}/operation-definitions`);
  return requireArray(body.operations);
}

export function executeCrmCommercialCommand(
  workspaceId: string,
  command: CrmCommercialCommand,
): Promise<CrmCommercialCommandResult> {
  return crmOperationsRequest(`${base(workspaceId)}/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
}

/** One preparation: current version, resolution, totals, questions, Office draft, and its invoice with attempts. */
export function getCrmPreparation(workspaceId: string, preparationId: string): Promise<CrmPreparationDetail> {
  return crmOperationsRequest(`${base(workspaceId)}/preparations/${encodeURIComponent(preparationId)}`);
}

/** Every invoice of one account in the caller's scope, following continuation. */
export async function listCrmInvoices(workspaceId: string, input: { accountId: string }): Promise<CrmInvoiceSummary[]> {
  const invoices: CrmInvoiceSummary[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams({ accountId: input.accountId, limit: "100" });
    if (cursor) params.set("cursor", cursor);
    const body: { invoices?: CrmInvoiceSummary[]; nextCursor?: string | null } =
      await crmOperationsRequest(`${base(workspaceId)}/invoices?${params}`);
    invoices.push(...requireArray(body.invoices));
    const next = body.nextCursor ?? null;
    if (next !== null && (typeof next !== "string" || !next || seen.has(next))) {
      throw new CrmReferenceRequestError("invalid_response", 502);
    }
    cursor = next;
    if (cursor) seen.add(cursor);
  } while (cursor);
  return invoices;
}
