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

export async function createContextTeam(
  workspaceId: string,
  input: { name: string; key: string; description?: string | null; color?: string | null },
): Promise<ContextTeam> {
  const body = await json<{ group: ContextTeam }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/groups`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) },
  );
  return body.group;
}

export async function getContextTeam(
  workspaceId: string,
  teamId: string,
): Promise<ContextTeam> {
  const body = await json<{ group: ContextTeam }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/groups/${encodeURIComponent(teamId)}`,
  );
  return body.group;
}

export async function updateContextTeam(
  workspaceId: string,
  teamId: string,
  input: { name?: string; description?: string | null; color?: string | null },
): Promise<ContextTeam> {
  const body = await json<{ group: ContextTeam }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/groups/${encodeURIComponent(teamId)}`,
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) },
  );
  return body.group;
}

export async function setContextTeamMember(
  workspaceId: string,
  teamId: string,
  userId: string,
  enabled: boolean,
): Promise<void> {
  await json(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/groups/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`,
    enabled
      ? { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ activateAssigned: true }) }
      : { method: "DELETE" },
  );
}

export async function setContextTeamAssistant(
  workspaceId: string,
  teamId: string,
  assistantId: string,
  enabled: boolean,
): Promise<void> {
  await json(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/groups/${encodeURIComponent(teamId)}/assistants/${encodeURIComponent(assistantId)}`,
    { method: enabled ? "PUT" : "DELETE" },
  );
}

export async function setTeamReadGrants(
  workspaceId: string,
  teamId: string,
  input: { readAll: boolean; groupIds: string[] },
): Promise<void> {
  await json(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/groups/${encodeURIComponent(teamId)}/read-grants`,
    { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) },
  );
}

export async function archiveContextTeam(workspaceId: string, teamId: string): Promise<void> {
  await json(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/groups/${encodeURIComponent(teamId)}/archive`,
    { method: "POST" },
  );
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
  input: { name: string; description?: string | null; icon?: string | null },
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

export async function updateAssistantContext(
  workspaceId: string,
  assistantId: string,
  context: Omit<AssistantContextConfig, "teamMode"> & { teamMode: "all" | "assigned" },
): Promise<void> {
  await json(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/assistants/${encodeURIComponent(assistantId)}/context`,
    { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(context) },
  );
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
): Promise<{ contextGroupId: string | null; contextProjectId: string | null }> {
  const body = await json<{ context: { contextGroupId: string | null; contextProjectId: string | null } }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/connectors/${encodeURIComponent(instanceId)}/context`,
  );
  return body.context;
}

export async function updateConnectorContext(
  workspaceId: string,
  instanceId: string,
  context: { contextGroupId: string | null; contextProjectId: string | null },
): Promise<void> {
  await json(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/connectors/${encodeURIComponent(instanceId)}/context`,
    { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(context) },
  );
}
