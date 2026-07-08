/**
 * SDK for the user-defined entity types + instances (Phase B — editable
 * Notion-database tables). Thin typed wrappers over
 * `packages/api/src/routes/doc-entities.ts`, all through `authFetch`.
 *
 * Wire types are declared locally (not imported from `@sidanclaw/core` — the
 * core barrel pulls in `skills/loader`'s `fs`, breaking client bundles; same
 * constraint as `lib/api/views.ts`). The server re-validates every write with
 * `docEntityTypeSchema` / `docEntityInstanceSchema`, so these shapes are
 * deliberately permissive.
 *
 * [COMP:app-web/doc-entities-sdk]
 */

import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type PropertyKind =
  | "text" | "number" | "select" | "multi_select" | "status" | "date"
  | "person" | "relation" | "files" | "checkbox" | "url" | "email" | "phone"
  | "created_time" | "created_by" | "last_edited_time" | "last_edited_by";

export type SelectOption = { id: string; name: string; color?: string };
export type StatusGroup = {
  id: "pending" | "in_progress" | "done";
  label: string;
  options: SelectOption[];
};

/** Per-kind config. Loose — only the fields the table UI sets are typed. */
type PropertyConfig = {
  kind: PropertyKind;
  format?: "int" | "decimal" | "percent" | "dollar" | "comma";
  options?: SelectOption[];
  groups?: StatusGroup[];
  includeTime?: boolean;
  supportRange?: boolean;
};

export type PropertyDef = {
  name: string;
  label?: string;
  config: PropertyConfig;
  required?: boolean;
};

export type EntityType = {
  id: string;
  workspaceId: string;
  name: string;
  icon?: string;
  properties: PropertyDef[];
  schemaVersion: number;
  createdAt: string;
  createdBy: string | null;
};

/** One cell value — `{ kind, value }`, shape per kind (see core CellValue). */
export type CellValue = { kind: PropertyKind; value: unknown };

export type EntityInstance = {
  id: string;
  entityTypeId: string;
  workspaceId: string;
  data: Record<string, CellValue>;
  sourceApp: string;
  createdAt: string;
  createdBy: string | null;
  lastEditedAt: string;
  lastEditedBy: string | null;
};

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ""}`);
  }
  return (await res.json()) as T;
}

function q(workspaceId: string): string {
  return `?workspaceId=${encodeURIComponent(workspaceId)}`;
}

// ── Entity types ───────────────────────────────────────────────────────

export async function getEntityType(
  workspaceId: string,
  entityTypeId: string,
): Promise<EntityType> {
  const res = await authFetch(`${API_URL}/api/entity-types/${entityTypeId}${q(workspaceId)}`);
  return json<EntityType>(res);
}

export async function createEntityType(
  workspaceId: string,
  input: { name: string; icon?: string; properties: PropertyDef[] },
): Promise<EntityType> {
  const res = await authFetch(`${API_URL}/api/entity-types`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId, ...input }),
  });
  return json<EntityType>(res);
}

/** Replace the property list (used by the column "retype" — swap one
 *  property's config in place). */
export async function updateEntityTypeProperties(
  workspaceId: string,
  entityTypeId: string,
  properties: PropertyDef[],
): Promise<EntityType> {
  const res = await authFetch(`${API_URL}/api/entity-types/${entityTypeId}${q(workspaceId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ properties }),
  });
  return json<EntityType>(res);
}

/** Add a column. */
export async function addProperty(
  workspaceId: string,
  entityTypeId: string,
  property: PropertyDef,
): Promise<EntityType> {
  const res = await authFetch(
    `${API_URL}/api/entity-types/${entityTypeId}/properties${q(workspaceId)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ property }),
    },
  );
  return json<EntityType>(res);
}

/** Delete a column (cell values are retained in the JSONB). */
export async function removeProperty(
  workspaceId: string,
  entityTypeId: string,
  name: string,
): Promise<EntityType> {
  const res = await authFetch(
    `${API_URL}/api/entity-types/${entityTypeId}/properties/${encodeURIComponent(name)}${q(workspaceId)}`,
    { method: "DELETE" },
  );
  return json<EntityType>(res);
}

/** Rename a column's KEY (atomic schema + per-row data migration). The table
 *  "Rename" action changes the display label instead (see `updateEntityTypeProperties`). */
export async function renameProperty(
  workspaceId: string,
  entityTypeId: string,
  oldName: string,
  newName: string,
): Promise<EntityType> {
  const res = await authFetch(
    `${API_URL}/api/entity-types/${entityTypeId}/properties/${encodeURIComponent(oldName)}${q(workspaceId)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newName }),
    },
  );
  return json<EntityType>(res);
}

// ── Entity instances (rows) ────────────────────────────────────────────

export async function createEntity(
  workspaceId: string,
  entityTypeId: string,
  data: Record<string, CellValue>,
): Promise<EntityInstance> {
  const res = await authFetch(`${API_URL}/api/entities`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId, entityTypeId, data }),
  });
  return json<EntityInstance>(res);
}

export async function updateEntity(
  workspaceId: string,
  id: string,
  data: Record<string, CellValue>,
): Promise<EntityInstance> {
  const res = await authFetch(`${API_URL}/api/entities/${id}${q(workspaceId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ data }),
  });
  return json<EntityInstance>(res);
}

export async function deleteEntity(workspaceId: string, id: string): Promise<void> {
  const res = await authFetch(`${API_URL}/api/entities/${id}${q(workspaceId)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Slugify a user-typed column name into a unique snake_case property key. */
export function uniquePropertyName(label: string, existing: readonly string[]): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || "field";
  if (!existing.includes(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}_${i}`;
    if (!existing.includes(candidate)) return candidate;
  }
  return `${base}_${existing.length}`;
}
