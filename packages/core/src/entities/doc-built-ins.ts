/**
 * Doc v1 — built-in entity type declarations.
 *
 * The doc entity layer (Lock #11) coexists in two halves:
 *
 *   - User-defined types live in the `entity_types` / `entity_instances`
 *     tables (migration 200) — declared in `./doc-types.ts`.
 *   - Built-in types — tasks, contacts, companies, deals, workflow runs —
 *     keep their dedicated Postgres tables (migrations 113/114/115). This
 *     module *projects* those tables through the same `DocEntityType`
 *     shape so they appear alongside user-defined types in
 *     `listEntityTypes()`.
 *
 * The built-in instance data continues to live in `tasks` / `companies` /
 * `contacts` / `deals` / `workflow_runs`. This file is purely metadata —
 * the hardcoded schemas a downstream store implementation can return
 * without touching JSONB. The IDs are deterministic strings
 * (`builtin:task`, etc.), not UUIDs, so consumers can distinguish a
 * built-in projection from a real user-defined type at a glance.
 *
 * Schema-mirroring sources:
 *   - Tasks    — migration 113, `packages/core/src/tasks/types.ts`
 *   - CRM      — migration 114, `packages/core/src/crm/types.ts`
 *   - Workflow — migration 115, `packages/core/src/workflow/types.ts`
 *
 * Phase 1 scope: get a "reasonable" projection for each built-in. Phase 2+
 * may refine (rich-text status colors, deal-stage labels, etc.) without
 * changing this module's surface.
 *
 * [COMP:entities/doc-built-ins]
 */

import type {
  EntityType as DocEntityType,
  PropertyDef,
  StatusGroup,
} from './doc-types.js'

// ── Built-in name vocabulary ──────────────────────────────────────────

/**
 * The closed enum of built-in entity-type names. Matches
 * `EntityTypeRef.builtin.name` in `./doc-types.ts` so a `relation`
 * property can target a built-in via `{ kind: 'builtin', name: <here> }`.
 */
export const BUILTIN_ENTITY_TYPE_NAMES = [
  'task',
  'contact',
  'company',
  'deal',
  'workflow_run',
] as const
export type BuiltInEntityTypeName = (typeof BUILTIN_ENTITY_TYPE_NAMES)[number]

/**
 * Sentinel epoch — built-ins are not real DB rows, so `createdAt` is a
 * fixed value rather than `now()`. Consumers should treat the stamp as
 * "always existed" and key cache-invalidation on `schemaVersion`.
 */
const BUILTIN_EPOCH = '1970-01-01T00:00:00.000Z'

const BUILTIN_SCHEMA_VERSION = 1

// ── Status / select option helpers ────────────────────────────────────

/**
 * `tasks.status` enum from migration 113 mapped onto the doc status
 * group shape. The five literals fan out into the three canonical groups
 * (`pending` / `in_progress` / `done`).
 */
const TASK_STATUS_GROUPS: StatusGroup[] = [
  {
    id: 'pending',
    label: 'Pending',
    options: [{ id: 'todo', name: 'Todo', color: 'gray' }],
  },
  {
    id: 'in_progress',
    label: 'In progress',
    options: [
      { id: 'in_progress', name: 'In progress', color: 'blue' },
      { id: 'blocked', name: 'Blocked', color: 'red' },
    ],
  },
  {
    id: 'done',
    label: 'Done',
    options: [
      { id: 'done', name: 'Done', color: 'green' },
      { id: 'archived', name: 'Archived', color: 'gray' },
    ],
  },
]

/**
 * `deals.stage` enum from migration 114. Lead / qualified / proposal /
 * negotiation feed the `in_progress` lane; `won` / `lost` land in `done`
 * (a closed-lost deal is still resolved).
 */
const DEAL_STAGE_GROUPS: StatusGroup[] = [
  {
    id: 'pending',
    label: 'Pending',
    options: [{ id: 'lead', name: 'Lead', color: 'gray' }],
  },
  {
    id: 'in_progress',
    label: 'In progress',
    options: [
      { id: 'qualified', name: 'Qualified', color: 'blue' },
      { id: 'proposal', name: 'Proposal', color: 'purple' },
      { id: 'negotiation', name: 'Negotiation', color: 'orange' },
    ],
  },
  {
    id: 'done',
    label: 'Done',
    options: [
      { id: 'won', name: 'Won', color: 'green' },
      { id: 'lost', name: 'Lost', color: 'red' },
    ],
  },
]

/**
 * `workflow_runs.status` enum from migration 115. `pending` → pending;
 * `running` / `awaiting_wait` / `awaiting_input` → in_progress;
 * `completed` / `failed` / `timeout` → done.
 */
const WORKFLOW_RUN_STATUS_GROUPS: StatusGroup[] = [
  {
    id: 'pending',
    label: 'Pending',
    options: [{ id: 'pending', name: 'Pending', color: 'gray' }],
  },
  {
    id: 'in_progress',
    label: 'In progress',
    options: [
      { id: 'running', name: 'Running', color: 'blue' },
      { id: 'awaiting_wait', name: 'Awaiting wait', color: 'yellow' },
      { id: 'awaiting_input', name: 'Awaiting input', color: 'orange' },
    ],
  },
  {
    id: 'done',
    label: 'Done',
    options: [
      { id: 'completed', name: 'Completed', color: 'green' },
      { id: 'failed', name: 'Failed', color: 'red' },
      { id: 'timeout', name: 'Timeout', color: 'red' },
    ],
  },
]

// ── Common property fragments ─────────────────────────────────────────
//
// Every built-in table has `created_at` + `updated_at` and is touched by
// a real user, so each projection ends with the four auto properties.

const COMMON_AUDIT_PROPERTIES: PropertyDef[] = [
  { name: 'created_at', label: 'Created at', config: { kind: 'created_time' } },
  { name: 'created_by', label: 'Created by', config: { kind: 'created_by' } },
  {
    name: 'last_edited_at',
    label: 'Last edited at',
    config: { kind: 'last_edited_time' },
  },
  {
    name: 'last_edited_by',
    label: 'Last edited by',
    config: { kind: 'last_edited_by' },
  },
]

// ── Per-built-in property declarations ────────────────────────────────

const TASK_PROPERTIES: PropertyDef[] = [
  { name: 'title', label: 'Title', config: { kind: 'text' }, required: true },
  {
    name: 'status',
    label: 'Status',
    config: { kind: 'status', groups: TASK_STATUS_GROUPS },
  },
  {
    name: 'assignee',
    label: 'Assignee',
    config: { kind: 'person' },
  },
  {
    name: 'due_date',
    label: 'Due date',
    config: { kind: 'date', includeTime: true },
  },
  {
    name: 'tags',
    label: 'Tags',
    config: { kind: 'multi_select', options: [] },
  },
  {
    name: 'parent_task',
    label: 'Parent task',
    config: {
      kind: 'relation',
      targetEntityTypeRef: { kind: 'builtin', name: 'task' },
    },
  },
  ...COMMON_AUDIT_PROPERTIES,
]

const CONTACT_PROPERTIES: PropertyDef[] = [
  { name: 'name', label: 'Name', config: { kind: 'text' }, required: true },
  { name: 'email', label: 'Email', config: { kind: 'email' } },
  { name: 'phone', label: 'Phone', config: { kind: 'phone' } },
  {
    name: 'company',
    label: 'Company',
    config: {
      kind: 'relation',
      targetEntityTypeRef: { kind: 'builtin', name: 'company' },
    },
  },
  {
    name: 'tags',
    label: 'Tags',
    config: { kind: 'multi_select', options: [] },
  },
  ...COMMON_AUDIT_PROPERTIES,
]

const COMPANY_PROPERTIES: PropertyDef[] = [
  { name: 'name', label: 'Name', config: { kind: 'text' }, required: true },
  { name: 'website', label: 'Website', config: { kind: 'url' } },
  {
    name: 'tags',
    label: 'Tags',
    config: { kind: 'multi_select', options: [] },
  },
  ...COMMON_AUDIT_PROPERTIES,
]

const DEAL_PROPERTIES: PropertyDef[] = [
  { name: 'name', label: 'Name', config: { kind: 'text' }, required: true },
  {
    name: 'stage',
    label: 'Stage',
    config: { kind: 'status', groups: DEAL_STAGE_GROUPS },
  },
  {
    name: 'amount',
    label: 'Amount',
    config: { kind: 'number', format: 'dollar' },
  },
  {
    name: 'close_date',
    label: 'Close date',
    config: { kind: 'date' },
  },
  {
    name: 'contact',
    label: 'Contact',
    config: {
      kind: 'relation',
      targetEntityTypeRef: { kind: 'builtin', name: 'contact' },
    },
  },
  {
    name: 'company',
    label: 'Company',
    config: {
      kind: 'relation',
      targetEntityTypeRef: { kind: 'builtin', name: 'company' },
    },
  },
  ...COMMON_AUDIT_PROPERTIES,
]

const WORKFLOW_RUN_PROPERTIES: PropertyDef[] = [
  { name: 'name', label: 'Name', config: { kind: 'text' }, required: true },
  {
    name: 'status',
    label: 'Status',
    config: { kind: 'status', groups: WORKFLOW_RUN_STATUS_GROUPS },
  },
  {
    name: 'workflow_id',
    label: 'Workflow ID',
    config: { kind: 'text' },
  },
  {
    name: 'started_at',
    label: 'Started at',
    config: { kind: 'date', includeTime: true },
  },
  {
    name: 'finished_at',
    label: 'Finished at',
    config: { kind: 'date', includeTime: true },
  },
  ...COMMON_AUDIT_PROPERTIES,
]

// ── Type-level metadata ───────────────────────────────────────────────

const BUILTIN_DISPLAY: Record<
  BuiltInEntityTypeName,
  { displayName: string; icon: string; properties: PropertyDef[] }
> = {
  task: {
    displayName: 'Task',
    icon: 'square-check',
    properties: TASK_PROPERTIES,
  },
  contact: {
    displayName: 'Contact',
    icon: 'user',
    properties: CONTACT_PROPERTIES,
  },
  company: {
    displayName: 'Company',
    icon: 'building',
    properties: COMPANY_PROPERTIES,
  },
  deal: {
    displayName: 'Deal',
    icon: 'briefcase',
    properties: DEAL_PROPERTIES,
  },
  workflow_run: {
    displayName: 'Workflow run',
    icon: 'workflow',
    properties: WORKFLOW_RUN_PROPERTIES,
  },
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Returns the `DocEntityType` projection for one built-in primitive.
 *
 * The `id` is the deterministic string `builtin:<name>` (not a UUID) so
 * consumers can distinguish a built-in row from a user-defined one
 * without consulting a sentinel column. `createdBy` is `null` because no
 * user authored the schema — it's project-seeded.
 */
export function getBuiltInEntityType(
  workspaceId: string,
  name: BuiltInEntityTypeName,
): DocEntityType {
  const { displayName, icon, properties } = BUILTIN_DISPLAY[name]
  return {
    id: `builtin:${name}`,
    workspaceId,
    name: displayName,
    icon,
    properties,
    schemaVersion: BUILTIN_SCHEMA_VERSION,
    createdAt: BUILTIN_EPOCH,
    createdBy: null,
  }
}

/**
 * Enumerates every built-in entity type for a workspace. Returned in
 * the order declared by `BUILTIN_ENTITY_TYPE_NAMES`, which is the order
 * the chat sidebar / `listEntityTypes` consumer should render.
 */
export function listBuiltInEntityTypes(
  workspaceId: string,
): DocEntityType[] {
  return BUILTIN_ENTITY_TYPE_NAMES.map(name =>
    getBuiltInEntityType(workspaceId, name),
  )
}

/**
 * Type guard — does the given id reference a built-in entity type? Cheap
 * string check that lets callers branch the storage path (built-in →
 * dedicated table, user-defined → entity_instances JSONB) without an
 * extra schema lookup.
 */
export function isBuiltInEntityTypeId(id: string): boolean {
  if (!id.startsWith('builtin:')) return false
  const tail = id.slice('builtin:'.length)
  return (BUILTIN_ENTITY_TYPE_NAMES as readonly string[]).includes(tail)
}
