/**
 * CRM operator-surface SDK. Keyset collection pages, authoritative summary,
 * compact relationship lookup, canonical cold record reads, typed record
 * PATCH, stable pipeline stages, and R2 resources live behind `/api/crm`.
 * The flat compatibility read remains only for bounded legacy dialogs.
 *
 * Spec: docs/architecture/features/crm.md → "Operator surface".
 * [COMP:app-web/crm-surface]
 */

import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type DealStage =
  | "lead"
  | "qualified"
  | "proposal"
  | "negotiation"
  | "won"
  | "lost";

export function isOpenStage(stage: DealStage): boolean {
  return stage !== "won" && stage !== "lost";
}

/** One flat deal row off `GET /api/brain/crm`. */
export type CrmDealRow = {
  id: string;
  /** The deal entity's display name (e.g. "Deal - Acme"). */
  name: string;
  stage: DealStage;
  amount: number | null;
  /** Calendar date `YYYY-MM-DD`, or null (crm.md decision 4). */
  closeDate: string | null;
  contactId: string | null;
  companyId: string | null;
  pipelineId?: string | null;
  pipelineStageId?: string | null;
  currencyCode?: string;
  probability?: number | null;
  ownerId?: string | null;
  source?: string | null;
  winLossReason?: string | null;
  customFields?: Record<string, unknown>;
  archivedAt?: string | null;
  /** ISO timestamp. */
  updatedAt: string;
};

export type CrmContactRow = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  companyId: string | null;
  tags: string[];
  ownerId?: string | null;
  customFields?: Record<string, unknown>;
  archivedAt?: string | null;
  /** ISO timestamp. */
  updatedAt: string;
};

export type CrmCompanyRow = {
  id: string;
  name: string;
  domain: string | null;
  tags: string[];
  ownerId?: string | null;
  customFields?: Record<string, unknown>;
  archivedAt?: string | null;
  /** ISO timestamp. */
  updatedAt: string;
};

export type CrmData = {
  deals: CrmDealRow[];
  contacts: CrmContactRow[];
  companies: CrmCompanyRow[];
};

export type CrmEmailDraft = {
  id: string;
  status: "draft" | "discarded";
  revision: number;
  from: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  attachments: string[];
  sourceSessionId: string | null;
  createdAt: string;
  updatedAt: string;
};

export async function fetchCrmEmailDrafts(workspaceId: string): Promise<CrmEmailDraft[]> {
  const body = await jsonRequest<{ drafts: CrmEmailDraft[] }>(
    `/api/crm/${encodeURIComponent(workspaceId)}/email-drafts`,
  );
  return body.drafts;
}

export type CrmCollectionKind = "deal" | "contact" | "company";
export type CrmCollectionSort = "updated" | "name" | "amount" | "close";
type CrmSortDirection = "asc" | "desc";

export type CrmRecordPage<T extends CrmPublicRecord = CrmPublicRecord> = {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type CrmCollectionQuery = {
  kind: CrmCollectionKind;
  cursor?: string | null;
  limit?: number;
  sort?: CrmCollectionSort;
  direction?: CrmSortDirection;
  q?: string;
  archived?: boolean;
  owner?: string[];
  pipeline?: string | null;
  stage?: string[];
  company?: string[];
  tag?: string[];
  custom?: Record<string, string[]>;
  filter?: "overdue" | "stale" | "noAmount" | "orphaned" | null;
};

function appendMany(params: URLSearchParams, key: string, values: readonly string[] | undefined) {
  for (const value of values ?? []) params.append(key, value);
}

export function crmCollectionSearch(query: CrmCollectionQuery): string {
  const params = new URLSearchParams({ kind: query.kind });
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.limit) params.set("limit", String(query.limit));
  if (query.sort) params.set("sort", query.sort);
  if (query.direction) params.set("direction", query.direction);
  if (query.q?.trim()) params.set("q", query.q.trim());
  if (query.archived) params.set("archived", "true");
  if (query.pipeline) params.set("pipeline", query.pipeline);
  if (query.filter) params.set("filter", query.filter);
  appendMany(params, "owner", query.owner);
  appendMany(params, "stage", query.stage);
  appendMany(params, "company", query.company);
  appendMany(params, "tag", query.tag);
  for (const [key, values] of Object.entries(query.custom ?? {})) {
    appendMany(params, `cf.${key}`, values);
  }
  return params.toString();
}

export function fetchCrmRecordPage<T extends CrmPublicRecord = CrmPublicRecord>(
  workspaceId: string,
  query: CrmCollectionQuery,
): Promise<CrmRecordPage<T>> {
  return jsonRequest(
    `/api/crm/${encodeURIComponent(workspaceId)}/records?${crmCollectionSearch(query)}`,
  );
}

export type CrmDealBoardPages = Record<string, CrmRecordPage<Extract<CrmPublicRecord, { kind: "deal" }>>>;

/** One independent keyset per board stage. */
export async function fetchCrmDealBoardPages(
  workspaceId: string,
  query: Omit<CrmCollectionQuery, "kind" | "stage" | "cursor">,
  stageIds: readonly string[],
): Promise<CrmDealBoardPages> {
  const entries = await Promise.all(stageIds.map(async (stageId) => [
    stageId,
    await fetchCrmRecordPage<Extract<CrmPublicRecord, { kind: "deal" }>>(workspaceId, {
      ...query,
      kind: "deal",
      stage: [stageId],
    }),
  ] as const));
  return Object.fromEntries(entries);
}

export type CrmSummary = {
  totals: { deals: number; contacts: number; companies: number };
  attention: { overdue: number; stale: number; noAmount: number; orphaned: number };
  stages: Array<{ stageId: string; count: number; values: Record<string, number> }>;
};

export function fetchCrmSummary(workspaceId: string, pipeline?: string | null): Promise<CrmSummary> {
  const query = pipeline ? `?pipeline=${encodeURIComponent(pipeline)}` : "";
  return jsonRequest(`/api/crm/${encodeURIComponent(workspaceId)}/summary${query}`);
}

export type CrmLookupRow = { id: string; name: string; hint: string | null };

export function fetchCrmLookup(
  workspaceId: string,
  kind: CrmCollectionKind,
  q = "",
  limit = 100,
): Promise<CrmLookupRow[]> {
  const params = new URLSearchParams({ kind, limit: String(limit) });
  if (q.trim()) params.set("q", q.trim());
  return jsonRequest<{ items: CrmLookupRow[] }>(
    `/api/crm/${encodeURIComponent(workspaceId)}/lookup?${params.toString()}`,
  ).then((body) => body.items);
}

export type CrmPublicRecord =
  | ({ kind: "deal" } & CrmDealRow)
  | ({ kind: "contact" } & CrmContactRow)
  | ({ kind: "company" } & CrmCompanyRow);

export type CrmRecordBundle = {
  record: CrmPublicRecord;
  relationships: CrmData;
  participants: CrmDealParticipant[];
};

export async function fetchWorkspaceCrm(workspaceId: string, includeArchived = false): Promise<CrmData> {
  const res = await authFetch(
    `${API_URL}/api/crm/${encodeURIComponent(workspaceId)}/records${includeArchived ? "?archived=true" : ""}`,
  );
  if (!res.ok) throw new Error(`Failed to load CRM (${res.status})`);
  const body = (await res.json()) as Partial<CrmData>;
  return {
    deals: body.deals ?? [],
    contacts: body.contacts ?? [],
    companies: body.companies ?? [],
  };
}

export async function fetchCrmRecord(
  workspaceId: string,
  entityId: string,
): Promise<CrmRecordBundle | null> {
  const res = await authFetch(
    `${API_URL}/api/crm/${encodeURIComponent(workspaceId)}/records/${encodeURIComponent(entityId)}`,
  );
  if (res.status === 404) return null;
  const body = (await res.json().catch(() => ({}))) as CrmRecordBundle & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Failed to load CRM record (${res.status})`);
  return body;
}

export function updateCrmRecord(
  workspaceId: string,
  entityId: string,
  changes: Record<string, unknown>,
): Promise<CrmRecordBundle> {
  return jsonRequest(
    `/api/crm/${encodeURIComponent(workspaceId)}/records/${encodeURIComponent(entityId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(changes),
    },
  );
}

export type CrmStageCategory = "open" | "won" | "lost";

export type CrmPipelineStage = {
  id: string;
  pipelineId: string;
  name: string;
  legacyKey: DealStage | null;
  category: CrmStageCategory;
  position: number;
  probability: number;
  requiredFields: string[];
  archivedAt?: string | null;
};

export type CrmPipeline = {
  id: string;
  name: string;
  isDefault: boolean;
  position: number;
  stages: CrmPipelineStage[];
  archivedAt?: string | null;
};

export type CrmFieldType =
  | "text"
  | "number"
  | "date"
  | "boolean"
  | "single_select"
  | "multi_select"
  | "entity_reference";

export type CrmFieldDefinition = {
  id: string;
  entityKind: "person" | "company" | "deal";
  fieldKey: string;
  label: string;
  fieldType: CrmFieldType;
  options: string[];
  isRequired: boolean;
  position: number;
  archivedAt?: string | null;
};

export type CrmConfig = {
  pipelines: CrmPipeline[];
  fields: CrmFieldDefinition[];
};

type CrmIntakeFieldDefinition = {
  key: string;
  label: string;
  type: "text" | "email" | "phone" | "number" | "boolean" | "date" | "string_array";
  required: boolean;
  maxLength?: number;
  options?: string[];
  mapping:
    | { kind: "base_field"; field: "name" | "email" | "phone" | "tags" }
    | { kind: "custom_field"; fieldKey: string }
    | { kind: "submission_only" };
};

export type CrmIntakeDefinition = {
  id: string;
  definitionKey: string;
  label: string;
  active: boolean;
  currentVersion: number;
  fields: CrmIntakeFieldDefinition[];
  identityPolicy: "external_subject" | "trusted_verified_email" | "new_or_review";
  allowedIdentityProvider?: string | null;
  consentMappings: Array<{ fieldKey: string; grantedValue: string | boolean | number; purposeKey: string }>;
  queueKey: string;
  ownerUserId?: string | null;
  followUpTaskTemplate?: { title: string; description: string; priority: "low" | "medium" | "high" | "urgent"; tags: string[] } | null;
  followUpDueMinutes?: number | null;
  maxPayloadBytes: number;
  workflowHint?: string | null;
  schemaHash: string;
  createdAt: string;
  updatedAt: string;
};

export type CrmIntakeCredential = {
  id: string;
  label: string;
  prefix: string;
  definitionIds: string[];
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
};

export type CrmSubmission = {
  id: string;
  contactId: string;
  contactName: string;
  definitionId: string | null;
  definitionKey: string | null;
  definitionLabel: string | null;
  definitionVersionId?: string | null;
  definitionSchemaHash?: string | null;
  definitionSchemaSnapshot?: Record<string, unknown> | null;
  fields?: Record<string, unknown>;
  status: "new" | "in_progress" | "resolved" | "spam";
  queueKey: string;
  ownerUserId: string | null;
  followUpTaskId: string | null;
  submittedAt: string;
  createdAt: string;
  updatedAt: string;
  notes?: Array<{ id: string; body: string; actorKind: string; actingUserId: string | null; createdAt: string }>;
};

export type CrmConsentPurpose = {
  id: string;
  purposeKey: string;
  label: string;
  description: string;
  requiresConsent: boolean;
  applicableChannels: CrmDeliveryChannel[];
  wordingVersion: string;
  wording: string;
  wordingHash: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CrmDeliveryChannel = "email" | "sms" | "phone" | "whatsapp" | "telegram" | "slack";
export type CrmCompliance = {
  purposes: CrmConsentPurpose[];
  events: Array<{
    id: string; purposeKey: string; action: "granted" | "withdrawn";
    wordingVersion: string; source: string; occurredAt: string; createdAt: string;
  }>;
  suppressions: Array<{
    id: string; channel: "all" | CrmDeliveryChannel; action: "suppressed" | "released";
    reasonCode: string; source: string; occurredAt: string; createdAt: string;
  }>;
};

export type CrmSendabilityVerdict = {
  verdict: "allowed" | "blocked" | "unknown";
  reasons: Array<"contact_method_missing" | "global_suppression" | "channel_suppression" | "consent_withdrawn" | "consent_not_recorded" | "purpose_archived">;
  effectiveConsentEventId?: string;
  effectiveSuppressionEventIds: string[];
};

export type CrmSegmentEntityKind = "person" | "company" | "deal";
export type CrmSegmentOperator =
  | "eq" | "neq" | "contains" | "not_contains" | "in" | "not_in"
  | "gt" | "gte" | "lt" | "lte" | "before" | "after"
  | "is_empty" | "is_not_empty";
export type CrmSegmentRule = {
  type: "rule";
  family: "base" | "custom" | "tag" | "relationship" | "consent" | "suppression" | "entitlement" | "participation" | "pipeline";
  field: string;
  operator: CrmSegmentOperator;
  value?: unknown;
};
export type CrmSegmentPredicate = {
  type: "group";
  combinator: "and" | "or";
  items: Array<CrmSegmentPredicate | CrmSegmentRule>;
};
export type CrmSegmentCatalogEntry = {
  family: CrmSegmentRule["family"];
  field: string;
  label: string;
  operators: CrmSegmentOperator[];
  valueType: "text" | "number" | "date" | "boolean" | "uuid" | "enum";
  validValues?: string[];
};
export type CrmSegment = {
  id: string;
  segmentKey: string;
  name: string;
  description: string;
  entityKind: CrmSegmentEntityKind;
  predicate: CrmSegmentPredicate;
  version: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
export type CrmSegmentPreview = {
  rows: Array<{ id: string; name: string; kind: string; attributes?: Record<string, unknown> }>;
  count: number;
  snapshotIds: string[];
};

export type CrmEntitlementStatus = "pending" | "active" | "expired" | "cancelled";
export type CrmEntitlementPlan = {
  id: string;
  planKey: string;
  name: string;
  currency: string;
  feeMinor: string;
  billingPeriod: string;
  benefits: string[];
  published: boolean;
  provider: string | null;
  providerPlanId: string | null;
  commerceManaged: boolean;
  activeFrom: string | null;
  activeTo: string | null;
};
export type CrmEntitlement = {
  id: string;
  contactId: string;
  contactName: string;
  planId: string;
  planKey: string;
  planName: string;
  status: CrmEntitlementStatus;
  startsAt: string;
  endsAt: string | null;
  renewalMode: "none" | "manual" | "auto";
  provider: string | null;
  providerEntitlementId: string | null;
  createdAt: string;
  updatedAt: string;
};
export type CrmEvent = {
  id: string;
  slug: string;
  programmeKey: string | null;
  title: string;
  description: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  mode: string;
  venue: string | null;
  onlineUrl: string | null;
  capacity: number | null;
  status: "draft" | "published" | "cancelled" | "completed";
  commerceManaged: boolean;
};
export type CrmParticipationStatus = "registered" | "attended" | "cancelled" | "no_show";
export type CrmParticipation = {
  id: string;
  eventId: string;
  eventKey: string;
  eventTitle: string;
  contactId: string | null;
  contactName: string | null;
  attendeeName: string;
  attendeeEmail: string | null;
  status: CrmParticipationStatus;
  sourceStatus: string;
  sourceKind: "commerce" | "manual" | "form" | "workflow" | "import";
  sourceId: string;
  commerceManaged: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CrmIntakeDefinitionInput = {
  definitionId?: string;
  definitionKey: string;
  label: string;
  active?: boolean;
  expectedVersion?: number;
  definition: {
    fields: CrmIntakeFieldDefinition[];
    identityPolicy: CrmIntakeDefinition["identityPolicy"];
    allowedIdentityProvider?: string | null;
    consentMappings?: CrmIntakeDefinition["consentMappings"];
    queueKey?: string;
    ownerUserId?: string | null;
    followUpTaskTemplate?: CrmIntakeDefinition["followUpTaskTemplate"];
    followUpDueMinutes?: number | null;
    maxPayloadBytes?: number;
    workflowHint?: string | null;
  };
};

async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authFetch(`${API_URL}${path}`, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `CRM request failed (${res.status})`);
  return body;
}

export async function listCrmIntakeDefinitions(workspaceId: string): Promise<CrmIntakeDefinition[]> {
  const body = await jsonRequest<{ definitions: CrmIntakeDefinition[] }>(
    `/api/crm/${encodeURIComponent(workspaceId)}/operations/intake-definitions`,
  );
  return body.definitions;
}

export function saveCrmIntakeDefinition(
  workspaceId: string,
  input: CrmIntakeDefinitionInput,
): Promise<{ record: CrmIntakeDefinition; created: boolean }> {
  return jsonRequest(`/api/crm/${encodeURIComponent(workspaceId)}/operations/intake-definitions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function listCrmIntakeCredentials(workspaceId: string): Promise<CrmIntakeCredential[]> {
  const body = await jsonRequest<{ credentials: CrmIntakeCredential[] }>(
    `/api/crm/${encodeURIComponent(workspaceId)}/operations/intake-credentials`,
  );
  return body.credentials;
}

export function createCrmIntakeCredential(
  workspaceId: string,
  input: { label: string; definitionIds: string[] },
): Promise<{ record: CrmIntakeCredential; key: string }> {
  return jsonRequest(`/api/crm/${encodeURIComponent(workspaceId)}/operations/intake-credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function revokeCrmIntakeCredential(
  workspaceId: string,
  credentialId: string,
): Promise<{ record: CrmIntakeCredential }> {
  return jsonRequest(
    `/api/crm/${encodeURIComponent(workspaceId)}/operations/intake-credentials/${encodeURIComponent(credentialId)}`,
    { method: "DELETE" },
  );
}

export async function listCrmSubmissions(
  workspaceId: string,
  filters: { status?: CrmSubmission["status"]; definitionKey?: string; ownerUserId?: string; limit?: number } = {},
): Promise<CrmSubmission[]> {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.definitionKey) params.set("definitionKey", filters.definitionKey);
  if (filters.ownerUserId) params.set("ownerUserId", filters.ownerUserId);
  if (filters.limit) params.set("limit", String(filters.limit));
  const query = params.toString();
  const body = await jsonRequest<{ submissions: CrmSubmission[] }>(
    `/api/crm/${encodeURIComponent(workspaceId)}/operations/submissions${query ? `?${query}` : ""}`,
  );
  return body.submissions;
}

export async function getCrmSubmission(workspaceId: string, submissionId: string): Promise<CrmSubmission> {
  const body = await jsonRequest<{ submission: CrmSubmission }>(
    `/api/crm/${encodeURIComponent(workspaceId)}/operations/submissions/${encodeURIComponent(submissionId)}`,
  );
  return body.submission;
}

export function updateCrmSubmission(
  workspaceId: string,
  submissionId: string,
  changes: { status?: CrmSubmission["status"]; queueKey?: string; ownerUserId?: string | null; note?: string },
): Promise<{ record: CrmSubmission }> {
  return jsonRequest(
    `/api/crm/${encodeURIComponent(workspaceId)}/operations/submissions/${encodeURIComponent(submissionId)}`,
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(changes) },
  );
}

export async function listCrmConsentPurposes(workspaceId: string, includeArchived = false): Promise<CrmConsentPurpose[]> {
  const body = await jsonRequest<{ purposes: CrmConsentPurpose[] }>(
    `/api/crm/${encodeURIComponent(workspaceId)}/operations/consent-purposes${includeArchived ? "?includeArchived=true" : ""}`,
  );
  return body.purposes;
}

export function saveCrmConsentPurpose(
  workspaceId: string,
  input: {
    purposeId?: string; purposeKey: string; label: string; description?: string;
    requiresConsent?: boolean; applicableChannels?: CrmDeliveryChannel[];
    wordingVersion: string; wording: string; archived?: boolean;
  },
): Promise<{ record: CrmConsentPurpose; created: boolean }> {
  return jsonRequest(`/api/crm/${encodeURIComponent(workspaceId)}/operations/consent-purposes`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
}

export function getCrmCompliance(workspaceId: string, contactId: string): Promise<CrmCompliance> {
  return jsonRequest(`/api/crm/${encodeURIComponent(workspaceId)}/operations/contacts/${encodeURIComponent(contactId)}/compliance`);
}

export function recordCrmConsent(
  workspaceId: string,
  contactId: string,
  input: { purposeKey: string; action: "granted" | "withdrawn"; source: string },
): Promise<{ record: Record<string, unknown> }> {
  return jsonRequest(`/api/crm/${encodeURIComponent(workspaceId)}/operations/contacts/${encodeURIComponent(contactId)}/consent`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
}

export function recordCrmSuppression(
  workspaceId: string,
  contactId: string,
  input: { channel: "all" | CrmDeliveryChannel; action: "suppressed" | "released"; reasonCode: string; source: string },
): Promise<{ record: Record<string, unknown> }> {
  return jsonRequest(`/api/crm/${encodeURIComponent(workspaceId)}/operations/contacts/${encodeURIComponent(contactId)}/suppressions`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
}

export function checkCrmSendability(
  workspaceId: string,
  contactId: string,
  channel: CrmDeliveryChannel,
  purposeKey: string,
): Promise<CrmSendabilityVerdict> {
  const params = new URLSearchParams({ channel, purposeKey });
  return jsonRequest(`/api/crm/${encodeURIComponent(workspaceId)}/operations/contacts/${encodeURIComponent(contactId)}/sendability?${params}`);
}

export async function listCrmSegments(
  workspaceId: string,
  entityKind: CrmSegmentEntityKind,
  includeArchived = false,
): Promise<{ segments: CrmSegment[]; catalog: CrmSegmentCatalogEntry[] }> {
  const params = new URLSearchParams({ entityKind });
  if (includeArchived) params.set("includeArchived", "true");
  return jsonRequest(`/api/crm/${encodeURIComponent(workspaceId)}/operations/segments?${params}`);
}

export function previewCrmSegment(workspaceId: string, segmentId: string): Promise<CrmSegmentPreview> {
  return jsonRequest(`/api/crm/${encodeURIComponent(workspaceId)}/operations/segments/${encodeURIComponent(segmentId)}/preview?limit=25&snapshotLimit=1000`);
}

export function saveCrmSegment(
  workspaceId: string,
  input: {
    segmentId?: string;
    segmentKey: string;
    name: string;
    description?: string;
    entityKind: CrmSegmentEntityKind;
    predicate: CrmSegmentPredicate;
    expectedVersion?: number;
  },
): Promise<{ record: CrmSegment; created: boolean }> {
  const path = input.segmentId
    ? `/api/crm/${encodeURIComponent(workspaceId)}/operations/segments/${encodeURIComponent(input.segmentId)}`
    : `/api/crm/${encodeURIComponent(workspaceId)}/operations/segments`;
  const { segmentId: _segmentId, ...body } = input;
  return jsonRequest(path, {
    method: input.segmentId ? "PATCH" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function archiveCrmSegment(
  workspaceId: string,
  segmentId: string,
  expectedVersion?: number,
): Promise<{ record: CrmSegment }> {
  return jsonRequest(`/api/crm/${encodeURIComponent(workspaceId)}/operations/segments/${encodeURIComponent(segmentId)}/archive`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedVersion }),
  });
}

export async function listCrmEntitlementPlans(
  workspaceId: string,
  filters: { published?: boolean; limit?: number } = {},
): Promise<CrmEntitlementPlan[]> {
  const params = new URLSearchParams();
  if (filters.published !== undefined) params.set("published", String(filters.published));
  if (filters.limit) params.set("limit", String(filters.limit));
  const query = params.toString();
  const body = await jsonRequest<{ plans: CrmEntitlementPlan[] }>(
    `/api/crm/${encodeURIComponent(workspaceId)}/operations/entitlement-plans${query ? `?${query}` : ""}`,
  );
  return body.plans;
}

export async function listCrmEntitlements(
  workspaceId: string,
  filters: { contactId?: string; planId?: string; status?: CrmEntitlementStatus; limit?: number } = {},
): Promise<CrmEntitlement[]> {
  const params = new URLSearchParams();
  if (filters.contactId) params.set("contactId", filters.contactId);
  if (filters.planId) params.set("planId", filters.planId);
  if (filters.status) params.set("status", filters.status);
  if (filters.limit) params.set("limit", String(filters.limit));
  const query = params.toString();
  const body = await jsonRequest<{ entitlements: CrmEntitlement[] }>(
    `/api/crm/${encodeURIComponent(workspaceId)}/operations/entitlements${query ? `?${query}` : ""}`,
  );
  return body.entitlements;
}

export function grantCrmEntitlement(
  workspaceId: string,
  input: {
    contactId: string; planId: string; idempotencyKey: string;
    status?: CrmEntitlementStatus; startsAt: string; endsAt?: string | null;
    renewalMode?: "none" | "manual" | "auto";
  },
): Promise<{ record: CrmEntitlement; created: boolean }> {
  return jsonRequest(`/api/crm/${encodeURIComponent(workspaceId)}/operations/entitlements`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
}

export function updateCrmEntitlement(
  workspaceId: string,
  entitlementId: string,
  changes: { status?: CrmEntitlementStatus; endsAt?: string | null; renewalMode?: "none" | "manual" | "auto" },
): Promise<{ record: CrmEntitlement }> {
  return jsonRequest(`/api/crm/${encodeURIComponent(workspaceId)}/operations/entitlements/${encodeURIComponent(entitlementId)}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(changes),
  });
}

export async function listCrmEvents(
  workspaceId: string,
  filters: { status?: CrmEvent["status"]; limit?: number } = {},
): Promise<CrmEvent[]> {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.limit) params.set("limit", String(filters.limit));
  const query = params.toString();
  const body = await jsonRequest<{ events: CrmEvent[] }>(
    `/api/crm/${encodeURIComponent(workspaceId)}/operations/events${query ? `?${query}` : ""}`,
  );
  return body.events;
}

export async function listCrmParticipation(
  workspaceId: string,
  filters: { contactId?: string; eventId?: string; status?: CrmParticipationStatus; sourceKind?: CrmParticipation["sourceKind"]; limit?: number } = {},
): Promise<CrmParticipation[]> {
  const params = new URLSearchParams();
  if (filters.contactId) params.set("contactId", filters.contactId);
  if (filters.eventId) params.set("eventId", filters.eventId);
  if (filters.status) params.set("status", filters.status);
  if (filters.sourceKind) params.set("sourceKind", filters.sourceKind);
  if (filters.limit) params.set("limit", String(filters.limit));
  const query = params.toString();
  const body = await jsonRequest<{ participation: CrmParticipation[] }>(
    `/api/crm/${encodeURIComponent(workspaceId)}/operations/participation${query ? `?${query}` : ""}`,
  );
  return body.participation;
}

export function recordCrmParticipation(
  workspaceId: string,
  input: {
    contactId: string; eventId: string; sourceKind: "manual" | "form" | "workflow" | "import";
    sourceId: string; status?: CrmParticipationStatus; attendeeName: string;
    attendeeEmail?: string; metadata?: Record<string, unknown>;
  },
): Promise<{ record: CrmParticipation; created: boolean }> {
  return jsonRequest(`/api/crm/${encodeURIComponent(workspaceId)}/operations/participation`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
}

export function updateCrmParticipation(
  workspaceId: string,
  participationId: string,
  status: CrmParticipationStatus,
): Promise<{ record: CrmParticipation }> {
  return jsonRequest(`/api/crm/${encodeURIComponent(workspaceId)}/operations/participation/${encodeURIComponent(participationId)}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }),
  });
}

export function fetchCrmConfig(workspaceId: string, includeArchived = false): Promise<CrmConfig> {
  return jsonRequest(`/api/crm/${encodeURIComponent(workspaceId)}/config${includeArchived ? "?archived=true" : ""}`);
}

export async function createCrmRecord(
  workspaceId: string,
  record: Record<string, unknown>,
): Promise<{ id: string; kind: string }> {
  return jsonRequest(`/api/crm/${encodeURIComponent(workspaceId)}/records`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(record),
  });
}

export type CrmProductionImportKind = "contact" | "company" | "deal" | "operations";
export type CrmProductionImportMapping = {
  columns: Record<string, string | null>;
  trustedIdentitySource?: string;
};
export type CrmProductionImportDryRun = {
  dryRunHash: string;
  bytes: number;
  totalRows: number;
  validRows: number;
  failedRows: number;
  headers: string[];
  sampleErrors: Array<{ row: number; code: string; field?: string; message: string }>;
};
export type CrmProductionImportJob = {
  id: string;
  status: "ready" | "running" | "paused" | "completed" | "cancelled" | "failed";
  entityKind: CrmProductionImportKind;
  totalRows: number;
  processedRows: number;
  succeededRows: number;
  failedRows: number;
};

export function dryRunCrmImport(
  workspaceId: string,
  input: { stagedFileId: string; entityKind: CrmProductionImportKind; mapping: CrmProductionImportMapping },
): Promise<CrmProductionImportDryRun> {
  return jsonRequest(`/api/crm/${encodeURIComponent(workspaceId)}/operations/imports/dry-run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function confirmCrmImport(
  workspaceId: string,
  input: {
    stagedFileId: string;
    entityKind: CrmProductionImportKind;
    mapping: CrmProductionImportMapping;
    dryRunHash: string;
    confirmed: true;
  },
): Promise<CrmProductionImportJob> {
  return jsonRequest(`/api/crm/${encodeURIComponent(workspaceId)}/operations/imports`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function resumeCrmImport(
  workspaceId: string,
  jobId: string,
): Promise<CrmProductionImportJob> {
  return jsonRequest(
    `/api/crm/${encodeURIComponent(workspaceId)}/operations/imports/${encodeURIComponent(jobId)}/resume`,
    { method: "POST" },
  );
}

export function cancelCrmImport(
  workspaceId: string,
  jobId: string,
): Promise<CrmProductionImportJob> {
  return jsonRequest(
    `/api/crm/${encodeURIComponent(workspaceId)}/operations/imports/${encodeURIComponent(jobId)}/cancel`,
    { method: "POST" },
  );
}

export async function downloadCrmImportErrors(workspaceId: string, jobId: string): Promise<Blob> {
  const res = await authFetch(
    `${API_URL}/api/crm/${encodeURIComponent(workspaceId)}/operations/imports/${encodeURIComponent(jobId)}/errors.csv`,
  );
  if (!res.ok) throw new Error(`CRM import error export failed (${res.status})`);
  return res.blob();
}

export type CrmOperationsAuditEntry = {
  id: string;
  action: string;
  subjectKind: string;
  subjectId: string;
  actorKind: string;
  occurredAt: string;
  details: Record<string, unknown>;
};
export type CrmEventDeliveryEntry = {
  id: string;
  eventType: string;
  subjectKind: string;
  subjectId: string;
  status: "pending" | "leased" | "delivered" | "failed";
  attempts: number;
  occurredAt: string;
  deliveredAt: string | null;
};

export async function listCrmOperationsAudit(
  workspaceId: string,
  limit = 50,
): Promise<CrmOperationsAuditEntry[]> {
  const body = await jsonRequest<{ entries: CrmOperationsAuditEntry[] }>(
    `/api/crm/${encodeURIComponent(workspaceId)}/operations/audit?limit=${limit}`,
  );
  return body.entries;
}

export async function listCrmEventDelivery(
  workspaceId: string,
  limit = 50,
): Promise<CrmEventDeliveryEntry[]> {
  const body = await jsonRequest<{ events: CrmEventDeliveryEntry[] }>(
    `/api/crm/${encodeURIComponent(workspaceId)}/operations/event-delivery?limit=${limit}`,
  );
  return body.events;
}

export async function downloadCrmOperationsPrivacyExport(workspaceId: string): Promise<Blob> {
  const res = await authFetch(
    `${API_URL}/api/crm/${encodeURIComponent(workspaceId)}/operations/privacy-export`,
  );
  if (!res.ok) throw new Error(`CRM operations export failed (${res.status})`);
  return res.blob();
}

export async function downloadCrmCsv(
  workspaceId: string,
  kind: "contacts" | "companies" | "deals",
): Promise<Blob> {
  const res = await authFetch(
    `${API_URL}/api/crm/${encodeURIComponent(workspaceId)}/export?kind=${kind}`,
  );
  if (!res.ok) throw new Error(`CRM export failed (${res.status})`);
  return res.blob();
}

export async function setCrmRecordArchived(
  workspaceId: string,
  entityId: string,
  archived: boolean,
): Promise<void> {
  await jsonRequest(
    `/api/crm/${encodeURIComponent(workspaceId)}/records/${encodeURIComponent(entityId)}/${archived ? "archive" : "restore"}`,
    { method: "POST" },
  );
}

export type CrmActivity = {
  id: string;
  activityType: "note" | "call" | "meeting" | "message" | "field_change" | "stage_change";
  direction: "inbound" | "outbound" | "internal";
  occurredAt: string;
  subject: string | null;
  summary: string;
  sourceKind: string | null;
  metadata: Record<string, unknown>;
};

export async function fetchCrmTimeline(
  workspaceId: string,
  entityId: string,
): Promise<CrmActivity[]> {
  const body = await jsonRequest<{ activities: CrmActivity[] }>(
    `/api/crm/${encodeURIComponent(workspaceId)}/records/${encodeURIComponent(entityId)}/timeline`,
  );
  return body.activities;
}

export async function createCrmActivity(
  workspaceId: string,
  entityId: string,
  input: {
    activityType: "note" | "call" | "meeting" | "message";
    direction?: "inbound" | "outbound" | "internal";
    occurredAt?: string;
    subject?: string;
    summary: string;
  },
): Promise<CrmActivity> {
  const body = await jsonRequest<{ activity: CrmActivity }>(
    `/api/crm/${encodeURIComponent(workspaceId)}/records/${encodeURIComponent(entityId)}/activities`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  return body.activity;
}

export type CrmReport = {
  byStage: Array<{ stageId: string; name: string; category: CrmStageCategory; count: number; values: Record<string, number> }>;
  openValue: Record<string, number>;
  weightedForecast: Record<string, number>;
  wonCount: number;
  lostCount: number;
  winRate: number | null;
  missingOwnerCount: number;
  missingAmountCount: number;
  bySource: Array<{ source: string; count: number; won: number; values: Record<string, number> }>;
  stageVelocityDays: Array<{ stageId: string; medianDays: number | null; samples: number }>;
};

export function fetchCrmReport(workspaceId: string): Promise<CrmReport> {
  return jsonRequest(`/api/crm/${encodeURIComponent(workspaceId)}/reports`);
}

export type CrmSavedView = {
  id: string;
  name: string;
  section: string;
  queryState: Record<string, unknown>;
  position: number;
};

export async function listCrmSavedViews(workspaceId: string): Promise<CrmSavedView[]> {
  const body = await jsonRequest<{ views: CrmSavedView[] }>(
    `/api/crm/${encodeURIComponent(workspaceId)}/views`,
  );
  return body.views;
}

export function saveCrmView(
  workspaceId: string,
  input: { name: string; section: string; queryState: Record<string, unknown> },
): Promise<CrmSavedView> {
  return jsonRequest(`/api/crm/${encodeURIComponent(workspaceId)}/views`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function deleteCrmView(workspaceId: string, viewId: string): Promise<void> {
  await jsonRequest(
    `/api/crm/${encodeURIComponent(workspaceId)}/views/${encodeURIComponent(viewId)}`,
    { method: "DELETE" },
  );
}

export type CrmDuplicateGroup = {
  kind: "person" | "company" | "deal";
  reason: "email" | "phone" | "domain" | "name" | "alias";
  value: string;
  records: Array<{ id: string; name: string }>;
};

export type CrmSeparation = {
  id: string;
  workspaceId: string;
  leftEntityId: string;
  rightEntityId: string;
  leftName: string;
  rightName: string;
  reason: string | null;
  createdAt: string;
};

export async function fetchCrmDuplicates(workspaceId: string): Promise<CrmDuplicateGroup[]> {
  const body = await jsonRequest<{ groups: CrmDuplicateGroup[] }>(
    `/api/crm/${encodeURIComponent(workspaceId)}/duplicates`,
  );
  return body.groups;
}

export async function fetchCrmSeparations(workspaceId: string): Promise<CrmSeparation[]> {
  const body = await jsonRequest<{ separations: CrmSeparation[] }>(
    `/api/crm/${encodeURIComponent(workspaceId)}/separations`,
  );
  return body.separations;
}

export function keepCrmRecordsSeparate(
  workspaceId: string,
  leftEntityId: string,
  rightEntityId: string,
): Promise<{ separation: CrmSeparation; idempotent: boolean }> {
  return jsonRequest(`/api/crm/${encodeURIComponent(workspaceId)}/separations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ leftEntityId, rightEntityId }),
  });
}

export async function reviewCrmSeparationAgain(
  workspaceId: string,
  separationId: string,
): Promise<void> {
  await jsonRequest(
    `/api/crm/${encodeURIComponent(workspaceId)}/separations/${encodeURIComponent(separationId)}/review-again`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
  );
}

export function mergeCrmRecords(
  workspaceId: string,
  survivingId: string,
  mergedId: string,
): Promise<{ mergeId: string; undoUntil: string }> {
  return jsonRequest(`/api/crm/${encodeURIComponent(workspaceId)}/merge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ survivingId, mergedId }),
  });
}

export async function undoCrmMerge(
  workspaceId: string,
  mergeId: string,
): Promise<void> {
  await jsonRequest(
    `/api/crm/${encodeURIComponent(workspaceId)}/merges/${encodeURIComponent(mergeId)}/undo`,
    { method: "POST" },
  );
}

export function createCrmPipeline(
  workspaceId: string,
  name: string,
): Promise<CrmPipeline> {
  return jsonRequest(`/api/crm/${encodeURIComponent(workspaceId)}/pipelines`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export function createCrmPipelineStage(
  workspaceId: string,
  pipelineId: string,
  input: { name: string; category: CrmStageCategory; probability: number },
): Promise<CrmPipelineStage> {
  return jsonRequest(
    `/api/crm/${encodeURIComponent(workspaceId)}/pipelines/${encodeURIComponent(pipelineId)}/stages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
}

export function updateCrmPipeline(
  workspaceId: string,
  pipelineId: string,
  changes: { name?: string; isDefault?: boolean; archived?: boolean },
): Promise<{ ok: true }> {
  return jsonRequest(
    `/api/crm/${encodeURIComponent(workspaceId)}/pipelines/${encodeURIComponent(pipelineId)}`,
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(changes) },
  );
}

export function reorderCrmPipelines(workspaceId: string, orderedIds: string[]): Promise<{ ok: true }> {
  return jsonRequest(`/api/crm/${encodeURIComponent(workspaceId)}/pipelines/reorder`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderedIds }),
  });
}

export function updateCrmPipelineStage(
  workspaceId: string,
  stageId: string,
  changes: Partial<Pick<CrmPipelineStage, "name" | "category" | "probability" | "requiredFields">> & { archived?: boolean },
): Promise<CrmPipelineStage | { ok: true }> {
  return jsonRequest(`/api/crm/${encodeURIComponent(workspaceId)}/stages/${encodeURIComponent(stageId)}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(changes),
  });
}

export function reorderCrmPipelineStages(
  workspaceId: string,
  pipelineId: string,
  orderedIds: string[],
): Promise<{ ok: true }> {
  return jsonRequest(
    `/api/crm/${encodeURIComponent(workspaceId)}/pipelines/${encodeURIComponent(pipelineId)}/stages/reorder`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderedIds }) },
  );
}

export function createCrmField(
  workspaceId: string,
  input: {
    entityKind: "person" | "company" | "deal";
    fieldKey: string;
    label: string;
    fieldType: CrmFieldType;
    options?: string[];
  },
): Promise<CrmFieldDefinition> {
  return jsonRequest(`/api/crm/${encodeURIComponent(workspaceId)}/fields`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export const CRM_PRESET_IDS = [
  "services_saas",
  "enterprise_sales",
  "partnership_referral",
] as const;
export type CrmPresetId = (typeof CRM_PRESET_IDS)[number];
export type CrmPresetApplyResult = {
  created: string[];
  skipped: string[];
  revived: string[];
  conflicts: string[];
};

export function applyCrmFieldPreset(
  workspaceId: string,
  presetId: CrmPresetId,
): Promise<CrmPresetApplyResult> {
  return jsonRequest(
    `/api/crm/${encodeURIComponent(workspaceId)}/field-presets/${encodeURIComponent(presetId)}`,
    { method: "POST" },
  );
}

export async function archiveCrmField(
  workspaceId: string,
  fieldId: string,
): Promise<void> {
  await jsonRequest(
    `/api/crm/${encodeURIComponent(workspaceId)}/fields/${encodeURIComponent(fieldId)}`,
    { method: "DELETE" },
  );
}

export function updateCrmField(
  workspaceId: string,
  fieldId: string,
  changes: { label?: string; options?: string[]; isRequired?: boolean },
): Promise<CrmFieldDefinition> {
  return jsonRequest(`/api/crm/${encodeURIComponent(workspaceId)}/fields/${encodeURIComponent(fieldId)}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(changes),
  });
}

export async function restoreCrmField(workspaceId: string, fieldId: string): Promise<void> {
  await jsonRequest(
    `/api/crm/${encodeURIComponent(workspaceId)}/fields/${encodeURIComponent(fieldId)}/restore`,
    { method: "POST" },
  );
}

export function reorderCrmFields(
  workspaceId: string,
  entityKind: "person" | "company" | "deal",
  orderedIds: string[],
): Promise<{ ok: true }> {
  return jsonRequest(`/api/crm/${encodeURIComponent(workspaceId)}/fields/reorder`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entityKind, orderedIds }),
  });
}

export async function updateCrmCustomFields(
  workspaceId: string,
  entityId: string,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const body = await jsonRequest<{ customFields: Record<string, unknown> }>(
    `/api/crm/${encodeURIComponent(workspaceId)}/records/${encodeURIComponent(entityId)}/custom-fields`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    },
  );
  return body.customFields;
}

export async function setCrmPipelineStage(
  workspaceId: string,
  entityId: string,
  pipelineId: string,
  stageId: string,
): Promise<void> {
  await jsonRequest(
    `/api/crm/${encodeURIComponent(workspaceId)}/operations/deals/${encodeURIComponent(entityId)}/pipeline-stage`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pipelineId, stageId }),
    },
  );
}

export type CrmDealParticipant = {
  contactId: string;
  role: string | null;
  isPrimary: boolean;
  name: string;
  email: string | null;
};

export async function listCrmDealParticipants(
  workspaceId: string,
  dealId: string,
): Promise<CrmDealParticipant[]> {
  const body = await jsonRequest<{ participants: CrmDealParticipant[] }>(
    `/api/crm/${encodeURIComponent(workspaceId)}/records/${encodeURIComponent(dealId)}/participants`,
  );
  return body.participants;
}

export async function addCrmDealParticipant(
  workspaceId: string,
  dealId: string,
  contactId: string,
  options: { role?: string | null; isPrimary?: boolean } = {},
): Promise<void> {
  await jsonRequest(
    `/api/crm/${encodeURIComponent(workspaceId)}/records/${encodeURIComponent(dealId)}/participants`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contactId, ...options }),
    },
  );
}

export async function removeCrmDealParticipant(
  workspaceId: string,
  dealId: string,
  contactId: string,
): Promise<void> {
  await jsonRequest(
    `/api/crm/${encodeURIComponent(workspaceId)}/records/${encodeURIComponent(dealId)}/participants/${encodeURIComponent(contactId)}`,
    { method: "DELETE" },
  );
}
