/**
 * Workspace LLM provider key (BYO) API client (app-web).
 *
 * Wraps the workspace-scoped `/api/workspaces/:workspaceId/llm-keys` CRUD that
 * stores a workspace's own Gemini API key (bring-your-own-key). The endpoint
 * NEVER returns the raw key — only a masked status ({ provider, isSet, last4 }).
 * Follows the same client/auth pattern as `lib/api/brain-keys.ts`.
 *
 * Owner/admin gated server-side: a 403 surfaces a "not available" state in the
 * UI; a 404 (BYO not configured on the server) degrades the same way.
 */
import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/** Masked key status — the only key info the server ever returns. */
export type LlmKeyStatus = {
  provider: "gemini";
  isSet: boolean;
  /** Last 4 chars of the stored key, or null when no key is set. */
  last4: string | null;
};

/** Signals the BYO endpoint is unavailable to this caller (404/403) so the UI
 *  can degrade to a disabled "not available" state instead of erroring out. */
export class LlmKeyUnavailableError extends Error {
  constructor(public readonly status: number) {
    super(`llm-keys unavailable (HTTP ${status})`);
    this.name = "LlmKeyUnavailableError";
  }
}

function base(workspaceId: string): string {
  return `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/llm-keys`;
}

/** Throws LlmKeyUnavailableError on 404/403; a generic Error otherwise. */
function assertAvailable(status: number): void {
  if (status === 404 || status === 403) throw new LlmKeyUnavailableError(status);
  throw new Error(`HTTP ${status}`);
}

export async function getLlmKeyStatus(workspaceId: string): Promise<LlmKeyStatus> {
  const res = await authFetch(base(workspaceId));
  if (!res.ok) assertAvailable(res.status);
  return (await res.json()) as LlmKeyStatus;
}

export async function setLlmKey(
  workspaceId: string,
  apiKey: string,
): Promise<LlmKeyStatus> {
  const res = await authFetch(base(workspaceId), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
  if (!res.ok) {
    if (res.status === 404 || res.status === 403) throw new LlmKeyUnavailableError(res.status);
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as LlmKeyStatus;
}

export async function deleteLlmKey(workspaceId: string): Promise<void> {
  const res = await authFetch(base(workspaceId), { method: "DELETE" });
  // 204 = removed, 404 = already gone — both leave the workspace key unset.
  if (!res.ok && res.status !== 404) {
    if (res.status === 403) throw new LlmKeyUnavailableError(res.status);
    throw new Error(`HTTP ${res.status}`);
  }
}
