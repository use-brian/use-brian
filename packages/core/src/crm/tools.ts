import { z } from 'zod'
import type { Classifier } from '../classification/types.js'
import type { EntityKind } from '../entities/types.js'
import type { AccessContext } from '../security/access-context.js'
import { researchWriteFloor } from '../security/sensitivity.js'
import { unionCompartments } from '../security/compartments.js'
import { buildTool, type Tool } from '../tools/types.js'
import {
  applyExplicitCloses,
  applyExplicitLinks,
  explicitClosesField,
  explicitLinksField,
  formatClosesSummary,
  formatLinksSummary,
  type EntityLinksStore,
} from '../entities/index.js'
import {
  DEAL_STAGES,
  type CompanyListRow,
  type CompanyRecord,
  type ContactListRow,
  type ContactRecord,
  type CrmStore,
  type DealListRow,
  type DealRecord,
  type DealStage,
} from './types.js'

/**
 * Tools that let the primary assistant manage workspace-scoped CRM
 * records via chat. 13 tools across three entities:
 *
 *   contacts:  saveContact, getContact, listContacts, updateContact
 *   companies: saveCompany, getCompany, listCompanies, updateCompany
 *   deals:     saveDeal, getDeal, listDeals, updateDeal, advanceDealStage
 *
 * Same-shape helpers + structure as `createTaskTools` (Q1) — see
 * docs/architecture/features/crm.md.
 *
 * Every tool requires `ctx.workspaceId`. Without a workspace there is no
 * place for CRM rows to live; the tool returns an isError result rather
 * than implicitly creating user-scoped state. The §9 collapse migration
 * guarantees every signed-in user has at least a Personal workspace, so
 * an absent `workspaceId` is a real error path (legacy / system caller).
 */

export type CrmToolEvent =
  | { type: 'contact_created'; contactId: string }
  | { type: 'contact_updated'; contactId: string; fields: string[] }
  | { type: 'contact_listed'; resultCount: number }
  | { type: 'company_created'; companyId: string }
  | { type: 'company_updated'; companyId: string; fields: string[] }
  | { type: 'company_listed'; resultCount: number }
  | { type: 'deal_created'; dealId: string }
  | { type: 'deal_updated'; dealId: string; fields: string[] }
  | { type: 'deal_stage_advanced'; dealId: string; stage: DealStage }
  | { type: 'deal_listed'; resultCount: number }

/** Subset of ToolContext the analytics callback can use without pulling the full type in. */
export type CrmToolEventContext = {
  userId: string
  assistantId: string
  sessionId: string
  channelType: string
}

export type CrmToolOptions = {
  /** Receives every primitive event with the originating tool context. Wire to AnalyticsLogger at boot. */
  onEvent?: (event: CrmToolEvent, ctx: CrmToolEventContext) => void
  /**
   * Edge store for writing explicit `links` rows alongside the CRM
   * row. Optional — when absent the `links` input field is silently
   * dropped (the implicit `works_at` / `engagement_of` hooks live on
   * the store factory and continue to fire independently). Always
   * inject this at API boot; the optional shape exists for tests.
   */
  entityLinks?: EntityLinksStore
  /**
   * Entity-kind classifier. When provided, each save tool runs the
   * classifier against the tool args; deterministic mismatch returns
   * a typed rejection (Decision 2) so the LLM can re-call the right
   * tool or escalate to the user. Probabilistic match attaches
   * `suggestions[]` to the success result.
   *
   * Spec: docs/architecture/brain/classification/README.md
   *   §Decision semantics per boundary — B2 chat tool
   */
  entityKindClassifier?: Classifier<EntityKind>
  /**
   * `source` stamped on rows these tools create. Default behavior (absent)
   * is unchanged — the store writes its default `'user'`. The structural-
   * synthesis engine builds these tools with `writeSource: 'extracted'` so
   * synthesis-captured companies / contacts / deals surface in Brain Reviews
   * (`?includeExtracted=true`). Only affects fresh inserts; the upsert/merge
   * path preserves the existing row's source.
   */
  writeSource?: 'user' | 'extracted'
}

/**
 * Tool name a rejection should suggest the LLM re-call when the
 * classifier disagrees. Maps the classified kind to the right CRM /
 * generic tool name.
 */
const TOOL_NAME_FOR_KIND: Record<string, string | undefined> = {
  person: 'saveContact',
  company: 'saveCompany',
  deal: 'saveDeal',
  repository: 'createEntity',
  project: 'createEntity',
  product: 'createEntity',
}

/**
 * Pre-write classifier check for a CRM save tool. Returns a typed
 * rejection on deterministic mismatch (LLM must re-call), or null
 * to indicate the write may proceed.
 *
 * `suggestions[]` accumulator is mutated for probabilistic hints so
 * the calling tool can attach them to its success result.
 */
function runChatToolClassifier(
  classifier: Classifier<EntityKind> | undefined,
  expectedKind: 'person' | 'company' | 'deal',
  candidate: {
    primary: string
    canonical_id?: string | null
    attributes?: Record<string, unknown>
  },
  suggestionsOut: Array<{ rule_id: string; suggested_value: string; confidence: number; hint: string }>,
): { data: string; isError: true } | null {
  if (!classifier) return null
  try {
    const decision = classifier.decide({ ...candidate, proposed: expectedKind }, 'tool')
    if (decision.kind === 'override' && decision.match.value !== expectedKind) {
      const suggestedTool = TOOL_NAME_FOR_KIND[decision.match.value]
      const explanation =
        `Classifier rule ${decision.match.rule_id} indicates this input is a ${decision.match.value}, ` +
        `not a ${expectedKind}.` +
        (suggestedTool ? ` Re-call ${suggestedTool} with the same arguments.` : ' Ask the user how to record it.')
      return {
        data: JSON.stringify({
          ok: false,
          reason: 'reclassified',
          blocking_rule_id: decision.match.rule_id,
          explanation,
          suggested_tool: suggestedTool,
          suggested_kind: decision.match.value,
        }),
        isError: true,
      }
    }
    if (decision.kind === 'blocked') {
      const block = decision.suppressedBy[0]
      return {
        data: JSON.stringify({
          ok: false,
          reason: 'reclassified',
          blocking_rule_id: block?.rule_id ?? 'unknown',
          explanation:
            block?.reason ??
            `Classifier blocked save${expectedKind ? ` as ${expectedKind}` : ''} — input does not match the expected shape.`,
        }),
        isError: true,
      }
    }
    if (decision.kind === 'hint') {
      for (const m of decision.matches) {
        if (m.value === expectedKind) continue  // matching hints aren't worth surfacing
        suggestionsOut.push({
          rule_id: m.rule_id,
          suggested_value: m.value,
          confidence: m.confidence,
          hint: `Rule ${m.rule_id} suggests ${m.value}.`,
        })
      }
    }
  } catch (err) {
    // Classifier failure must never block a tool call
    console.warn(`[crm-tools] classifier check failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  return null
}

/** Format a suggestion list into a trailing hint string for the success message. */
function formatSuggestions(
  suggestions: Array<{ rule_id: string; suggested_value: string; confidence: number; hint: string }>,
): string {
  if (suggestions.length === 0) return ''
  const top = suggestions[0]!
  return ` (suggestion: ${top.hint})`
}

const STAGE_VALUES = [...DEAL_STAGES] as [DealStage, ...DealStage[]]
const stageEnum = z.enum(STAGE_VALUES)

const idShape = z.string().uuid()
const tagShape = z.array(z.string().min(1).max(64)).max(20)
const externalRefShape = z.record(z.unknown())

function workspaceGate(workspaceId: string | null | undefined): { data: string; isError: true } | null {
  if (!workspaceId) {
    return {
      data: 'CRM tools require a workspace. This assistant is not bound to one — switch to a workspace-scoped chat to manage contacts, companies, and deals.',
      isError: true,
    }
  }
  return null
}

function ctxFor(context: {
  userId: string
  assistantId: string
  workspaceId: string
  assistantKind?: AccessContext['assistantKind']
  clearance?: AccessContext['clearance']
  compartments?: AccessContext['compartments']
}): AccessContext {
  return {
    workspaceId: context.workspaceId,
    userId: context.userId,
    assistantId: context.assistantId,
    assistantKind: context.assistantKind ?? 'standard',
    clearance: context.clearance,
    compartments: context.compartments,
  }
}

function eventCtx(context: { userId: string; assistantId: string; sessionId: string; channelType: string }): CrmToolEventContext {
  return {
    userId: context.userId,
    assistantId: context.assistantId,
    sessionId: context.sessionId,
    channelType: context.channelType,
  }
}

// ── Row formatters ──────────────────────────────────────────────────

// Every projection emits `entity_id` alongside `id`. `id` is the
// CRM-row id (contacts.id / companies.id / deals.id) — the right
// argument for getContact / updateContact / etc. `entity_id` is the
// underlying entities-table row — the right argument for createEdge
// source_id / target_id. Surfacing both lets the model chain into
// edge writes without a second lookup; without `entity_id` the model
// guesses (passes the CRM id) and hits the entity_links FK constraint.
function compactContact(row: ContactListRow): {
  id: string
  entity_id: string | null
  name: string
  email: string | null
  company_id: string | null
  tags: string[]
  updated_at: string
} {
  return {
    id: row.id,
    entity_id: row.entityId,
    name: row.name,
    email: row.email,
    company_id: row.companyId,
    tags: row.tags,
    updated_at: row.updatedAt.toISOString(),
  }
}

function fullContact(row: ContactRecord): {
  id: string
  entity_id: string | null
  name: string
  email: string | null
  phone: string | null
  company_id: string | null
  tags: string[]
  external_ref: Record<string, unknown>
  created_at: string
  updated_at: string
} {
  return {
    id: row.id,
    entity_id: row.entityId,
    name: row.name,
    email: row.email,
    phone: row.phone,
    company_id: row.companyId,
    tags: row.tags,
    external_ref: row.externalRef,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  }
}

function compactCompany(row: CompanyListRow): {
  id: string
  entity_id: string | null
  name: string
  domain: string | null
  tags: string[]
  updated_at: string
} {
  return {
    id: row.id,
    entity_id: row.entityId,
    name: row.name,
    domain: row.domain,
    tags: row.tags,
    updated_at: row.updatedAt.toISOString(),
  }
}

function fullCompany(row: CompanyRecord): {
  id: string
  entity_id: string | null
  name: string
  domain: string | null
  tags: string[]
  external_ref: Record<string, unknown>
  created_at: string
  updated_at: string
} {
  return {
    id: row.id,
    entity_id: row.entityId,
    name: row.name,
    domain: row.domain,
    tags: row.tags,
    external_ref: row.externalRef,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  }
}

function compactDeal(row: DealListRow): {
  id: string
  entity_id: string | null
  contact_id: string | null
  company_id: string | null
  stage: DealStage
  amount: number | null
  close_date: string | null
  updated_at: string
} {
  return {
    id: row.id,
    entity_id: row.entityId,
    contact_id: row.contactId,
    company_id: row.companyId,
    stage: row.stage,
    amount: row.amount,
    close_date: row.closeDate ? row.closeDate.toISOString().slice(0, 10) : null,
    updated_at: row.updatedAt.toISOString(),
  }
}

function fullDeal(row: DealRecord): {
  id: string
  entity_id: string | null
  contact_id: string | null
  company_id: string | null
  stage: DealStage
  amount: number | null
  close_date: string | null
  external_ref: Record<string, unknown>
  created_at: string
  updated_at: string
} {
  return {
    id: row.id,
    entity_id: row.entityId,
    contact_id: row.contactId,
    company_id: row.companyId,
    stage: row.stage,
    amount: row.amount,
    close_date: row.closeDate ? row.closeDate.toISOString().slice(0, 10) : null,
    external_ref: row.externalRef,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  }
}

function translateLinkError(err: unknown): { data: string; isError: true } | null {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.includes('company_id must reference a company in the same workspace')) {
    return { data: 'company_id must reference a company in the same workspace.', isError: true }
  }
  if (msg.includes('contact_id must reference a contact in the same workspace')) {
    return { data: 'contact_id must reference a contact in the same workspace.', isError: true }
  }
  if (msg.includes('foreign key') && msg.includes('company')) {
    return { data: 'company_id not found in this workspace.', isError: true }
  }
  if (msg.includes('foreign key') && msg.includes('contact')) {
    return { data: 'contact_id not found in this workspace.', isError: true }
  }
  if (msg.includes('invalid input syntax for type uuid')) {
    return { data: 'Invalid UUID — pass an id from a prior list/get call.', isError: true }
  }
  return null
}

export function createCrmTools(
  store: CrmStore,
  opts?: CrmToolOptions,
): {
  saveContact: Tool
  getContact: Tool
  listContacts: Tool
  updateContact: Tool
  saveCompany: Tool
  getCompany: Tool
  listCompanies: Tool
  updateCompany: Tool
  saveDeal: Tool
  getDeal: Tool
  listDeals: Tool
  updateDeal: Tool
  advanceDealStage: Tool
} {
  // ── Contacts ────────────────────────────────────────────────────
  const saveContact = buildTool({
    name: 'saveContact',
    requiresCapability: 'crm',
    description:
      'Upsert a contact in the current workspace. Dedupes on email first (case-insensitive), falling back to display name — an existing active contact with the same email or name is superseded with merged tags (union), non-empty phone / email / company_id (incoming wins), and external_ref (shallow merge). Contacts are visible to every workspace member. Use updateContact when you have an explicit id and need to patch other fields. ' +
      'Pass company_id only after listCompanies confirms the company exists in this workspace; cross-workspace links are rejected by the DB. ' +
      'Pass `links` to record relationship edges from this contact (e.g. cofounder_of a company, attended an event, mentioned in a deal). Use the `entityId` returned from prior saveCompany / saveContact / saveDeal / createEntity calls (or read from list*).',
    inputSchema: z.object({
      name: z.string().min(1).max(256).describe('Full display name (e.g. "Sam Lee").'),
      email: z.string().email().optional(),
      phone: z.string().max(64).optional(),
      company_id: idShape.optional().describe('UUID of an existing company in this workspace. Omit if unknown or unaffiliated. Setting this auto-writes a works_at edge — do NOT also pass a duplicate works_at in `links`.'),
      tags: tagShape.optional(),
      external_ref: externalRefShape.optional().describe('Reserved for sync-engine round-tripping ({provider, id, url}). Leave empty unless mirroring an existing Attio/HubSpot record.'),
      links: explicitLinksField,
    }),
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const suggestions: Array<{ rule_id: string; suggested_value: string; confidence: number; hint: string }> = []
      const reject = runChatToolClassifier(
        opts?.entityKindClassifier,
        'person',
        {
          primary: input.name,
          canonical_id: input.email ?? null,
          attributes: input.email ? { email: input.email } : undefined,
        },
        suggestions,
      )
      if (reject) return reject

      try {
        const contact = await store.createContact({
          userId: context.userId,
          workspaceId: context.workspaceId!,
          name: input.name,
          email: input.email ?? null,
          phone: input.phone ?? null,
          companyId: input.company_id ?? null,
          tags: input.tags,
          externalRef: input.external_ref,
          // Research findings come from the public web — stamp `public`
          // (confidential source seen still floors). Else: store default.
          sensitivity: context.researchMode
            ? researchWriteFloor(context.sensitivity?.max, true)
            : undefined,
          compartments: unionCompartments(
            context.compartmentAccumulator?.compartments,
            context.assistantDefaultCompartments,
          ),
          source: opts?.writeSource,
        })
        opts?.onEvent?.({ type: 'contact_created', contactId: contact.id }, eventCtx(context))
        const linksSummary = await applyExplicitLinks({
          entityLinks: opts?.entityLinks,
          workspaceId: context.workspaceId!,
          userId: context.userId,
          assistantId: context.assistantId,
          sourceKind: 'entity',
          sourceId: contact.entityId ?? '',
          source: 'user',
          links: contact.entityId ? input.links : undefined,
        })
        const entitySuffix = contact.entityId ? `, entityId=${contact.entityId}` : ''
        return {
          data:
            `Created contact [${contact.id}${entitySuffix}]: ${contact.name}` +
            formatLinksSummary(linksSummary) +
            formatSuggestions(suggestions),
        }
      } catch (err) {
        const translated = translateLinkError(err)
        if (translated) return translated
        throw err
      }
    },
  })

  const getContact = buildTool({
    name: 'getContact',
    requiresCapability: 'crm',
    description: 'Fetch the full contact record by id, including phone, external_ref, and created_at. Use this when listContacts (compact projection) doesn\'t have what you need.',
    inputSchema: z.object({ id: idShape }),
    isConcurrencySafe: true,
    isReadOnly: true,
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate
      const contact = await store.getContactById(
        ctxFor({
          userId: context.userId,
          assistantId: context.assistantId,
          workspaceId: context.workspaceId!,
          assistantKind: context.assistantKind,
          clearance: context.clearance,
          compartments: context.compartments,
        }),
        input.id,
      )
      if (!contact || contact.workspaceId !== context.workspaceId) {
        return { data: `Contact ${input.id} not found in workspace.`, isError: true }
      }
      return { data: fullContact(contact) }
    },
  })

  const listContacts = buildTool({
    name: 'listContacts',
    requiresCapability: 'crm',
    description:
      'List contacts in the current workspace, filtered by any combination of query (substring on name+email), tag, or company_id. ' +
      'Returns a compact projection (id, name, email, company_id, tags, updated_at) sized for downstream tool calls. Use getContact for the full record. ' +
      'Default limit is 25 (max 100). If multiple contacts match, ASK the user to disambiguate by id — do not pick the first match.',
    inputSchema: z.object({
      query: z.string().min(1).max(128).optional().describe('ILIKE substring on name and email.'),
      tag: z.string().min(1).max(64).optional(),
      company_id: idShape.optional(),
      limit: z.coerce.number().int().min(1).max(100).optional().default(25),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const rows = await store.listContacts(
        ctxFor({
          userId: context.userId,
          assistantId: context.assistantId,
          workspaceId: context.workspaceId!,
          assistantKind: context.assistantKind,
          clearance: context.clearance,
          compartments: context.compartments,
        }),
        {
          query: input.query,
          tag: input.tag,
          companyId: input.company_id,
          limit: input.limit,
        },
      )

      opts?.onEvent?.({ type: 'contact_listed', resultCount: rows.length }, eventCtx(context))
      return { data: rows.map(compactContact) }
    },
  })

  const updateContact = buildTool({
    name: 'updateContact',
    requiresCapability: 'crm',
    description:
      'Patch fields on an existing contact. Pass only the fields to change. To clear a nullable field (email, phone, company_id), pass `null` explicitly — omitting a key leaves it unchanged. ' +
      'Pass `links` to ADD relationship edges; pass `closeLinks` to close existing relationships (e.g. recording that the contact left a previous employer). At least one of fields, tags, links, or closeLinks is required.',
    inputSchema: z.object({
      id: idShape,
      name: z.string().min(1).max(256).optional(),
      email: z.string().email().nullable().optional(),
      phone: z.string().max(64).nullable().optional(),
      company_id: idShape.nullable().optional(),
      tags: tagShape.optional(),
      external_ref: externalRefShape.optional(),
      links: explicitLinksField,
      closeLinks: explicitClosesField,
    }),
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const fields: Parameters<CrmStore['updateContact']>[2] = {}
      if (input.name !== undefined) fields.name = input.name
      if (input.email !== undefined) fields.email = input.email
      if (input.phone !== undefined) fields.phone = input.phone
      if (input.company_id !== undefined) fields.companyId = input.company_id
      if (input.tags !== undefined) fields.tags = input.tags
      if (input.external_ref !== undefined) fields.externalRef = input.external_ref

      const hasFieldChange = Object.keys(fields).length > 0
      const hasLinkChange = (input.links?.length ?? 0) > 0
      const hasCloseChange = (input.closeLinks?.length ?? 0) > 0
      if (!hasFieldChange && !hasLinkChange && !hasCloseChange) {
        return { data: 'Pass at least one field, link, or closeLink to update.', isError: true }
      }

      // Resolve the contact's entity_id even when no field changes — a
      // links-only update still needs it to anchor the new edges.
      let updated: ContactRecord | null = null
      if (hasFieldChange) {
        try {
          updated = await store.updateContact(context.userId, input.id, fields)
        } catch (err) {
          const translated = translateLinkError(err)
          if (translated) return translated
          throw err
        }
        if (!updated) return { data: `Contact ${input.id} not found in workspace.`, isError: true }
      } else {
        updated = await store.getContactById(
          ctxFor({
            userId: context.userId,
            assistantId: context.assistantId,
            workspaceId: context.workspaceId!,
            assistantKind: context.assistantKind,
            clearance: context.clearance,
            compartments: context.compartments,
          }),
          input.id,
        )
        if (!updated) return { data: `Contact ${input.id} not found in workspace.`, isError: true }
      }
      if (hasFieldChange) {
        opts?.onEvent?.({ type: 'contact_updated', contactId: updated.id, fields: Object.keys(fields) }, eventCtx(context))
      }
      const linksSummary = await applyExplicitLinks({
        entityLinks: opts?.entityLinks,
        workspaceId: context.workspaceId!,
        userId: context.userId,
        assistantId: context.assistantId,
        sourceKind: 'entity',
        sourceId: updated.entityId ?? '',
        source: 'user',
        links: updated.entityId ? input.links : undefined,
      })
      const closesSummary = await applyExplicitCloses({
        entityLinks: opts?.entityLinks,
        userId: context.userId,
        sourceKind: 'entity',
        sourceId: updated.entityId ?? '',
        closes: updated.entityId ? input.closeLinks : undefined,
      })
      return {
        data: `Updated contact [${updated.id}]: ${updated.name}${formatLinksSummary(linksSummary)}${formatClosesSummary(closesSummary)}`,
      }
    },
  })

  // ── Companies ───────────────────────────────────────────────────
  const saveCompany = buildTool({
    name: 'saveCompany',
    requiresCapability: 'crm',
    description:
      'Upsert a company in the current workspace by display name. If an active company with the same name (case-insensitive) already exists, its tags (union), domain (incoming wins if non-empty), and external_ref (shallow merge) are merged into a superseding version — no duplicate row is created. Use updateCompany when you have an explicit id and need to patch other fields.',
    inputSchema: z.object({
      name: z.string().min(1).max(256).describe('Display name (e.g. "Acme Corp").'),
      domain: z.string().max(256).optional().describe('Primary web domain (e.g. "acme.com"). Used to disambiguate against synced sources.'),
      tags: tagShape.optional(),
      external_ref: externalRefShape.optional(),
      links: explicitLinksField,
    }),
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const suggestions: Array<{ rule_id: string; suggested_value: string; confidence: number; hint: string }> = []
      const reject = runChatToolClassifier(
        opts?.entityKindClassifier,
        'company',
        {
          primary: input.name,
          canonical_id: input.domain ?? null,
          attributes: input.domain ? { domain: input.domain } : undefined,
        },
        suggestions,
      )
      if (reject) return reject

      const company = await store.createCompany({
        userId: context.userId,
        workspaceId: context.workspaceId!,
        name: input.name,
        domain: input.domain ?? null,
        tags: input.tags,
        externalRef: input.external_ref,
        // Research findings come from the public web — stamp `public`
        // (confidential source seen still floors). Else: store default.
        sensitivity: context.researchMode
          ? researchWriteFloor(context.sensitivity?.max, true)
          : undefined,
        compartments: unionCompartments(
          context.compartmentAccumulator?.compartments,
          context.assistantDefaultCompartments,
        ),
        source: opts?.writeSource,
      })
      opts?.onEvent?.({ type: 'company_created', companyId: company.id }, eventCtx(context))
      const linksSummary = await applyExplicitLinks({
        entityLinks: opts?.entityLinks,
        workspaceId: context.workspaceId!,
        userId: context.userId,
        assistantId: context.assistantId,
        sourceKind: 'entity',
        sourceId: company.entityId ?? '',
        source: 'user',
        links: company.entityId ? input.links : undefined,
      })
      const entitySuffix = company.entityId ? `, entityId=${company.entityId}` : ''
      return {
        data:
          `Created company [${company.id}${entitySuffix}]: ${company.name}` +
          formatLinksSummary(linksSummary) +
          formatSuggestions(suggestions),
      }
    },
  })

  const getCompany = buildTool({
    name: 'getCompany',
    requiresCapability: 'crm',
    description: 'Fetch the full company record by id, including external_ref and created_at.',
    inputSchema: z.object({ id: idShape }),
    isConcurrencySafe: true,
    isReadOnly: true,
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate
      const company = await store.getCompanyById(
        ctxFor({
          userId: context.userId,
          assistantId: context.assistantId,
          workspaceId: context.workspaceId!,
          assistantKind: context.assistantKind,
          clearance: context.clearance,
          compartments: context.compartments,
        }),
        input.id,
      )
      if (!company || company.workspaceId !== context.workspaceId) {
        return { data: `Company ${input.id} not found in workspace.`, isError: true }
      }
      return { data: fullCompany(company) }
    },
  })

  const listCompanies = buildTool({
    name: 'listCompanies',
    requiresCapability: 'crm',
    description:
      'List companies in the current workspace, filtered by query (substring on name+domain) or tag. Returns a compact projection (id, name, domain, tags, updated_at). Default limit is 25 (max 100).',
    inputSchema: z.object({
      query: z.string().min(1).max(128).optional().describe('ILIKE substring on name and domain.'),
      tag: z.string().min(1).max(64).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional().default(25),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const rows = await store.listCompanies(
        ctxFor({
          userId: context.userId,
          assistantId: context.assistantId,
          workspaceId: context.workspaceId!,
          assistantKind: context.assistantKind,
          clearance: context.clearance,
          compartments: context.compartments,
        }),
        {
          query: input.query,
          tag: input.tag,
          limit: input.limit,
        },
      )

      opts?.onEvent?.({ type: 'company_listed', resultCount: rows.length }, eventCtx(context))
      return { data: rows.map(compactCompany) }
    },
  })

  const updateCompany = buildTool({
    name: 'updateCompany',
    requiresCapability: 'crm',
    description:
      'Patch fields on an existing company. Pass only the fields to change. Pass `null` for `domain` to clear it. ' +
      'Pass `links` to ADD relationship edges and `closeLinks` to close existing ones (e.g. "this company was acquired by X" closes the competes_with edge with X, opens an acquired_by). At least one of fields, tags, links, or closeLinks is required.',
    inputSchema: z.object({
      id: idShape,
      name: z.string().min(1).max(256).optional(),
      domain: z.string().max(256).nullable().optional(),
      tags: tagShape.optional(),
      external_ref: externalRefShape.optional(),
      links: explicitLinksField,
      closeLinks: explicitClosesField,
    }),
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const fields: Parameters<CrmStore['updateCompany']>[2] = {}
      if (input.name !== undefined) fields.name = input.name
      if (input.domain !== undefined) fields.domain = input.domain
      if (input.tags !== undefined) fields.tags = input.tags
      if (input.external_ref !== undefined) fields.externalRef = input.external_ref

      const hasFieldChange = Object.keys(fields).length > 0
      const hasLinkChange = (input.links?.length ?? 0) > 0
      const hasCloseChange = (input.closeLinks?.length ?? 0) > 0
      if (!hasFieldChange && !hasLinkChange && !hasCloseChange) {
        return { data: 'Pass at least one field, link, or closeLink to update.', isError: true }
      }

      let updated: CompanyRecord | null = null
      if (hasFieldChange) {
        updated = await store.updateCompany(context.userId, input.id, fields)
        if (!updated) return { data: `Company ${input.id} not found in workspace.`, isError: true }
        opts?.onEvent?.({ type: 'company_updated', companyId: updated.id, fields: Object.keys(fields) }, eventCtx(context))
      } else {
        updated = await store.getCompanyById(
          ctxFor({
            userId: context.userId,
            assistantId: context.assistantId,
            workspaceId: context.workspaceId!,
            assistantKind: context.assistantKind,
            clearance: context.clearance,
            compartments: context.compartments,
          }),
          input.id,
        )
        if (!updated) return { data: `Company ${input.id} not found in workspace.`, isError: true }
      }
      const linksSummary = await applyExplicitLinks({
        entityLinks: opts?.entityLinks,
        workspaceId: context.workspaceId!,
        userId: context.userId,
        assistantId: context.assistantId,
        sourceKind: 'entity',
        sourceId: updated.entityId ?? '',
        source: 'user',
        links: updated.entityId ? input.links : undefined,
      })
      const closesSummary = await applyExplicitCloses({
        entityLinks: opts?.entityLinks,
        userId: context.userId,
        sourceKind: 'entity',
        sourceId: updated.entityId ?? '',
        closes: updated.entityId ? input.closeLinks : undefined,
      })
      return {
        data: `Updated company [${updated.id}]: ${updated.name}${formatLinksSummary(linksSummary)}${formatClosesSummary(closesSummary)}`,
      }
    },
  })

  // ── Deals ───────────────────────────────────────────────────────
  const dateOnlyShape = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'close_date must be YYYY-MM-DD (calendar date, not timestamp)')

  const saveDeal = buildTool({
    name: 'saveDeal',
    requiresCapability: 'crm',
    description:
      'Create a new deal in the current workspace. A deal is a sales-pipeline opportunity (lead → qualified → proposal → negotiation → won/lost). ' +
      'Stage defaults to `lead` if omitted. At least one of `contact_id` or `company_id` is required — a deal must be linked to who it\'s with. ' +
      'Amount is in dollars (NUMERIC), not cents — pass 50000 for $50k. close_date is a calendar date in YYYY-MM-DD format. ' +
      'To change stage later, use advanceDealStage (the canonical stage-transition verb), not updateDeal.',
    inputSchema: z
      .object({
        contact_id: idShape.optional(),
        company_id: idShape.optional(),
        stage: stageEnum.optional().describe('Defaults to `lead`.'),
        amount: z.number().nonnegative().optional().describe('Decimal dollars (e.g. 50000 for $50k).'),
        close_date: dateOnlyShape.optional().describe('Expected close date, YYYY-MM-DD.'),
        tags: tagShape.optional(),
        external_ref: externalRefShape.optional(),
        links: explicitLinksField,
      })
      .refine((v) => v.contact_id !== undefined || v.company_id !== undefined, {
        message: 'A deal must be linked to at least one of contact_id or company_id.',
      }),
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      try {
        const deal = await store.createDeal({
          userId: context.userId,
          workspaceId: context.workspaceId!,
          contactId: input.contact_id ?? null,
          companyId: input.company_id ?? null,
          stage: input.stage,
          amount: input.amount ?? null,
          closeDate: input.close_date ? new Date(input.close_date) : null,
          externalRef: input.external_ref,
          // Research findings come from the public web — stamp `public`
          // (confidential source seen still floors). Else: store default.
          sensitivity: context.researchMode
            ? researchWriteFloor(context.sensitivity?.max, true)
            : undefined,
          compartments: unionCompartments(
            context.compartmentAccumulator?.compartments,
            context.assistantDefaultCompartments,
          ),
          source: opts?.writeSource,
        })
        opts?.onEvent?.({ type: 'deal_created', dealId: deal.id }, eventCtx(context))
        const linksSummary = await applyExplicitLinks({
          entityLinks: opts?.entityLinks,
          workspaceId: context.workspaceId!,
          userId: context.userId,
          assistantId: context.assistantId,
          sourceKind: 'entity',
          sourceId: deal.entityId ?? '',
          source: 'user',
          links: deal.entityId ? input.links : undefined,
        })
        const summary = `${deal.stage}${deal.amount !== null ? `, $${deal.amount}` : ''}`
        const entitySuffix = deal.entityId ? `, entityId=${deal.entityId}` : ''
        return { data: `Created deal [${deal.id}${entitySuffix}]: ${summary}${formatLinksSummary(linksSummary)}` }
      } catch (err) {
        const translated = translateLinkError(err)
        if (translated) return translated
        throw err
      }
    },
  })

  const getDeal = buildTool({
    name: 'getDeal',
    requiresCapability: 'crm',
    description: 'Fetch the full deal record by id, including external_ref and created_at.',
    inputSchema: z.object({ id: idShape }),
    isConcurrencySafe: true,
    isReadOnly: true,
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate
      const deal = await store.getDealById(
        ctxFor({
          userId: context.userId,
          assistantId: context.assistantId,
          workspaceId: context.workspaceId!,
          assistantKind: context.assistantKind,
          clearance: context.clearance,
          compartments: context.compartments,
        }),
        input.id,
      )
      if (!deal || deal.workspaceId !== context.workspaceId) {
        return { data: `Deal ${input.id} not found in workspace.`, isError: true }
      }
      return { data: fullDeal(deal) }
    },
  })

  const listDeals = buildTool({
    name: 'listDeals',
    requiresCapability: 'crm',
    description:
      'List deals in the current workspace, filtered by stage (single value or array — e.g. ["proposal", "negotiation"]), contact_id, or company_id. ' +
      'Returns a compact projection (id, contact_id, company_id, stage, amount, close_date, updated_at). Default limit is 25 (max 100).',
    inputSchema: z.object({
      stage: stageEnum.or(z.array(stageEnum)).optional(),
      contact_id: idShape.optional(),
      company_id: idShape.optional(),
      limit: z.coerce.number().int().min(1).max(100).optional().default(25),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const rows = await store.listDeals(
        ctxFor({
          userId: context.userId,
          assistantId: context.assistantId,
          workspaceId: context.workspaceId!,
          assistantKind: context.assistantKind,
          clearance: context.clearance,
          compartments: context.compartments,
        }),
        {
          stage: input.stage,
          contactId: input.contact_id,
          companyId: input.company_id,
          limit: input.limit,
        },
      )

      opts?.onEvent?.({ type: 'deal_listed', resultCount: rows.length }, eventCtx(context))
      return { data: rows.map(compactDeal) }
    },
  })

  const updateDeal = buildTool({
    name: 'updateDeal',
    requiresCapability: 'crm',
    description:
      'Patch non-stage fields on an existing deal (contact_id, company_id, amount, close_date, external_ref). ' +
      'To change `stage`, use advanceDealStage instead — it is the canonical stage-transition verb and the cut-point for stage-change events. ' +
      'Pass `null` for any nullable field to clear it. ' +
      'Pass `links` to ADD relationship edges and `closeLinks` to close existing ones. At least one of fields, links, or closeLinks is required.',
    inputSchema: z.object({
      id: idShape,
      contact_id: idShape.nullable().optional(),
      company_id: idShape.nullable().optional(),
      amount: z.number().nonnegative().nullable().optional(),
      close_date: dateOnlyShape.nullable().optional(),
      external_ref: externalRefShape.optional(),
      links: explicitLinksField,
      closeLinks: explicitClosesField,
    }),
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const fields: Parameters<CrmStore['updateDeal']>[2] = {}
      if (input.contact_id !== undefined) fields.contactId = input.contact_id
      if (input.company_id !== undefined) fields.companyId = input.company_id
      if (input.amount !== undefined) fields.amount = input.amount
      if (input.close_date !== undefined) fields.closeDate = input.close_date === null ? null : new Date(input.close_date)
      if (input.external_ref !== undefined) fields.externalRef = input.external_ref

      const hasFieldChange = Object.keys(fields).length > 0
      const hasLinkChange = (input.links?.length ?? 0) > 0
      const hasCloseChange = (input.closeLinks?.length ?? 0) > 0
      if (!hasFieldChange && !hasLinkChange && !hasCloseChange) {
        return { data: 'Pass at least one field, link, or closeLink to update.', isError: true }
      }

      let updated: DealRecord | null = null
      if (hasFieldChange) {
        try {
          updated = await store.updateDeal(context.userId, input.id, fields)
        } catch (err) {
          const translated = translateLinkError(err)
          if (translated) return translated
          throw err
        }
        if (!updated) return { data: `Deal ${input.id} not found in workspace.`, isError: true }
        opts?.onEvent?.({ type: 'deal_updated', dealId: updated.id, fields: Object.keys(fields) }, eventCtx(context))
      } else {
        updated = await store.getDealById(
          ctxFor({
            userId: context.userId,
            assistantId: context.assistantId,
            workspaceId: context.workspaceId!,
            assistantKind: context.assistantKind,
            clearance: context.clearance,
            compartments: context.compartments,
          }),
          input.id,
        )
        if (!updated) return { data: `Deal ${input.id} not found in workspace.`, isError: true }
      }
      const linksSummary = await applyExplicitLinks({
        entityLinks: opts?.entityLinks,
        workspaceId: context.workspaceId!,
        userId: context.userId,
        assistantId: context.assistantId,
        sourceKind: 'entity',
        sourceId: updated.entityId ?? '',
        source: 'user',
        links: updated.entityId ? input.links : undefined,
      })
      const closesSummary = await applyExplicitCloses({
        entityLinks: opts?.entityLinks,
        userId: context.userId,
        sourceKind: 'entity',
        sourceId: updated.entityId ?? '',
        closes: updated.entityId ? input.closeLinks : undefined,
      })
      return {
        data: `Updated deal [${updated.id}]${formatLinksSummary(linksSummary)}${formatClosesSummary(closesSummary)}`,
      }
    },
  })

  const advanceDealStage = buildTool({
    name: 'advanceDealStage',
    requiresCapability: 'crm',
    description:
      'Move a deal to a new pipeline stage. Valid stages: lead, qualified, proposal, negotiation, won, lost. ' +
      'This is the canonical verb for stage transitions — use it instead of updateDeal so the brain has a clean cut-point for stage-change events (when sync ships, this is what pushes to Attio/HubSpot).',
    inputSchema: z.object({
      id: idShape,
      stage: stageEnum,
    }),
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const updated = await store.setDealStage(context.userId, input.id, input.stage)
      if (!updated) return { data: `Deal ${input.id} not found in workspace.`, isError: true }
      opts?.onEvent?.({ type: 'deal_stage_advanced', dealId: updated.id, stage: input.stage }, eventCtx(context))
      return { data: `Moved deal [${updated.id}] to ${input.stage}` }
    },
  })

  return {
    saveContact, getContact, listContacts, updateContact,
    saveCompany, getCompany, listCompanies, updateCompany,
    saveDeal, getDeal, listDeals, updateDeal, advanceDealStage,
  }
}
