import type { CrmAmount, DealStage, CrmExternalRef, CrmCustomFieldType, CrmCustomFieldEntityKind, CrmCustomFieldDefinition, CrmCustomFieldWriteResult } from '../application-platform/record-values.js'
/**
 * CRM store interface.
 *
 * Workspace-scoped contact / company / deal records (see
 * docs/architecture/features/crm.md). The canonical record shape remains
 * fixed while CRM R2 adds bounded workspace pipelines and typed custom
 * fields through the optional catalog methods below.
 *
 * Read methods take `ctx: AccessContext` (WU-4.2b) so the store can
 * compose the universal access predicate (workspace + visibility double
 * + sensitivity ≤ clearance) consistently with the rest of the brain.
 *
 * Injected by the API layer into `createCrmTools`. The core package has
 * no direct DB dependency — concrete impl lives in
 * `packages/api/src/db/crm-store.ts`.
 */

import type { AccessContext } from '@use-brian/agent-runtime/security/access-context.js'
import type { Sensitivity } from '@use-brian/agent-runtime/security/sensitivity.js'
import type { StableExternalIdentity } from '../decision-learning/types.js'

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
  /** Native entity aliases, separate from the canonical display name. */
  aliases?: string[]
  domain: string | null
  tags: string[]
  externalRef: CrmExternalRef
  sensitivity?: Sensitivity
  compartments?: string[]
  projectIds?: string[]
  createdAt: Date
  updatedAt: Date
}

export type CompanyListRow = Pick<
  CompanyRecord,
  'id' | 'workspaceId' | 'entityId' | 'name' | 'aliases' | 'domain' | 'tags' | 'sensitivity' | 'compartments' | 'projectIds' | 'updatedAt'
>

export type CompanyListFilters = {
  query?: string
  tag?: string
  limit?: number
}

export type CompanyUpdateFields = {
  aliases?: string[]
  tags?: string[]
  ownerId?: string | null
  archivedAt?: string | null

  /** Current declared custom keys, committed with the typed business patch. */
  customFields?: Record<string, unknown>
  name?: string
  /** Pass `null` to clear; omit to leave unchanged. */
  domain?: string | null
  externalRef?: CrmExternalRef
}

// ── Contacts ───────────────────────────────────────────────────────

export type ContactRecord = {
  id: string
  workspaceId: string
  /** Underlying entity row id — see CompanyRecord.entityId for context. */
  entityId: string | null
  name: string
  /** Native entity aliases, separate from the canonical display name. */
  aliases?: string[]
  email: string | null
  phone: string | null
  companyId: string | null
  tags: string[]
  externalRef: CrmExternalRef
  sensitivity?: Sensitivity
  compartments?: string[]
  projectIds?: string[]
  createdAt: Date
  updatedAt: Date
}

export type ContactListRow = Pick<
  ContactRecord,
  'id' | 'workspaceId' | 'entityId' | 'name' | 'aliases' | 'email' | 'phone' | 'companyId' | 'tags' | 'sensitivity' | 'compartments' | 'projectIds' | 'updatedAt'
>

export type ContactListFilters = {
  query?: string
  tag?: string
  companyId?: string
  limit?: number
}

export type ContactUpdateFields = {
  aliases?: string[]
  tags?: string[]
  ownerId?: string | null
  archivedAt?: string | null

  /** Current declared custom keys, committed with the typed business patch. */
  customFields?: Record<string, unknown>
  name?: string
  /** Pass `null` to clear; omit to leave unchanged. */
  email?: string | null
  /** Pass `null` to clear; omit to leave unchanged. */
  phone?: string | null
  /** Pass `null` to clear; omit to leave unchanged. */
  companyId?: string | null
  externalRef?: CrmExternalRef
}

// ── Deals ──────────────────────────────────────────────────────────

export type DealRecord = {
  id: string
  workspaceId: string
  /** Underlying entity row id — see CompanyRecord.entityId for context. */
  entityId: string | null
  /** The deal entity's `display_name` (e.g. "Deal - Acme"), the row's title
   *  on operator surfaces. */
  name: string
  /** Native entity aliases, separate from the canonical display name. */
  aliases?: string[]
  contactId: string | null
  companyId: string | null
  stage: DealStage
  amount: CrmAmount | null
  closeDate: Date | null
  externalRef: CrmExternalRef
  sensitivity?: Sensitivity
  compartments?: string[]
  projectIds?: string[]
  createdAt: Date
  updatedAt: Date
}

export type DealListRow = Pick<
  DealRecord,
  'id' | 'workspaceId' | 'entityId' | 'name' | 'aliases' | 'contactId' | 'companyId' | 'stage' | 'amount' | 'closeDate' | 'sensitivity' | 'compartments' | 'projectIds' | 'updatedAt'
>

export type DealListFilters = {
  stage?: DealStage | DealStage[]
  contactId?: string
  companyId?: string
  limit?: number
}

export type DealUpdateFields = {
  name?: string
  stage?: DealStage
  pipelineId?: string | null
  pipelineStageId?: string | null
  currencyCode?: string | null
  source?: string | null
  winLossReason?: string | null
  probability?: number | null
  aliases?: string[]
  tags?: string[]
  ownerId?: string | null
  archivedAt?: string | null

  /** Current declared custom keys, committed with the typed business patch. */
  customFields?: Record<string, unknown>
  /** Pass `null` to clear; omit to leave unchanged. */
  contactId?: string | null
  /** Pass `null` to clear; omit to leave unchanged. */
  companyId?: string | null
  /** Pass `null` to clear; omit to leave unchanged. */
  amount?: CrmAmount | null
  /** Pass `null` to clear; omit to leave unchanged. */
  closeDate?: Date | null
  externalRef?: CrmExternalRef
}

// ── Store ──────────────────────────────────────────────────────────

export type CrmStore = {
  // Companies
  createCompany(params: {
    /** Initial current custom values; required values belong in this insert. */
    customFields?: Record<string, unknown>
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
    projectIds?: string[]
    /** Fresh-insert source; default 'user'; synthesis passes 'extracted' so the row surfaces in Brain Reviews. */
    source?: 'user' | 'extracted'
    /** Extraction provenance anchor — the Episode this row derives from (Pipeline B / compose / synthesis). */
    sourceEpisodeId?: string | null
    /** Interactive-write provenance anchor (mig 316) — the creating conversation's session (chat saves). */
    sourceSessionId?: string | null
    /** The assistant that mediated the write. */
    createdByAssistantId?: string | null
    /** Viewer projection for access-scoped company deduplication. */
    access?: AccessContext
  }): Promise<CompanyRecord>

  getCompanyById(ctx: AccessContext, id: string): Promise<CompanyRecord | null>

  listCompanies(ctx: AccessContext, filters: CompanyListFilters): Promise<CompanyListRow[]>

  /**
   * `access` is the viewer projection for the update-by-id write (read/
   * write symmetry with the dedupe scan): the target row is matched under
   * this context, so a caller can never patch a row that reads hide from
   * them. Omitted → the store falls back to the user-axis projection
   * derived from `userId`.
   */
  updateCompany(
    userId: string,
    id: string,
    fields: CompanyUpdateFields,
    access?: AccessContext,
    scope?: { compartments: string[]; projectIds: string[]; sensitivity?: Sensitivity },
  ): Promise<CompanyRecord | null>

  // Contacts
  createContact(params: {
    /** Initial current custom values; required values belong in this insert. */
    customFields?: Record<string, unknown>
    userId: string
    workspaceId: string
    name: string
    email?: string | null
    phone?: string | null
    companyId?: string | null
    tags?: string[]
    externalRef?: CrmExternalRef
    /**
     * Adapter-verified stable provider subject. This is the only automatic
     * person write authority; free-form `externalRef`, email, phone, name,
     * aliases, and fuzzy matches remain metadata/candidates.
     */
    stableIdentity?: StableExternalIdentity
    /** Fresh-insert sensitivity tier; omitted → store default (`internal`). Research saves pass `public`. */
    sensitivity?: Sensitivity
    /** Compartment set (MLS category axis) stamped on the fresh entity + specialization pair. Default '{}'. */
    compartments?: string[]
    projectIds?: string[]
    /** Fresh-insert source; default 'user'; synthesis passes 'extracted' so the row surfaces in Brain Reviews. */
    source?: 'user' | 'extracted'
    /** Extraction provenance anchor — the Episode this row derives from (Pipeline B / compose / synthesis). */
    sourceEpisodeId?: string | null
    /** Interactive-write provenance anchor (mig 316) — the creating conversation's session (chat saves). */
    sourceSessionId?: string | null
    /** The assistant that mediated the write. */
    createdByAssistantId?: string | null
    /** Viewer projection used when a stable binding resolves an existing row. */
    access?: AccessContext
  }): Promise<ContactRecord>

  getContactById(ctx: AccessContext, id: string): Promise<ContactRecord | null>

  listContacts(ctx: AccessContext, filters: ContactListFilters): Promise<ContactListRow[]>

  /** `access`: see `updateCompany` — write-path viewer projection. */
  updateContact(
    userId: string,
    id: string,
    fields: ContactUpdateFields,
    access?: AccessContext,
    scope?: { compartments: string[]; projectIds: string[]; sensitivity?: Sensitivity },
  ): Promise<ContactRecord | null>

  // Deals
  createDeal(params: {
    /** Initial current custom values; required values belong in this insert. */
    customFields?: Record<string, unknown>
    userId: string
    workspaceId: string
    access?: AccessContext
    contactId?: string | null
    companyId?: string | null
    stage?: DealStage
    amount?: CrmAmount | null
    closeDate?: Date | null
    externalRef?: CrmExternalRef
    /** Fresh-insert sensitivity tier; omitted → store default (`internal`). Research saves pass `public`. */
    sensitivity?: Sensitivity
    /** Compartment set (MLS category axis) stamped on the fresh entity + specialization pair. Default '{}'. */
    compartments?: string[]
    projectIds?: string[]
    /** Fresh-insert source; default 'user'; synthesis passes 'extracted' so the row surfaces in Brain Reviews. */
    source?: 'user' | 'extracted'
    /** Extraction provenance anchor — the Episode this row derives from (Pipeline B / compose / synthesis). */
    sourceEpisodeId?: string | null
    /** Interactive-write provenance anchor (mig 316) — the creating conversation's session (chat saves). */
    sourceSessionId?: string | null
    /** The assistant that mediated the write. */
    createdByAssistantId?: string | null
  }): Promise<DealRecord>

  getDealById(ctx: AccessContext, id: string): Promise<DealRecord | null>

  listDeals(ctx: AccessContext, filters: DealListFilters): Promise<DealListRow[]>

  /** `access`: see `updateCompany` — write-path viewer projection. */
  updateDeal(
    userId: string,
    id: string,
    fields: DealUpdateFields,
    access?: AccessContext,
    scope?: { compartments: string[]; projectIds: string[]; sensitivity?: Sensitivity },
  ): Promise<DealRecord | null>

  /** Stage-only update — sole cut-point for stage transitions. */
  /** `access`: see `updateCompany` — write-path viewer projection. */
  setDealStage(
    userId: string,
    id: string,
    stage: DealStage,
    access?: AccessContext,
    scope?: { compartments: string[]; projectIds: string[]; sensitivity?: Sensitivity },
  ): Promise<DealRecord | null>

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

  /** Live typed workspace vocabulary used by both chat and Brain MCP. */
  listCustomFields?(
    ctx: AccessContext,
    entityKind?: CrmCustomFieldEntityKind,
  ): Promise<CrmCustomFieldDefinition[]>

  /** Read current typed values for one visible CRM entity. */
  getCustomFields?(
    ctx: AccessContext,
    entityId: string,
  ): Promise<CrmCustomFieldWriteResult | null>

  /** Patch one visible CRM entity through the R2 catalog and reference gate. */
  setCustomFields?(
    ctx: AccessContext,
    entityId: string,
    values: Record<string, unknown>,
  ): Promise<CrmCustomFieldWriteResult | null>
}


export { crmAmountSchema, decodeCrmAmount, DEAL_STAGES, CRM_CUSTOM_FIELD_TYPES, validateCrmCustomFieldValue } from '../application-platform/record-values.js'
export type { CrmAmount, DealStage, CrmExternalRef, CrmCustomFieldType, CrmCustomFieldEntityKind, CrmCustomFieldDefinition, CrmCustomFieldWriteResult } from '../application-platform/record-values.js'
