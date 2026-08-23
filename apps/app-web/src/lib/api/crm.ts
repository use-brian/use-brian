/**
 * CRM operator-surface SDK — the flat CRM read behind `/w/[id]/crm`
 * (`GET /api/brain/crm`, [COMP:brain/crm-list-http]): every live deal /
 * contact / company the viewer can see, one payload, 500/kind cap, full
 * operator fields. The client joins display names by id (`crm-view.ts`) and
 * resolves the workspace's stable pipeline stages from the configuration API.
 * Mutations reuse the existing brain-inbox adjust wire (`adjustBrainRow`
 * in `lib/api/brain-inbox.ts`) — the CRM-typed fields ride the same
 * endpoint (crm.md → "Operator surface"); stage changes route through
 * `setDealStage` server-side.
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
};

export type CrmPipeline = {
  id: string;
  name: string;
  isDefault: boolean;
  position: number;
  stages: CrmPipelineStage[];
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
};

export type CrmConfig = {
  pipelines: CrmPipeline[];
  fields: CrmFieldDefinition[];
};

async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authFetch(`${API_URL}${path}`, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `CRM request failed (${res.status})`);
  return body;
}

export function fetchCrmConfig(workspaceId: string): Promise<CrmConfig> {
  return jsonRequest(`/api/crm/${encodeURIComponent(workspaceId)}/config`);
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

export async function importCrmRecords(
  workspaceId: string,
  records: Record<string, unknown>[],
): Promise<{ created: number; failed: number; results: Array<{ row: number; id?: string; error?: string }> }> {
  return jsonRequest(`/api/crm/${encodeURIComponent(workspaceId)}/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ records }),
  });
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
  reason: "email" | "domain" | "name";
  value: string;
  records: Array<{ id: string; name: string }>;
};

export async function fetchCrmDuplicates(workspaceId: string): Promise<CrmDuplicateGroup[]> {
  const body = await jsonRequest<{ groups: CrmDuplicateGroup[] }>(
    `/api/crm/${encodeURIComponent(workspaceId)}/duplicates`,
  );
  return body.groups;
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
  stageId: string,
): Promise<void> {
  await jsonRequest(
    `/api/crm/${encodeURIComponent(workspaceId)}/records/${encodeURIComponent(entityId)}/pipeline-stage`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stageId }),
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
): Promise<void> {
  await jsonRequest(
    `/api/crm/${encodeURIComponent(workspaceId)}/records/${encodeURIComponent(dealId)}/participants`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contactId }),
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
