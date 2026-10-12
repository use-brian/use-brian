import { publicRuntimeConfig } from "@/lib/runtime-public-config";
/**
 * Stable Team/Project registry and context-binding SDK.
 * Raw compartment keys never cross this boundary.
 * [COMP:app-web/context-scope]
 */
import { authFetch } from "@/lib/auth-fetch";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";

export type ContextTeam = {
  id: string;
  name: string;
  key: string;
  description: string | null;
  color: string | null;
  status: "active" | "archived";
  readAll: boolean;
  readGrantGroupIds: string[];
  memberCount: number;
  members?: Array<{ userId: string; name: string | null; email: string | null }>;
  assistantIds?: string[];
};

export type ContextProject = {
  id: string;
  workspaceId: string;
  name: string;
  normalizedName: string;
  description: string | null;
  icon: string | null;
  status: "active" | "archived";
  entityId: string | null;
  members?: Array<{ userId: string; role: "lead" | "member"; name: string | null; email: string | null }>;
  assistantIds?: string[];
  aggregates?: Record<string, number>;
  /** Shared Project summary (project-shared-spaces.md); null for a legacy focus-only Project. */
  shared?: ProjectSharedSummary | ProjectRoster | null;
};

/** The caller's role in a shared Project; `oversight` is the workspace owner's read-only access (D27). */
export type ProjectSharedRole = "owner" | "participant" | "oversight";

export type ProjectSharedSummary = {
  projectId: string;
  status: "active" | "quarantined";
  revision: number;
  myRole: ProjectSharedRole | null;
};

export type ProjectPrincipal = { kind: "user" | "assistant"; id: string };

export type ProjectRoster = ProjectSharedSummary & {
  origin: "created" | "converted";
  members: Array<{ principal: ProjectPrincipal; name: string | null; email: string | null; isOwner: boolean; expiresAt: string | null; origin: string }>;
  oversight: Array<{ userId: string; name: string | null; isMember: boolean }>;
};

export type ProjectConversionPreview = {
  projectId: string;
  projectName: string;
  ownerUserId: string;
  userIds: string[];
  assistantIds: string[];
  legacyParticipation: { userIds: string[]; assistantIds: string[] };
  relabelled: 0;
  requestHash: string;
};

export type ContextReadiness = {
  enforcementVersion: number;
  readyForActivation: boolean;
  checks: Array<{
    id: string;
    ready: boolean;
    blocking: boolean;
    detail: string;
    missing?: string[];
  }>;
  legacyGeneral: Record<string, number>;
};

export type AssistantContextConfig = {
  teamMode: "legacy" | "all" | "assigned";
  teamIds: string[];
  defaultGroupId: string | null;
  projectMode: "all" | "assigned";
  projectIds: string[];
  defaultProjectId: string | null;
};

export type ContextExplanation = {
  memberTeams: Array<{ id: string; name: string; readAll: boolean }>;
  assistant: AssistantContextConfig | null;
  activeTeam: { id: string; name: string } | null;
  activeProject: Pick<ContextProject, "id" | "name" | "status"> | null;
  effective: {
    teamIds: string[];
    projectIds: string[];
    teamUniverse: boolean;
    projectUniverse: boolean;
  };
  rule: string;
};

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await authFetch(`${API_URL}${path}`, init);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

export async function listContextTeams(workspaceId: string): Promise<ContextTeam[]> {
  const body = await json<{ groups: ContextTeam[] }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/groups`,
  );
  return body.groups;
}

export async function listContextProjects(
  workspaceId: string,
  includeArchived = false,
): Promise<ContextProject[]> {
  const body = await json<{ projects: ContextProject[] }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/projects?includeArchived=${includeArchived}`,
  );
  return body.projects;
}

export async function getContextProject(
  workspaceId: string,
  projectId: string,
): Promise<ContextProject> {
  const body = await json<{ project: ContextProject }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}`,
  );
  return body.project;
}

export async function createContextProject(
  workspaceId: string,
  input: { name: string; description?: string | null; icon?: string | null;
    /** Shared spaces: the visible People/Assistants selection (D20/D21). */
    participants?: { userIds: string[]; assistantIds: string[] } },
): Promise<ContextProject> {
  const body = await json<{ project: ContextProject }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/projects`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) },
  );
  return body.project;
}

export async function updateContextProject(
  workspaceId: string,
  projectId: string,
  input: { name?: string; description?: string | null; icon?: string | null; status?: "active" },
): Promise<ContextProject> {
  const body = await json<{ project: ContextProject }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}`,
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) },
  );
  return body.project;
}

export async function archiveContextProject(workspaceId: string, projectId: string): Promise<void> {
  await json(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/archive`,
    { method: "POST" },
  );
}

export async function setContextProjectMember(
  workspaceId: string,
  projectId: string,
  userId: string,
  enabled: boolean,
  role: "lead" | "member" = "member",
): Promise<void> {
  await json(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,
    enabled
      ? { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role }) }
      : { method: "DELETE" },
  );
}

export async function setContextProjectAssistant(
  workspaceId: string,
  projectId: string,
  assistantId: string,
  enabled: boolean,
): Promise<void> {
  await json(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/assistants/${encodeURIComponent(assistantId)}`,
    { method: enabled ? "PUT" : "DELETE" },
  );
}

export async function getContextReadiness(workspaceId: string): Promise<ContextReadiness> {
  return json(`/api/workspaces/${encodeURIComponent(workspaceId)}/context/readiness`);
}

export async function getContextExplanation(
  workspaceId: string,
  context: { assistantId?: string; groupId?: string; projectId?: string } = {},
): Promise<ContextExplanation> {
  const query = new URLSearchParams();
  if (context.assistantId) query.set("assistantId", context.assistantId);
  if (context.groupId) query.set("groupId", context.groupId);
  if (context.projectId) query.set("projectId", context.projectId);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return json(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/context/explain${suffix}`,
  );
}

export async function getAssistantContext(
  workspaceId: string,
  assistantId: string,
): Promise<AssistantContextConfig> {
  const body = await json<{ context: AssistantContextConfig }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/assistants/${encodeURIComponent(assistantId)}/context`,
  );
  return body.context;
}

export async function reclassifyContext(input: {
  workspaceId: string;
  primitive: "memory" | "task" | "file" | "entity" | "knowledge" | "recording" | "office";
  rowId: string;
  teamIds: string[];
  projectIds: string[];
  reason: string;
  confirmed?: boolean;
}): Promise<void> {
  const { workspaceId, ...body } = input;
  await json(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/context/reclassify`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
}

export async function getReclassifiableContext(input: {
  workspaceId: string;
  primitive: "memory" | "task" | "file" | "entity" | "knowledge" | "recording" | "office";
  rowId: string;
}): Promise<{ teamIds: string[]; projectIds: string[]; hasOtherCompartments: boolean }> {
  const query = new URLSearchParams({ primitive: input.primitive, rowId: input.rowId });
  const body = await json<{ context: { teamIds: string[]; projectIds: string[]; hasOtherCompartments?: boolean } }>(
    `/api/workspaces/${encodeURIComponent(input.workspaceId)}/context/reclassify?${query.toString()}`,
  );
  return { ...body.context, hasOtherCompartments: body.context.hasOtherCompartments === true };
}

export async function getConnectorContext(
  workspaceId: string,
  instanceId: string,
): Promise<{ contextGroupId: string | null; contextProjectId: string | null; canEdit: boolean }> {
  const body = await json<{
    context: { contextGroupId: string | null; contextProjectId: string | null };
    canEdit?: boolean;
  }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/connectors/${encodeURIComponent(instanceId)}/context`,
  );
  return { ...body.context, canEdit: body.canEdit === true };
}

export async function updateConnectorContext(
  workspaceId: string,
  instanceId: string,
  // Omit a field to keep it: the header badge sets only the department, the
  // Settings binding only the Project.
  context: { contextGroupId?: string | null; contextProjectId?: string | null },
): Promise<void> {
  await json(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/connectors/${encodeURIComponent(instanceId)}/context`,
    { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(context) },
  );
}


export type ProjectContentView = "work" | "knowledge" | "recent";
export type ProjectContentPage = {
  items: Array<{ key: string; id: string; title: string; snippet: string; kind: string;
    target: import("@use-brian/shared").WorkspaceSearchTarget; status: string | null; updatedAt: string | null }>;
  nextOffset: number | null;
};
export function getProjectContent(workspaceId: string, projectId: string, view: ProjectContentView, q: string, offset: number) {
  const query = new URLSearchParams({view,q,offset:String(offset)});
  return json<ProjectContentPage>(`/api/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/content?${query}`);
}

// ── Shared Project spaces (project-shared-spaces.md -> "Canonical commands") ──
// One store backs these routes and Brian's manageProjectAccess tool.

const sharedBase = (workspaceId: string, projectId: string) =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/shared`;
const send = (method: string, body: unknown): RequestInit =>
  ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export async function getProjectSharedCapability(workspaceId: string): Promise<{ enabled: boolean; canConfigure: boolean }> {
  return json(`/api/workspaces/${encodeURIComponent(workspaceId)}/project-shared/capability`);
}

export async function setProjectSharedCapability(workspaceId: string, enabled: boolean): Promise<{ enabled: boolean }> {
  return json(`/api/workspaces/${encodeURIComponent(workspaceId)}/project-shared/capability`, send("PUT", { enabled }));
}

/** Add a participant, or change their expiry. No clearance choice (D22). */
export async function setProjectParticipant(workspaceId: string, projectId: string, principal: ProjectPrincipal, expectedRevision?: number): Promise<{ revision: number }> {
  return json(`${sharedBase(workspaceId, projectId)}/members`, send("PUT", { principal, ...(expectedRevision ? { expectedRevision } : {}) }));
}

export async function removeProjectParticipant(workspaceId: string, projectId: string, principal: ProjectPrincipal, expectedRevision?: number): Promise<{ revision: number }> {
  return json(`${sharedBase(workspaceId, projectId)}/members`, send("DELETE", { principal, ...(expectedRevision ? { expectedRevision } : {}) }));
}

export async function setProjectOwner(workspaceId: string, projectId: string, userId: string, owner: boolean, expectedRevision?: number): Promise<{ revision: number }> {
  return json(`${sharedBase(workspaceId, projectId)}/owners`, send(owner ? "POST" : "DELETE", { userId, ...(expectedRevision ? { expectedRevision } : {}) }));
}

export async function transferProjectOwnership(workspaceId: string, projectId: string, userId: string, expectedRevision?: number): Promise<{ revision: number }> {
  return json(`${sharedBase(workspaceId, projectId)}/transfer`, send("POST", { userId, ...(expectedRevision ? { expectedRevision } : {}) }));
}

/** D26: the workspace owner adds an owner (default: themself) at any time; audited. */
export async function recoverProjectOwnership(workspaceId: string, projectId: string, input: { targetUserId?: string | null; reason: string; expectedRevision?: number }): Promise<{ revision: number }> {
  return json(`${sharedBase(workspaceId, projectId)}/recover`, send("POST", input));
}

export async function previewProjectConversion(workspaceId: string, projectId: string,
  input: { ownerUserId?: string | null; userIds: string[]; assistantIds: string[] }): Promise<ProjectConversionPreview> {
  return (await json<{ preview: ProjectConversionPreview }>(`${sharedBase(workspaceId, projectId)}/convert`, send("POST", { mode: "preview", ...input }))).preview;
}

export async function applyProjectConversion(workspaceId: string, projectId: string,
  input: { ownerUserId?: string | null; userIds: string[]; assistantIds: string[]; idempotencyKey: string; requestHash: string }): Promise<{ replayed: boolean }> {
  return (await json<{ receipt: { replayed: boolean } }>(`${sharedBase(workspaceId, projectId)}/convert`, send("POST", { mode: "apply", ...input }))).receipt;
}
