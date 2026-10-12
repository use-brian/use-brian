import { publicRuntimeConfig } from "@/lib/runtime-public-config";
/**
 * Governed Brief SDK (project-briefs.md -> "Commands"). The same service
 * backs Brian's tools, so the pane and Brian share authority, revision checks
 * and errors. [COMP:app-web/brief-journey]
 */
import { authFetch } from "@/lib/auth-fetch";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";

export type BriefOwnerKind = "project" | "department";
export type BriefDirectionSection = "outcome" | "rules" | "decisions";
export type BriefContextSection = "findings" | "questions" | "references";
export type BriefSections = Partial<Record<BriefDirectionSection, string[]>>;

type Block = { id: string; kind: string; text?: string };

export type BriefEvidence = { kind: string; id?: string | null; version?: string | null; passage?: string | null; label?: string | null };

export type BriefProposal = {
  id: string;
  kind: "draft" | "proposal";
  status: "open" | "applied" | "dismissed" | "superseded";
  authorUserId: string;
  authorAssistantId: string | null;
  summary: string | null;
  baseDirectionRevision: number;
  evidence: BriefEvidence[];
  stale: boolean;
  restoreOf: string | null;
};

export type BriefView = {
  binding: { id: string; ownerKind: BriefOwnerKind; ownerId: string; directionRevision: number; selectionRevision: number; updatedAt: string };
  role: "owner" | "participant" | "oversight";
  pageId: string | null;
  missing: boolean;
  established: boolean;
  direction: Record<BriefDirectionSection, string[]> | null;
  context: Record<BriefContextSection, Block[]> | null;
  proposals: BriefProposal[];
  myDraft: BriefProposal | null;
  selections: string[];
};

export type BriefRevision = {
  id: string;
  kind: "created" | "apply" | "restore" | "repair" | "selection";
  directionRevision: number;
  selectionRevision: number;
  actorUserId: string | null;
  actingAssistantId: string | null;
  activeWork: "pause" | "continue";
  createdAt: string;
};

export type DepartmentBriefOption = { bindingId: string; departmentId: string; name: string | null; directionRevision: number };

export class BriefRequestError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authFetch(`${API_URL}/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new BriefRequestError(body.error ?? "brief_unavailable", res.status);
  return body as T;
}

const base = (workspaceId: string) => `/workspaces/${workspaceId}/briefs`;

export async function getBriefByOwner(workspaceId: string, kind: BriefOwnerKind, ownerId: string): Promise<BriefView | null> {
  try {
    return (await call<{ brief: BriefView }>(`${base(workspaceId)}/by-owner/${kind}/${ownerId}`)).brief;
  } catch (error) {
    if (error instanceof BriefRequestError && error.code === "brief_not_found") return null;
    throw error;
  }
}

export async function ensureBrief(workspaceId: string, kind: BriefOwnerKind, ownerId: string, locale?: string): Promise<BriefView> {
  return (await call<{ brief: BriefView }>(`${base(workspaceId)}/ensure`, {
    method: "POST", body: JSON.stringify({ ownerKind: kind, ownerId, ...(locale ? { locale } : {}) }),
  })).brief;
}

export async function saveBriefDraft(workspaceId: string, bindingId: string, sections: BriefSections): Promise<BriefProposal> {
  return (await call<{ draft: BriefProposal }>(`${base(workspaceId)}/${bindingId}/draft`, { method: "PUT", body: JSON.stringify({ sections }) })).draft;
}

export async function proposeBriefChange(workspaceId: string, bindingId: string, sections: BriefSections, evidence: BriefEvidence[], summary?: string): Promise<BriefProposal> {
  return (await call<{ proposal: BriefProposal }>(`${base(workspaceId)}/${bindingId}/proposals`, {
    method: "POST", body: JSON.stringify({ sections, evidence, ...(summary ? { summary } : {}) }),
  })).proposal;
}

export async function applyBriefDirection(workspaceId: string, bindingId: string, input: {
  proposalId?: string; sections?: BriefSections; expectedDirectionRevision: number; expectedSelectionRevision: number
  activeWork: "pause" | "continue"; idempotencyKey: string
}): Promise<{ revisionId: string; directionRevision: number; replayed: boolean }> {
  return (await call<{ receipt: { revisionId: string; directionRevision: number; replayed: boolean } }>(`${base(workspaceId)}/${bindingId}/apply`, {
    method: "POST", body: JSON.stringify(input),
  })).receipt;
}

export async function dismissBriefProposal(workspaceId: string, bindingId: string, proposalId: string): Promise<void> {
  await call(`${base(workspaceId)}/${bindingId}/proposals/${proposalId}/dismiss`, { method: "POST", body: "{}" });
}

export async function listBriefRevisions(workspaceId: string, bindingId: string): Promise<BriefRevision[]> {
  return (await call<{ revisions: BriefRevision[] }>(`${base(workspaceId)}/${bindingId}/revisions`)).revisions;
}

export async function restoreBriefRevision(workspaceId: string, bindingId: string, revisionId: string): Promise<{ proposalId: string }> {
  return call(`${base(workspaceId)}/${bindingId}/revisions/${revisionId}/restore`, { method: "POST", body: "{}" });
}

export async function listDepartmentBriefs(workspaceId: string): Promise<DepartmentBriefOption[]> {
  return (await call<{ departmentBriefs: DepartmentBriefOption[] }>(`${base(workspaceId)}/departments`)).departmentBriefs;
}

export async function selectBriefDepartments(workspaceId: string, bindingId: string, input: {
  departmentBindingIds: string[]; expectedSelectionRevision: number; activeWork: "pause" | "continue"; idempotencyKey: string
}): Promise<{ selectionRevision: number }> {
  return (await call<{ receipt: { selectionRevision: number } }>(`${base(workspaceId)}/${bindingId}/departments`, {
    method: "PUT", body: JSON.stringify(input),
  })).receipt;
}

export async function repairBrief(workspaceId: string, bindingId: string): Promise<{ pageId: string }> {
  return call(`${base(workspaceId)}/${bindingId}/repair`, { method: "POST", body: "{}" });
}
