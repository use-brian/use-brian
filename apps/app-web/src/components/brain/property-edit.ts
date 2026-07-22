/**
 * Pure logic behind the brain entry page's Notion-style property list —
 * everything the drawer needs that is testable without a DOM.
 *
 * The detail drawer (detail-drawer.tsx) renders one interactive property
 * row per editable field and commits each field independently through
 * `adjustBrainRow`. This module owns:
 *
 *   - the per-primitive "dedicated key" sets (fields that get their own
 *     interactive row and must not re-appear in the generic read-only list),
 *   - tag parsing/compare (comma-separated editor, server-parity trim+filter),
 *   - date <input type="date"> ↔ ISO conversion (day-start UTC pinning),
 *   - optimistic body patching after a successful adjust,
 *   - the adjust-response new-id extraction (task + memory adjusts supersede
 *     the row and mint a new bi-temporal id; the drawer re-anchors instead of
 *     closing).
 *
 * Spec: docs/architecture/brain/corrections.md → "Entry page view".
 * [COMP:app-web/brain-property-fields]
 */

import type { AdjustMemoryChanges, BrainPrimitive } from "@/lib/api/brain-inbox";

/** Body fields that should never reach the user — provenance plumbing,
 *  not entry content. */
const HIDDEN_BODY_KEYS = new Set([
  "source_episode_id",
  "source_session_id",
  "assistant_id",
  "user_id",
  "verified_by_user_id",
  "verified_at",
  "original_scope",
  "original_sensitivity",
  "original_summary",
  "entity_id",
  "canonical_id",
]);

/**
 * Fields that render as dedicated (mostly interactive) property rows per
 * primitive. The generic read-only remainder (`extraBodyFields`) excludes
 * them so a field never shows up twice.
 */
export const PRIMITIVE_DEDICATED_KEYS: Record<string, ReadonlySet<string>> = {
  task: new Set([
    "title",
    "status",
    "due_at",
    "tags",
    "sensitivity",
    "attributes",
    "assignee_id",
  ]),
  memory: new Set(["summary", "detail", "scope", "sensitivity", "tags"]),
  workspace_file: new Set(["name", "sensitivity", "tags"]),
  contact: new Set(["name", "display_name", "sensitivity", "kind"]),
  company: new Set(["name", "display_name", "sensitivity", "kind"]),
  deal: new Set(["name", "display_name", "sensitivity", "kind"]),
  entity: new Set(["display_name", "sensitivity", "kind", "attributes", "aliases"]),
};

/** Parse the comma-separated tags editor into the wire tag set. Mirrors the
 *  server's normalisation (trim + drop empties) so the change detection in
 *  the drawer compares like with like. */
export function parseTagsInput(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function tagsEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((tag, i) => tag === b[i]);
}

/** Read a string[] tag set out of an untyped body value. */
export function bodyTags(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : [];
}

/** `<input type="date">` value → ISO string for the adjust wire, pinned to
 *  day-start UTC (matches the pre-redesign edit form). Empty clears. */
export function dateInputToIso(d: string): string | null {
  const trimmed = d.trim();
  if (trimmed.length === 0) return null;
  return new Date(`${trimmed}T00:00:00.000Z`).toISOString();
}

/** ISO (or unknown) body value → `<input type="date">` seed. */
export function isoToDateInput(v: unknown): string {
  const s = String(v ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

// The adjust-response new-id extraction (`parseAdjustNewId`) lives with the
// wire call in `@/lib/api/brain-inbox` — re-exported here so the property
// logic tests exercise one module.
export { parseAdjustNewId } from "@/lib/api/brain-inbox";

/**
 * Optimistically patch a row body after a successful adjust so the open
 * panel reflects the edit without a refetch. CRM rows read their label from
 * `name` (falling back to `display_name`), so a display_name change patches
 * both. `reason` is audit metadata, never a body field.
 */
export function applyChangesToBody(
  body: Record<string, unknown>,
  changes: AdjustMemoryChanges,
  primitive: BrainPrimitive,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...body };
  if (changes.title !== undefined) next.title = changes.title;
  if (changes.status !== undefined) next.status = changes.status;
  if (changes.due_at !== undefined) next.due_at = changes.due_at;
  if (changes.tags !== undefined) next.tags = changes.tags;
  if (changes.assignee_id !== undefined) next.assignee_id = changes.assignee_id;
  if (changes.priority !== undefined) {
    // Mirrors the server: priority lives under the free-form `attributes`
    // object (merge, never clobber siblings); null removes the key.
    const raw = body.attributes;
    const attrs: Record<string, unknown> =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? { ...(raw as Record<string, unknown>) }
        : {};
    if (changes.priority === null) delete attrs.priority;
    else attrs.priority = changes.priority;
    next.attributes = attrs;
  }
  if (changes.summary !== undefined) next.summary = changes.summary;
  if (changes.detail !== undefined) next.detail = changes.detail;
  if (changes.scope !== undefined) next.scope = changes.scope;
  if (changes.sensitivity !== undefined) next.sensitivity = changes.sensitivity;
  if (changes.display_name !== undefined) {
    next.display_name = changes.display_name;
    const isCrm =
      primitive === "contact" || primitive === "company" || primitive === "deal";
    if (isCrm) next.name = changes.display_name;
  }
  return next;
}

/**
 * The generic read-only remainder of a row body: everything that is not
 * hidden plumbing and not already rendered as a dedicated property row.
 * Values are pre-formatted for display.
 */
export function extraBodyFields(
  primitive: string,
  body: Record<string, unknown>,
): Array<[string, string]> {
  const dedicated = PRIMITIVE_DEDICATED_KEYS[primitive];
  return Object.entries(body)
    .filter(
      ([k, v]) =>
        !HIDDEN_BODY_KEYS.has(k) &&
        !(dedicated?.has(k) ?? false) &&
        v != null &&
        v !== "",
    )
    .map(([k, v]) => [k, formatValue(v)] as [string, string]);
}

/** Flatten a free-form `attributes` JSON object into displayable rows.
 *  Non-object payloads produce no rows (the generic list already skips
 *  the key for primitives that mark it dedicated). `omit` drops keys that
 *  already render as dedicated rows (the task Priority row). */
export function flattenAttributes(
  v: unknown,
  omit?: ReadonlySet<string>,
): Array<[string, string]> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return [];
  return Object.entries(v as Record<string, unknown>)
    .filter(([key, value]) => value != null && value !== "" && !(omit?.has(key) ?? false))
    .map(([key, value]) => [key, formatValue(value)] as [string, string]);
}

/** Read the conventional `attributes.priority` key off an untyped body
 *  attributes value. Empty string when unset or malformed. */
export function attributePriority(v: unknown): string {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "";
  const p = (v as Record<string, unknown>).priority;
  return typeof p === "string" ? p : "";
}

export function formatValue(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return d.toLocaleString();
    }
    return v;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return "";
    return v
      .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
      .join(", ");
  }
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 0) return "";
    return JSON.stringify(v, null, 2);
  }
  return String(v);
}

export function humaniseKey(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * The slice of a workspace-roster row the task Assignee property needs.
 * `id` is the `workspace_members` row id — that is what `tasks.assignee_id`
 * stores (docs/architecture/features/tasks.md → design decision #2), NOT the
 * account's `users.id`.
 */
export type AssignableMember = {
  id: string;
  userName: string | null;
  email: string | null;
  avatarUrl: string | null;
  role: string;
};

/** Resolve a task's `assignee_id` against the workspace roster. Null when
 *  unassigned or when the member row no longer exists (the FK is SET NULL on
 *  member removal, so a dangling id only appears on a stale roster). */
export function resolveAssignee(
  members: AssignableMember[],
  assigneeId: unknown,
): AssignableMember | null {
  if (typeof assigneeId !== "string" || assigneeId.length === 0) return null;
  return members.find((m) => m.id === assigneeId) ?? null;
}

/** Display name for a roster member: name, else email, else null (the
 *  caller renders its own unknown-member fallback). */
export function memberDisplayName(m: AssignableMember): string | null {
  return m.userName || m.email || null;
}

// ── Value-pill state dots (shared by the Brain drawer + the operator peek
//    panels, so a task reads identically on both surfaces) ──────────────

/** State-dot tints for the Notion-style value pills (muted pill, colored
 *  dot, sentence-case label). Live work earns colour; terminal states stay
 *  neutral. */
export const TASK_STATUS_DOT_CLASS: Record<string, string> = {
  todo: "bg-muted-foreground/40",
  in_progress: "bg-primary",
  blocked: "bg-amber-500",
  done: "bg-emerald-500",
  archived: "bg-muted-foreground/30",
};

/** Priority tints — urgency earns heat; "none" stays neutral. Values live
 *  under `attributes.priority` (the frozen-v1 tasks schema has no typed
 *  column). */
export const TASK_PRIORITY_DOT_CLASS: Record<string, string> = {
  none: "bg-muted-foreground/30",
  low: "bg-sky-500",
  medium: "bg-amber-500",
  high: "bg-orange-500",
  urgent: "bg-red-500",
};
