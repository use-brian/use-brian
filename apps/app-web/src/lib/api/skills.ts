/**
 * SDK for skills as a procedural-brain primitive (app-web).
 *
 * Surfaces the workspace's skills WITH governance fields in the Brain, plus
 * the trust-loop mutations (confirm / edit / delete), the skill-centric
 * access endpoints, and the creator's draft + catalog endpoints. Wraps
 * `authFetch` with typed signatures over the skill routes mounted at
 * `/api/skills` in `apps/api/src/index.ts`. Kept as its own file (not
 * imported from apps/web) per the same convention as `lib/api/brain.ts` /
 * `lib/api/approvals.ts`.
 *
 *   GET    /api/skills/workspace?workspaceId=   — governance-aware list (Brain)
 *   POST   /api/skills                           — author a skill (born Active)
 *   POST   /api/skills/draft                     — one conversational draft turn
 *   GET    /api/skills/catalog                   — template picker source
 *   GET    /api/skills/catalog/:slug             — full template detail (content)
 *   POST   /api/skills/:id/confirm              — human-confirm → Active
 *   PATCH  /api/skills/:id                       — edit (name / body / sensitivity)
 *   GET    /api/skills/:id/access                — skill-centric enablement list
 *   PUT    /api/skills/:id/access                — set enablement rows
 *   DELETE /api/skills/:id                       — delete a skill
 *
 * Spec: docs/architecture/engine/skill-system.md §5, §7.1 and
 * docs/plans/brain-skill-management-ux.md §4.
 */

import { authFetch } from "@/lib/auth-fetch";
import { BrainContentHttpError } from "@/lib/offline/brain-content-cache";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/** Where a skill came from — drives the provenance tier + the induction-source
 *  chip. `authored` = a human wrote it; `self` = induced from the team's own
 *  interactions; `ingested` = induced from ingested external content. */
export type SkillInductionSource = "self" | "ingested" | "authored";

export type SkillSensitivity = "public" | "internal" | "confidential";

type SkillLifecycleState = "active" | "stale" | "archived";

/**
 * Governance-aware projection of a `workspace_skills` row, as returned by
 * `GET /api/skills/workspace`. `activatedAt != null` ⇒ the skill is Active
 * (freely invocable); `null` ⇒ Suggested (offered to the originating
 * assistant only, awaiting confirmation / re-derivation / a human edit).
 */
export type WorkspaceSkillSummary = {
  /** Skill row UUID (`workspace_skills.id`) — the id confirm/edit/delete take. */
  rowId: string;
  slug: string;
  name: string;
  description: string;
  whenToUse: string | null;
  /** The skill body (markdown). */
  content: string;
  /** Library grouping bucket. TEXT server-side, so normalize with
   *  `skillCategoryOf` before rendering — never trust it to be in the enum. */
  category: string;
  state: SkillLifecycleState;
  confidence: number;
  /** ISO timestamp; null ⇒ Suggested (not yet activated). */
  activatedAt: string | null;
  inductionSource: SkillInductionSource;
  sensitivity: SkillSensitivity;
  /** True when a human set the sensitivity; false ⇒ inherited from source. */
  sensitivityOverridden: boolean;
  originatingAssistantId: string | null;
  verifiedByUserId: string | null;
  /** ISO timestamp of the last human verification; null ⇒ never verified. */
  verifiedAt: string | null;
  /** Independent re-derivation count (the non-human confidence channel). */
  rederivationCount: number;
  /** Structural-synthesis Phase 2: the v2 blueprint (page-template id) this skill
   *  fills, if its draft carried a structured output shape; null ⇒ purely procedural. */
  blueprintId: string | null;
  requiresConnectors: string[];
  /** Allowlist of assistant ids the skill is offered to (D4 semantics). */
  enabledAssistantIds: string[];
  /** Applies to every assistant, including ones created later (mig 492). */
  allAssistants?: boolean;
  /** ISO timestamp of the most recent invocation; null ⇒ never invoked. */
  lastInvokedAt: string | null;
  /** CL-8 counters — outcome telemetry over the skill's invocations. */
  invocations: number;
  succeeded: number;
  userCorrectedAfter: number;
  bundleVersion?: 1 | 2;
  sourceDigest?: string | null;
  /** Origin-aware induction provenance: the workflow this skill was
   *  distilled from (`learned_from` edge, skill → workflow). Absent for
   *  interactive inductions. */
  learnedFromWorkflowId?: string;
  learnedFromWorkflowName?: string;
};

/**
 * Every non-archived workspace skill with its governance fields. Backed by
 * `GET /api/skills/workspace`. Returns an empty list on any non-OK response
 * (e.g. the endpoint is absent while the parallel backend work lands) so the
 * Brain renders without a Skills section rather than crashing.
 */
export async function listWorkspaceSkills(
  workspaceId: string,
  options?: { failOnError?: boolean },
): Promise<WorkspaceSkillSummary[]> {
  const q = new URLSearchParams({ workspaceId });
  const res = await authFetch(`${API_URL}/api/skills/workspace?${q.toString()}`);
  if (!res.ok) {
    if (options?.failOnError) {
      throw new BrainContentHttpError(res.status, "Workspace skills");
    }
    return [];
  }
  const data = (await res.json()) as { skills?: WorkspaceSkillSummary[] };
  return Array.isArray(data.skills) ? data.skills : [];
}

/**
 * One skill by row id, resolved through the workspace list (there is no
 * single-row GET; the list is small and already carries the full projection).
 * Returns null when the row is missing — deleted, archived, or another
 * workspace's.
 */
export async function getWorkspaceSkill(
  workspaceId: string,
  skillRowId: string,
): Promise<WorkspaceSkillSummary | null> {
  const skills = await listWorkspaceSkills(workspaceId);
  return skills.find((s) => s.rowId === skillRowId) ?? null;
}

export type CreateSkillInput = {
  name: string;
  content: string;
  description?: string;
  whenToUse?: string;
  /** Library grouping bucket; the server defaults it to `custom`. */
  category?: string;
  workspaceId: string;
  sensitivity?: SkillSensitivity;
  /** D4 — `'all'` writes enablement rows for every current workspace
   *  assistant; an explicit id list restricts at birth. */
  enabledAssistantIds?: string[] | "all";
  /** Skill import: folder support files written to `workspace_skill_files`
   *  after the row insert (the body's {{kind:name}} appendix resolves them). */
  supportFiles?: SkillImportSupportFile[];
  /** Skill import: provenance blob stored verbatim on the row. */
  importSource?: Record<string, unknown>;
  bundleVersion?: 1 | 2;
  sourceDigest?: string;
};

/**
 * Author a skill from the Brain (plan §7.1 — Brain hosts create). Backed by
 * the workspace-aware branch of `POST /api/skills`; governance-at-birth makes
 * an authored skill born Active (confidence 1.0, `induction_source =
 * 'authored'`), and D4 defaults enablement to every current assistant.
 * Returns the created projection so the caller can route to the editor.
 */
export async function createSkill(
  input: CreateSkillInput,
): Promise<
  { ok: true; skill: WorkspaceSkillSummary } | { ok: false; error: string }
> {
  const res = await authFetch(`${API_URL}/api/skills`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: data.error ?? "Failed to create skill" };
  }
  // 201 body is the projection — accept it bare or `{ skill }`-wrapped so a
  // wrapper change on the (parallel) backend never breaks the creator.
  const data = (await res.json().catch(() => ({}))) as
    | WorkspaceSkillSummary
    | { skill?: WorkspaceSkillSummary };
  const skill =
    "skill" in data && data.skill ? data.skill : (data as WorkspaceSkillSummary);
  return { ok: true, skill };
}

/**
 * Human-confirm a suggested skill (Brain trust action): stamps the verifier,
 * lifts confidence to the activation threshold, and activates the skill.
 * Backed by `POST /api/skills/:id/confirm`.
 */
export async function confirmSkill(
  workspaceId: string,
  skillRowId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await authFetch(
    `${API_URL}/api/skills/${encodeURIComponent(skillRowId)}/confirm`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    },
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: data.error ?? "Failed to confirm skill" };
  }
  return { ok: true };
}

export type UpdateSkillInput = {
  name?: string;
  content?: string;
  description?: string;
  whenToUse?: string;
  sensitivity?: SkillSensitivity;
  /** Library grouping bucket. Without a write surface the column stays at its
   *  `custom` default and the grouped library renders one bucket forever. */
  category?: string;
};

/**
 * Edit a skill. Backed by `PATCH /api/skills/:id`. The server applies the D2
 * trust stamp (docs/plans/brain-skill-management-ux.md §2): a human save of
 * name/content stamps the verifier, lifts confidence, and ACTIVATES a
 * Suggested skill — the editor labels its button "Save & activate" so the
 * consequence is visible. `sensitivity` sets `sensitivity_overridden`.
 */
export async function updateSkill(
  skillRowId: string,
  updates: UpdateSkillInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await authFetch(
    `${API_URL}/api/skills/${encodeURIComponent(skillRowId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    },
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: data.error ?? "Failed to update skill" };
  }
  return { ok: true };
}

/**
 * Delete a skill. Backed by `DELETE /api/skills/:id`. 204 ⇒ removed,
 * 404 ⇒ already gone (treated as success so the UI converges).
 */
export async function deleteSkill(
  skillRowId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await authFetch(
    `${API_URL}/api/skills/${encodeURIComponent(skillRowId)}`,
    { method: "DELETE" },
  );
  if (res.ok || res.status === 404) return { ok: true };
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: data.error ?? "Failed to delete skill" };
}

// ── Skill-centric assistant access (plan §4 — the dual of Studio's
//    assistant-centric enable toggle) ─────────────────────────────────

export type SkillAccessAssistant = {
  id: string;
  name: string;
  enabled: boolean;
};

export type SkillAccessResult =
  | {
      ok: true;
      assistants: SkillAccessAssistant[];
      /**
       * True = the skill applies to every assistant in the workspace,
       * INCLUDING ones created later, and holds no per-assistant rows. The
       * two states look identical in `assistants` (all enabled) and differ
       * the moment another assistant exists, so the flag is what the master
       * toggle reflects.
       */
      allAssistants: boolean;
    }
  | { ok: false; status: number; error: string };

/** Which assistants this skill is enabled for. Backed by
 *  `GET /api/skills/:id/access`. 501 ⇒ the access surface isn't deployed yet
 *  (the editor degrades to a note); 404 ⇒ non-member or missing skill. */
export async function getSkillAccess(
  skillRowId: string,
): Promise<SkillAccessResult> {
  const res = await authFetch(
    `${API_URL}/api/skills/${encodeURIComponent(skillRowId)}/access`,
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return {
      ok: false,
      status: res.status,
      error: data.error ?? "Failed to load skill access",
    };
  }
  const data = (await res.json()) as {
    assistants?: SkillAccessAssistant[];
    allAssistants?: boolean;
  };
  return {
    ok: true,
    assistants: data.assistants ?? [],
    allAssistants: data.allAssistants ?? false,
  };
}

/**
 * Replace the skill's offering scope. Backed by `PUT /api/skills/:id/access`.
 *
 * Two shapes, and they are not interchangeable:
 *   * `{ allAssistants: true }` — every assistant, including future ones.
 *     Stored as intent; drops any per-assistant rows.
 *   * `{ enabledAssistantIds: [...] }` — exactly these. If the skill was
 *     previously `allAssistants`, the server converts the flag into rows
 *     before applying the list.
 *
 * Sending the full id list is NOT equivalent to `allAssistants: true`: it
 * pins the skill to the assistants that exist today, which is the behaviour
 * mig 492 exists to stop being the default.
 */
export async function setSkillAccess(
  skillRowId: string,
  scope: { allAssistants: true } | { enabledAssistantIds: string[] },
): Promise<SkillAccessResult> {
  const res = await authFetch(
    `${API_URL}/api/skills/${encodeURIComponent(skillRowId)}/access`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(scope),
    },
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return {
      ok: false,
      status: res.status,
      error: data.error ?? "Failed to update skill access",
    };
  }
  const data = (await res.json()) as {
    assistants?: SkillAccessAssistant[];
    allAssistants?: boolean;
  };
  return {
    ok: true,
    assistants: data.assistants ?? [],
    allAssistants: data.allAssistants ?? false,
  };
}

// ── Creator + editor chat: conversational draft turns + templates ────
//    (plan §3.2, D3 as amended for chat iteration)

export type SkillDraft = {
  name: string;
  description: string;
  whenToUse: string;
  content: string;
  sensitivity: SkillSensitivity;
};

export type SkillDraftTurnInput = {
  workspaceId: string;
  /** The drafting conversation, oldest first; the last entry must be the
   *  user's. The endpoint is stateless — resend the whole transcript.
   *  Reference material is not a separate field: pasted text rides inside a
   *  message, documents ride as `fileIds`. */
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  templateSlug?: string;
  /** The LIVE document state (including hand edits) the agent revises from. */
  currentDraft?: SkillDraft;
  /** Model tier — plan-gated server-side (silent downgrade, like chat). */
  model?: "standard" | "pro" | "max";
  /** Arm webSearch/urlReader grounding for this turn. */
  research?: boolean;
  /** Uploaded attachment ids (POST /api/files/upload) for this turn. */
  fileIds?: string[];
};

export type SkillDraftTurnResult =
  | { ok: true; kind: "draft"; draft: SkillDraft; message: string }
  | { ok: true; kind: "reply"; message: string }
  | { ok: false; status: number; error: string };

/**
 * One conversational draft turn (`POST /api/skills/draft` — the
 * `skill-builder` builtin, plan D3 as amended). Returns either a revised
 * draft plus a short narration message, or a plain reply (questions/advice,
 * no draft change). Error statuses the hosts handle: 501 (route not wired) /
 * 503 (no provider) / 404 / 500 → drafting unavailable; 429 (rate/budget
 * limits) and 422 (the model couldn't draft) → inline error, keep state.
 */
export async function draftSkillTurn(
  input: SkillDraftTurnInput,
): Promise<SkillDraftTurnResult> {
  const res = await authFetch(`${API_URL}/api/skills/draft`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return {
      ok: false,
      status: res.status,
      error: data.error ?? "Failed to draft skill",
    };
  }
  const data = (await res.json()) as
    | { kind: "draft"; draft: SkillDraft; message?: string }
    | { kind: "reply"; message: string };
  if (data.kind === "reply") {
    return { ok: true, kind: "reply", message: data.message };
  }
  return { ok: true, kind: "draft", draft: data.draft, message: data.message ?? "" };
}

/** Full template detail (including the body) — `GET /api/skills/catalog/:slug`. */
export type SkillTemplateDetail = {
  id: string;
  name: string;
  description: string;
  whenToUse: string | null;
  content: string;
  category: string;
  requiresConnectors: string[];
  source: "builtin" | "community" | "user";
  bundleVersion: 1 | 2;
  sourceDigest: string | null;
  bundleSource: Record<string, unknown> | null;
  supportFiles: SkillImportSupportFile[];
};

/**
 * One template's FULL content for the creator's instant template load —
 * picking a template shows the whole skill in the document view with no
 * model call. Returns null when the slug is unknown or the fetch fails (the
 * creator surfaces a retryable notice).
 */
export async function getSkillTemplate(
  slug: string,
): Promise<SkillTemplateDetail | null> {
  const res = await authFetch(
    `${API_URL}/api/skills/catalog/${encodeURIComponent(slug)}`,
  );
  if (!res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as {
    skill?: SkillTemplateDetail;
  };
  return data.skill ?? null;
}

export type SkillCatalogEntry = {
  id: string;
  name: string;
  description: string;
  whenToUse?: string;
  category: string;
  source: "builtin" | "community" | "user";
  starred?: boolean;
  requiresConnectors: string[];
  bundleVersion?: 1 | 2;
  resourceCount?: number;
  sourceDigest?: string | null;
};

/** The builtin + community + user-published template catalog backing the
 *  creator's template picker. Backed by `GET /api/skills/catalog`; returns
 *  `[]` on failure so the picker simply hides. */
export async function listSkillCatalog(): Promise<SkillCatalogEntry[]> {
  const res = await authFetch(`${API_URL}/api/skills/catalog`);
  if (!res.ok) return [];
  const data = (await res.json().catch(() => ({}))) as {
    skills?: SkillCatalogEntry[];
  };
  return Array.isArray(data.skills) ? data.skills : [];
}

// ── Skill import (GitHub / URL) ───────────────────────────────
// Spec: docs/architecture/engine/skill-system.md → "Importing skills".

type SkillImportWarning = { code: string; detail: string };

export type SkillImportSupportFile = {
  kind: "reference" | "asset" | "template" | "script";
  name: string;
  path?: string;
  content: string;
  description?: string | null;
  contentHash?: string;
};

export type SkillImportResult = {
  dialect: string;
  draft: {
    name: string;
    slug: string;
    description: string;
    whenToUse?: string;
    category: string;
    requiresConnectors: string[];
    content: string;
  };
  supportFiles: SkillImportSupportFile[];
  links?: Array<{
    sourcePath: string;
    targetPath: string;
    relation: "contains" | "references" | "uses_skill";
    targetSkillSlug?: string;
  }>;
  bundleVersion?: 2;
  sourceDigest?: string;
  warnings: SkillImportWarning[];
  importSource: Record<string, unknown>;
};

export type SkillImportSource =
  | { kind: "url"; url: string }
  /** Markdown pasted into the dialog or read off a picked `.md` file.
   *  `fileName` only informs dialect detection and name derivation. */
  | { kind: "paste"; content: string; fileName?: string }
  | {
      kind: "github";
      connectorInstanceId: string;
      owner: string;
      repo: string;
      path: string;
      ref?: string;
    };

/**
 * Parse a skill file from GitHub or a public URL into a draft — no row is
 * written; the caller opens the creator pre-filled with the result. Backed by
 * `POST /api/skills/import`.
 */
export async function importSkill(
  workspaceId: string,
  source: SkillImportSource,
): Promise<
  | { ok: true; result: SkillImportResult }
  | { ok: false; status: number; error: string }
> {
  const res = await authFetch(`${API_URL}/api/skills/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId, source }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return {
      ok: false,
      status: res.status,
      error: data.error ?? "Failed to import the skill",
    };
  }
  const result = (await res.json().catch(() => null)) as SkillImportResult | null;
  if (!result || !result.draft) {
    return { ok: false, status: 500, error: "Failed to import the skill" };
  }
  return { ok: true, result };
}

export type SkillImportGithubInstance = {
  id: string;
  label: string;
  connectedEmail: string | null;
};

/** Usable GitHub connector instances for the import picker. `409` (no
 *  connector) maps to `{ ok: true, instances: [] }` so the dialog can show
 *  its connect hint instead of an error. */
export async function listImportGithubInstances(
  workspaceId: string,
): Promise<
  | { ok: true; instances: SkillImportGithubInstance[] }
  | { ok: false; error: string }
> {
  const res = await authFetch(
    `${API_URL}/api/skills/import/github/instances?workspaceId=${encodeURIComponent(workspaceId)}`,
  );
  if (res.status === 409) return { ok: true, instances: [] };
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: data.error ?? "Failed to list GitHub connectors" };
  }
  const data = (await res.json().catch(() => ({}))) as {
    instances?: SkillImportGithubInstance[];
  };
  return { ok: true, instances: Array.isArray(data.instances) ? data.instances : [] };
}

export type SkillImportGithubRepo = {
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  description: string | null;
};

export async function listImportGithubRepos(
  workspaceId: string,
  connectorInstanceId: string,
): Promise<
  { ok: true; repos: SkillImportGithubRepo[] } | { ok: false; error: string }
> {
  const res = await authFetch(
    `${API_URL}/api/skills/import/github/repos?workspaceId=${encodeURIComponent(workspaceId)}&connectorInstanceId=${encodeURIComponent(connectorInstanceId)}`,
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: data.error ?? "Failed to list repositories" };
  }
  const data = (await res.json().catch(() => ({}))) as {
    repos?: SkillImportGithubRepo[];
  };
  return { ok: true, repos: Array.isArray(data.repos) ? data.repos : [] };
}

export type SkillImportGithubEntry = {
  type: "file" | "dir";
  name: string;
  path: string;
  size: number;
};

export async function listImportGithubContents(
  workspaceId: string,
  connectorInstanceId: string,
  owner: string,
  repo: string,
  path: string,
): Promise<
  { ok: true; entries: SkillImportGithubEntry[] } | { ok: false; error: string }
> {
  const params = new URLSearchParams({
    workspaceId,
    connectorInstanceId,
    owner,
    repo,
    path,
  });
  const res = await authFetch(
    `${API_URL}/api/skills/import/github/contents?${params.toString()}`,
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: data.error ?? "Failed to read the repository" };
  }
  const data = (await res.json().catch(() => ({}))) as {
    entries?: SkillImportGithubEntry[];
  };
  return { ok: true, entries: Array.isArray(data.entries) ? data.entries : [] };
}

// ── Support files (the skill's bundle) ───────────────────────────
//
// A skill is a folder, not a lone body: these rows hold its reference /
// template / script files and the body reaches them through `{{kind:name}}`
// pointers the loader expands at `useSkill` time. Backed by
// `GET/PUT/DELETE /api/skills/:id/files`; spec:
// docs/architecture/engine/skill-system.md → "Support files".

export type SkillFileKind = "reference" | "asset" | "template" | "script";

export const SKILL_FILE_KINDS: SkillFileKind[] = [
  "reference",
  "asset",
  "template",
  "script",
];

export type SkillFile = {
  kind: SkillFileKind;
  name: string;
  path: string | null;
  content: string;
  description: string | null;
  contentHash: string | null;
  /** ISO timestamp of the last write (the curator writes here too). */
  updatedAt: string;
};

/** The `{{kind:name}}` pointer that expands this file into the body. */
export function skillFilePointer(file: {
  kind: SkillFileKind;
  name: string;
}): string {
  return `{{${file.kind}:${file.name}}}`;
}

/** Portable relative link used by bundle-v2 SKILL.md bodies. */
export function skillFileMarkdownLink(file: {
  name: string;
  path: string | null;
}): string | null {
  return file.path ? `[${file.name}](${file.path})` : null;
}

/**
 * A skill's support files. `501` (deployment without the files store) maps to
 * an empty list so the editor simply renders no bundle section rather than an
 * error — same degrade-quietly posture as the access rail.
 */
export async function listSkillFiles(
  skillRowId: string,
): Promise<{ ok: true; files: SkillFile[] } | { ok: false; error: string }> {
  const res = await authFetch(`${API_URL}/api/skills/${skillRowId}/files`);
  if (res.status === 501) return { ok: true, files: [] };
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: data.error ?? "Failed to load support files" };
  }
  const data = (await res.json().catch(() => ({}))) as { files?: SkillFile[] };
  return { ok: true, files: Array.isArray(data.files) ? data.files : [] };
}

/** Create or replace one support file, keyed by `(kind, name)`. */
export async function saveSkillFile(
  skillRowId: string,
  file: {
    kind: SkillFileKind;
    name: string;
    path?: string | null;
    content: string;
    description?: string | null;
  },
): Promise<{ ok: true; file: SkillFile } | { ok: false; error: string }> {
  const res = await authFetch(`${API_URL}/api/skills/${skillRowId}/files`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(file),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: data.error ?? "Failed to save the file" };
  }
  const data = (await res.json().catch(() => ({}))) as { file?: SkillFile };
  if (!data.file) return { ok: false, error: "Failed to save the file" };
  return { ok: true, file: data.file };
}

export async function deleteSkillFile(
  skillRowId: string,
  kind: SkillFileKind,
  name: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const params = new URLSearchParams({ kind, name });
  const res = await authFetch(
    `${API_URL}/api/skills/${skillRowId}/files?${params.toString()}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: data.error ?? "Failed to delete the file" };
  }
  return { ok: true };
}

// ── Bulk group suggestion ────────────────────────────────────────
//
// Propose → review → apply, never one shot: `suggestSkillGroups` writes
// nothing and `applySkillGroups` takes only the assignments the user has
// seen. Backed by `POST /api/skills/categorize` + `/categorize/apply`; spec:
// docs/architecture/engine/skill-system.md → "Suggesting groups".

export type SkillGroupSuggestion = {
  skillRowId: string;
  name: string;
  current: string;
  suggested: string;
  /** Short model rationale; absent when it returned none. */
  rationale?: string;
};

/**
 * Ask for a group per unsorted skill. `considered` is how many were in the
 * batch, which is NOT `suggestions.length` — a skill the model left where it
 * was produces no row. `501`/`503` (no workspace store / no provider) map to
 * an unavailable result so the caller can hide the affordance rather than
 * show an error for a feature this deployment simply lacks.
 */
export async function suggestSkillGroups(
  workspaceId: string,
): Promise<
  | { ok: true; suggestions: SkillGroupSuggestion[]; considered: number }
  | { ok: false; unavailable: boolean; error: string }
> {
  const res = await authFetch(`${API_URL}/api/skills/categorize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return {
      ok: false,
      unavailable: res.status === 501 || res.status === 503,
      error: data.error ?? "Failed to suggest groups",
    };
  }
  const data = (await res.json().catch(() => ({}))) as {
    suggestions?: SkillGroupSuggestion[];
    considered?: number;
  };
  return {
    ok: true,
    suggestions: Array.isArray(data.suggestions) ? data.suggestions : [],
    considered: typeof data.considered === "number" ? data.considered : 0,
  };
}

/** Apply the reviewed assignments. `failed` names rows that matched nothing. */
export async function applySkillGroups(
  workspaceId: string,
  assignments: { skillRowId: string; category: string }[],
): Promise<
  { ok: true; updated: number; failed: string[] } | { ok: false; error: string }
> {
  const res = await authFetch(`${API_URL}/api/skills/categorize/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId, assignments }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: data.error ?? "Failed to apply groups" };
  }
  const data = (await res.json().catch(() => ({}))) as {
    updated?: number;
    failed?: string[];
  };
  return {
    ok: true,
    updated: typeof data.updated === "number" ? data.updated : 0,
    failed: Array.isArray(data.failed) ? data.failed : [],
  };
}

/** A skill invocable as a slash command (`/slug …`). Menu hint only: the
 *  server re-applies the full governance gates at invocation, and a command
 *  that resolves to nothing falls through as plain conversational text. */
export type InvocableSkill = {
  slug: string;
  name: string;
  description: string;
};

/**
 * The roster the composer's `/` autocomplete offers: built-in skills (enabled
 * by default for every assistant) plus this workspace's own activated skills.
 * Community/published catalog entries are deliberately excluded — they need
 * an explicit install/enablement before they'd resolve. Empty on any failure:
 * the menu simply doesn't open, and typed commands still work.
 */
export async function listInvocableSkills(
  workspaceId: string | null,
): Promise<InvocableSkill[]> {
  const [catalog, workspace] = await Promise.all([
    authFetch(`${API_URL}/api/skills/catalog`)
      .then((res) =>
        res.ok ? (res.json() as Promise<{ skills?: unknown }>) : { skills: [] },
      )
      .catch(() => ({ skills: [] as unknown[] })),
    workspaceId
      ? listWorkspaceSkills(workspaceId).catch(() => [])
      : Promise.resolve([]),
  ]);
  const bySlug = new Map<string, InvocableSkill>();
  const catalogSkills = Array.isArray(catalog.skills) ? catalog.skills : [];
  for (const raw of catalogSkills) {
    const s = raw as { id?: unknown; name?: unknown; description?: unknown; source?: unknown };
    if (s.source !== "builtin") continue;
    if (typeof s.id !== "string" || typeof s.name !== "string") continue;
    bySlug.set(s.id, {
      slug: s.id,
      name: s.name,
      description: typeof s.description === "string" ? s.description : "",
    });
  }
  for (const s of workspace) {
    // Suggested drafts (never activated) and archived skills aren't offered
    // to the model, so don't offer them as commands either.
    if (!s.activatedAt || s.state === "archived") continue;
    bySlug.set(s.slug, { slug: s.slug, name: s.name, description: s.description });
  }
  return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}
