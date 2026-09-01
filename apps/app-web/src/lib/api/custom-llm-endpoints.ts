import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type CustomLlmTier = "standard" | "pro" | "max" | "research";

export type CustomLlmProfile = {
  id: string;
  endpointId: string;
  workspaceId: string;
  selector: string;
  name: string;
  modelId: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsTools: boolean;
  /**
   * Probe-verified image support. False means an image turn on this profile is
   * answered by a built-in model instead (announced), so the settings row says
   * "Text only" and re-saving the profile re-runs the probe.
   */
  supportsVision: boolean;
  verifiedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type CustomLlmEndpoint = {
  id: string;
  workspaceId: string;
  name: string;
  baseUrl: string;
  hasApiKey: boolean;
  /**
   * Admin opt-in: when this endpoint fails, the turn is answered by the
   * built-in model the tier would otherwise have used, and the reader is told
   * it happened. Off by default, because turning it on sends workspace
   * content to a provider the admin did not originally pick and bills the
   * fallback turn as ordinary platform usage.
   */
  fallbackToDefaultOnFailure: boolean;
  createdAt: string;
  updatedAt: string;
  profiles: CustomLlmProfile[];
};

export type CustomLlmTierDefault = {
  workspaceId: string;
  tier: CustomLlmTier;
  profileId: string;
  updatedAt: string;
};

export type CustomLlmEndpointInput = {
  name: string;
  baseUrl: string;
  apiKey?: string | null;
  modelId: string;
  contextWindow: number;
  maxOutputTokens: number;
};

export type CustomLlmProfileInput = {
  name: string;
  modelId: string;
  contextWindow: number;
  maxOutputTokens: number;
};

export class CustomLlmEndpointsUnavailableError extends Error {}

async function responseError(res: Response, fallback: string): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
  const error = new Error(body?.error ?? fallback) as Error & { code?: string };
  error.code = body?.code;
  return error;
}

export async function getCustomLlmConfiguration(workspaceId: string): Promise<{
  endpoints: CustomLlmEndpoint[];
  tierDefaults: CustomLlmTierDefault[];
}> {
  const res = await authFetch(`${API_URL}/api/workspaces/${workspaceId}/custom-llm-endpoints`);
  if (res.status === 404) throw new CustomLlmEndpointsUnavailableError();
  if (!res.ok) throw await responseError(res, `endpoint list failed (${res.status})`);
  return (await res.json()) as { endpoints: CustomLlmEndpoint[]; tierDefaults: CustomLlmTierDefault[] };
}

export async function listCustomLlmEndpoints(workspaceId: string): Promise<CustomLlmEndpoint[]> {
  return (await getCustomLlmConfiguration(workspaceId)).endpoints;
}

export async function createCustomLlmEndpoint(
  workspaceId: string,
  input: CustomLlmEndpointInput,
): Promise<CustomLlmEndpoint> {
  const res = await authFetch(`${API_URL}/api/workspaces/${workspaceId}/custom-llm-endpoints`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 404) throw new CustomLlmEndpointsUnavailableError();
  if (!res.ok) throw await responseError(res, `endpoint create failed (${res.status})`);
  return ((await res.json()) as { endpoint: CustomLlmEndpoint }).endpoint;
}

export async function createCustomLlmProfile(
  workspaceId: string,
  endpointId: string,
  input: CustomLlmProfileInput,
): Promise<CustomLlmProfile> {
  const res = await authFetch(`${API_URL}/api/workspaces/${workspaceId}/custom-llm-endpoints/${endpointId}/profiles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await responseError(res, `profile create failed (${res.status})`);
  return ((await res.json()) as { profile: CustomLlmProfile }).profile;
}

export async function updateCustomLlmProfile(
  workspaceId: string,
  endpointId: string,
  profileId: string,
  input: CustomLlmProfileInput,
): Promise<CustomLlmProfile> {
  const res = await authFetch(`${API_URL}/api/workspaces/${workspaceId}/custom-llm-endpoints/${endpointId}/profiles/${profileId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await responseError(res, `profile update failed (${res.status})`);
  return ((await res.json()) as { profile: CustomLlmProfile }).profile;
}

export async function deleteCustomLlmProfile(
  workspaceId: string,
  endpointId: string,
  profileId: string,
): Promise<void> {
  const res = await authFetch(`${API_URL}/api/workspaces/${workspaceId}/custom-llm-endpoints/${endpointId}/profiles/${profileId}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) throw await responseError(res, `profile delete failed (${res.status})`);
}

export async function deleteCustomLlmEndpoint(workspaceId: string, endpointId: string): Promise<void> {
  const res = await authFetch(`${API_URL}/api/workspaces/${workspaceId}/custom-llm-endpoints/${endpointId}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) throw await responseError(res, `endpoint delete failed (${res.status})`);
}

export async function setCustomLlmFallbackPolicy(
  workspaceId: string,
  endpointId: string,
  fallbackToDefaultOnFailure: boolean,
): Promise<CustomLlmEndpoint> {
  const res = await authFetch(`${API_URL}/api/workspaces/${workspaceId}/custom-llm-endpoints/${endpointId}/fallback`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fallbackToDefaultOnFailure }),
  });
  if (!res.ok) throw await responseError(res, `fallback update failed (${res.status})`);
  return ((await res.json()) as { endpoint: CustomLlmEndpoint }).endpoint;
}

export async function setCustomLlmTierDefault(
  workspaceId: string,
  tier: CustomLlmTier,
  profileId: string,
): Promise<CustomLlmTierDefault> {
  const res = await authFetch(`${API_URL}/api/workspaces/${workspaceId}/custom-llm-endpoints/tiers/${tier}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profileId }),
  });
  if (!res.ok) throw await responseError(res, `tier update failed (${res.status})`);
  return ((await res.json()) as { tierDefault: CustomLlmTierDefault }).tierDefault;
}

export async function clearCustomLlmTierDefault(workspaceId: string, tier: CustomLlmTier): Promise<void> {
  const res = await authFetch(`${API_URL}/api/workspaces/${workspaceId}/custom-llm-endpoints/tiers/${tier}`, {
    method: "DELETE",
  });
  if (!res.ok) throw await responseError(res, `tier clear failed (${res.status})`);
}
