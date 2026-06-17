/**
 * Brain key API client (app-web).
 *
 * Ported verbatim from `apps/web/src/lib/api/brain-keys.ts` as part of the
 * brain surface migration (docs/plans/doc-web-app-consolidation.md
 * §5a). Wraps the workspace-scoped
 * `/api/workspaces/:workspaceId/brain-keys` CRUD that backs the brain MCP
 * server's credentials. Used by the brain empty-state "Connect via MCP"
 * card. Identical wire contract; imports already resolve in app-web.
 *
 * Spec: docs/architecture/features/programmatic-access.md.
 */
import { authFetch } from "@/lib/auth-fetch";
import { DISPLAY_API_URL } from "@/lib/display-api-url";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/** The brain MCP endpoint an external client connects to — displayed/copied,
 *  so it uses the absolute origin (see lib/display-api-url.ts). */
export const BRAIN_MCP_URL = `${DISPLAY_API_URL}/api/brain/mcp`;

export type BrainKeyScope = "read" | "read_write";

/** Sensitivity tiers a key's effective clearance can be capped to. */
export type BrainKeyClearance = "public" | "internal" | "confidential";

export type BrainKey = {
  id: string;
  name: string;
  prefix: string;
  scope: BrainKeyScope;
  status: "active" | "revoked";
  /**
   * Clearance cap (migration 262). The key's effective clearance is
   * min(primary assistant's clearance, this cap). `null` = no cap — the
   * primary assistant's clearance governs.
   */
  maxClearance: BrainKeyClearance | null;
  createdAt: string;
  lastUsedAt: string | null;
};

/** A freshly created key — carries the plaintext, returned exactly once. */
export type CreatedBrainKey = BrainKey & { key: string };

function base(workspaceId: string): string {
  return `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/brain-keys`;
}

export async function listBrainKeys(workspaceId: string): Promise<BrainKey[]> {
  const res = await authFetch(base(workspaceId));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { keys?: BrainKey[] };
  return Array.isArray(data.keys) ? data.keys : [];
}

export async function createBrainKey(
  workspaceId: string,
  params: { name: string; scope: BrainKeyScope; maxClearance?: BrainKeyClearance | null },
): Promise<CreatedBrainKey> {
  const res = await authFetch(base(workspaceId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as CreatedBrainKey;
}

export async function updateBrainKeyMaxClearance(
  workspaceId: string,
  keyId: string,
  maxClearance: BrainKeyClearance | null,
): Promise<void> {
  const res = await authFetch(`${base(workspaceId)}/${encodeURIComponent(keyId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maxClearance }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
}

export async function revokeBrainKey(
  workspaceId: string,
  keyId: string,
): Promise<void> {
  const res = await authFetch(`${base(workspaceId)}/${encodeURIComponent(keyId)}`, {
    method: "DELETE",
  });
  // 204 = revoked, 404 = already gone — both leave the key inactive.
  if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
}
