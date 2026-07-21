/**
 * SDK for the model selection surfaces (model-registry.md L10/L15):
 * per-class menus, metered profiles CRUD, and the metered pre-flight
 * estimate. Thin typed wrappers over `packages/api/src/routes/model-menu.ts`;
 * all calls go through `authFetch`.
 *
 * [COMP:app-web/models-sdk]
 */

import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type MenuModel = {
  alias: string;
  class: string;
  provider: string;
  contextWindow: number;
  capabilities: { tools: boolean; vision: boolean; thinking: boolean };
  metered: boolean;
};

export type MeteredProfile = {
  id: string;
  workspaceId: string;
  name: string;
  modelAlias: string;
  toolRounds: number;
  thinking: boolean | null;
};

export type WorkspaceModelDefault = {
  workspaceId: string;
  modelClass: "standard-pro" | "max" | "research";
  modelAlias: string | null;
  meteredProfileId: string | null;
  updatedAt: string;
};

export type ModelMenu = {
  classes: Record<string, MenuModel[]>;
  profiles: MeteredProfile[];
  defaults: WorkspaceModelDefault[];
  meteredBillingAvailable: boolean;
};

export type MeteredEstimate = {
  modelAlias: string;
  toolRounds: number;
  minCredits: number;
  maxCredits: number;
};

export async function fetchModelMenu(workspaceId: string): Promise<ModelMenu> {
  const res = await authFetch(`${API_URL}/api/models/menu?workspaceId=${encodeURIComponent(workspaceId)}`);
  if (!res.ok) throw new Error(`model menu failed (${res.status})`);
  return (await res.json()) as ModelMenu;
}

export async function fetchMeteredEstimate(
  workspaceId: string,
  modelAlias: string,
  toolRounds: number,
): Promise<MeteredEstimate | null> {
  const res = await authFetch(`${API_URL}/api/models/metered-estimate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId, modelAlias, toolRounds }),
  });
  if (!res.ok) throw new Error(`estimate failed (${res.status})`);
  return ((await res.json()) as { estimate: MeteredEstimate | null }).estimate;
}

export async function createMeteredProfile(
  workspaceId: string,
  params: { name: string; modelAlias: string; toolRounds: number; thinking?: boolean | null },
): Promise<MeteredProfile> {
  const res = await authFetch(`${API_URL}/api/workspaces/${workspaceId}/metered-profiles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `profile create failed (${res.status})`);
  }
  return ((await res.json()) as { profile: MeteredProfile }).profile;
}

export async function updateMeteredProfile(
  workspaceId: string,
  id: string,
  params: { name?: string; toolRounds?: number; thinking?: boolean | null },
): Promise<MeteredProfile> {
  const res = await authFetch(`${API_URL}/api/workspaces/${workspaceId}/metered-profiles/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`profile update failed (${res.status})`);
  return ((await res.json()) as { profile: MeteredProfile }).profile;
}

export async function deleteMeteredProfile(workspaceId: string, id: string): Promise<void> {
  const res = await authFetch(`${API_URL}/api/workspaces/${workspaceId}/metered-profiles/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`profile delete failed (${res.status})`);
}

export async function setWorkspaceModelDefault(
  workspaceId: string,
  modelClass: WorkspaceModelDefault["modelClass"],
  target: { modelAlias: string } | { meteredProfileId: string },
): Promise<WorkspaceModelDefault> {
  const res = await authFetch(`${API_URL}/api/workspaces/${workspaceId}/model-defaults/${modelClass}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(target),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `default update failed (${res.status})`);
  }
  return ((await res.json()) as { default: WorkspaceModelDefault }).default;
}

export async function clearWorkspaceModelDefault(
  workspaceId: string,
  modelClass: WorkspaceModelDefault["modelClass"],
): Promise<void> {
  const res = await authFetch(`${API_URL}/api/workspaces/${workspaceId}/model-defaults/${modelClass}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `default clear failed (${res.status})`);
  }
}
