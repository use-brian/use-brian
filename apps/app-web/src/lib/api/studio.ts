/**
 * Studio SDK (app-web).
 *
 * Ported from `apps/web/src/lib/api/studio.ts` (app consolidation §5a /
 * §9 #5). Originally trimmed to `listAssistants` (which backs the approvals
 * assistant-filter labels); extended for the Studio → Assistants surface
 * migration with `createAssistant`. Identical wire contract —
 * `GET /api/assistants?workspaceId=` scopes server-side, so the response
 * already contains only this workspace's assistants. Kept as its own file
 * (not imported from apps/web), same convention as `lib/api/views.ts` /
 * `lib/api/approvals.ts`.
 *
 * The full per-assistant config surface (`<AssistantDetail>` and its tabs)
 * calls `authFetch` against `/api/assistants/:id/*` directly rather than
 * routing every endpoint through this SDK, mirroring apps/web — only the
 * shared rail concerns (list + create) live here.
 */

import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type StudioAssistantSummary = {
  id: string;
  name: string;
  workspaceId: string | null;
  channels: string[];
  clearance?: string | null;
  iconSeed?: number | null;
};

export async function listAssistants(
  workspaceId: string,
): Promise<StudioAssistantSummary[]> {
  // `?workspaceId=` scopes the list server-side, so the response already
  // contains only this workspace's assistants — no client-side filter.
  // The endpoint omits `channels` / `clearance`, so normalise to the SDK
  // contract here so consumers don't crash on undefined.
  const res = await authFetch(
    `${API_URL}/api/assistants?workspaceId=${encodeURIComponent(workspaceId)}`,
  );
  if (!res.ok) return [];
  const data = (await res.json()) as {
    assistants?: Array<
      Partial<StudioAssistantSummary> & { id: string; name: string }
    >;
  };
  if (!Array.isArray(data.assistants)) return [];
  return data.assistants.map(normalizeAssistant);
}

/**
 * Whether the signed-in account has at least one CONNECTED connector. Drives
 * the Studio cold-start nudge in the persistent sidebar (`WorkspaceChrome`):
 * an empty connector set ≈ setup incomplete. Reads the same
 * `GET /api/connectors` list the Studio → Connectors page uses (rows carry a
 * `connected: boolean`), so the signal is a real workspace-account state, not a
 * proxy. Returns `true` defensively on any fetch error so a transient API blip
 * never *shows* the nudge to an already-set-up user (the nudge is opt-out, so
 * the safe default is "assume set up").
 */
export async function hasAnyConnectedConnector(): Promise<boolean> {
  try {
    const res = await authFetch(`${API_URL}/api/connectors`);
    if (!res.ok) return true;
    const data = (await res.json()) as {
      connectors?: Array<{ connected?: boolean }>;
    };
    if (!Array.isArray(data.connectors)) return true;
    return data.connectors.some((c) => c.connected === true);
  } catch {
    return true;
  }
}

function normalizeAssistant(
  a: Partial<StudioAssistantSummary> & { id: string; name: string },
): StudioAssistantSummary {
  return {
    id: a.id,
    name: a.name,
    workspaceId: a.workspaceId ?? null,
    channels: Array.isArray(a.channels) ? a.channels : [],
    clearance: a.clearance ?? null,
    iconSeed: typeof a.iconSeed === "number" ? a.iconSeed : null,
  };
}

/**
 * Create a standard assistant in the given workspace. Used by the Studio
 * Assistants rail's "New assistant" action. Throws with the server's error
 * message on failure so the caller can surface it inline.
 */
export async function createAssistant(
  workspaceId: string,
  name: string,
): Promise<StudioAssistantSummary> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${workspaceId}/assistants`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    },
  );
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };
    throw new Error(err.message ?? err.error ?? `Create failed (${res.status})`);
  }
  const created = (await res.json()) as Partial<StudioAssistantSummary> & {
    id: string;
    name: string;
  };
  return normalizeAssistant({
    ...created,
    workspaceId: created.workspaceId ?? workspaceId,
  });
}
