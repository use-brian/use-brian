/**
 * Brain inbox store — unified unverified-row list across every brain
 * primitive that carries the universal `verified_by_user_id` column
 * (mig 128 / WU-2.1).
 *
 * Generalises the per-assistant + per-workspace memory unverified
 * listing in `memories.ts` (`listUnverifiedByWorkspace` /
 * `countUnverifiedByWorkspace`) to also surface model-saved entities,
 * entity links, tasks, CRM rows, and workspace files.
 *
 * Spec: [`docs/architecture/brain/corrections.md`](../../../../docs/architecture/brain/corrections.md).
 *
 * ── V1 scope ──
 *
 * Only **chat-tool saves** appear (i.e. `source = 'model'`). Pipeline B
 * extraction (`source = 'extracted'`) is excluded — a single meeting
 * transcript that mentions 30 people would otherwise flood the inbox
 * overnight. A separate "Extraction queue" surface tuned for higher
 * signal-to-noise is the follow-up.
 *
 * ── Query shape ──
 *
 * UNION ALL across the seven primitive tables. Each branch hits its
 * mig 174 partial index (`idx_<table>_unverified_workspace`). Per-row
 * primitive-specific columns are packed into a `body JSONB` blob —
 * frontend reads them per the `primitive` discriminator. The `entity_link`
 * branch additionally resolves `body.source_label` + `body.target_label`
 * (each edge endpoint's human name, via `edgeEndpointLabelSql`) so the review
 * UI can render the relationship as a labelled source → edge → target diagram
 * rather than the raw "memory → documented_by → file" + bare endpoint UUIDs.
 *
 * DANGLING edges (an endpoint deleted out from under the edge — hard-deleted,
 * soft-deleted via `valid_to`, or retracted) carry nothing to review, so the
 * `entity_link` list + count branches EXCLUDE them (`danglingEntityLinkSql`)
 * and `pruneDanglingEntityLinks` soft-deletes them lazily from the list route
 * — auto-pruning the dead relationships instead of asking the user to confirm
 * an edge that points at nothing.
 *
 * ── COMP ──
 * Component-map tag: `brain/inbox-store`.
 */

import { query } from './client.js'

export type BrainInboxPrimitive =
  | 'memory'
  | 'entity'
  | 'entity_link'
  | 'task'
  | 'contact'
  | 'company'
  | 'deal'
  | 'workspace_file'

export type BrainInboxRow = {
  primitive: BrainInboxPrimitive
  id: string
  workspaceId: string
  createdAt: Date
  createdByAssistantId: string | null
  /** Primitive-specific payload — TypeScript-side discriminated by `primitive`. */
  body: Record<string, unknown>
}

export type ListBrainInboxResult = {
  rows: BrainInboxRow[]
  /** Opaque base64 cursor; null when fewer than `limit` rows returned. */
  cursor: string | null
}

/** Tables we union over, in the same order as the UNION subqueries.
 *  Each table must (a) carry the universal column set (mig 128) and
 *  (b) have a partial index `idx_<table>_unverified_workspace` from
 *  mig 174 — that's what keeps each branch fast. */
const PRIMITIVE_TABLES: readonly BrainInboxPrimitive[] = [
  'memory',
  'entity',
  'entity_link',
  'task',
  'contact',
  'company',
  'deal',
  'workspace_file',
] as const

/** Resolve an `entity_link` endpoint id to a human label for the inbox row,
 *  so the frontend can render "Documented by file: roadmap.pdf" instead of
 *  the raw "memory → documented_by → file". The endpoint kind picks the
 *  table; an unresolvable kind (episode / kb_chunk) yields NULL and the
 *  frontend falls back to the humanised kind. `kindCol` / `idCol` are the
 *  qualified columns of the aliased `entity_links el` row (e.g.
 *  `el.target_kind`). Correlated subqueries — the inbox is small
 *  (`source='model'`, capped limit), so the per-row lookups are cheap.
 *
 *  `skill` + `assistant` are the `learned_from` induction-provenance
 *  endpoints (skill → learned_from → assistant): without them a review of
 *  that edge read "Skill → Learned from → Assistant" — the bare kind names,
 *  telling the reviewer nothing about WHICH skill or assistant they were
 *  confirming. Resolving `workspace_skills.name` / `assistants.name` here
 *  makes the source card name the actual skill and the target the actual
 *  assistant (the frontend then offers a preview link for the skill). */
function edgeEndpointLabelSql(kindCol: string, idCol: string): string {
  return `(CASE ${kindCol}
             WHEN 'file' THEN (SELECT name FROM workspace_files WHERE id = ${idCol})
             WHEN 'entity' THEN (SELECT display_name FROM entities WHERE id = ${idCol})
             WHEN 'memory' THEN (SELECT summary FROM memories WHERE id = ${idCol})
             WHEN 'task' THEN (SELECT title FROM tasks WHERE id = ${idCol})
             WHEN 'skill' THEN (SELECT name FROM workspace_skills WHERE id = ${idCol})
             WHEN 'assistant' THEN (SELECT name FROM assistants WHERE id = ${idCol})
             ELSE NULL END)`
}

/** SQL boolean: is `entity_link` row `${alias}` DANGLING — i.e. does either
 *  endpoint point at a row that is no longer LIVE? An endpoint counts as
 *  present only when its row exists AND is active (`valid_to IS NULL AND
 *  retracted_at IS NULL`) — soft delete is the platform's DEFAULT delete
 *  (corrections.md D.4, including the review UI's own delete button), so a
 *  soft-deleted or retracted endpoint must orphan the edge exactly like a
 *  hard delete. Only RESOLVABLE kinds (memory / file / task / entity) can be
 *  checked; for non-resolvable kinds (episode / kb_chunk / event) we can't
 *  tell, so they're treated as present (never dangling) — conservative, we
 *  only prune when we're SURE the endpoint is gone. A dangling edge carries
 *  nothing to review; the inbox excludes these and
 *  `pruneDanglingEntityLinks` soft-deletes them. */
function danglingEntityLinkSql(alias: string): string {
  const live = 'sub.valid_to IS NULL AND sub.retracted_at IS NULL'
  const missing = (kindCol: string, idCol: string) =>
    `(CASE ${kindCol}
        WHEN 'memory' THEN NOT EXISTS (SELECT 1 FROM memories sub WHERE sub.id = ${idCol} AND ${live})
        WHEN 'file' THEN NOT EXISTS (SELECT 1 FROM workspace_files sub WHERE sub.id = ${idCol} AND ${live})
        WHEN 'task' THEN NOT EXISTS (SELECT 1 FROM tasks sub WHERE sub.id = ${idCol} AND ${live})
        WHEN 'entity' THEN NOT EXISTS (SELECT 1 FROM entities sub WHERE sub.id = ${idCol} AND ${live})
        ELSE FALSE END)`
  return `(${missing(`${alias}.source_kind`, `${alias}.source_id`)}
        OR ${missing(`${alias}.target_kind`, `${alias}.target_id`)})`
}

/**
 * Auto-prune the review queue's dead relationships: soft-delete (`valid_to =
 * now()`) every unverified, model-saved `entity_link` whose source or target
 * endpoint has been deleted (hard-deleted, soft-deleted, or retracted). A
 * dangling edge points at nothing, so there is literally nothing for the
 * user to confirm — leaving it in the inbox is
 * noise (and the count badge over-states the real backlog). Idempotent: once
 * an edge is pruned it has `valid_to`, so re-runs touch 0 rows. Scoped to
 * `source = 'model'` (what the review surface shows) so it never sweeps the
 * large extracted-edge backlog. Called lazily from the inbox list route when
 * edges are in scope. Returns the number of rows pruned.
 *
 * System-level — caller (route) enforces workspace membership.
 */
export async function pruneDanglingEntityLinks(
  workspaceId: string,
): Promise<number> {
  const result = await query(
    `UPDATE entity_links el SET valid_to = now()
     WHERE el.workspace_id = $1
       AND el.source = 'model'
       AND el.valid_to IS NULL
       AND el.verified_by_user_id IS NULL
       AND el.retracted_at IS NULL
       AND ${danglingEntityLinkSql('el')}`,
    [workspaceId],
  )
  return result.rowCount ?? 0
}

type Cursor = { createdAt: Date; id: string }

function decodeCursor(raw: string | undefined): Cursor | undefined {
  if (!raw) return undefined
  try {
    const decoded = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))
    if (
      decoded &&
      typeof decoded.createdAt === 'string' &&
      typeof decoded.id === 'string'
    ) {
      return { createdAt: new Date(decoded.createdAt), id: decoded.id }
    }
  } catch {
    // Malformed cursor → undefined → restart from head.
  }
  return undefined
}

function encodeCursor(row: BrainInboxRow): string {
  return Buffer.from(
    JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id }),
  ).toString('base64')
}

/**
 * Paginated unverified-row list for a workspace, oldest-newest by
 * `(created_at DESC, id DESC)`. Per-primitive filter optional —
 * `primitive=undefined` returns rows from every primitive; passing a
 * specific value restricts to that one.
 *
 * The `body` JSONB is shaped per primitive — see the per-primitive
 * SELECT clauses below for the exact keys.
 *
 * `includeExtracted` (default false) controls whether Pipeline B
 * extraction-derived rows (`source='extracted'`) surface in the
 * list. Default-off keeps the inbox tight on chat-tool saves; opt-in
 * surfaces the (much higher-volume) extraction stream — a single
 * meeting transcript can create 30+ person-entity rows. The UI
 * exposes a toggle for this; the chrome pill count uses the default
 * (off) value to stay quiet.
 *
 * System-level — caller (route) enforces workspace membership.
 */
export async function listBrainInbox(params: {
  workspaceId: string
  primitive?: BrainInboxPrimitive
  cursor?: string
  limit?: number
  includeExtracted?: boolean
}): Promise<ListBrainInboxResult> {
  const limit = Math.min(params.limit ?? 20, 100)
  const cursor = decodeCursor(params.cursor)
  const sourceFilter = params.includeExtracted
    ? ['model', 'extracted']
    : ['model']

  // Parameter layout: $1 = workspaceId, $2 = sourceFilter (TEXT[]),
  // then optional cursor pair, then limit. The per-primitive subqueries
  // template `$sourceFilter` with `$2` (the array). cursor + limit
  // positions are computed dynamically from `values.length`.
  const values: unknown[] = [params.workspaceId, sourceFilter]
  const cursorFilter = cursor
    ? `WHERE (created_at, id) < ($${values.length + 1}, $${values.length + 2})`
    : ''
  if (cursor) {
    values.push(cursor.createdAt, cursor.id)
  }
  values.push(limit)
  const limitParam = `$${values.length}`

  // Per-primitive subqueries. Each:
  //   - filters workspace_id = $1
  //   - filters verified_by_user_id IS NULL (matches partial index)
  //   - filters valid_to IS NULL AND retracted_at IS NULL (active row)
  //   - filters source ∈ $2 (the sourceFilter array — by default just
  //     'model' for chat-tool saves; 'extracted' added when
  //     includeExtracted is true to surface Pipeline B output)
  //   - projects a uniform (primitive, id, workspace_id, created_at,
  //     created_by_assistant_id, body) tuple
  const branches: string[] = []

  if (!params.primitive || params.primitive === 'memory') {
    branches.push(`
      SELECT 'memory'::text AS primitive,
             id,
             workspace_id,
             created_at,
             created_by_assistant_id,
             jsonb_build_object(
               'summary', summary,
               'detail', detail,
               'scope', scope,
               'sensitivity', sensitivity,
               'tags', tags,
               'source_session_id', source_session_id,
               'source_episode_id', source_episode_id,
               'assistant_id', assistant_id,
               'user_id', user_id,
               'original_scope', original_scope,
               'original_sensitivity', original_sensitivity,
               'original_summary', original_summary
             ) AS body
      FROM memories
      WHERE workspace_id = $1
        AND verified_by_user_id IS NULL
        AND valid_to IS NULL
        AND retracted_at IS NULL
        AND source = ANY($2)
    `)
  }

  if (!params.primitive || params.primitive === 'entity') {
    branches.push(`
      SELECT 'entity'::text AS primitive,
             id,
             workspace_id,
             created_at,
             created_by_assistant_id,
             jsonb_build_object(
               'display_name', display_name,
               'kind', kind,
               'canonical_id', canonical_id,
               'attributes', attributes,
               'sensitivity', sensitivity,
               'source_episode_id', source_episode_id
             ) AS body
      FROM entities
      WHERE workspace_id = $1
        AND verified_by_user_id IS NULL
        AND valid_to IS NULL
        AND retracted_at IS NULL
        AND source = ANY($2)
        AND kind NOT IN ('person', 'company', 'deal')
    `)
    // Q24: person/company/deal entities are CRM-specialized — the CRM
    // row carries the user-facing fields. We surface those via the
    // contact/company/deal branches; the entity branch covers
    // 'project' / 'product' kinds only.
  }

  if (!params.primitive || params.primitive === 'entity_link') {
    branches.push(`
      SELECT 'entity_link'::text AS primitive,
             id,
             workspace_id,
             created_at,
             NULL::uuid AS created_by_assistant_id,
             jsonb_build_object(
               'edge_type', edge_type,
               'source_kind', source_kind,
               'source_id', source_id,
               'target_kind', target_kind,
               'target_id', target_id,
               'source_label', ${edgeEndpointLabelSql('el.source_kind', 'el.source_id')},
               'target_label', ${edgeEndpointLabelSql('el.target_kind', 'el.target_id')},
               'attributes', attributes,
               'sensitivity', sensitivity,
               'source_episode_id', source_episode_id
             ) AS body
      FROM entity_links el
      WHERE workspace_id = $1
        AND verified_by_user_id IS NULL
        AND valid_to IS NULL
        AND retracted_at IS NULL
        AND source = ANY($2)
        AND NOT ${danglingEntityLinkSql('el')}
    `)
    // entity_links lacks `created_by_assistant_id` in the shape we're
    // selecting — the column exists on the table but isn't always
    // populated. NULL-cast keeps the UNION column types aligned;
    // frontend treats null as "no author chip".
  }

  if (!params.primitive || params.primitive === 'task') {
    branches.push(`
      SELECT 'task'::text AS primitive,
             id,
             workspace_id,
             created_at,
             created_by_assistant_id,
             jsonb_build_object(
               'title', title,
               'status', status,
               'assignee_id', assignee_id,
               'due_at', due,
               'tags', tags,
               'attributes', attributes,
               'sensitivity', sensitivity,
               'source_episode_id', source_episode_id
             ) AS body
      FROM tasks
      WHERE workspace_id = $1
        AND verified_by_user_id IS NULL
        AND valid_to IS NULL
        AND retracted_at IS NULL
        AND source = ANY($2)
    `)
  }

  if (!params.primitive || params.primitive === 'contact') {
    branches.push(`
      SELECT 'contact'::text AS primitive,
             id,
             workspace_id,
             created_at,
             created_by_assistant_id,
             jsonb_build_object(
               'entity_id', id,
               'name', display_name,
               'email', COALESCE(attributes->>'email', canonical_id),
               'phone', attributes->>'phone',
               'tags', COALESCE(attributes->'tags', '[]'::jsonb),
               'sensitivity', sensitivity,
               'source_episode_id', source_episode_id
             ) AS body
      FROM entities
      WHERE workspace_id = $1
        AND kind = 'person'
        AND NOT COALESCE((attributes->>'self')::boolean, false)
        AND verified_by_user_id IS NULL
        AND valid_to IS NULL
        AND retracted_at IS NULL
        AND source = ANY($2)
    `)
  }

  if (!params.primitive || params.primitive === 'company') {
    branches.push(`
      SELECT 'company'::text AS primitive,
             id,
             workspace_id,
             created_at,
             created_by_assistant_id,
             jsonb_build_object(
               'entity_id', id,
               'name', display_name,
               'domain', COALESCE(attributes->>'domain', canonical_id),
               'tags', COALESCE(attributes->'tags', '[]'::jsonb),
               'sensitivity', sensitivity,
               'source_episode_id', source_episode_id
             ) AS body
      FROM entities
      WHERE workspace_id = $1
        AND kind = 'company'
        AND verified_by_user_id IS NULL
        AND valid_to IS NULL
        AND retracted_at IS NULL
        AND source = ANY($2)
    `)
  }

  if (!params.primitive || params.primitive === 'deal') {
    branches.push(`
      SELECT 'deal'::text AS primitive,
             id,
             workspace_id,
             created_at,
             created_by_assistant_id,
             jsonb_build_object(
               'entity_id', id,
               'stage', attributes->>'stage',
               'amount', attributes->>'amount',
               'close_date', attributes->>'close_date',
               'sensitivity', sensitivity,
               'source_episode_id', source_episode_id
             ) AS body
      FROM entities
      WHERE workspace_id = $1
        AND kind = 'deal'
        AND verified_by_user_id IS NULL
        AND valid_to IS NULL
        AND retracted_at IS NULL
        AND source = ANY($2)
    `)
  }

  if (!params.primitive || params.primitive === 'workspace_file') {
    branches.push(`
      SELECT 'workspace_file'::text AS primitive,
             id,
             workspace_id,
             created_at,
             created_by_assistant_id,
             jsonb_build_object(
               'name', name,
               -- the column is mime, not mime_type; keep the body key the frontend
               -- reads (mime_type) but source it from the real mime column so the
               -- inbox UNION doesn't throw.
               'mime_type', mime,
               'size_bytes', size_bytes,
               'tags', tags,
               'sensitivity', sensitivity,
               'source_episode_id', source_episode_id
             ) AS body
      FROM workspace_files
      WHERE workspace_id = $1
        AND verified_by_user_id IS NULL
        AND valid_to IS NULL
        AND retracted_at IS NULL
        AND source = ANY($2)
    `)
  }

  if (branches.length === 0) {
    return { rows: [], cursor: null }
  }

  const sql = `
    WITH inbox AS (
      ${branches.join(' UNION ALL ')}
    )
    SELECT primitive, id, workspace_id AS "workspaceId",
           created_at AS "createdAt",
           created_by_assistant_id AS "createdByAssistantId",
           body
    FROM inbox
    ${cursorFilter}
    ORDER BY "createdAt" DESC, id DESC
    LIMIT ${limitParam}
  `

  const result = await query<{
    primitive: BrainInboxPrimitive
    id: string
    workspaceId: string
    createdAt: Date
    createdByAssistantId: string | null
    body: Record<string, unknown>
  }>(sql, values)

  const rows: BrainInboxRow[] = result.rows.map((r) => ({
    primitive: r.primitive,
    id: r.id,
    workspaceId: r.workspaceId,
    createdAt: r.createdAt,
    createdByAssistantId: r.createdByAssistantId,
    body: r.body,
  }))

  const nextCursor =
    rows.length === limit ? encodeCursor(rows[rows.length - 1]) : null

  return { rows, cursor: nextCursor }
}

export type BrainInboxRowDetail = BrainInboxRow & {
  /** Userid of the verifier if the row has been confirmed, else null.
   *  Lets the detail page render a "Verified" banner instead of hiding
   *  the row once the user clicks Confirm. */
  verifiedByUserId: string | null
  /** Confirmation timestamp; null when not yet verified. */
  verifiedAt: Date | null
}

/**
 * Fetch a single brain-inbox row by (primitive, id) for the per-primitive
 * detail page. Same `body` JSONB shape as `listBrainInbox`, plus the
 * verified-state fields so the page can render a "Verified" badge
 * post-confirmation without immediately disappearing on the user.
 *
 * Returns `null` when the row doesn't exist, was soft-deleted
 * (`valid_to IS NOT NULL`), was retracted (`retracted_at IS NOT NULL`),
 * or belongs to a different workspace. We deliberately INCLUDE verified
 * rows (unlike the inbox list) so the page survives the verify click
 * and bookmark/deep-link patterns work.
 *
 * System-level — caller (route) enforces workspace membership.
 */
export async function getBrainInboxRow(
  workspaceId: string,
  primitive: BrainInboxPrimitive,
  rowId: string,
): Promise<BrainInboxRowDetail | null> {
  const select = SINGLE_ROW_SELECT[primitive]
  const result = await query<{
    primitive: BrainInboxPrimitive
    id: string
    workspaceId: string
    createdAt: Date
    createdByAssistantId: string | null
    verifiedByUserId: string | null
    verifiedAt: Date | null
    body: Record<string, unknown>
  }>(
    `${select}
       AND id = $2
       AND valid_to IS NULL
       AND retracted_at IS NULL`,
    [workspaceId, rowId],
  )
  const row = result.rows[0]
  if (!row) return null
  return {
    primitive: row.primitive,
    id: row.id,
    workspaceId: row.workspaceId,
    createdAt: row.createdAt,
    createdByAssistantId: row.createdByAssistantId,
    verifiedByUserId: row.verifiedByUserId,
    verifiedAt: row.verifiedAt,
    body: row.body,
  }
}

// Per-primitive SELECT clauses for the single-row fetch. Each must
// (a) project the same uniform tuple as the list UNION branches plus
// `verified_by_user_id` + `verified_at`, and (b) filter
// `workspace_id = $1` so the id-bind ($2) added by the caller is
// workspace-scoped. The caller appends the `AND id = $2 AND valid_to
// IS NULL AND retracted_at IS NULL` predicates.
const SINGLE_ROW_SELECT: Record<BrainInboxPrimitive, string> = {
  memory: `
    SELECT 'memory'::text AS primitive, id,
           workspace_id AS "workspaceId",
           created_at AS "createdAt",
           created_by_assistant_id AS "createdByAssistantId",
           verified_by_user_id AS "verifiedByUserId",
           verified_at AS "verifiedAt",
           jsonb_build_object(
             'summary', summary, 'detail', detail,
             'scope', scope, 'sensitivity', sensitivity, 'tags', tags,
             'source_session_id', source_session_id,
             'source_episode_id', source_episode_id,
             'assistant_id', assistant_id, 'user_id', user_id
           ) AS body
    FROM memories
    WHERE workspace_id = $1`,
  entity: `
    SELECT 'entity'::text AS primitive, id,
           workspace_id AS "workspaceId",
           created_at AS "createdAt",
           created_by_assistant_id AS "createdByAssistantId",
           verified_by_user_id AS "verifiedByUserId",
           verified_at AS "verifiedAt",
           jsonb_build_object(
             'display_name', display_name, 'kind', kind,
             'canonical_id', canonical_id, 'attributes', attributes,
             'sensitivity', sensitivity,
             'source_episode_id', source_episode_id
           ) AS body
    FROM entities
    WHERE workspace_id = $1`,
  entity_link: `
    SELECT 'entity_link'::text AS primitive, id,
           workspace_id AS "workspaceId",
           created_at AS "createdAt",
           NULL::uuid AS "createdByAssistantId",
           verified_by_user_id AS "verifiedByUserId",
           verified_at AS "verifiedAt",
           jsonb_build_object(
             'edge_type', edge_type,
             'source_kind', source_kind, 'source_id', source_id,
             'target_kind', target_kind, 'target_id', target_id,
             'source_label', ${edgeEndpointLabelSql('el.source_kind', 'el.source_id')},
             'target_label', ${edgeEndpointLabelSql('el.target_kind', 'el.target_id')},
             'attributes', attributes, 'sensitivity', sensitivity,
             'source_episode_id', source_episode_id
           ) AS body
    FROM entity_links el
    WHERE workspace_id = $1`,
  task: `
    SELECT 'task'::text AS primitive, id,
           workspace_id AS "workspaceId",
           created_at AS "createdAt",
           created_by_assistant_id AS "createdByAssistantId",
           verified_by_user_id AS "verifiedByUserId",
           verified_at AS "verifiedAt",
           jsonb_build_object(
             'title', title, 'status', status,
             'assignee_id', assignee_id, 'due_at', due,
             'tags', tags, 'attributes', attributes,
             'sensitivity', sensitivity,
             'source_episode_id', source_episode_id
           ) AS body
    FROM tasks
    WHERE workspace_id = $1`,
  contact: `
    SELECT 'contact'::text AS primitive, id,
           workspace_id AS "workspaceId",
           created_at AS "createdAt",
           created_by_assistant_id AS "createdByAssistantId",
           verified_by_user_id AS "verifiedByUserId",
           verified_at AS "verifiedAt",
           jsonb_build_object(
             'entity_id', id, 'name', display_name,
             'email', COALESCE(attributes->>'email', canonical_id),
             'phone', attributes->>'phone',
             'tags', COALESCE(attributes->'tags', '[]'::jsonb),
             'sensitivity', sensitivity,
             'source_episode_id', source_episode_id
           ) AS body
    FROM entities
    WHERE workspace_id = $1 AND kind = 'person'`,
  company: `
    SELECT 'company'::text AS primitive, id,
           workspace_id AS "workspaceId",
           created_at AS "createdAt",
           created_by_assistant_id AS "createdByAssistantId",
           verified_by_user_id AS "verifiedByUserId",
           verified_at AS "verifiedAt",
           jsonb_build_object(
             'entity_id', id, 'name', display_name,
             'domain', COALESCE(attributes->>'domain', canonical_id),
             'tags', COALESCE(attributes->'tags', '[]'::jsonb),
             'sensitivity', sensitivity,
             'source_episode_id', source_episode_id
           ) AS body
    FROM entities
    WHERE workspace_id = $1 AND kind = 'company'`,
  deal: `
    SELECT 'deal'::text AS primitive, id,
           workspace_id AS "workspaceId",
           created_at AS "createdAt",
           created_by_assistant_id AS "createdByAssistantId",
           verified_by_user_id AS "verifiedByUserId",
           verified_at AS "verifiedAt",
           jsonb_build_object(
             'entity_id', id,
             'stage', attributes->>'stage', 'amount', attributes->>'amount',
             'close_date', attributes->>'close_date',
             'sensitivity', sensitivity,
             'source_episode_id', source_episode_id
           ) AS body
    FROM entities
    WHERE workspace_id = $1 AND kind = 'deal'`,
  workspace_file: `
    SELECT 'workspace_file'::text AS primitive, id,
           workspace_id AS "workspaceId",
           created_at AS "createdAt",
           created_by_assistant_id AS "createdByAssistantId",
           verified_by_user_id AS "verifiedByUserId",
           verified_at AS "verifiedAt",
           jsonb_build_object(
             -- column is mime, not mime_type (keep the body key the UI reads).
             'name', name, 'mime_type', mime,
             'size_bytes', size_bytes, 'tags', tags,
             'sensitivity', sensitivity,
             'source_episode_id', source_episode_id
           ) AS body
    FROM workspace_files
    WHERE workspace_id = $1`,
}

/**
 * Per-workspace count of unverified rows across all primitives. Returns
 * both a total and a per-primitive breakdown — the chrome pill renders
 * the total; a filter dropdown can show per-primitive counts inline.
 *
 * `includeExtracted` mirrors `listBrainInbox`. The chrome pill calls
 * with default-false to stay quiet; the page calls with whatever the
 * user toggled to keep its chip badges accurate.
 *
 * System-level — caller enforces workspace membership.
 */
export async function countBrainInbox(
  workspaceId: string,
  options?: { includeExtracted?: boolean },
): Promise<{
  total: number
  byPrimitive: Record<BrainInboxPrimitive, number>
}> {
  const sourceFilter = options?.includeExtracted
    ? ['model', 'extracted']
    : ['model']
  const counts: Record<BrainInboxPrimitive, number> = {
    memory: 0,
    entity: 0,
    entity_link: 0,
    task: 0,
    contact: 0,
    company: 0,
    deal: 0,
    workspace_file: 0,
  }

  // Parallel per-primitive count queries — each hits its partial index.
  const queries: Array<Promise<{ primitive: BrainInboxPrimitive; n: number }>> = [
    countOne(workspaceId, sourceFilter, 'memories', 'memory'),
    countOne(workspaceId, sourceFilter, 'entities', 'entity', `AND kind NOT IN ('person', 'company', 'deal')`),
    // Exclude dangling edges so the badge matches the (auto-pruned) list.
    countOne(
      workspaceId,
      sourceFilter,
      'entity_links',
      'entity_link',
      `AND NOT ${danglingEntityLinkSql('entity_links')}`,
    ),
    countOne(workspaceId, sourceFilter, 'tasks', 'task'),
    // CRM primitives are entities filtered by kind (post-unification).
    countOne(workspaceId, sourceFilter, 'entities', 'contact', `AND kind = 'person' AND NOT COALESCE((attributes->>'self')::boolean, false)`),
    countOne(workspaceId, sourceFilter, 'entities', 'company', `AND kind = 'company'`),
    countOne(workspaceId, sourceFilter, 'entities', 'deal', `AND kind = 'deal'`),
    countOne(workspaceId, sourceFilter, 'workspace_files', 'workspace_file'),
  ]

  const results = await Promise.all(queries)
  for (const { primitive, n } of results) {
    counts[primitive] = n
  }

  const total = results.reduce((sum, r) => sum + r.n, 0)
  return { total, byPrimitive: counts }
}

async function countOne(
  workspaceId: string,
  sourceFilter: string[],
  table: string,
  primitive: BrainInboxPrimitive,
  extra: string = '',
): Promise<{ primitive: BrainInboxPrimitive; n: number }> {
  const result = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${table}
     WHERE workspace_id = $1
       AND verified_by_user_id IS NULL
       AND valid_to IS NULL
       AND retracted_at IS NULL
       AND source = ANY($2)
       ${extra}`,
    [workspaceId, sourceFilter],
  )
  return { primitive, n: Number(result.rows[0]?.n ?? '0') }
}

/**
 * Generic verify-stamp. Sets `verified_by_user_id` + `verified_at` on
 * the active version of any primitive row carrying the universal
 * column set. Returns boolean for whether the update touched a row.
 *
 * Idempotent — re-stamping is a no-op (UPDATE returns 0 if the row
 * already has the verified_by stamp because we filter
 * `verified_by_user_id IS NULL`, but that's fine; caller treats
 * 0-rows-touched as "already verified" success).
 *
 * The `table` argument is a closed-set CHECK against the primitive
 * tables — never call this with user-supplied input. Caller resolves
 * the `primitive` discriminator to the right table name.
 *
 * System-level — caller enforces workspace + permissions.
 */
export async function markVerifiedGeneric(
  primitive: BrainInboxPrimitive,
  rowId: string,
  verifiedByUserId: string,
): Promise<boolean> {
  const table = primitiveToTable(primitive)
  const result = await query(
    `UPDATE ${table}
        SET verified_by_user_id = $2,
            verified_at = now(),
            updated_at = now()
      WHERE id = $1
        AND valid_to IS NULL
        AND verified_by_user_id IS NULL`,
    [rowId, verifiedByUserId],
  )
  return (result.rowCount ?? 0) > 0
}

/** Closed-set resolution of primitive → table name. */
export function primitiveToTable(primitive: BrainInboxPrimitive): string {
  switch (primitive) {
    case 'memory': return 'memories'
    case 'entity': return 'entities'
    case 'entity_link': return 'entity_links'
    case 'task': return 'tasks'
    // CRM primitives resolve to `entities` post-unification — the record
    // id IS the entity id, so verify/adjust/delete operate on the entity.
    case 'contact': return 'entities'
    case 'company': return 'entities'
    case 'deal': return 'entities'
    case 'workspace_file': return 'workspace_files'
  }
}

/**
 * Append a row to `brain_verifications` (mig 174). One row per logical
 * change — caller writes N rows for an adjust that touches N
 * dimensions.
 *
 * System-level — caller enforces workspace membership + auth + has
 * already validated the row exists (no FK to target).
 */
export async function appendBrainVerification(params: {
  targetKind: BrainInboxPrimitive
  targetId: string
  workspaceId: string
  verifiedByUserId: string
  action:
    | 'confirm'
    | 'adjust_attributes'
    | 'adjust_sensitivity'
    | 'adjust_scope'
    | 'edit_summary'
    | 'edit_assignee'
    | 'edit_due'
    | 'edit_status'
    | 'delete'
    // Migration 192 — kind change actions for the brain-inbox entity
    // detail panel. `reclassify_kind` is the non-CRM-to-non-CRM rename;
    // `promote_to_crm` is the atomic UPDATE+INSERT that adds the
    // contacts/companies/deals companion row.
    | 'reclassify_kind'
    | 'promote_to_crm'
  modelValue?: unknown
  userValue?: unknown
  reason?: string
}): Promise<void> {
  await query(
    `INSERT INTO brain_verifications (
       target_kind, target_id, workspace_id, verified_by,
       action, model_value, user_value, reason
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
    [
      params.targetKind,
      params.targetId,
      params.workspaceId,
      params.verifiedByUserId,
      params.action,
      params.modelValue !== undefined ? JSON.stringify(params.modelValue) : null,
      params.userValue !== undefined ? JSON.stringify(params.userValue) : null,
      params.reason ?? null,
    ],
  )
}
