/**
 * CRM store interface.
 *
 * Workspace-scoped contact / company / deal records (see
 * docs/architecture/features/crm.md). Schema is deliberately frozen v1
 * per docs/plans/company-brain.md §15: no custom fields, no custom
 * pipelines.
 *
 * Read methods take `ctx: AccessContext` (WU-4.2b) so the store can
 * compose the universal access predicate (workspace + visibility double
 * + sensitivity ≤ clearance) consistently with the rest of the brain.
 *
 * Injected by the API layer into `createCrmTools`. The core package has
 * no direct DB dependency — concrete impl lives in
 * `packages/api/src/db/crm-store.ts`.
 */

import type { AccessContext } from '../security/access-context.js'
import type { Sensitivity } from '../security/sensitivity.js'

export const DEAL_STAGES = ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'] as const
export type DealStage = (typeof DEAL_STAGES)[number]

/**
 * External-system reference for synced rows. Free-form for v1; the
 * intended shape is `{provider, id, url}` but it is not validated at this
 * layer. Open item #5 (sync engine architecture) will firm up the schema
 * later. Same convention as `TaskExternalRef`.
 */
export type CrmExternalRef = Record<string, unknown>

// ── Companies ──────────────────────────────────────────────────────

export type CompanyRecord = {
  id: string
  workspaceId: string
  /**
   * Underlying entity row id (Q24 CRM-as-specialization). Used as the
   * source/target id when the chat layer writes `entity_links` rows
   * — the edge graph operates on entities, not on CRM table rows.
   * Null only for legacy "brain-blind" companies created before Q24
   * forward-only entity backing.
   */
  entityId: string | null
  name: string
  domain: string | null
  tags: string[]
  externalRef: CrmExternalRef
  createdAt: Date
  updatedAt: Date
}

export type CompanyListRow = Pick<
  CompanyRecord,
  'id' | 'workspaceId' | 'entityId' | 'name' | 'domain' | 'tags' | 'updatedAt'
>

export type CompanyListFilters = {
  query?: string
  tag?: string
  limit?: number
}

export type CompanyUpdateFields = {
  name?: string
  /** Pass `null` to clear; omit to leave unchanged. */
  domain?: string | null
  tags?: string[]
  externalRef?: CrmExternalRef
}

// ── Contacts ───────────────────────────────────────────────────────

export type ContactRecord = {
  id: string
  workspaceId: string
  /** Underlying entity row id — see CompanyRecord.entityId for context. */
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

export type ContactListRow = Pick<
  ContactRecord,
  'id' | 'workspaceId' | 'entityId' | 'name' | 'email' | 'companyId' | 'tags' | 'updatedAt'
>

export type ContactListFilters = {
  query?: string
  tag?: string
  companyId?: string
  limit?: number
}

export type ContactUpdateFields = {
  name?: string
  /** Pass `null` to clear; omit to leave unchanged. */
  email?: string | null
  /** Pass `null` to clear; omit to leave unchanged. */
  phone?: string | null
  /** Pass `null` to clear; omit to leave unchanged. */
  companyId?: string | null
  tags?: string[]
  externalRef?: CrmExternalRef
}

// ── Deals ──────────────────────────────────────────────────────────

export type DealRecord = {
  id: string
  workspaceId: string
  /** Underlying entity row id — see CompanyRecord.entityId for context. */
  entityId: string | null
  contactId: string | null
  companyId: string | null
  stage: DealStage
  amount: number | null
  closeDate: Date | null
  externalRef: CrmExternalRef
  createdAt: Date
  updatedAt: Date
}

export type DealListRow = Pick<
  DealRecord,
  'id' | 'workspaceId' | 'entityId' | 'contactId' | 'companyId' | 'stage' | 'amount' | 'closeDate' | 'updatedAt'
>

export type DealListFilters = {
  stage?: DealStage | DealStage[]
  contactId?: string
  companyId?: string
  limit?: number
}

export type DealUpdateFields = {
  /** Pass `null` to clear; omit to leave unchanged. */
  contactId?: string | null
  /** Pass `null` to clear; omit to leave unchanged. */
  companyId?: string | null
  /** Pass `null` to clear; omit to leave unchanged. */
  amount?: number | null
  /** Pass `null` to clear; omit to leave unchanged. */
  closeDate?: Date | null
  externalRef?: CrmExternalRef
}

// ── Store ──────────────────────────────────────────────────────────

export type CrmStore = {
  // Companies
  createCompany(params: {
    userId: string
    workspaceId: string
    name: string
    domain?: string | null
    tags?: string[]
    externalRef?: CrmExternalRef
    /** Fresh-insert sensitivity tier; omitted → store default (`internal`). Research saves pass `public`. */
    sensitivity?: Sensitivity
    /** Compartment set (MLS category axis) stamped on the fresh entity + specialization pair. Default '{}'. */
    compartments?: string[]
    /** Fresh-insert source; default 'user'; synthesis passes 'extracted' so the row surfaces in Brain Reviews. */
    source?: 'user' | 'extracted'
    /**
     * Viewer projection for the upsert-dedupe scan: candidates are selected
     * under this access context so the write never merges into a row the
     * caller cannot read back (read-your-write). Omitted → the store falls
     * back to the user-axis projection derived from `userId`.
     */
    access?: AccessContext
  }): Promise<CompanyRecord>

  getCompanyById(ctx: AccessContext, id: string): Promise<CompanyRecord | null>

  listCompanies(ctx: AccessContext, filters: CompanyListFilters): Promise<CompanyListRow[]>

  updateCompany(userId: string, id: string, fields: CompanyUpdateFields): Promise<CompanyRecord | null>

  // Contacts
  createContact(params: {
    userId: string
    workspaceId: string
    name: string
    email?: string | null
    phone?: string | null
    companyId?: string | null
    tags?: string[]
    externalRef?: CrmExternalRef
    /** Fresh-insert sensitivity tier; omitted → store default (`internal`). Research saves pass `public`. */
    sensitivity?: Sensitivity
    /** Compartment set (MLS category axis) stamped on the fresh entity + specialization pair. Default '{}'. */
    compartments?: string[]
    /** Fresh-insert source; default 'user'; synthesis passes 'extracted' so the row surfaces in Brain Reviews. */
    source?: 'user' | 'extracted'
    /**
     * Viewer projection for the upsert-dedupe scan: candidates are selected
     * under this access context so the write never merges into a row the
     * caller cannot read back (read-your-write). Omitted → the store falls
     * back to the user-axis projection derived from `userId`.
     */
    access?: AccessContext
  }): Promise<ContactRecord>

  getContactById(ctx: AccessContext, id: string): Promise<ContactRecord | null>

  listContacts(ctx: AccessContext, filters: ContactListFilters): Promise<ContactListRow[]>

  updateContact(userId: string, id: string, fields: ContactUpdateFields): Promise<ContactRecord | null>

  // Deals
  createDeal(params: {
    userId: string
    workspaceId: string
    contactId?: string | null
    companyId?: string | null
    stage?: DealStage
    amount?: number | null
    closeDate?: Date | null
    externalRef?: CrmExternalRef
    /** Fresh-insert sensitivity tier; omitted → store default (`internal`). Research saves pass `public`. */
    sensitivity?: Sensitivity
    /** Compartment set (MLS category axis) stamped on the fresh entity + specialization pair. Default '{}'. */
    compartments?: string[]
    /** Fresh-insert source; default 'user'; synthesis passes 'extracted' so the row surfaces in Brain Reviews. */
    source?: 'user' | 'extracted'
  }): Promise<DealRecord>

  getDealById(ctx: AccessContext, id: string): Promise<DealRecord | null>

  listDeals(ctx: AccessContext, filters: DealListFilters): Promise<DealListRow[]>

  updateDeal(userId: string, id: string, fields: DealUpdateFields): Promise<DealRecord | null>

  /** Stage-only update — sole cut-point for stage transitions. */
  setDealStage(userId: string, id: string, stage: DealStage): Promise<DealRecord | null>

  /**
   * Batch label resolution for Relation cells (Phase 1 — Notion-feel).
   *
   * View bindings emit a `RelationWidget` per row that references a CRM
   * entity by id. The widget carries a human-readable `label` resolved
   * server-side so the renderer never needs a directory lookup.
   *
   * Returns a `Map` keyed by `${entity}:${id}` (e.g. `'company:abc-…'`),
   * which lets a single call resolve mixed entity types in one round
   * trip. Ids not visible under `ctx`'s access predicate are silently
   * omitted (no leaking labels across workspaces).
   *
   * Deals do not carry a `name` column; the resolver returns
   * `Deal #<first-8-chars-of-id>` for visible deals, matching the
   * id-slice fallback that bindings used pre-Phase-1.
   */
  batchLabels(
    ctx: AccessContext,
    requests: { entity: 'company' | 'contact' | 'deal'; ids: string[] }[],
  ): Promise<Map<string, string>>
}
