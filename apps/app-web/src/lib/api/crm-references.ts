import { publicRuntimeConfig } from "@/lib/runtime-public-config";
/**
 * CRM business-reference SDK: definition catalog, masked preview, lookup,
 * history, and the versioned reference commands on
 * `/api/crm/:workspaceId/operations`.
 *
 * Writes carry a caller-held `operationId`. A refusal the server answered
 * (4xx) is definite; a network failure or a 5xx leaves the outcome unknown,
 * so the error says `uncertain` and the caller must retry with the SAME id.
 *
 * Spec: docs/architecture/features/crm-commercial-operations.md -> "Business references".
 * [COMP:app-web/crm-commercial-operations]
 */

import { authFetch } from "@/lib/auth-fetch";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";

export type CrmReferenceTargetKind = "company" | "deal";
export type CrmReferenceAssignmentMode = "native" | "manual" | "external";
export type CrmReferenceAssignmentEvent = "explicit" | "approval" | "issue";
export type CrmReferenceChangePolicy = "immutable" | "correctable";
export type CrmReferencePartitionDimension = "business_year" | "parent_target" | "service_category";
export type CrmReferenceDefinitionStatus = "draft" | "active" | "archived";
export type CrmReferenceDatePart = "yyyy" | "yy" | "mm" | "dd";

export const CRM_REFERENCE_PARTITION_DIMENSIONS: readonly CrmReferencePartitionDimension[] = [
  "business_year", "parent_target", "service_category",
];

export type CrmReferenceSegment =
  | { kind: "literal"; text: string }
  | { kind: "parent"; definitionKey: string }
  | { kind: "date"; part: CrmReferenceDatePart }
  | { kind: "category" }
  | { kind: "counter"; width: number };

export type CrmReferenceCategory = { key: string; code: string; label: string };

export type CrmReferenceDefinitionInput = {
  definitionKey: string;
  label: string;
  targetKinds: CrmReferenceTargetKind[];
  assignmentMode: CrmReferenceAssignmentMode;
  namespaceKey: string;
  format: CrmReferenceSegment[] | null;
  partitionDimensions: CrmReferencePartitionDimension[];
  categories: CrmReferenceCategory[];
  timezone: string;
  assignmentEvent: CrmReferenceAssignmentEvent;
  changePolicy: CrmReferenceChangePolicy;
  counterStart: number;
  status: CrmReferenceDefinitionStatus;
};

type CrmReferencePartition = { partitionKey: string; nextValue: number; allocatedCount: number };

export type CrmReferenceDefinition = CrmReferenceDefinitionInput & {
  id: string;
  version: number;
  seriesId: string | null;
  counterWidth: number | null;
  /** Present for owner/admin readers only. */
  partitions?: CrmReferencePartition[];
};

type CrmReferenceStatus = "active" | "replaced" | "retired";

export type CrmBusinessReference = {
  id: string;
  definitionId: string;
  definitionKey: string;
  definitionVersion: number;
  targetKind: CrmReferenceTargetKind;
  targetId: string;
  targetName: string | null;
  value: string;
  origin: "native" | "manual" | "external" | "import";
  status: CrmReferenceStatus;
  businessDate: string | null;
  categoryKey: string | null;
  counterValue: number | null;
  partitionKey: string | null;
  parentSnapshot: unknown;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type CrmReferenceHistoryEntry = {
  id: string;
  action: "assigned" | "replaced" | "retired" | "imported";
  formerValue: string | null;
  newValue: string | null;
  reason: string | null;
  actorKind: string;
  effectiveAt: string;
};

export type CrmReferencePreview = {
  reserves: false;
  explanation: {
    segments: Array<{ kind: string; description: string; example: string }>;
    maskedExample: string;
    needsBusinessDate: boolean;
    needsCategory: boolean;
  } | null;
  needsBusinessDate: boolean;
  needsCategory: boolean;
  categories: CrmReferenceCategory[];
  partitionKey: string | null;
  assignmentMode: CrmReferenceAssignmentMode;
  assignmentEvent: CrmReferenceAssignmentEvent;
  note?: string;
};

export type CrmReferenceImportRow = {
  target: { kind: CrmReferenceTargetKind; id: string };
  value: string;
  status: "active" | "retired";
  businessDate?: string;
  categoryKey?: string;
};

export type CrmReferenceImportConflict = {
  index: number;
  reason: string;
  value?: string;
  partitionKey?: string;
};

export type CrmReferenceCommand =
  | {
    kind: "save_reference_definition";
    operationId: string;
    definitionId?: string;
    expectedVersion?: number;
    definition: CrmReferenceDefinitionInput;
  }
  | {
    kind: "assign_business_reference";
    operationId: string;
    definitionKey: string;
    target: { kind: CrmReferenceTargetKind; id: string };
    businessDate?: string;
    categoryKey?: string;
    value?: string;
    external?: { provider: string; remoteId: string };
  }
  | {
    kind: "replace_business_reference";
    operationId: string;
    referenceId: string;
    expectedVersion: number;
    reason: string;
    value?: string;
    external?: { provider: string; remoteId: string };
  }
  | {
    kind: "retire_business_reference";
    operationId: string;
    referenceId: string;
    expectedVersion: number;
    reason: string;
  }
  | {
    kind: "import_business_references";
    operationId: string;
    definitionKey: string;
    rows: CrmReferenceImportRow[];
    partitionCounters: Array<{ partitionKey: string; nextValue: number }>;
  };

export type CrmReferenceCommandResult = {
  command: string;
  record: unknown;
  created: boolean;
  duplicate: boolean;
  emittedEventIds: string[];
};

/**
 * A failed reference request. `uncertain` is true when the server never gave
 * a definite answer (network failure or 5xx): a write may or may not have
 * committed, so it is retried only by the user and only with the same
 * operation id.
 */
export class CrmReferenceRequestError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly details: Record<string, unknown>;
  readonly uncertain: boolean;
  constructor(code: string, status: number | null, details: Record<string, unknown> = {}, message?: string) {
    super(message ?? code);
    this.name = "CrmReferenceRequestError";
    this.code = code;
    this.status = status;
    this.details = details;
    this.uncertain = status === null || status >= 500;
  }
  get reason(): string | null {
    return typeof this.details.reason === "string" ? this.details.reason : null;
  }
}

const base = (workspaceId: string) => `/api/crm/${encodeURIComponent(workspaceId)}/operations`;

/** One request on the CRM operations API, translating failures into `CrmReferenceRequestError` (shared by the commercial-context client). */
export async function crmOperationsRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await authFetch(`${API_URL}${path}`, init);
  } catch (cause) {
    throw new CrmReferenceRequestError("network_error", null, {}, cause instanceof Error ? cause.message : undefined);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const { error, message, ...details } = body;
    throw new CrmReferenceRequestError(
      typeof error === "string" ? error : `http_${res.status}`,
      res.status,
      details,
      typeof message === "string" ? message : undefined,
    );
  }
  return body as T;
}

export async function listCrmReferenceDefinitions(
  workspaceId: string,
  includeArchived = false,
): Promise<CrmReferenceDefinition[]> {
  const body = await crmOperationsRequest<{ definitions: CrmReferenceDefinition[] }>(
    `${base(workspaceId)}/reference-definitions?includeArchived=${includeArchived ? "true" : "false"}`,
  );
  if (!Array.isArray(body.definitions)) throw new CrmReferenceRequestError("invalid_response", 502);
  return body.definitions;
}

export function previewCrmReference(
  workspaceId: string,
  input: { definitionKey: string; targetId?: string; businessDate?: string; categoryKey?: string },
): Promise<CrmReferencePreview> {
  const params = new URLSearchParams({ definitionKey: input.definitionKey });
  if (input.targetId) params.set("targetId", input.targetId);
  if (input.businessDate) params.set("businessDate", input.businessDate);
  if (input.categoryKey) params.set("categoryKey", input.categoryKey);
  return crmOperationsRequest(`${base(workspaceId)}/references/preview?${params}`);
}

/** Every reference (current and former) on one record, following continuation. */
export async function listCrmReferencesForTarget(
  workspaceId: string,
  targetId: string,
): Promise<CrmBusinessReference[]> {
  const references: CrmBusinessReference[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams({ targetId, includeFormer: "true", limit: "100" });
    if (cursor) params.set("cursor", cursor);
    const body: { references: CrmBusinessReference[]; nextCursor?: string | null } =
      await crmOperationsRequest(`${base(workspaceId)}/references?${params}`);
    if (!Array.isArray(body.references)) throw new CrmReferenceRequestError("invalid_response", 502);
    references.push(...body.references);
    const next = body.nextCursor ?? null;
    if (next !== null && (typeof next !== "string" || !next || seen.has(next))) {
      throw new CrmReferenceRequestError("invalid_response", 502);
    }
    cursor = next;
    if (cursor) seen.add(cursor);
  } while (cursor);
  return references;
}

export function findCrmReferences(
  workspaceId: string,
  q: string,
  match: "exact" | "prefix" = "exact",
): Promise<{ references: CrmBusinessReference[]; nextCursor: string | null }> {
  const params = new URLSearchParams({ q, match });
  return crmOperationsRequest(`${base(workspaceId)}/references?${params}`);
}

export function getCrmReferenceHistory(
  workspaceId: string,
  referenceId: string,
): Promise<{ reference: CrmBusinessReference; history: CrmReferenceHistoryEntry[] }> {
  return crmOperationsRequest(`${base(workspaceId)}/references/${encodeURIComponent(referenceId)}/history`);
}

export function executeCrmReferenceCommand(
  workspaceId: string,
  command: CrmReferenceCommand,
): Promise<CrmReferenceCommandResult> {
  return crmOperationsRequest(`${base(workspaceId)}/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
}

/** A fresh idempotency key for one user intent. */
export function newCrmOperationId(): string {
  return crypto.randomUUID();
}

/**
 * Local, non-reserving rendering of a format for the builder: literals as
 * typed, date parts as tokens, the category as its token, the counter as `#`.
 */
export function maskCrmReferenceFormat(
  segments: readonly CrmReferenceSegment[],
  tokens: { parent: (definitionKey: string) => string; category: string },
): string {
  return segments.map((segment) => {
    switch (segment.kind) {
      case "literal": return segment.text;
      case "parent": return tokens.parent(segment.definitionKey);
      case "date": return segment.part.toUpperCase();
      case "category": return tokens.category;
      case "counter": return "#".repeat(Math.min(12, Math.max(1, segment.width)));
    }
  }).join("");
}
