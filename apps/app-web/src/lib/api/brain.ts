/**
 * SDK for the Brain page (app-web).
 *
 * Ported verbatim from `apps/web/src/lib/api/brain.ts` as part of the
 * brain surface migration of the app consolidation
 * (docs/plans/doc-web-app-consolidation.md §5a — brain is XL). Wraps
 * `authFetch` with typed signatures over the company-brain retrieval
 * routes (docs/architecture/brain/retrieval-layer.md). The wire contract
 * is identical to apps/web; this file diverges only in its import paths
 * (`@/lib/auth-fetch`, `NEXT_PUBLIC_API_URL`), the same convention as
 * `lib/api/views.ts` / `lib/api/approvals.ts`.
 */

import { authFetch } from "@/lib/auth-fetch";
import type {
  BrainInboxRow,
  BrainPrimitive as InboxPrimitive,
} from "@/lib/api/brain-inbox";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type EntityKind =
  | "person"
  | "company"
  | "project"
  | "deal"
  | "product"
  | "repository"
  | "other";

// Skills are deliberately NOT a member: the procedural primitive has its own
// top-level Brain section (library + editor, fetched via `lib/api/skills.ts`)
// rather than a filter chip over `/api/brain/list`.
export type BrainPrimitive =
  | "people"
  | "companies"
  | "deals"
  | "knowledge"
  | "memories"
  | "files"
  | "sessions"
  | "tasks";

/**
 * Every brain-page primitive — the canonical "all primitives" list.
 * Derive set logic from this rather than hardcoding a subset (e.g. the
 * chip-reachable inbox cover in `review-queue.ts`): adding a member here
 * then flows everywhere, the same "derive, don't hardcode 'all'" rule the
 * connector registry follows. Order is the type-union order, not the
 * filter-chip display order (that lives in the sidebar panel's
 * `ENTRY_OPTIONS`).
 */
export const BRAIN_PRIMITIVES: BrainPrimitive[] = [
  "people",
  "companies",
  "deals",
  "knowledge",
  "memories",
  "files",
  "sessions",
  "tasks",
];

export type Sensitivity =
  | "public"
  | "internal"
  | "confidential"
  | "restricted";

export type BrainRow = {
  id: string;
  kind: BrainPrimitive | EntityKind;
  name: string;
  summary?: string | null;
  sensitivity?: Sensitivity;
  createdByUserId?: string | null;
  createdByAssistantId?: string | null;
  hasPending?: boolean;
};

export type EntityRollup = {
  id: string;
  kind: EntityKind;
  name: string;
  sensitivity: Sensitivity;
  /**
   * Lowercase variant names the brain has learned for this entity
   * (e.g. ["dd", "deltadefi-protocol"] on the DeltaDeFi row). Powers
   * the aliases section in the entity drawer.
   */
  aliases: string[];
  /**
   * Free-form attribute map on the entity row. For the user's self
   * entity (`attributes.self === true`) this holds the Identity Phase 2
   * profile fields lifted out of `memories` by mig 176 (name, role,
   * location, etc.). The entity panel renders these — without this
   * surface, post-migration identity data has no UI representation.
   */
  attributes: Record<string, unknown>;
  authorship: {
    createdByUserId: string | null;
    createdByAssistantId: string | null;
    sourceEpisodeId: string | null;
  };
  summary: {
    memoriesCount: number;
    tasksCount: number;
    filesCount: number;
    knowledgeCount: number;
    episodesCount: number;
  };
  embedded: {
    recentMemories: BrainRow[];
    openTasks: BrainRow[];
    files: BrainRow[];
    knowledge: BrainRow[];
    recentEpisodes: BrainRow[];
    edges: { kind: string; targetEntityId: string; targetName: string }[];
  };
  pendingChanges: BrainRow[];
};

export type BrainListParams = {
  workspaceId: string;
  primitives?: BrainPrimitive[];
  search?: string;
  viewpointAssistantId?: string | null;
  pendingOnly?: boolean;
  cursor?: string;
  limit?: number;
};

export type BrainListResult = {
  rows: BrainRow[];
  nextCursor: string | null;
};

/**
 * Cross-primitive list query for the Brain page list view.
 *
 * Backed by `GET /api/brain/list` — see packages/api/src/routes/brain.ts.
 */
export async function listBrain(
  params: BrainListParams,
): Promise<BrainListResult> {
  const q = new URLSearchParams();
  q.set("workspaceId", params.workspaceId);
  if (params.search) q.set("q", params.search);
  if (params.viewpointAssistantId)
    q.set("assistantId", params.viewpointAssistantId);
  if (params.pendingOnly) q.set("pending", "true");
  if (params.cursor) q.set("cursor", params.cursor);
  if (params.limit) q.set("limit", String(params.limit));
  if (params.primitives?.length) q.set("kinds", params.primitives.join(","));

  // Backed by `GET /api/brain/list` — a thin wrapper over the retrieval
  // `search()` surface. v1 omits the `sessions` primitive and the
  // `pendingOnly` filter (see the route doc in brain.ts).
  const res = await authFetch(`${API_URL}/api/brain/list?${q.toString()}`);
  if (!res.ok) {
    return { rows: [], nextCursor: null };
  }
  const data = (await res.json()) as {
    results?: BrainRow[];
    nextCursor?: string | null;
  };
  return {
    rows: Array.isArray(data.results) ? data.results : [],
    nextCursor: data.nextCursor ?? null,
  };
}

/**
 * Full entity rollup for the Brain entity panel. Backed by
 * `packages/api/src/routes/brain.ts` (WU-5.9). The server returns the
 * web-shape `EntityRollup` directly, mapping the internal rollup row
 * types so this client only sees its own contract.
 */
export async function getEntity(
  entityId: string,
  workspaceId: string,
  viewpointAssistantId?: string | null,
): Promise<EntityRollup | null> {
  const q = new URLSearchParams({ workspaceId });
  if (viewpointAssistantId) q.set("assistantId", viewpointAssistantId);
  const res = await authFetch(
    `${API_URL}/api/brain/entities/${encodeURIComponent(entityId)}?${q.toString()}`,
  );
  if (!res.ok) return null;
  return (await res.json()) as EntityRollup;
}

// ── Graph view ────────────────────────────────────────────────────────

/** Node kind on the brain graph. Mirrors `EntityKind` plus the synthetic
 *  node kinds the graph route projects: `'knowledge'` (a `knowledge_entries`
 *  document), `'skill'` (a `workspace_skills` row — procedural-brain primitive,
 *  see docs/plans/skills-as-procedural-brain-primitive.md §6/§7.1),
 *  `'connector'` (a connector a skill requires), and `'memory'` (a `memories`
 *  row — only present when the caller opts in via `showMemory`; rendered for the
 *  entity it's linked to). None of these are entity rows, but all render as
 *  graph nodes so their derived edges are visible. */
export type BrainGraphNodeKind =
  | EntityKind
  | "knowledge"
  | "skill"
  | "connector"
  | "memory";

export type BrainGraphNode = {
  id: string;
  kind: BrainGraphNodeKind;
  name: string;
  sensitivity: Sensitivity;
  /** Connection count, pre-computed server-side for sizing. */
  degree: number;
};

export type BrainGraphEdge = {
  id: string;
  source: string;
  target: string;
  /** edge_type from `entity_links` (e.g. "works_at", "discussed_in"). */
  type: string;
  sensitivity: Sensitivity;
};

export type BrainGraph = {
  nodes: BrainGraphNode[];
  edges: BrainGraphEdge[];
  /** True when the workspace has more entities than the node cap. */
  truncated: boolean;
};

// ── Knowledge entry detail ────────────────────────────────────────────

/** A resolved related-entry ref — wikilink targets + the reader rail list. */
export type KnowledgeRelatedRef = {
  id: string;
  title: string;
  path: string;
};

/** Provenance of a GitHub-synced entry (null for manual entries). */
export type KnowledgeEntrySource = {
  id: string;
  repo: string;
  branch: string;
  rootPath: string;
  lastSyncedAt: string | null;
};

export type KnowledgeEntryDetail = {
  id: string;
  path: string;
  title: string;
  summary: string | null;
  content: string;
  tags: string[];
  sensitivity: Sensitivity;
  sourceId: string | null;
  sourceSha: string | null;
  createdAt: string;
  updatedAt: string;
  /** Resolved `related_ids` (clearance-scoped). Absent on older servers. */
  related?: KnowledgeRelatedRef[];
  /** Owning sync source, null for manual entries. Absent on older servers. */
  source?: KnowledgeEntrySource | null;
};

/**
 * Single knowledge-entry read for the brain detail drawer. Backed by
 * `GET /api/brain/knowledge/:id`. Returns null on any 4xx/5xx so the
 * caller can fall back to the generic not-found surface.
 */
export async function getKnowledgeEntry(
  id: string,
  workspaceId: string,
  viewpointAssistantId?: string | null,
): Promise<KnowledgeEntryDetail | null> {
  const q = new URLSearchParams({ workspaceId });
  if (viewpointAssistantId) q.set("assistantId", viewpointAssistantId);
  const res = await authFetch(
    `${API_URL}/api/brain/knowledge/${encodeURIComponent(id)}?${q.toString()}`,
  );
  if (!res.ok) return null;
  return (await res.json()) as KnowledgeEntryDetail;
}

// ── Knowledge edit proposals (entry reader) ──────────────────────────
// Spec: docs/architecture/features/knowledge-base.md → "Knowledge
// reader + edit proposals". The repo stays the source of truth: a
// proposal opens a PR through the source's bound GitHub connector and
// the DB row updates via the normal sync after merge.

export type KnowledgeEditCapability = {
  mode: "github" | "manual";
  canPropose: boolean;
  reason: "no_write_access" | "no_credentials" | "source_missing" | null;
  repo: string | null;
  branch: string | null;
  repoUrl: string | null;
};

/**
 * Can the entry reader's "Suggest an edit" flow run for this entry?
 * `canPropose: false` with `reason: 'no_write_access'` means a read-only
 * PAT — the UI greys the button. Returns null on any error so the reader
 * degrades to read-only rather than crashing.
 */
export async function getKnowledgeEditCapability(
  workspaceId: string,
  entryId: string,
): Promise<KnowledgeEditCapability | null> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/knowledge/entries/${encodeURIComponent(entryId)}/edit-capability`,
  );
  if (!res.ok) return null;
  return (await res.json()) as KnowledgeEditCapability;
}

export type KnowledgeProposalResult =
  | { ok: true; prUrl: string; prNumber: number; branch: string }
  | { ok: false; error: string };

/**
 * Submit a suggested edit — opens a PR on the source repo with the new
 * body (frontmatter preserved server-side) and the member's comment.
 */
export async function proposeKnowledgeEdit(
  workspaceId: string,
  entryId: string,
  params: { content: string; comment?: string },
): Promise<KnowledgeProposalResult> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/knowledge/entries/${encodeURIComponent(entryId)}/proposals`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    },
  );
  const data = (await res.json().catch(() => ({}))) as {
    prUrl?: string;
    prNumber?: number;
    branch?: string;
    error?: string;
  };
  if (!res.ok || !data.prUrl) {
    return { ok: false, error: data.error ?? `Request failed (${res.status})` };
  }
  return {
    ok: true,
    prUrl: data.prUrl,
    prNumber: data.prNumber ?? 0,
    branch: data.branch ?? "",
  };
}

/**
 * Presence map for the brain's primitive types. `true` ⇒ the brain has
 * ≥1 visible row of that primitive. Powers the filter rail's
 * present-only chip rendering (hide chips for empty primitive types).
 */
export type BrainFacets = Record<BrainPrimitive, boolean>;

/**
 * Which primitive types currently have ≥1 visible row in the brain.
 * Backed by `GET /api/brain/facets`. Used by the filter rail to hide
 * chips for empty primitive types.
 *
 * Fail-open: on any non-OK response (or a missing endpoint while the
 * parallel backend work lands) every primitive defaults to `true`, so a
 * failed presence check never makes the UI look emptier than it is — it
 * just falls back to showing every chip.
 */
export async function getBrainFacets(
  workspaceId: string,
  viewpointAssistantId?: string | null,
): Promise<BrainFacets> {
  const allPresent: BrainFacets = {
    people: true,
    companies: true,
    deals: true,
    tasks: true,
    knowledge: true,
    memories: true,
    files: true,
    sessions: true,
  };
  const q = new URLSearchParams({ workspaceId });
  if (viewpointAssistantId) q.set("assistantId", viewpointAssistantId);
  const res = await authFetch(`${API_URL}/api/brain/facets?${q.toString()}`);
  if (!res.ok) return allPresent;
  const data = (await res.json()) as { present?: Partial<BrainFacets> };
  const present = data.present ?? {};
  return {
    people: present.people === true,
    companies: present.companies === true,
    deals: present.deals === true,
    tasks: present.tasks === true,
    knowledge: present.knowledge === true,
    memories: present.memories === true,
    files: present.files === true,
    sessions: present.sessions === true,
  };
}

/**
 * Workspace-wide graph snapshot — every visible entity + every active
 * entity↔entity edge. Backed by `GET /api/brain/graph`. Returns an
 * empty graph on error so the view can render its empty state instead
 * of crashing.
 */
export async function getBrainGraph(params: {
  workspaceId: string;
  viewpointAssistantId?: string | null;
  limit?: number;
  /** Opt into memory nodes (the Phase 3 `?include=memory` toggle). Only
   *  memories linked to a visible entity are returned. Default off. */
  showMemory?: boolean;
}): Promise<BrainGraph> {
  const q = new URLSearchParams({ workspaceId: params.workspaceId });
  if (params.viewpointAssistantId) q.set("assistantId", params.viewpointAssistantId);
  if (params.limit) q.set("limit", String(params.limit));
  if (params.showMemory) q.set("include", "memory");
  const res = await authFetch(`${API_URL}/api/brain/graph?${q.toString()}`);
  if (!res.ok) {
    return { nodes: [], edges: [], truncated: false };
  }
  const data = (await res.json()) as Partial<BrainGraph>;
  return {
    nodes: Array.isArray(data.nodes) ? data.nodes : [],
    edges: Array.isArray(data.edges) ? data.edges : [],
    truncated: data.truncated === true,
  };
}

/**
 * Map a brain-page primitive (people/companies/…) to the inbox primitive
 * (contact/company/…) used by `/api/brain-inbox`. Returns null for
 * primitives that have no inbox equivalent (knowledge syncs from external
 * sources, sessions don't carry verified_by_user_id).
 */
export function brainToInboxPrimitive(p: BrainPrimitive): InboxPrimitive | null {
  switch (p) {
    case "people":
      return "contact";
    case "companies":
      return "company";
    case "deals":
      return "deal";
    case "memories":
      return "memory";
    case "files":
      return "workspace_file";
    case "tasks":
      return "task";
    case "knowledge":
    case "sessions":
      return null;
  }
}

/** Humanise a snake/underscore data token for display: `documented_by` →
 *  `Documented by`. Same "render the raw value" treatment the inbox detail
 *  list gives body keys — not UI copy, so no i18n. */
function humaniseEdgeToken(token: string): string {
  const spaced = token.replace(/_/g, " ").trim();
  return spaced.length > 0
    ? spaced.charAt(0).toUpperCase() + spaced.slice(1)
    : spaced;
}

/**
 * Readable name for an `entity_link` inbox row (a knowledge-graph edge).
 * Prefers the backend-resolved `target_label` (the endpoint's real name) so
 * the review queue reads "Documented by file: roadmap.pdf" or "Works at:
 * DeltaDeFi" instead of the raw "memory → documented_by → file". Qualifies
 * with the target kind for content endpoints (file / episode / …) but not for
 * an entity target, where the name alone reads cleanly. Falls back to the
 * humanised target kind when the name is unresolved (target soft-deleted, or
 * an endpoint kind the store doesn't resolve): "Mentioned: File".
 */
function entityLinkName(b: Record<string, unknown>): string {
  const edge = humaniseEdgeToken(String(b.edge_type ?? "links"));
  const targetKind = String(b.target_kind ?? "");
  const rawLabel =
    typeof b.target_label === "string" ? b.target_label.trim() : "";
  const label =
    rawLabel.length > 80 ? `${rawLabel.slice(0, 79).trimEnd()}…` : rawLabel;
  if (label.length > 0) {
    return targetKind && targetKind !== "entity"
      ? `${edge} ${targetKind}: ${label}`
      : `${edge}: ${label}`;
  }
  return targetKind ? `${edge}: ${humaniseEdgeToken(targetKind)}` : edge;
}

/**
 * Project a `BrainInboxRow` into the brain-list `BrainRow` shape so the
 * brain page's `EntityRow` can render unverified inbox items inline.
 * Always sets `hasPending: true` — the inbox by definition holds rows
 * the user hasn't acknowledged yet, so `EntityRow` will surface the
 * `UnverifiedNudge` with verify/delete affordances.
 */
export function projectInboxRowToBrainRow(row: BrainInboxRow): BrainRow {
  const b = row.body as Record<string, unknown>;
  const sensitivity =
    typeof b.sensitivity === "string" &&
    ["public", "internal", "confidential", "restricted"].includes(b.sensitivity)
      ? (b.sensitivity as Sensitivity)
      : undefined;
  const common = {
    id: row.id,
    createdByAssistantId: row.createdByAssistantId,
    sensitivity,
    hasPending: true as const,
  };
  switch (row.primitive) {
    case "memory":
      return {
        ...common,
        kind: "memories",
        name: String(b.summary ?? "(no summary)"),
        summary: typeof b.detail === "string" ? b.detail : null,
      };
    case "entity": {
      const kind = String(b.kind ?? "other");
      const mapped: EntityKind =
        kind === "person" ||
        kind === "company" ||
        kind === "project" ||
        kind === "deal" ||
        kind === "product" ||
        kind === "repository"
          ? kind
          : "other";
      return {
        ...common,
        kind: mapped,
        name: String(b.display_name ?? "(unnamed entity)"),
      };
    }
    case "entity_link":
      return {
        ...common,
        kind: "other",
        name: entityLinkName(b),
      };
    case "task":
      return {
        ...common,
        kind: "tasks",
        name: String(b.title ?? "(untitled task)"),
        summary: typeof b.status === "string" ? `Status: ${b.status}` : null,
      };
    case "contact":
      return {
        ...common,
        kind: "people",
        name: String(b.display_name ?? b.email ?? "(contact)"),
        summary: typeof b.role === "string" ? b.role : null,
      };
    case "company":
      return {
        ...common,
        kind: "companies",
        name: String(b.name ?? b.domain ?? "(company)"),
        summary: typeof b.industry === "string" ? b.industry : null,
      };
    case "deal":
      return {
        ...common,
        kind: "deals",
        name: String(b.name ?? "(deal)"),
        summary: typeof b.stage === "string" ? `Stage: ${b.stage}` : null,
      };
    case "workspace_file":
      return {
        ...common,
        kind: "files",
        name: String(b.name ?? "(file)"),
        summary: typeof b.mime_type === "string" ? b.mime_type : null,
      };
  }
}

/**
 * Pending changes (staged_write approvals) affecting a specific entity.
 *
 * Backend gap: `pending_approvals.approval_payload` needs an
 * `entity_ids: UUID[]` field to enable this query. Until then this
 * returns an empty array.
 */
export async function listPendingForEntity(
  entityId: string,
  workspaceId: string,
): Promise<BrainRow[]> {
  const q = new URLSearchParams({ workspaceId, entityId });
  const res = await authFetch(
    `${API_URL}/api/approvals/pending?${q.toString()}`,
  );
  if (!res.ok) return [];
  const data = (await res.json()) as { approvals?: BrainRow[] };
  return Array.isArray(data.approvals) ? data.approvals : [];
}
