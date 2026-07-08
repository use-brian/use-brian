/**
 * OAuth authorizations client (app-web) — Studio Programmatic Access
 * "Connected apps".
 *
 * Ported from `apps/web/src/lib/api/oauth-authorizations.ts` as part of the
 * studio surface migration (docs/architecture/features/doc.md §9 #5).
 * Lists and revokes the OAuth grants third-party MCP clients (Claude.ai,
 * Claude Desktop, ChatGPT) have against this workspace's brain. Identical wire
 * contract; kept as its own file (not imported from apps/web), same convention
 * as `lib/api/brain-keys.ts` / `lib/api/studio.ts`.
 *
 * Spec: docs/architecture/features/programmatic-access.md.
 */

import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type OAuthAuthorization = {
  id: string;
  clientId: string;
  clientName: string | null;
  clientUri: string | null;
  scope: "read" | "read_write";
  status: "active" | "revoked";
  createdAt: string;
  lastUsedAt: string | null;
};

function base(workspaceId: string): string {
  return `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/oauth-authorizations`;
}

export async function listOAuthAuthorizations(
  workspaceId: string,
): Promise<OAuthAuthorization[]> {
  const res = await authFetch(base(workspaceId));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { authorizations?: OAuthAuthorization[] };
  return Array.isArray(data.authorizations) ? data.authorizations : [];
}

export async function revokeOAuthAuthorization(
  workspaceId: string,
  id: string,
): Promise<void> {
  const res = await authFetch(`${base(workspaceId)}/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
}
