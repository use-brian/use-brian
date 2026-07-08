/**
 * Typed write helpers for the Notion-feel data block (Phase 2 + Phase 3).
 *
 * The renderer's `Editor` modules fire `onCommit(next)`, which the host
 * (block-data.tsx) translates into an `onAction('cell-update', …)` call.
 * That handler — plus the Phase-3 `row-add` / `row-delete` / board
 * `move-card` actions — hits one of these helpers, each of which maps to
 * a route exposed by `packages/api/src/routes/views.ts`:
 *
 *   - `patchEntity`  → `PATCH  /api/<entity>/<id>`   (inline cell edit + move-card)
 *   - `createEntity` → `POST   /api/<entity>`         ("+ Add row")
 *   - `deleteEntity` → `DELETE /api/<entity>/<id>`    (row-menu "Delete row")
 *
 * The patch / create shape is intentionally permissive
 * (`Record<string, unknown>`) because the server re-validates with Zod at
 * the route boundary; the UI doesn't need to mirror every field type. The
 * host translates widget-shaped commit values (e.g. PersonWidget →
 * `{ assigneeId: id }`) before calling these.
 *
 * Spec: docs/architecture/features/views.md § Phase 2 + § Phase 3.
 *
 * [COMP:app-web/block-data]
 */

import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type EntityKind = "tasks" | "deals" | "contacts" | "companies";

type PatchEntitySuccess = {
  ok: true;
  row: Record<string, unknown>;
};

type PatchEntityFailure = {
  ok: false;
  error: string;
};

export type PatchEntityResult = PatchEntitySuccess | PatchEntityFailure;

export async function patchEntity(opts: {
  entity: EntityKind;
  id: string;
  patch: Record<string, unknown>;
}): Promise<PatchEntityResult> {
  try {
    const res = await authFetch(`${API_URL}/api/${opts.entity}/${opts.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(opts.patch),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        error: `HTTP ${res.status}${text ? `: ${text}` : ""}`,
      };
    }
    const row = (await res.json()) as Record<string, unknown>;
    return { ok: true, row };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

type CreateEntitySuccess = {
  ok: true;
  row: Record<string, unknown>;
};

export type CreateEntityResult = CreateEntitySuccess | PatchEntityFailure;

/**
 * Create a new row of `entity` in `workspaceId`. The "+ Add row"
 * affordance fires this with the entity's minimal required defaults
 * (e.g. a placeholder title for tasks); the server fills the rest from
 * the frozen-v1 column defaults. Returns the created row so the host can
 * refetch (or, later, optimistically insert) the resolved view payload.
 */
export async function createEntity(opts: {
  entity: EntityKind;
  workspaceId: string;
  values: Record<string, unknown>;
}): Promise<CreateEntityResult> {
  try {
    const res = await authFetch(`${API_URL}/api/${opts.entity}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: opts.workspaceId, ...opts.values }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        error: `HTTP ${res.status}${text ? `: ${text}` : ""}`,
      };
    }
    const row = (await res.json()) as Record<string, unknown>;
    return { ok: true, row };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

type DeleteEntitySuccess = { ok: true };
export type DeleteEntityResult = DeleteEntitySuccess | PatchEntityFailure;

/**
 * Soft-delete a row (bi-temporal `valid_to = now()` via the D.4
 * universal soft-delete contract — the same path `deleteBrainRow` uses).
 * `workspaceId` is required: the soft-delete repository reads the row by
 * `(workspace_id, id)` before closing it, so the caller must scope the
 * delete to the active workspace it is rendering.
 */
export async function deleteEntity(opts: {
  entity: EntityKind;
  id: string;
  workspaceId: string;
}): Promise<DeleteEntityResult> {
  try {
    const url = new URL(`${API_URL}/api/${opts.entity}/${opts.id}`);
    url.searchParams.set("workspaceId", opts.workspaceId);
    const res = await authFetch(url.toString(), { method: "DELETE" });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        error: `HTTP ${res.status}${text ? `: ${text}` : ""}`,
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
