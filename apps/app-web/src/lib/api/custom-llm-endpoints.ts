import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type CustomLlmEndpoint = {
  id: string;
  workspaceId: string;
  selector: string;
  name: string;
  baseUrl: string;
  modelId: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsTools: boolean;
  verifiedAt: string;
  isDefault: boolean;
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CustomLlmEndpointInput = {
  name: string;
  baseUrl: string;
  apiKey?: string | null;
  modelId: string;
  contextWindow: number;
  maxOutputTokens: number;
  isDefault?: boolean;
};

export class CustomLlmEndpointsUnavailableError extends Error {}

async function responseError(res: Response, fallback: string): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
  const error = new Error(body?.error ?? fallback) as Error & { code?: string };
  error.code = body?.code;
  return error;
}

export async function listCustomLlmEndpoints(workspaceId: string): Promise<CustomLlmEndpoint[]> {
  const res = await authFetch(`${API_URL}/api/workspaces/${workspaceId}/custom-llm-endpoints`);
  if (res.status === 404) throw new CustomLlmEndpointsUnavailableError();
  if (!res.ok) throw await responseError(res, `endpoint list failed (${res.status})`);
  return ((await res.json()) as { endpoints: CustomLlmEndpoint[] }).endpoints;
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

export async function deleteCustomLlmEndpoint(workspaceId: string, endpointId: string): Promise<void> {
  const res = await authFetch(`${API_URL}/api/workspaces/${workspaceId}/custom-llm-endpoints/${endpointId}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) throw await responseError(res, `endpoint delete failed (${res.status})`);
}

export async function setCustomLlmEndpointDefault(
  workspaceId: string,
  endpointId: string,
): Promise<void> {
  const res = await authFetch(`${API_URL}/api/workspaces/${workspaceId}/custom-llm-endpoints/${endpointId}/default`, {
    method: "PUT",
  });
  if (!res.ok) throw await responseError(res, `endpoint default failed (${res.status})`);
}

export async function clearCustomLlmEndpointDefault(workspaceId: string): Promise<void> {
  const res = await authFetch(`${API_URL}/api/workspaces/${workspaceId}/custom-llm-endpoints/default`, {
    method: "DELETE",
  });
  if (!res.ok) throw await responseError(res, `endpoint default clear failed (${res.status})`);
}
