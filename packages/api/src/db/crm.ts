import type { PoolClient } from 'pg'
import type {
  AccessContext,
  CompanyListFilters, CompanyListRow, CompanyRecord, CompanyUpdateFields,
  ContactListFilters, ContactListRow, ContactRecord, ContactUpdateFields,
  CrmExternalRef,
  DealListFilters, DealListRow, DealRecord, DealStage, DealUpdateFields,
  EntityLinksStore,
  Sensitivity,
} from '@sidanclaw/core'
import { buildAccessPredicate } from './access-predicate.js'
import { assertAuthorshipPresent } from './authorship-guard.js'
import { getAppPool, query, queryGated, queryWithRLS, rollbackAndRelease } from './client.js'
import { emitCrmRelationEdge, superseedCrmRelationEdge } from './edge-hooks.js'

// ── Companies ────────────────────────────────────────────────────────

const COMPANY_FULL_SELECT = `
  id, workspace_id as "workspaceId",
  entity_id as "entityId",
  name, domain, tags,
  external_ref as "externalRef",
  created_at as "createdAt", updated_at as "updatedAt"
`

const COMPANY_COMPACT_SELECT = `
  id, workspace_id as "workspaceId",
  entity_id as "entityId",
  name, domain, tags,
  updated_at as "updatedAt"
`

type CompanyRow = {
  id: string
  workspaceId: string
  entityId: string | null
  name: string
  domain: string | null
  tags: string[]
  externalRef: CrmExternalRef
  createdAt: Date
  updatedAt: Date
}

type CompanyCompactRow = Pick<CompanyRow, 'id' | 'workspaceId' | 'entityId' | 'name' | 'domain' | 'tags' | 'updatedAt'>

function toCompany(row: CompanyRow): CompanyRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    entityId: row.entityId,
    name: row.name,
    domain: row.domain,
    tags: row.tags,
    externalRef: row.externalRef ?? {},
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function toCompanyListRow(row: CompanyCompactRow): CompanyListRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    entityId: row.entityId,
    name: row.name,
    domain: row.domain,
    tags: row.tags,
    updatedAt: row.updatedAt,
  }
}

// Q24 — CRM create wraps two writes in one transaction: insert into
// `entities` first, then the specialization row with entity_id set.
// Direct entity inserts for kind='company' MUST come through here —
// `createEntity` in `entities-store.ts` rejects `kind='person'|
// 'company'|'deal'` (WU-1.5 Q24 guard). This raw `INSERT INTO entities`
// is the sanctioned write path; it runs on a pooled connection with
// the transaction below, not through the guarded store helper.
//
// Upsert-by-name: before inserting, this looks up an active company in
// the workspace with a matching lower(name). If one exists, the existing
// row is superseded via `updateCompany` with the new fields merged in
// (tags union, non-null domain wins, external_ref shallow-merged). This
// makes the tool callable repeatedly during research without producing
// duplicate (entity, company) pairs — the user only ever sees one
// "SIDAN Lab" row no matter how many times the model re-records it.
export async function createCompany(
  userId: string,
  params: {
    workspaceId: string
    name: string
    domain?: string | null
    tags?: string[]
    externalRef?: CrmExternalRef
    /**
     * Sensitivity tier for the fresh entity + companies pair. Omitted by
     * default → DB column default (`internal`). Research-mode saves pass
     * `public` (public-web provenance); see researchWriteFloor. Only the
     * fresh-insert path honours it — the dedupe/merge path preserves the
     * existing row's tier.
     */
    sensitivity?: Sensitivity
    /** Compartment set (MLS category axis) for the fresh entity + company pair. Default '{}'. */
    compartments?: string[]
    /**
     * Fresh-insert `source` for the entity + companies pair. Default `'user'`
     * (interactive chat / API writes). The structural-synthesis engine passes
     * `'extracted'` so synthesis-captured companies surface in Brain Reviews
     * (`?includeExtracted=true`). Only the fresh-insert path honours it — the
     * dedupe/merge path preserves the existing row's source.
     */
    source?: 'user' | 'extracted'
  },
): Promise<CompanyRecord> {
  // WU-4.5 — the `userId` arg is both RLS actor and row author for
  // the entity + companies pair. Guard before the transaction opens.
  assertAuthorshipPresent('createCompany', userId)

  // Dedupe pass — look up an active row with a matching lower(name) in
  // the same workspace under the caller's RLS. A workspace-foreign hit
  // would be invisible (and unmergeable) so RLS is the right gate here.
  const existing = await queryWithRLS<{ id: string }>(
    userId,
    `SELECT id FROM companies
      WHERE workspace_id = $1
        AND lower(name) = lower($2)
        AND valid_to IS NULL
        AND retracted_at IS NULL
      ORDER BY created_at ASC
      LIMIT 1`,
    [params.workspaceId, params.name],
  )
  if (existing.rows[0]) {
    const merged = await mergeCompanyFields(userId, existing.rows[0].id, {
      domain: params.domain ?? null,
      tags: params.tags,
      externalRef: params.externalRef,
    })
    if (merged) return merged
    // Match vanished mid-flight (rare: concurrent retraction). Fall
    // through to the insert path — better to write a fresh row than to
    // drop the user's data.
  }

  const client = await getAppPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL app.current_user_id = '${userId.replace(/'/g, "''")}'`)

    // user_id is set to the creator to satisfy the Q11 visibility CHECK
    // (entities require user_id OR assistant_id non-null). Workspace-shared
    // CRM entities are a deferred Q11/SV alignment — see WU-1.5 gap notes.
    const entityResult = await client.query<{ id: string }>(
      `INSERT INTO entities
         (kind, display_name, canonical_id, workspace_id, user_id, created_by_user_id, source, sensitivity, compartments)
       VALUES ('company', $1, $2, $3, $4, $4, $7, $5, $6)
       RETURNING id`,
      [params.name, params.domain ?? null, params.workspaceId, userId, params.sensitivity ?? 'internal', params.compartments ?? [], params.source ?? 'user'],
    )
    const entityId = entityResult.rows[0].id

    // WU-4.5 — stamp `created_by_user_id` on the specialization row too.
    // Migration 128 added the column; the entity write already carries
    // it, but the companies row was previously landing with NULL.
    const result = await client.query<CompanyRow>(
      `INSERT INTO companies (workspace_id, name, domain, tags, external_ref, entity_id, created_by_user_id, sensitivity, compartments, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${COMPANY_FULL_SELECT}`,
      [
        params.workspaceId,
        params.name,
        params.domain ?? null,
        params.tags ?? [],
        JSON.stringify(params.externalRef ?? {}),
        entityId,
        userId,
        params.sensitivity ?? 'internal',
        params.compartments ?? [],
        params.source ?? 'user',
      ],
    )

    await client.query('COMMIT')
    return toCompany(result.rows[0])
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    await rollbackAndRelease(client)
  }
}

// Merge new fields into an existing company via the supersession path.
// Returns the new (superseding) record, the unchanged record if the
// incoming fields add nothing, or null if the row vanished between the
// dedupe lookup and this merge call.
async function mergeCompanyFields(
  userId: string,
  id: string,
  incoming: {
    domain?: string | null
    tags?: string[]
    externalRef?: CrmExternalRef
  },
): Promise<CompanyRecord | null> {
  const currentResult = await queryWithRLS<CompanyRow>(
    userId,
    `SELECT ${COMPANY_FULL_SELECT} FROM companies
      WHERE id = $1 AND valid_to IS NULL`,
    [id],
  )
  if (currentResult.rows.length === 0) return null
  const current = toCompany(currentResult.rows[0])

  const fields: CompanyUpdateFields = {}
  // Domain: only overwrite when incoming has a non-empty value. We never
  // clear a previously-known domain just because the new call omitted it.
  if (incoming.domain && incoming.domain !== current.domain) {
    fields.domain = incoming.domain
  }
  // Tags: union (case-sensitive). Skip if no new tags add anything.
  if (incoming.tags && incoming.tags.length > 0) {
    const merged = Array.from(new Set([...current.tags, ...incoming.tags]))
    if (merged.length !== current.tags.length) fields.tags = merged
  }
  // external_ref: shallow merge, incoming wins on key collisions.
  if (incoming.externalRef && Object.keys(incoming.externalRef).length > 0) {
    fields.externalRef = { ...current.externalRef, ...incoming.externalRef }
  }

  if (Object.keys(fields).length === 0) {
    // No effective change — return the existing row unchanged.
    return current
  }
  return updateCompany(userId, id, fields)
}

export async function getCompanyById(ctx: AccessContext, id: string): Promise<CompanyRecord | null> {
  // Universal access projection (WU-4.2b) + `valid_to IS NULL` to hide
  // superseded versions; historical versions are reachable through the
  // supersession chain via `getCompanyHistory`.
  const ap = buildAccessPredicate(ctx, { startIdx: 1 })
  const result = await queryWithRLS<CompanyRow>(
    ctx.userId,
    `SELECT ${COMPANY_FULL_SELECT} FROM companies
     WHERE ${ap.sql}
       AND id = $${ap.nextIdx} AND valid_to IS NULL`,
    [...ap.params, id],
  )
  if (result.rows.length === 0) return null
  return toCompany(result.rows[0])
}

export async function listCompanies(ctx: AccessContext, filters: CompanyListFilters): Promise<CompanyListRow[]> {
  const ap = buildAccessPredicate(ctx, { startIdx: 1 })
  const wheres: string[] = [ap.sql, 'valid_to IS NULL']
  const values: unknown[] = [...ap.params]
  let idx = ap.nextIdx

  if (filters.query) {
    wheres.push(`(name ILIKE $${idx} OR domain ILIKE $${idx})`)
    values.push(`%${filters.query}%`)
    idx++
  }
  if (filters.tag) {
    wheres.push(`$${idx} = ANY(tags)`)
    values.push(filters.tag)
    idx++
  }

  const limit = Math.min(Math.max(filters.limit ?? 25, 1), 100)
  values.push(limit)

  const result = await queryGated<CompanyCompactRow>(
    ctx,
    `SELECT ${COMPANY_COMPACT_SELECT} FROM companies
     WHERE ${wheres.join(' AND ')}
     ORDER BY updated_at DESC
     LIMIT $${idx}`,
    values,
  )
  return result.rows.map(toCompanyListRow)
}

// Supersession-on-write (company-brain WU-2.5 / D.7): edits to a company
// tombstone the active row (`valid_to=now()`, `superseded_by=<new_id>`) and
// insert a fresh row carrying merged typed fields plus the old row's
// entity link, authorship, visibility, and trust columns.
//
// `entity_id` is column-UNIQUE on `companies` (mig 127); the new row needs
// the old entity_id to retain the brain-link, so the tombstoned row's
// entity_id is set to NULL inside the same transaction. Historical CRM
// rows reach the entity via the `superseded_by` chain. The proper fix is
// to convert that UNIQUE to a partial unique index — flagged as a
// follow-up for the coordinator.
//
// Returns the **new** CompanyRecord, or `null` when the id isn't an
// active row (already tombstoned, never existed, or hidden by RLS).
export async function updateCompany(
  userId: string,
  id: string,
  fields: CompanyUpdateFields,
): Promise<CompanyRecord | null> {
  type CompanyOldRow = {
    workspaceId: string
    entityId: string | null
    name: string
    domain: string | null
    tags: string[]
    externalRef: CrmExternalRef | null
    sensitivity: string
    rowUserId: string | null
    rowAssistantId: string | null
    source: string
    createdByUserId: string | null
    createdByAssistantId: string | null
    sourceEpisodeId: string | null
    verifiedByUserId: string | null
    verifiedAt: Date | null
  }

  const client = await getAppPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL app.current_user_id = '${userId.replace(/'/g, "''")}'`)
    try {
      const lockResult = await client.query<CompanyOldRow>(
        `SELECT workspace_id  as "workspaceId",
                entity_id     as "entityId",
                name, domain, tags,
                external_ref  as "externalRef",
                sensitivity,
                user_id       as "rowUserId",
                assistant_id  as "rowAssistantId",
                source,
                created_by_user_id      as "createdByUserId",
                created_by_assistant_id as "createdByAssistantId",
                source_episode_id       as "sourceEpisodeId",
                verified_by_user_id     as "verifiedByUserId",
                verified_at             as "verifiedAt"
           FROM companies
          WHERE id = $1 AND valid_to IS NULL
          FOR UPDATE`,
        [id],
      )
      const old = lockResult.rows[0]
      if (!old) {
        await client.query('ROLLBACK')
        return null
      }

      const next = {
        name: fields.name ?? old.name,
        domain: fields.domain !== undefined ? fields.domain : old.domain,
        tags: fields.tags ?? old.tags,
        externalRef: fields.externalRef ?? old.externalRef ?? {},
      }

      // Release the old row's entity_id BEFORE inserting the new row so the
      // column-UNIQUE (mig 127) admits the same entity link on the new row.
      // Safe inside the transaction with FOR UPDATE held on the old row.
      await client.query(`UPDATE companies SET entity_id = NULL WHERE id = $1`, [id])

      const insertResult = await client.query<CompanyRow>(
        `INSERT INTO companies (
           workspace_id, entity_id, name, domain, tags, external_ref,
           sensitivity, user_id, assistant_id, source,
           created_by_user_id, created_by_assistant_id, source_episode_id,
           verified_by_user_id, verified_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING ${COMPANY_FULL_SELECT}`,
        [
          old.workspaceId, old.entityId,
          next.name, next.domain, next.tags, JSON.stringify(next.externalRef),
          old.sensitivity, old.rowUserId, old.rowAssistantId, old.source,
          old.createdByUserId, old.createdByAssistantId, old.sourceEpisodeId,
          old.verifiedByUserId, old.verifiedAt,
        ],
      )
      const newRow = insertResult.rows[0]

      await client.query(
        `UPDATE companies
            SET valid_to = now(),
                superseded_by = $2,
                updated_at = now()
          WHERE id = $1`,
        [id, newRow.id],
      )

      await client.query('COMMIT')
      return toCompany(newRow)
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    }
  } finally {
    await rollbackAndRelease(client)
  }
}

// ── Contacts ─────────────────────────────────────────────────────────

const CONTACT_FULL_SELECT = `
  id, workspace_id as "workspaceId",
  entity_id as "entityId",
  name, email, phone,
  company_id as "companyId", tags, external_ref as "externalRef",
  created_at as "createdAt", updated_at as "updatedAt"
`

const CONTACT_COMPACT_SELECT = `
  id, workspace_id as "workspaceId",
  entity_id as "entityId",
  name, email,
  company_id as "companyId", tags, updated_at as "updatedAt"
`

type ContactRow = {
  id: string
  workspaceId: string
  entityId: string | null
  name: string
  email: string | null
  phone: string | null
  companyId: string | null
  tags: string[]
  externalRef: CrmExternalRef
  createdAt: Date
  updatedAt: Date
}

type ContactCompactRow = Pick<
  ContactRow,
  'id' | 'workspaceId' | 'entityId' | 'name' | 'email' | 'companyId' | 'tags' | 'updatedAt'
>

function toContact(row: ContactRow): ContactRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    entityId: row.entityId,
    name: row.name,
    email: row.email,
    phone: row.phone,
    companyId: row.companyId,
    tags: row.tags,
    externalRef: row.externalRef ?? {},
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function toContactListRow(row: ContactCompactRow): ContactListRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    entityId: row.entityId,
    name: row.name,
    email: row.email,
    companyId: row.companyId,
    tags: row.tags,
    updatedAt: row.updatedAt,
  }
}

// Q24 — see createCompany. Entity carries kind='person' and canonical_id=email.
//
// WU-1.7 edge hook: when `companyId` is supplied AND an `entityLinks`
// store is passed, a `works_at` edge (person entity → company entity)
// is emitted fire-and-forget after the transaction commits. The edge is
// best-effort — its failure never affects the contact save (see
// `edge-hooks.ts`). The `entityLinks` arg is optional so existing call
// sites that don't carry the graph layer keep compiling unchanged.
//
// Upsert-by-name (mirrors createCompany): look for an active contact in
// the workspace by lower(name) — fall back to lower(email) if name
// doesn't match but the email does. On a hit, supersede via
// `updateContact` with merged tags/phone/company/external_ref so
// repeated research turns never produce duplicate contacts.
export async function createContact(
  userId: string,
  params: {
    workspaceId: string
    name: string
    email?: string | null
    phone?: string | null
    companyId?: string | null
    tags?: string[]
    externalRef?: CrmExternalRef
    /** See createCompany — fresh-insert tier; defaults to DB `internal`. */
    sensitivity?: Sensitivity
    /** Compartment set (MLS category axis) for the fresh entity + contact pair. Default '{}'. */
    compartments?: string[]
    /** See createCompany — fresh-insert source; default 'user'; synthesis passes 'extracted'. */
    source?: 'user' | 'extracted'
  },
  entityLinks?: EntityLinksStore,
): Promise<ContactRecord> {
  // WU-4.5 — see createCompany; same author-stamp invariant applies.
  assertAuthorshipPresent('createContact', userId)

  // Dedupe pass — prefer email match (high confidence), fall back to
  // lower(name) (the user's chosen key). The COALESCE/UNION below picks
  // the email hit first when present.
  const existing = await queryWithRLS<{ id: string }>(
    userId,
    `(
       SELECT id, 1 AS pri FROM contacts
        WHERE workspace_id = $1
          AND $2::text IS NOT NULL
          AND lower(email) = lower($2)
          AND valid_to IS NULL
          AND retracted_at IS NULL
        ORDER BY created_at ASC
        LIMIT 1
     )
     UNION ALL
     (
       SELECT id, 2 AS pri FROM contacts
        WHERE workspace_id = $1
          AND lower(name) = lower($3)
          AND valid_to IS NULL
          AND retracted_at IS NULL
        ORDER BY created_at ASC
        LIMIT 1
     )
     ORDER BY pri ASC
     LIMIT 1`,
    [params.workspaceId, params.email ?? null, params.name],
  )
  if (existing.rows[0]) {
    const merged = await mergeContactFields(userId, existing.rows[0].id, {
      email: params.email ?? null,
      phone: params.phone ?? null,
      companyId: params.companyId ?? null,
      tags: params.tags,
      externalRef: params.externalRef,
    })
    if (merged) return merged
    // Match vanished mid-flight — fall through and insert fresh.
  }

  const client = await getAppPool().connect()
  let contactEntityId: string
  let companyEntityId: string | null = null
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL app.current_user_id = '${userId.replace(/'/g, "''")}'`)

    // See createCompany — user_id mirrors creator to satisfy Q11 CHECK.
    const entityResult = await client.query<{ id: string }>(
      `INSERT INTO entities
         (kind, display_name, canonical_id, workspace_id, user_id, created_by_user_id, source, sensitivity, compartments)
       VALUES ('person', $1, $2, $3, $4, $4, $7, $5, $6)
       RETURNING id`,
      [params.name, params.email ?? null, params.workspaceId, userId, params.sensitivity ?? 'internal', params.compartments ?? [], params.source ?? 'user'],
    )
    const entityId = entityResult.rows[0].id
    contactEntityId = entityId

    // WU-4.5 — stamp `created_by_user_id` on the contacts row; see
    // createCompany for the matching note.
    const result = await client.query<ContactRow>(
      `INSERT INTO contacts (workspace_id, name, email, phone, company_id, tags, external_ref, entity_id, created_by_user_id, sensitivity, compartments, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING ${CONTACT_FULL_SELECT}`,
      [
        params.workspaceId,
        params.name,
        params.email ?? null,
        params.phone ?? null,
        params.companyId ?? null,
        params.tags ?? [],
        JSON.stringify(params.externalRef ?? {}),
        entityId,
        userId,
        params.sensitivity ?? 'internal',
        params.compartments ?? [],
        params.source ?? 'user',
      ],
    )

    // Read the linked company's entity id inside the same transaction
    // so the post-commit edge hook has both endpoints. A company with
    // no `entity_id` (legacy brain-blind row, Q24 forward-only) yields
    // null and the edge is simply skipped.
    if (params.companyId) {
      const companyEntity = await client.query<{ entityId: string | null }>(
        `SELECT entity_id AS "entityId" FROM companies WHERE id = $1`,
        [params.companyId],
      )
      companyEntityId = companyEntity.rows[0]?.entityId ?? null
    }

    await client.query('COMMIT')
    const contact = toContact(result.rows[0])

    // Fire-and-forget `works_at` edge — runs after COMMIT, never awaited
    // on the caller's hot path, never able to fail the contact save.
    if (entityLinks && companyEntityId) {
      void emitCrmRelationEdge(entityLinks, userId, {
        sourceEntityId: contactEntityId,
        targetEntityId: companyEntityId,
        edgeType: 'works_at',
        workspaceId: params.workspaceId,
        source: 'user',
        userId,
      })
    }
    return contact
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    await rollbackAndRelease(client)
  }
}

// Merge new contact fields into an existing row via supersession.
// Mirrors mergeCompanyFields: nullable scalar fields only overwrite when
// the incoming value is non-empty (never clear a known value silently),
// tags union, external_ref shallow-merged.
async function mergeContactFields(
  userId: string,
  id: string,
  incoming: {
    email?: string | null
    phone?: string | null
    companyId?: string | null
    tags?: string[]
    externalRef?: CrmExternalRef
  },
): Promise<ContactRecord | null> {
  const currentResult = await queryWithRLS<ContactRow>(
    userId,
    `SELECT ${CONTACT_FULL_SELECT} FROM contacts
      WHERE id = $1 AND valid_to IS NULL`,
    [id],
  )
  if (currentResult.rows.length === 0) return null
  const current = toContact(currentResult.rows[0])

  const fields: ContactUpdateFields = {}
  if (incoming.email && incoming.email !== current.email) fields.email = incoming.email
  if (incoming.phone && incoming.phone !== current.phone) fields.phone = incoming.phone
  if (incoming.companyId && incoming.companyId !== current.companyId) {
    fields.companyId = incoming.companyId
  }
  if (incoming.tags && incoming.tags.length > 0) {
    const merged = Array.from(new Set([...current.tags, ...incoming.tags]))
    if (merged.length !== current.tags.length) fields.tags = merged
  }
  if (incoming.externalRef && Object.keys(incoming.externalRef).length > 0) {
    fields.externalRef = { ...current.externalRef, ...incoming.externalRef }
  }

  if (Object.keys(fields).length === 0) return current
  return updateContact(userId, id, fields)
}

export async function getContactById(ctx: AccessContext, id: string): Promise<ContactRecord | null> {
  const ap = buildAccessPredicate(ctx, { startIdx: 1 })
  const result = await queryWithRLS<ContactRow>(
    ctx.userId,
    `SELECT ${CONTACT_FULL_SELECT} FROM contacts
     WHERE ${ap.sql}
       AND id = $${ap.nextIdx} AND valid_to IS NULL`,
    [...ap.params, id],
  )
  if (result.rows.length === 0) return null
  return toContact(result.rows[0])
}

export async function listContacts(ctx: AccessContext, filters: ContactListFilters): Promise<ContactListRow[]> {
  const ap = buildAccessPredicate(ctx, { startIdx: 1 })
  const wheres: string[] = [ap.sql, 'valid_to IS NULL']
  const values: unknown[] = [...ap.params]
  let idx = ap.nextIdx

  if (filters.query) {
    wheres.push(`(name ILIKE $${idx} OR email ILIKE $${idx})`)
    values.push(`%${filters.query}%`)
    idx++
  }
  if (filters.tag) {
    wheres.push(`$${idx} = ANY(tags)`)
    values.push(filters.tag)
    idx++
  }
  if (filters.companyId) {
    wheres.push(`company_id = $${idx}`)
    values.push(filters.companyId)
    idx++
  }

  const limit = Math.min(Math.max(filters.limit ?? 25, 1), 100)
  values.push(limit)

  const result = await queryGated<ContactCompactRow>(
    ctx,
    `SELECT ${CONTACT_COMPACT_SELECT} FROM contacts
     WHERE ${wheres.join(' AND ')}
     ORDER BY updated_at DESC
     LIMIT $${idx}`,
    values,
  )
  return result.rows.map(toContactListRow)
}

// Supersession-on-write — see updateCompany for the full design notes.
// The contact-specific carry-forward column is `company_id`.
//
// When `companyId` changes (FK supersession), the post-commit edge hook
// closes the prior `works_at` edge from the contact's entity and opens a
// new one to the incoming company. Same fire-and-forget invariant as
// `createContact` — edge failures log but never affect the contact write.
export async function updateContact(
  userId: string,
  id: string,
  fields: ContactUpdateFields,
  entityLinks?: EntityLinksStore,
): Promise<ContactRecord | null> {
  type ContactOldRow = {
    workspaceId: string
    entityId: string | null
    name: string
    email: string | null
    phone: string | null
    companyId: string | null
    tags: string[]
    externalRef: CrmExternalRef | null
    sensitivity: string
    rowUserId: string | null
    rowAssistantId: string | null
    source: string
    createdByUserId: string | null
    createdByAssistantId: string | null
    sourceEpisodeId: string | null
    verifiedByUserId: string | null
    verifiedAt: Date | null
  }

  const client = await getAppPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL app.current_user_id = '${userId.replace(/'/g, "''")}'`)
    try {
      const lockResult = await client.query<ContactOldRow>(
        `SELECT workspace_id  as "workspaceId",
                entity_id     as "entityId",
                name, email, phone,
                company_id    as "companyId",
                tags,
                external_ref  as "externalRef",
                sensitivity,
                user_id       as "rowUserId",
                assistant_id  as "rowAssistantId",
                source,
                created_by_user_id      as "createdByUserId",
                created_by_assistant_id as "createdByAssistantId",
                source_episode_id       as "sourceEpisodeId",
                verified_by_user_id     as "verifiedByUserId",
                verified_at             as "verifiedAt"
           FROM contacts
          WHERE id = $1 AND valid_to IS NULL
          FOR UPDATE`,
        [id],
      )
      const old = lockResult.rows[0]
      if (!old) {
        await client.query('ROLLBACK')
        return null
      }

      const next = {
        name: fields.name ?? old.name,
        email: fields.email !== undefined ? fields.email : old.email,
        phone: fields.phone !== undefined ? fields.phone : old.phone,
        companyId: fields.companyId !== undefined ? fields.companyId : old.companyId,
        tags: fields.tags ?? old.tags,
        externalRef: fields.externalRef ?? old.externalRef ?? {},
      }

      // Release entity_id on the old row first; see updateCompany for why.
      await client.query(`UPDATE contacts SET entity_id = NULL WHERE id = $1`, [id])

      const insertResult = await client.query<ContactRow>(
        `INSERT INTO contacts (
           workspace_id, entity_id, name, email, phone, company_id, tags, external_ref,
           sensitivity, user_id, assistant_id, source,
           created_by_user_id, created_by_assistant_id, source_episode_id,
           verified_by_user_id, verified_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         RETURNING ${CONTACT_FULL_SELECT}`,
        [
          old.workspaceId, old.entityId,
          next.name, next.email, next.phone, next.companyId, next.tags, JSON.stringify(next.externalRef),
          old.sensitivity, old.rowUserId, old.rowAssistantId, old.source,
          old.createdByUserId, old.createdByAssistantId, old.sourceEpisodeId,
          old.verifiedByUserId, old.verifiedAt,
        ],
      )
      const newRow = insertResult.rows[0]

      await client.query(
        `UPDATE contacts
            SET valid_to = now(),
                superseded_by = $2,
                updated_at = now()
          WHERE id = $1`,
        [id, newRow.id],
      )

      await client.query('COMMIT')
      const newContact = toContact(newRow)

      // FK-supersession: if the company FK changed, close the prior
      // `works_at` edge from the contact's entity and open a new one
      // to the incoming company. Skipped when the entity has no
      // backing entityId (legacy brain-blind rows) or both old and
      // new companyId resolve to the same entity. Always runs after
      // COMMIT, never awaited on the hot path.
      const fkChanged =
        fields.companyId !== undefined && fields.companyId !== old.companyId
      if (entityLinks && newContact.entityId && fkChanged) {
        let newCompanyEntityId: string | null = null
        if (newContact.companyId) {
          const r = await query<{ entityId: string | null }>(
            `SELECT entity_id AS "entityId" FROM companies WHERE id = $1`,
            [newContact.companyId],
          )
          newCompanyEntityId = r.rows[0]?.entityId ?? null
        }
        void superseedCrmRelationEdge(entityLinks, userId, {
          sourceEntityId: newContact.entityId,
          targetEntityId: newCompanyEntityId,
          edgeType: 'works_at',
          workspaceId: old.workspaceId,
          source: 'user',
          userId,
        })
      }
      return newContact
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    }
  } finally {
    await rollbackAndRelease(client)
  }
}

// ── Deals ────────────────────────────────────────────────────────────

const DEAL_FULL_SELECT = `
  id, workspace_id as "workspaceId",
  entity_id as "entityId",
  contact_id as "contactId",
  company_id as "companyId", stage, amount, close_date as "closeDate",
  external_ref as "externalRef",
  created_at as "createdAt", updated_at as "updatedAt"
`

const DEAL_COMPACT_SELECT = `
  id, workspace_id as "workspaceId",
  entity_id as "entityId",
  contact_id as "contactId",
  company_id as "companyId", stage, amount, close_date as "closeDate",
  updated_at as "updatedAt"
`

type DealRow = {
  id: string
  workspaceId: string
  entityId: string | null
  contactId: string | null
  companyId: string | null
  stage: DealStage
  // pg returns NUMERIC as string by default — coerce in toDeal.
  amount: string | null
  closeDate: Date | null
  externalRef: CrmExternalRef
  createdAt: Date
  updatedAt: Date
}

type DealCompactRow = Pick<
  DealRow,
  'id' | 'workspaceId' | 'entityId' | 'contactId' | 'companyId' | 'stage' | 'amount' | 'closeDate' | 'updatedAt'
>

function toDeal(row: DealRow): DealRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    entityId: row.entityId,
    contactId: row.contactId,
    companyId: row.companyId,
    stage: row.stage,
    amount: row.amount === null ? null : Number(row.amount),
    closeDate: row.closeDate,
    externalRef: row.externalRef ?? {},
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function toDealListRow(row: DealCompactRow): DealListRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    entityId: row.entityId,
    contactId: row.contactId,
    companyId: row.companyId,
    stage: row.stage,
    amount: row.amount === null ? null : Number(row.amount),
    closeDate: row.closeDate,
    updatedAt: row.updatedAt,
  }
}

// Q24 — see createCompany. Deals have no `name` column, so the entity's
// display_name is derived from the linked company inside the transaction
// (falling back to 'Deal' when companyId is absent).
//
// WU-1.7 edge hook: when `companyId` is supplied AND an `entityLinks`
// store is passed, an `engagement_of` edge (deal entity → company
// entity) is emitted fire-and-forget after COMMIT. Best-effort — its
// failure never affects the deal save. `entityLinks` is optional so
// pre-WU-1.7 call sites keep compiling unchanged.
export async function createDeal(
  userId: string,
  params: {
    workspaceId: string
    contactId?: string | null
    companyId?: string | null
    stage?: DealStage
    amount?: number | null
    closeDate?: Date | null
    externalRef?: CrmExternalRef
    /** See createCompany — fresh-insert tier; defaults to DB `internal`. */
    sensitivity?: Sensitivity
    /** Compartment set (MLS category axis) for the fresh entity + deal pair. Default '{}'. */
    compartments?: string[]
    /** See createCompany — fresh-insert source; default 'user'; synthesis passes 'extracted'. */
    source?: 'user' | 'extracted'
  },
  entityLinks?: EntityLinksStore,
): Promise<DealRecord> {
  // WU-4.5 — see createCompany; same author-stamp invariant applies.
  assertAuthorshipPresent('createDeal', userId)
  const client = await getAppPool().connect()
  let dealEntityId: string
  let companyEntityId: string | null = null
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL app.current_user_id = '${userId.replace(/'/g, "''")}'`)

    let displayName = 'Deal'
    if (params.companyId) {
      // One lookup serves both the display-name derivation and the
      // post-commit `engagement_of` edge hook.
      const companyLookup = await client.query<{ name: string; entityId: string | null }>(
        `SELECT name, entity_id AS "entityId" FROM companies WHERE id = $1`,
        [params.companyId],
      )
      if (companyLookup.rows.length > 0) {
        displayName = `Deal — ${companyLookup.rows[0].name}`
        companyEntityId = companyLookup.rows[0].entityId ?? null
      }
    }

    // See createCompany — user_id mirrors creator to satisfy Q11 CHECK.
    const entityResult = await client.query<{ id: string }>(
      `INSERT INTO entities
         (kind, display_name, workspace_id, user_id, created_by_user_id, source, sensitivity, compartments)
       VALUES ('deal', $1, $2, $3, $3, $6, $4, $5)
       RETURNING id`,
      [displayName, params.workspaceId, userId, params.sensitivity ?? 'internal', params.compartments ?? [], params.source ?? 'user'],
    )
    const entityId = entityResult.rows[0].id
    dealEntityId = entityId

    // WU-4.5 — stamp `created_by_user_id` on the deals row; see
    // createCompany for the matching note.
    const result = await client.query<DealRow>(
      `INSERT INTO deals (workspace_id, contact_id, company_id, stage, amount, close_date, external_ref, entity_id, created_by_user_id, sensitivity, compartments, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING ${DEAL_FULL_SELECT}`,
      [
        params.workspaceId,
        params.contactId ?? null,
        params.companyId ?? null,
        params.stage ?? 'lead',
        params.amount ?? null,
        params.closeDate ?? null,
        JSON.stringify(params.externalRef ?? {}),
        entityId,
        userId,
        params.sensitivity ?? 'internal',
        params.compartments ?? [],
        params.source ?? 'user',
      ],
    )

    await client.query('COMMIT')
    const deal = toDeal(result.rows[0])

    // Fire-and-forget `engagement_of` edge — post-COMMIT, never awaited,
    // never able to fail the deal save.
    if (entityLinks && companyEntityId) {
      void emitCrmRelationEdge(entityLinks, userId, {
        sourceEntityId: dealEntityId,
        targetEntityId: companyEntityId,
        edgeType: 'engagement_of',
        workspaceId: params.workspaceId,
        source: 'user',
        userId,
      })
    }
    return deal
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    await rollbackAndRelease(client)
  }
}

export async function getDealById(ctx: AccessContext, id: string): Promise<DealRecord | null> {
  const ap = buildAccessPredicate(ctx, { startIdx: 1 })
  const result = await queryWithRLS<DealRow>(
    ctx.userId,
    `SELECT ${DEAL_FULL_SELECT} FROM deals
     WHERE ${ap.sql}
       AND id = $${ap.nextIdx} AND valid_to IS NULL`,
    [...ap.params, id],
  )
  if (result.rows.length === 0) return null
  return toDeal(result.rows[0])
}

export async function listDeals(ctx: AccessContext, filters: DealListFilters): Promise<DealListRow[]> {
  const ap = buildAccessPredicate(ctx, { startIdx: 1 })
  const wheres: string[] = [ap.sql, 'valid_to IS NULL']
  const values: unknown[] = [...ap.params]
  let idx = ap.nextIdx

  if (filters.stage) {
    if (Array.isArray(filters.stage)) {
      wheres.push(`stage = ANY($${idx})`)
      values.push(filters.stage)
    } else {
      wheres.push(`stage = $${idx}`)
      values.push(filters.stage)
    }
    idx++
  }
  if (filters.contactId) {
    wheres.push(`contact_id = $${idx}`)
    values.push(filters.contactId)
    idx++
  }
  if (filters.companyId) {
    wheres.push(`company_id = $${idx}`)
    values.push(filters.companyId)
    idx++
  }

  const limit = Math.min(Math.max(filters.limit ?? 25, 1), 100)
  values.push(limit)

  const result = await queryGated<DealCompactRow>(
    ctx,
    `SELECT ${DEAL_COMPACT_SELECT} FROM deals
     WHERE ${wheres.join(' AND ')}
     ORDER BY updated_at DESC
     LIMIT $${idx}`,
    values,
  )
  return result.rows.map(toDealListRow)
}

// Supersession-on-write — see updateCompany for the full design notes.
// Both `updateDeal` and `setDealStage` follow the same pattern. The Q24
// lock calls out deal stage transitions explicitly
// (qualified → proposal → negotiation), but every typed-field edit
// supersedes so `getRowHistory('deals', id)` reconstructs a clean chain.
async function supersedeDeal(
  client: PoolClient,
  id: string,
  apply: (old: DealOldRow) => DealNextFields,
): Promise<DealRecord | null> {
  const lockResult = await client.query<DealOldRow>(
    `SELECT workspace_id  as "workspaceId",
            entity_id     as "entityId",
            contact_id    as "contactId",
            company_id    as "companyId",
            stage,
            amount,
            close_date    as "closeDate",
            external_ref  as "externalRef",
            sensitivity,
            user_id       as "rowUserId",
            assistant_id  as "rowAssistantId",
            source,
            created_by_user_id      as "createdByUserId",
            created_by_assistant_id as "createdByAssistantId",
            source_episode_id       as "sourceEpisodeId",
            verified_by_user_id     as "verifiedByUserId",
            verified_at             as "verifiedAt"
       FROM deals
      WHERE id = $1 AND valid_to IS NULL
      FOR UPDATE`,
    [id],
  )
  const old = lockResult.rows[0]
  if (!old) return null

  const next = apply(old)

  // Release entity_id on the old row first; see updateCompany for why.
  await client.query(`UPDATE deals SET entity_id = NULL WHERE id = $1`, [id])

  const insertResult = await client.query<DealRow>(
    `INSERT INTO deals (
       workspace_id, entity_id, contact_id, company_id, stage, amount, close_date, external_ref,
       sensitivity, user_id, assistant_id, source,
       created_by_user_id, created_by_assistant_id, source_episode_id,
       verified_by_user_id, verified_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     RETURNING ${DEAL_FULL_SELECT}`,
    [
      old.workspaceId, old.entityId,
      next.contactId, next.companyId, next.stage, next.amount, next.closeDate,
      JSON.stringify(next.externalRef),
      old.sensitivity, old.rowUserId, old.rowAssistantId, old.source,
      old.createdByUserId, old.createdByAssistantId, old.sourceEpisodeId,
      old.verifiedByUserId, old.verifiedAt,
    ],
  )
  const newRow = insertResult.rows[0]

  await client.query(
    `UPDATE deals
        SET valid_to = now(),
            superseded_by = $2,
            updated_at = now()
      WHERE id = $1`,
    [id, newRow.id],
  )

  return toDeal(newRow)
}

type DealOldRow = {
  workspaceId: string
  entityId: string | null
  contactId: string | null
  companyId: string | null
  stage: DealStage
  amount: string | null
  closeDate: Date | null
  externalRef: CrmExternalRef | null
  sensitivity: string
  rowUserId: string | null
  rowAssistantId: string | null
  source: string
  createdByUserId: string | null
  createdByAssistantId: string | null
  sourceEpisodeId: string | null
  verifiedByUserId: string | null
  verifiedAt: Date | null
}

type DealNextFields = {
  contactId: string | null
  companyId: string | null
  stage: DealStage
  amount: string | number | null
  closeDate: Date | null
  externalRef: CrmExternalRef
}

export async function updateDeal(
  userId: string,
  id: string,
  fields: DealUpdateFields,
  entityLinks?: EntityLinksStore,
): Promise<DealRecord | null> {
  const client = await getAppPool().connect()
  let oldCompanyId: string | null | undefined = undefined
  let workspaceId: string | null = null
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL app.current_user_id = '${userId.replace(/'/g, "''")}'`)
    try {
      const result = await supersedeDeal(client, id, (old) => {
        oldCompanyId = old.companyId
        workspaceId = old.workspaceId
        return {
          contactId: fields.contactId !== undefined ? fields.contactId : old.contactId,
          companyId: fields.companyId !== undefined ? fields.companyId : old.companyId,
          stage: old.stage,
          amount: fields.amount !== undefined ? fields.amount : old.amount,
          closeDate: fields.closeDate !== undefined ? fields.closeDate : old.closeDate,
          externalRef: fields.externalRef ?? old.externalRef ?? {},
        }
      })
      if (!result) {
        await client.query('ROLLBACK')
        return null
      }
      await client.query('COMMIT')
      // FK-supersession for engagement_of — same shape as updateContact.
      const fkChanged =
        fields.companyId !== undefined && fields.companyId !== oldCompanyId
      if (entityLinks && result.entityId && fkChanged && workspaceId) {
        let newCompanyEntityId: string | null = null
        if (result.companyId) {
          const r = await query<{ entityId: string | null }>(
            `SELECT entity_id AS "entityId" FROM companies WHERE id = $1`,
            [result.companyId],
          )
          newCompanyEntityId = r.rows[0]?.entityId ?? null
        }
        void superseedCrmRelationEdge(entityLinks, userId, {
          sourceEntityId: result.entityId,
          targetEntityId: newCompanyEntityId,
          edgeType: 'engagement_of',
          workspaceId,
          source: 'user',
          userId,
        })
      }
      return result
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    }
  } finally {
    await rollbackAndRelease(client)
  }
}

export async function setDealStage(userId: string, id: string, stage: DealStage): Promise<DealRecord | null> {
  const client = await getAppPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL app.current_user_id = '${userId.replace(/'/g, "''")}'`)
    try {
      const result = await supersedeDeal(client, id, (old) => ({
        contactId: old.contactId,
        companyId: old.companyId,
        stage,
        amount: old.amount,
        closeDate: old.closeDate,
        externalRef: old.externalRef ?? {},
      }))
      if (!result) {
        await client.query('ROLLBACK')
        return null
      }
      await client.query('COMMIT')
      return result
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    }
  } finally {
    await rollbackAndRelease(client)
  }
}

// ── D.7 history walkers (WU-6.9) ─────────────────────────────────────
//
// Each walker projects the universal columns the unified row-history
// surface (`packages/api/src/db/row-history-store.ts`) needs to derive
// status and render compact identity. Public CRM record types remain
// unchanged — these rows are a history-specific shape.

export type CrmHistoryRow = {
  id: string
  workspaceId: string
  validFrom: Date
  validTo: Date | null
  supersededBy: string | null
  retractedAt: Date | null
  retractedReason: string | null
  createdByUserId: string | null
  createdByAssistantId: string | null
  createdAt: Date
  display: Record<string, unknown>
}

const COMPANY_HISTORY_SELECT = `
  id,
  workspace_id              AS "workspaceId",
  valid_from                AS "validFrom",
  valid_to                  AS "validTo",
  superseded_by             AS "supersededBy",
  retracted_at              AS "retractedAt",
  retracted_reason          AS "retractedReason",
  created_by_user_id        AS "createdByUserId",
  created_by_assistant_id   AS "createdByAssistantId",
  created_at                AS "createdAt",
  jsonb_build_object('name', name, 'domain', domain, 'tags', tags) AS display
`

const CONTACT_HISTORY_SELECT = `
  id,
  workspace_id              AS "workspaceId",
  valid_from                AS "validFrom",
  valid_to                  AS "validTo",
  superseded_by             AS "supersededBy",
  retracted_at              AS "retractedAt",
  retracted_reason          AS "retractedReason",
  created_by_user_id        AS "createdByUserId",
  created_by_assistant_id   AS "createdByAssistantId",
  created_at                AS "createdAt",
  jsonb_build_object('name', name, 'email', email, 'companyId', company_id) AS display
`

const DEAL_HISTORY_SELECT = `
  id,
  workspace_id              AS "workspaceId",
  valid_from                AS "validFrom",
  valid_to                  AS "validTo",
  superseded_by             AS "supersededBy",
  retracted_at              AS "retractedAt",
  retracted_reason          AS "retractedReason",
  created_by_user_id        AS "createdByUserId",
  created_by_assistant_id   AS "createdByAssistantId",
  created_at                AS "createdAt",
  jsonb_build_object('stage', stage, 'amount', amount, 'companyId', company_id, 'contactId', contact_id) AS display
`

export async function getCompanyHistory(ctx: AccessContext, id: string): Promise<CrmHistoryRow[]> {
  // D.7 invariant: chain rows share the universal-column tuple, so the
  // predicate gates the anchor only (WU-4.2b).
  const ap = buildAccessPredicate(ctx, { startIdx: 1 })
  const result = await queryWithRLS<CrmHistoryRow>(
    ctx.userId,
    `WITH RECURSIVE chain AS (
       SELECT id, superseded_by FROM companies
        WHERE ${ap.sql} AND id = $${ap.nextIdx}
       UNION
       SELECT c.id, c.superseded_by
         FROM companies c, chain ch
        WHERE c.id = ch.superseded_by OR c.superseded_by = ch.id
     )
     SELECT ${COMPANY_HISTORY_SELECT} FROM companies
      WHERE id IN (SELECT id FROM chain)
      ORDER BY valid_from ASC, created_at ASC`,
    [...ap.params, id],
  )
  return result.rows
}

export async function getContactHistory(ctx: AccessContext, id: string): Promise<CrmHistoryRow[]> {
  const ap = buildAccessPredicate(ctx, { startIdx: 1 })
  const result = await queryWithRLS<CrmHistoryRow>(
    ctx.userId,
    `WITH RECURSIVE chain AS (
       SELECT id, superseded_by FROM contacts
        WHERE ${ap.sql} AND id = $${ap.nextIdx}
       UNION
       SELECT c.id, c.superseded_by
         FROM contacts c, chain ch
        WHERE c.id = ch.superseded_by OR c.superseded_by = ch.id
     )
     SELECT ${CONTACT_HISTORY_SELECT} FROM contacts
      WHERE id IN (SELECT id FROM chain)
      ORDER BY valid_from ASC, created_at ASC`,
    [...ap.params, id],
  )
  return result.rows
}

export async function getDealHistory(ctx: AccessContext, id: string): Promise<CrmHistoryRow[]> {
  const ap = buildAccessPredicate(ctx, { startIdx: 1 })
  const result = await queryWithRLS<CrmHistoryRow>(
    ctx.userId,
    `WITH RECURSIVE chain AS (
       SELECT id, superseded_by FROM deals
        WHERE ${ap.sql} AND id = $${ap.nextIdx}
       UNION
       SELECT d.id, d.superseded_by
         FROM deals d, chain ch
        WHERE d.id = ch.superseded_by OR d.superseded_by = ch.id
     )
     SELECT ${DEAL_HISTORY_SELECT} FROM deals
      WHERE id IN (SELECT id FROM chain)
      ORDER BY valid_from ASC, created_at ASC`,
    [...ap.params, id],
  )
  return result.rows
}

// ── Relation label resolution (Phase 1 — Notion-feel) ────────────────
//
// View bindings emit `RelationWidget` cells (`{ entityType, id, label }`)
// for company/contact/deal references. `batchLabels` resolves a mixed
// set of ids to display labels in one pass, scoped by the caller's
// access context — ids the caller cannot see are silently omitted.

export async function batchLabels(
  ctx: AccessContext,
  requests: { entity: 'company' | 'contact' | 'deal'; ids: string[] }[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  await Promise.all(requests.map((req) => resolveLabels(ctx, req.entity, req.ids, out)))
  return out
}

async function resolveLabels(
  ctx: AccessContext,
  entity: 'company' | 'contact' | 'deal',
  ids: string[],
  out: Map<string, string>,
): Promise<void> {
  if (ids.length === 0) return
  const ap = buildAccessPredicate(ctx, { startIdx: 1 })
  if (entity === 'deal') {
    const result = await queryGated<{ id: string }>(
      ctx,
      `SELECT id FROM deals
        WHERE ${ap.sql} AND valid_to IS NULL AND id = ANY($${ap.nextIdx}::uuid[])`,
      [...ap.params, ids],
    )
    for (const row of result.rows) {
      out.set(`deal:${row.id}`, `Deal #${row.id.slice(0, 8)}`)
    }
    return
  }
  const table = entity === 'company' ? 'companies' : 'contacts'
  const result = await queryGated<{ id: string; name: string }>(
    ctx,
    `SELECT id, name FROM ${table}
      WHERE ${ap.sql} AND valid_to IS NULL AND id = ANY($${ap.nextIdx}::uuid[])`,
    [...ap.params, ids],
  )
  for (const row of result.rows) {
    out.set(`${entity}:${row.id}`, row.name)
  }
}
