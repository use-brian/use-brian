/**
 * SDK for the Brain inbox (app-web) — workspace-scoped verification
 * surface across every brain primitive carrying the universal
 * `verified_by_user_id` column.
 *
 * Ported verbatim from `apps/web/src/lib/api/brain-inbox.ts` as part of
 * the brain surface migration (docs/plans/doc-web-app-consolidation.md
 * §5a). Identical wire contract — only the doc header differs; the
 * imports (`@/lib/auth-fetch`, `NEXT_PUBLIC_API_URL`) already resolve in
 * app-web.
 *
 * Spec: docs/architecture/brain/corrections.md.
 *
 * Routes backed:
 *   GET    /api/brain-inbox/:workspaceId[?primitive=memory|entity|...]
 *   GET    /api/brain-inbox/:workspaceId/count
 *   GET    /api/brain-inbox/:workspaceId/:primitive/:rowId — single-row detail (incl. verified)
 *   POST   /api/brain-inbox/:workspaceId/:primitive/:rowId/verify
 *   POST   /api/brain-inbox/:workspaceId/:primitive/:rowId/adjust (memory only in v1)
 *   DELETE /api/brain-inbox/:workspaceId/:primitive/:rowId
 *   GET    /api/brain-inbox/:workspaceId/:primitive/:rowId/explain
 *   POST   /api/brain-inbox/:workspaceId/:primitive/:rowId/inspection-session
 */

import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type BrainPrimitive =
  | "memory"
  | "entity"
  | "entity_link"
  | "task"
  | "contact"
  | "company"
  | "deal"
  | "workspace_file";

/** A row in the brain inbox. `body` is shaped per primitive — consumers
 *  branch on `primitive` to read the right fields. */
export type BrainInboxRow = {
  primitive: BrainPrimitive;
  id: string;
  workspaceId: string;
  createdAt: string;
  createdByAssistantId: string | null;
  body: Record<string, unknown>;
};

export type ListBrainInboxResult = {
  rows: BrainInboxRow[];
  cursor: string | null;
};

export type BrainInboxCounts = {
  total: number;
  byPrimitive: Record<BrainPrimitive, number>;
};

/** Paginated unverified-row list. Optional primitive filter. */
export async function listBrainInbox(
  workspaceId: string,
  options?: {
    primitive?: BrainPrimitive;
    cursor?: string;
    limit?: number;
    /** Surface Pipeline B extracted rows (source='extracted') in addition to
     *  chat-tool saves (source='model'). Default false — see docs/architecture/brain/corrections.md. */
    includeExtracted?: boolean;
  },
): Promise<ListBrainInboxResult> {
  const q = new URLSearchParams();
  q.set("limit", String(options?.limit ?? 20));
  if (options?.primitive) q.set("primitive", options.primitive);
  if (options?.cursor) q.set("cursor", options.cursor);
  if (options?.includeExtracted) q.set("includeExtracted", "true");
  const res = await authFetch(
    `${API_URL}/api/brain-inbox/${encodeURIComponent(workspaceId)}?${q.toString()}`,
  );
  if (!res.ok) return { rows: [], cursor: null };
  const data = (await res.json()) as Partial<ListBrainInboxResult>;
  return {
    rows: Array.isArray(data.rows) ? data.rows : [],
    cursor: typeof data.cursor === "string" ? data.cursor : null,
  };
}

/** Detail-shape row from `GET /:workspaceId/:primitive/:rowId`. Same
 *  body as a list row, plus verified-state fields so the detail page
 *  can render a "Verified" banner instead of disappearing after the
 *  user clicks Confirm. */
export type BrainInboxRowDetail = BrainInboxRow & {
  verifiedByUserId: string | null;
  verifiedAt: string | null;
};

/** Fetch a single brain row for the per-primitive detail page. Returns
 *  null on 404 (row missing, soft-deleted, or wrong workspace) so the
 *  caller can render a graceful "already actioned" empty state. */
export async function fetchBrainRow(
  workspaceId: string,
  primitive: BrainPrimitive,
  rowId: string,
): Promise<BrainInboxRowDetail | null> {
  const res = await authFetch(
    `${API_URL}/api/brain-inbox/${encodeURIComponent(workspaceId)}/${primitive}/${encodeURIComponent(rowId)}`,
  );
  if (!res.ok) return null;
  return (await res.json()) as BrainInboxRowDetail;
}

/** Total + per-primitive counts. Drives the chrome pill (total) and
 *  the page header primitive-filter chips (per-primitive). The chrome
 *  pill MUST call without includeExtracted so it stays quiet; the page
 *  passes whatever the user toggled. */
export async function brainInboxCount(
  workspaceId: string,
  options?: { includeExtracted?: boolean },
): Promise<BrainInboxCounts> {
  const q = new URLSearchParams();
  if (options?.includeExtracted) q.set("includeExtracted", "true");
  const qs = q.toString();
  const res = await authFetch(
    `${API_URL}/api/brain-inbox/${encodeURIComponent(workspaceId)}/count${qs ? `?${qs}` : ""}`,
  );
  if (!res.ok) {
    return {
      total: 0,
      byPrimitive: {
        memory: 0,
        entity: 0,
        entity_link: 0,
        task: 0,
        contact: 0,
        company: 0,
        deal: 0,
        workspace_file: 0,
      },
    };
  }
  return (await res.json()) as BrainInboxCounts;
}

/** Confirm a row as-is. Generic across primitives. */
export async function verifyBrainRow(
  workspaceId: string,
  primitive: BrainPrimitive,
  rowId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await authFetch(
    `${API_URL}/api/brain-inbox/${encodeURIComponent(workspaceId)}/${primitive}/${encodeURIComponent(rowId)}/verify`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
  );
  if (res.ok) return { ok: true };
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: data.error ?? `Verify failed (${res.status})` };
}

/** Adjust — memory + entity in v1. Other primitives return 405 and
 *  the caller should link out to the detail page instead.
 *
 *  Field availability per primitive:
 *  - memory: scope, sensitivity, summary, detail
 *  - entity: display_name, sensitivity
 *  - workspace_file: sensitivity, tags
 *  - task: title, status, due_at, tags */
export type AdjustMemoryChanges = {
  scope?: "personal" | "workspace_shared" | "workspace";
  sensitivity?: "public" | "internal" | "confidential";
  summary?: string;
  detail?: string;
  display_name?: string;
  /** workspace_file + task adjust — replace the tag set. */
  tags?: string[];
  /** task adjust — the editable doc-like fields. */
  title?: string;
  status?: "todo" | "in_progress" | "blocked" | "done" | "archived";
  /** task adjust — ISO date string, or null to clear the due date. */
  due_at?: string | null;
  reason?: string;
};

/**
 * URL for a `workspace_file` row's raw bytes, used by the brain detail
 * drawer's preview. The endpoint is auth-gated, so fetch it through
 * `authFetch` (a plain `<img src>` would not carry the bearer token).
 */
export function brainFileContentUrl(workspaceId: string, rowId: string): string {
  return `${API_URL}/api/brain-inbox/${encodeURIComponent(workspaceId)}/workspace_file/${encodeURIComponent(rowId)}/content`;
}

/**
 * Extract the superseded row's new id from an adjust response.
 * Task adjusts answer `{ ok, stamped, id }`; memory adjusts (behind the
 * 308 redirect to the per-assistant route) answer `{ memory: { id } }`.
 * In-place adjusts (entity / CRM / file) answer without an id → null.
 */
export function parseAdjustNewId(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const obj = json as Record<string, unknown>;
  if (typeof obj.id === "string" && obj.id.length > 0) return obj.id;
  const memory = obj.memory;
  if (memory && typeof memory === "object") {
    const id = (memory as Record<string, unknown>).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

export async function adjustBrainRow(
  workspaceId: string,
  primitive: BrainPrimitive,
  rowId: string,
  changes: AdjustMemoryChanges,
): Promise<{ ok: true; newId: string | null } | { ok: false; error: string }> {
  const res = await authFetch(
    `${API_URL}/api/brain-inbox/${encodeURIComponent(workspaceId)}/${primitive}/${encodeURIComponent(rowId)}/adjust`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(changes),
      // The brain-inbox route 308-redirects memory adjusts to the
      // per-assistant route; fetch follows redirects by default.
      redirect: "follow",
    },
  );
  if (res.ok) {
    // Task + memory adjusts supersede the row and return the new
    // bi-temporal id; the drawer re-anchors on it instead of closing.
    const data = (await res.json().catch(() => ({}))) as unknown;
    return { ok: true, newId: parseAdjustNewId(data) };
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: data.error ?? `Adjust failed (${res.status})` };
}

/**
 * Resolve a CRM-kind entity (kind in {person, company, deal}) to its
 * specialization row in contacts/companies/deals. Used by the brain
 * graph view's drawer so clicking a CRM entity node opens the rich
 * CRM detail (tags, domain, relationships) instead of the lean
 * entities-table projection.
 *
 * Returns `null` when the entity is non-CRM or is missing a companion
 * row (data-integrity edge case — the UI falls back to entity view).
 */
// (Removed) fetchCrmCompanion + the /crm-companion route. Post CRM→entity
// unification a person/company/deal IS the entity, so the detail drawer
// maps the entity kind to its plural primitive and fetches the entity
// directly (see detail-drawer.tsx) — no companion lookup.

/** Add an alias to an entity. Returns the updated alias list on
 *  success. Returns `{ conflict: true, conflictingEntityId }` when the
 *  alias is already bound to another entity in the workspace — caller
 *  surfaces a merge prompt. */
export async function addEntityAlias(
  workspaceId: string,
  entityId: string,
  alias: string,
): Promise<
  | { ok: true; aliases: string[] }
  | { ok: false; conflict: true; conflictingEntityId: string; error: string }
  | { ok: false; error: string }
> {
  const res = await authFetch(
    `${API_URL}/api/brain-inbox/${encodeURIComponent(workspaceId)}/entity/${encodeURIComponent(entityId)}/aliases`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alias }),
    },
  );
  if (res.ok) {
    const data = (await res.json().catch(() => ({}))) as { aliases?: string[] };
    return { ok: true, aliases: Array.isArray(data.aliases) ? data.aliases : [] };
  }
  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    conflictingEntityId?: string;
  };
  if (res.status === 409 && typeof data.conflictingEntityId === "string") {
    return {
      ok: false,
      conflict: true,
      conflictingEntityId: data.conflictingEntityId,
      error: data.error ?? "Alias is already bound to another entity",
    };
  }
  return { ok: false, error: data.error ?? `Add alias failed (${res.status})` };
}

/** Remove an alias from an entity. Returns the updated alias list. */
export async function removeEntityAlias(
  workspaceId: string,
  entityId: string,
  alias: string,
): Promise<{ ok: true; aliases: string[] } | { ok: false; error: string }> {
  const res = await authFetch(
    `${API_URL}/api/brain-inbox/${encodeURIComponent(workspaceId)}/entity/${encodeURIComponent(entityId)}/aliases/${encodeURIComponent(alias)}`,
    { method: "DELETE" },
  );
  if (res.ok) {
    const data = (await res.json().catch(() => ({}))) as { aliases?: string[] };
    return { ok: true, aliases: Array.isArray(data.aliases) ? data.aliases : [] };
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: data.error ?? `Remove alias failed (${res.status})` };
}

/** Non-CRM entity kind change (product ↔ project, etc). Rejects CRM
 *  targets — those go through `promoteEntityToCrm` below. */
export async function reclassifyEntityKind(
  workspaceId: string,
  entityId: string,
  kind: string,
  reason?: string,
): Promise<{ ok: true; kind: string } | { ok: false; error: string }> {
  const res = await authFetch(
    `${API_URL}/api/brain-inbox/${encodeURIComponent(workspaceId)}/entity/${encodeURIComponent(entityId)}/reclassify`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, ...(reason ? { reason } : {}) }),
    },
  );
  if (res.ok) {
    const data = (await res.json().catch(() => ({}))) as { kind?: string };
    return { ok: true, kind: data.kind ?? kind };
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: data.error ?? `Reclassify failed (${res.status})` };
}

export type PromoteToCrmParams = {
  kind: "person" | "company" | "deal";
  name?: string;
  tags?: string[];
  // company
  domain?: string;
  // person
  email?: string;
  phone?: string;
  companyId?: string;
  // deal
  stage?: "lead" | "qualified" | "proposal" | "negotiation" | "won" | "lost";
  amount?: number;
  closeDate?: string;
  contactId?: string;
  reason?: string;
};

/** Atomic CRM promotion — UPDATE entities.kind + INSERT companion row. */
export async function promoteEntityToCrm(
  workspaceId: string,
  entityId: string,
  params: PromoteToCrmParams,
): Promise<
  | { ok: true; kind: string; specializationId: string }
  | { ok: false; error: string }
> {
  const res = await authFetch(
    `${API_URL}/api/brain-inbox/${encodeURIComponent(workspaceId)}/entity/${encodeURIComponent(entityId)}/promote-to-crm`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    },
  );
  if (res.ok) {
    const data = (await res.json().catch(() => ({}))) as {
      kind?: string;
      specializationId?: string;
    };
    return {
      ok: true,
      kind: data.kind ?? params.kind,
      specializationId: data.specializationId ?? "",
    };
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: data.error ?? `Promote failed (${res.status})` };
}

/** Soft-delete a row. Generic across primitives. */
export async function deleteBrainRow(
  workspaceId: string,
  primitive: BrainPrimitive,
  rowId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await authFetch(
    `${API_URL}/api/brain-inbox/${encodeURIComponent(workspaceId)}/${primitive}/${encodeURIComponent(rowId)}`,
    { method: "DELETE" },
  );
  if (res.ok) return { ok: true };
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: data.error ?? `Delete failed (${res.status})` };
}

/** Source-session context for the "Why?" expansion. No LLM call. */
export type ExplainContext = {
  savedAt: string;
  savedByAssistantId: string | null;
  savedByAssistantName: string | null;
  sourceSessionId: string | null;
  sourceEpisodeId: string | null;
  messages: Array<{
    id: string;
    role: string;
    content: unknown;
    createdAt: string;
  }>;
};

export async function explainBrainRow(
  workspaceId: string,
  primitive: BrainPrimitive,
  rowId: string,
): Promise<ExplainContext | null> {
  const res = await authFetch(
    `${API_URL}/api/brain-inbox/${encodeURIComponent(workspaceId)}/${primitive}/${encodeURIComponent(rowId)}/explain`,
  );
  if (!res.ok) return null;
  return (await res.json()) as ExplainContext;
}

/** Create an ephemeral inspection session for the "Ask about this"
 *  drawer. Returns the session id + the primary assistant + the
 *  inspection context the frontend uses to seed the preamble. */
export type InspectionSession = {
  sessionId: string;
  assistantId: string;
  assistantName: string;
  inspectionContext: {
    primitive: BrainPrimitive;
    rowId: string;
  };
};

export async function createInspectionSession(
  workspaceId: string,
  primitive: BrainPrimitive,
  rowId: string,
): Promise<InspectionSession | { error: string }> {
  const res = await authFetch(
    `${API_URL}/api/brain-inbox/${encodeURIComponent(workspaceId)}/${primitive}/${encodeURIComponent(rowId)}/inspection-session`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
  );
  if (res.ok) return (await res.json()) as InspectionSession;
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return { error: data.error ?? `Inspection session failed (${res.status})` };
}

// ── Back-compat re-exports for memories-review SDK consumers ────────
//
// The original `memories-review.ts` SDK is now a thin adapter over
// this module. Memory cards consume these; non-memory cards consume
// the generic functions above.

type UnverifiedMemory = {
  id: string;
  assistantId: string;
  userId: string;
  workspaceId: string | null;
  type: string;
  scope: string;
  category?: string | null;
  tags: string[];
  summary: string;
  detail: string | null;
  sensitivity: string;
  source: string;
  sourceSessionId: string | null;
  sourceEpisodeId: string | null;
  createdByUserId: string | null;
  createdByAssistantId: string | null;
  originalScope: string | null;
  originalSensitivity: string | null;
  originalSummary: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Project a brain-inbox memory row into the legacy UnverifiedMemory
 *  shape — used by the memory card during the rename window so the
 *  existing card props keep working. */
function projectMemoryRow(row: BrainInboxRow): UnverifiedMemory | null {
  if (row.primitive !== "memory") return null;
  const b = row.body as Record<string, unknown>;
  return {
    id: row.id,
    assistantId: String(b.assistant_id ?? ""),
    userId: String(b.user_id ?? ""),
    workspaceId: row.workspaceId,
    type: String(b.type ?? "preference"),
    scope: String(b.scope ?? "shared"),
    category: (b.category as string | null) ?? null,
    tags: Array.isArray(b.tags) ? (b.tags as string[]) : [],
    summary: String(b.summary ?? ""),
    detail: (b.detail as string | null) ?? null,
    sensitivity: String(b.sensitivity ?? "internal"),
    source: "model",
    sourceSessionId: (b.source_session_id as string | null) ?? null,
    sourceEpisodeId: (b.source_episode_id as string | null) ?? null,
    createdByUserId: null,
    createdByAssistantId: row.createdByAssistantId,
    originalScope: (b.original_scope as string | null) ?? null,
    originalSensitivity: (b.original_sensitivity as string | null) ?? null,
    originalSummary: (b.original_summary as string | null) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.createdAt,
  };
}
