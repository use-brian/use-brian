/**
 * CRM ERP bridge SDK: the binding status, staged import reports, cutover runs,
 * and the bridge command kinds sent through the commercial command lane.
 *
 * The ERP adapter stages imports and prepares cutovers; the app reviews them.
 * A confirm binds to the exact report hash the reviewer read, a commit binds to
 * the cutover version and is refused unless counts and the export hash
 * reconcile. Fees only ever arrive as per-currency totals inside a report.
 *
 * Spec: docs/architecture/features/crm-commercial-operations.md -> "ERP bridge".
 * [COMP:app-web/crm-commercial-operations]
 */

import { CrmReferenceRequestError, crmOperationsRequest } from "@/lib/api/crm-references";

export type CrmErpWriterState = "legacy" | "frozen" | "brian";
export type CrmErpRecordClass = "client" | "engagement";
export type CrmErpImportState = "staged" | "confirmed" | "superseded";
export type CrmErpCutoverState = "prepared" | "committed" | "abandoned";
export type CrmErpRowAction = "create" | "update" | "unchanged";

export const CRM_ERP_RECORD_CLASSES: readonly CrmErpRecordClass[] = ["client", "engagement"];

type CrmErpCounts = Partial<Record<CrmErpRecordClass, number>>;
type CrmErpSource = { counts: CrmErpCounts; exportHash: string };

export type CrmErpBindingStatus = {
  schemaVersion: number;
  binding: {
    id: string;
    bindingKey: string;
    label: string | null;
    integrationCredentialId: string | null;
    writerState: CrmErpWriterState;
    recordClasses: CrmErpRecordClass[];
    referenceDefinitions: Partial<Record<CrmErpRecordClass, string>> | null;
    version: number;
    createdAt: string;
    updatedAt: string;
  };
  capabilities: { journeys: string[]; commands: string[]; reads: string[]; legacyWritesAllowed: boolean };
  mapped: Array<{ legacyType: string; count: number }>;
  recentCutovers: Array<{ id: string; state: CrmErpCutoverState; version: number; createdAt: string; committedAt: string | null }>;
  recentImports: Array<{ id: string; state: CrmErpImportState; reportHash: string; createdAt: string; confirmedAt: string | null }>;
  viewerEnrollment: { legacyUserId: string } | null;
};

type CrmErpImportReport = {
  counts: Partial<Record<CrmErpRecordClass, Record<CrmErpRowAction, number>>>;
  fees: Array<{ kind: string; currency: string; total: string; engagements: number }>;
  conflicts: Array<{ legacyType: string; legacyId: string; reason: string; detail?: string }>;
  possibleDuplicates: Array<{ legacyType: string; legacyId: string; existingTargetId: string }>;
  rows: Array<{ legacyType: string; legacyId: string; action: CrmErpRowAction; targetId: string | null; changes: string[]; recode: boolean }>;
};

export type CrmErpImportDetail = {
  id: string;
  bindingKey: string;
  state: CrmErpImportState;
  recordsHash: string;
  report: CrmErpImportReport;
  reportHash: string;
  outcome: unknown;
  version: number;
  createdAt: string;
  confirmedAt: string | null;
};

type CrmErpReconciliation = {
  brianCounts: CrmErpCounts;
  sourceCounts: CrmErpCounts;
  countMismatches: string[];
  exportHashMatches: boolean;
  pendingStagedImports: number;
  reconciled: boolean;
  lastImportId: string | null;
};

export type CrmErpCutoverDetail = {
  id: string;
  bindingKey: string;
  state: CrmErpCutoverState;
  recordClasses: CrmErpRecordClass[];
  source: CrmErpSource;
  reconciliation: CrmErpReconciliation | null;
  finalSource: CrmErpSource | null;
  version: number;
  createdAt: string;
  committedAt: string | null;
};

/**
 * The bridge command kinds, sent through the commercial command lane. Staging
 * and preparing are normally sent by the ERP adapter, never authored here.
 */
export type CrmErpCommand =
  | {
    kind: "stage_erp_import";
    operationId: string;
    bindingKey: string;
    label?: string;
    referenceDefinitions: Partial<Record<CrmErpRecordClass, string>>;
    records: { clients: unknown[]; engagements: unknown[] };
  }
  | { kind: "prepare_erp_cutover"; operationId: string; bindingKey: string; recordClasses: CrmErpRecordClass[]; source: CrmErpSource }
  | { kind: "confirm_erp_import"; operationId: string; importId: string; expectedReportHash: string }
  | { kind: "commit_erp_cutover"; operationId: string; cutoverId: string; expectedVersion: number; finalSource: CrmErpSource }
  | { kind: "enroll_erp_viewer"; operationId: string; bindingKey: string; legacyUserId: string };

const base = (workspaceId: string) => `/api/crm/${encodeURIComponent(workspaceId)}/operations`;

/** The binding status, or null when no binding with this key is configured (404). */
export async function getCrmErpBinding(workspaceId: string, bindingKey: string): Promise<CrmErpBindingStatus | null> {
  try {
    return await crmOperationsRequest<CrmErpBindingStatus>(`${base(workspaceId)}/erp-bindings/${encodeURIComponent(bindingKey)}`);
  } catch (cause) {
    if (cause instanceof CrmReferenceRequestError && cause.status === 404) return null;
    throw cause;
  }
}

export function getCrmErpImport(workspaceId: string, importId: string): Promise<CrmErpImportDetail> {
  return crmOperationsRequest(`${base(workspaceId)}/erp-imports/${encodeURIComponent(importId)}`);
}

export function getCrmErpCutover(workspaceId: string, cutoverId: string): Promise<CrmErpCutoverDetail> {
  return crmOperationsRequest(`${base(workspaceId)}/cutovers/${encodeURIComponent(cutoverId)}`);
}
