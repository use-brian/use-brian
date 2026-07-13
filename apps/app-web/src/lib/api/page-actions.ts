/**
 * SDK for page-action buttons (mig 321) — the page-header button strip and
 * the blueprint editor's Actions section.
 *
 *   GET    /api/pages/:pageId/actions
 *   POST   /api/pages/:pageId/actions/:actionId/invoke
 *   GET    /api/page-actions?workspaceId=&blueprintId=
 *   POST   /api/page-actions
 *   PATCH  /api/page-actions/:id
 *   DELETE /api/page-actions/:id
 *
 * Spec: docs/architecture/features/page-actions.md.
 */

import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/** Mirrors `PageActionSpec` in `packages/core/src/doc/page-action-types.ts`. */
export type PageActionSpec =
  | { kind: "workflow"; workflowId: string; vars?: Record<string, unknown> }
  | { kind: "goal"; outcome?: string; note?: string };

export type PageActionRow = {
  id: string;
  workspaceId: string;
  blueprintId: string | null;
  pageId: string | null;
  label: string;
  icon: string | null;
  confirmCopy: string | null;
  action: PageActionSpec;
  enabled: boolean;
  position: number;
  updatedAt: string;
};

export type InvokeResult =
  | {
      kind: "workflow";
      runId: string;
      workflowId: string;
      status: "completed" | "failed" | "paused";
      finalOutput: unknown;
      error: { message: string; reason?: string } | null;
    }
  | { kind: "goal"; goalId: string; outcome: string };

export async function listPageActions(pageId: string): Promise<PageActionRow[]> {
  const res = await authFetch(
    `${API_URL}/api/pages/${encodeURIComponent(pageId)}/actions`,
  );
  if (!res.ok) return [];
  const data = (await res.json()) as { actions?: PageActionRow[] };
  return Array.isArray(data.actions) ? data.actions : [];
}

export async function invokePageAction(
  pageId: string,
  actionId: string,
): Promise<{ ok: true; result: InvokeResult } | { ok: false; error: string }> {
  const res = await authFetch(
    `${API_URL}/api/pages/${encodeURIComponent(pageId)}/actions/${encodeURIComponent(actionId)}/invoke`,
    { method: "POST" },
  );
  const data = (await res.json().catch(() => null)) as
    | (InvokeResult & { error?: string })
    | { error?: string }
    | null;
  if (!res.ok || !data || !("kind" in data)) {
    return { ok: false, error: (data && "error" in data && data.error) || `HTTP ${res.status}` };
  }
  return { ok: true, result: data as InvokeResult };
}

export async function listBlueprintPageActions(
  workspaceId: string,
  blueprintId: string,
): Promise<PageActionRow[]> {
  const q = new URLSearchParams({ workspaceId, blueprintId });
  const res = await authFetch(`${API_URL}/api/page-actions?${q.toString()}`);
  if (!res.ok) return [];
  const data = (await res.json()) as { actions?: PageActionRow[] };
  return Array.isArray(data.actions) ? data.actions : [];
}

export async function createPageAction(input: {
  workspaceId: string;
  scope: { blueprintId: string } | { pageId: string };
  label: string;
  icon?: string;
  confirmCopy?: string;
  action: PageActionSpec;
  position?: number;
}): Promise<{ ok: true; action: PageActionRow } | { ok: false; error: string }> {
  const res = await authFetch(`${API_URL}/api/page-actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = (await res.json().catch(() => null)) as (PageActionRow & { error?: string }) | null;
  if (!res.ok || !data || !data.id) {
    return { ok: false, error: data?.error || `HTTP ${res.status}` };
  }
  return { ok: true, action: data };
}

export async function updatePageAction(
  id: string,
  patch: Partial<{
    label: string;
    icon: string | null;
    confirmCopy: string | null;
    action: PageActionSpec;
    enabled: boolean;
    position: number;
  }>,
): Promise<{ ok: true; action: PageActionRow } | { ok: false; error: string }> {
  const res = await authFetch(`${API_URL}/api/page-actions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const data = (await res.json().catch(() => null)) as (PageActionRow & { error?: string }) | null;
  if (!res.ok || !data || !data.id) {
    return { ok: false, error: data?.error || `HTTP ${res.status}` };
  }
  return { ok: true, action: data };
}

export async function deletePageAction(id: string): Promise<boolean> {
  const res = await authFetch(`${API_URL}/api/page-actions/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  return res.ok;
}
