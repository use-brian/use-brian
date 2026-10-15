/**
 * Brian and Brain-MCP tools for commercial context. Each tool submits the
 * same typed command as the CRM UI and REST adapters or reads through the same
 * permission-scoped read port. Accepting an operation version is deliberately
 * not a tool: a human owner or admin accepts it in CRM configuration.
 * Spec: docs/architecture/features/crm-commercial-operations.md -> Commercial context
 *
 * [COMP:crm/commercial-context]
 */

import { z } from 'zod'
import { buildTool, type Tool, type ToolContext, type ToolInput } from '../tools/types.js'
import { missingToolCapability } from '../tools/capability-gate.js'
import { crmOperationsToolContext, crmOperationsToolFailure } from './operations-tools.js'
import type { CrmOperationsCommand, CrmOperationsServicePort } from './operations-types.js'
import {
  CrmClassificationSchema,
  CrmCommercialFieldsSchema,
  CrmCommercialSourceEvidenceSchema,
  CrmOperationVersionInputSchema,
  type CrmCommercialContextReadPort,
} from './commercial-context.js'

const Uuid = z.string().uuid()
const Key = z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_-]{0,62}$/)
const OperationId = Uuid.describe('Stable operation id. Reuse the SAME id when retrying an uncertain result; never invent a new one to retry.')
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export type CrmCommercialContextTools = {
  listCrmCustomerAccounts: Tool
  listCrmCommercialProfiles: Tool
  resolveCrmCommercialFields: Tool
  listCrmOperationDefinitions: Tool
  saveCrmCustomerAccount: Tool
  saveCrmSellerProfile: Tool
  acceptCrmCommercialProfile: Tool
  proposeCrmOperationVersion: Tool
}

function notScoped() {
  return { isError: true as const, data: 'Commercial context requires a workspace-scoped assistant or programmatic credential.' }
}

export function createCrmCommercialContextTools(options: {
  reads: CrmCommercialContextReadPort
  service: CrmOperationsServicePort
}): CrmCommercialContextTools {
  function read<Input extends z.ZodType>(description: string, inputSchema: Input,
    run: (workspaceId: string, viewer: { userId: string }, input: z.infer<Input>) => Promise<unknown>): Omit<ToolInput<Input>, 'name' | 'isReadOnly'> {
    return {
      description, inputSchema, requiresCapability: 'crm', homeAppToolSet: { app: 'crm', set: 'read' },
      async execute(input, context: ToolContext) {
        if (!context.workspaceId || !context.userId) return notScoped()
        try { return { data: await run(context.workspaceId, { userId: context.userId }, inputSchema.parse(input)) } }
        catch (error) { return crmOperationsToolFailure(error) }
      },
    }
  }
  function command<Input extends z.ZodType>(description: string, inputSchema: Input,
    toCommand: (input: z.infer<Input>) => CrmOperationsCommand, configure: boolean): Omit<ToolInput<Input>, 'name' | 'isReadOnly'> {
    const gate = { requiresCapability: configure ? 'configure' : 'crm', homeAppToolSet: { app: 'crm', set: 'write' } } as const
    return {
      description, inputSchema, ...gate, requiresConfirmation: configure,
      async execute(input, context) {
        const missing = missingToolCapability(gate as unknown as Tool, context.activeCapabilities)
        if (missing) return { isError: true, data: { error: 'not_authorized', requiredCapability: missing } }
        const caller = crmOperationsToolContext(context)
        if (!caller) return notScoped()
        try {
          return { data: await options.service.execute(configure
            ? { ...caller, authority: { ...caller.authority, canConfigure: true } } : caller, toCommand(inputSchema.parse(input))) }
        } catch (error) { return crmOperationsToolFailure(error) }
      },
    }
  }

  const listCrmCustomerAccounts: Tool = buildTool({ name: 'listCrmCustomerAccounts', isReadOnly: true, ...read(
    'List customer accounts: each links one canonical company to one seller or business unit with its billing contact and address. A company can have several accounts. Only accounts visible in your current scope are returned; a hidden account looks exactly like no account. Follow nextCursor until null.',
    z.object({ company_id: Uuid.optional(), seller_key: Key.optional(), include_archived: z.boolean().default(false),
      cursor: z.string().min(1).max(4096).optional(), limit: z.number().int().min(1).max(100).default(50) }).strict(),
    (workspaceId, viewer, input) => options.reads.listAccounts(workspaceId, viewer, { companyId: input.company_id, sellerKey: input.seller_key,
      includeArchived: input.include_archived, cursor: input.cursor, limit: input.limit })) })
  const listCrmCommercialProfiles = buildTool({ name: 'listCrmCommercialProfiles', isReadOnly: true, ...read(
    'List accepted commercial profile versions (typed defaults and agreement terms) for one seller or one account, with effective dates and source evidence. These are the only accepted commercial facts; never infer terms, tax, payment status or prices from conversation or documents.',
    z.object({ seller_key: Key.optional(), account_id: Uuid.optional(), include_superseded: z.boolean().default(false) }).strict()
      .refine((value) => value.seller_key !== undefined || value.account_id !== undefined, 'Supply seller_key or account_id'),
    (workspaceId, viewer, input) => options.reads.listProfiles(workspaceId, viewer, { sellerKey: input.seller_key, accountId: input.account_id,
      includeSuperseded: input.include_superseded })) })
  const resolveCrmCommercialFields = buildTool({ name: 'resolveCrmCommercialFields', isReadOnly: true, ...read(
    'Resolve every field an accepted operation needs for one account (and optional deal and business date) deterministically: transaction value where permitted, then the applicable agreement, account defaults and seller defaults. Returns each value with its source record and version, plus precise questions for missing facts, conflicting agreements and protected terms. Ask the user exactly those questions; never fill a missing commercial fact yourself.',
    z.object({ operation_key: Key, account_id: Uuid, deal_id: Uuid.optional(), business_date: IsoDate.optional(),
      transaction: CrmCommercialFieldsSchema.optional() }).strict(),
    (workspaceId, viewer, input) => options.reads.resolve(workspaceId, viewer, { operationKey: input.operation_key, accountId: input.account_id,
      dealId: input.deal_id, businessDate: input.business_date, transaction: input.transaction })) })
  const listCrmOperationDefinitions = buildTool({ name: 'listCrmOperationDefinitions', isReadOnly: true, ...read(
    'List commercial operation definitions (such as invoice preparation) with their accepted and proposed versions: the accepted instruction snapshot, typed field bindings, template binding and review policy. Follow the ACCEPTED version\'s instructions when preparing a document; a proposed version is not in force.',
    z.object({}).strict(),
    (workspaceId, viewer) => options.reads.listOperationDefinitions(workspaceId, viewer)) })
  const saveCrmCustomerAccount = buildTool({ name: 'saveCrmCustomerAccount', isReadOnly: false, ...command(
    'Create or update a customer account linking a canonical company to a seller (seller_key), with label, billing contact (a CRM person id) and billing address. An account may be classified more strictly than its company but never more broadly. Update with account_id and expected_version; the company and seller of an account never change.',
    z.object({ operation_id: OperationId, account_id: Uuid.optional(), expected_version: z.number().int().min(1).optional(),
      seller_key: Key, company_id: Uuid, label: z.string().trim().min(1).max(300), billing_contact_id: Uuid.nullable().default(null),
      billing_address: z.string().trim().min(1).max(2000).nullable().default(null), status: z.enum(['active', 'archived']).default('active'),
      sensitivity: z.enum(['public', 'internal', 'confidential']).optional() }).strict(),
    (input) => ({ kind: 'save_customer_account', operationId: input.operation_id, accountId: input.account_id, expectedVersion: input.expected_version,
      account: { sellerKey: input.seller_key, companyId: input.company_id, label: input.label, billingContactId: input.billing_contact_id,
        billingAddress: input.billing_address, status: input.status },
      ...(input.sensitivity ? { classification: { sensitivity: input.sensitivity } } : {}) }), false) })
  const saveCrmSellerProfile = buildTool({ name: 'saveCrmSellerProfile', isReadOnly: false, ...command(
    'Propose a seller or business unit profile (stable seller_key, legal and display name, optional canonical company, timezone) for an operator to accept. Requires configure authority and the user\'s confirmation. Never invent a seller\'s legal identity.',
    z.object({ operation_id: OperationId, seller_id: Uuid.optional(), expected_version: z.number().int().min(1).optional(),
      seller_key: Key, legal_name: z.string().trim().min(1).max(300), display_name: z.string().trim().min(1).max(300),
      company_id: Uuid.nullable().default(null), timezone: z.string().trim().min(1).max(64).default('UTC'),
      status: z.enum(['active', 'archived']).default('active') }).strict(),
    (input) => ({ kind: 'save_seller_profile', operationId: input.operation_id, sellerId: input.seller_id, expectedVersion: input.expected_version,
      seller: { sellerKey: input.seller_key, legalName: input.legal_name, displayName: input.display_name, companyId: input.company_id,
        timezone: input.timezone, status: input.status } }), true) })
  const acceptCrmCommercialProfile = buildTool({ name: 'acceptCrmCommercialProfile', isReadOnly: false, ...command(
    'Accept a new version of typed commercial facts for a seller, an account or an agreement (an account plus optional deal ids), with effective dates and source evidence. Only values the user explicitly confirmed or that come from a named source document may be accepted; never infer tax treatment, payment status, prices or terms. Pass expected_current_version (0 for the first). Requires configure authority and the user\'s confirmation.',
    z.object({ operation_id: OperationId,
      owner: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('seller'), seller_key: Key }).strict(),
        z.object({ kind: z.literal('account'), account_id: Uuid }).strict(),
        z.object({ kind: z.literal('agreement'), account_id: Uuid, agreement_key: Key, deal_ids: z.array(Uuid).max(50).default([]) }).strict(),
      ]),
      expected_current_version: z.number().int().min(0), fields: CrmCommercialFieldsSchema,
      effective_from: IsoDate.nullable().default(null), effective_to: IsoDate.nullable().default(null),
      evidence: CrmCommercialSourceEvidenceSchema, classification: CrmClassificationSchema.omit({ departmentId: true }).optional() }).strict(),
    (input) => ({ kind: 'accept_commercial_profile', operationId: input.operation_id,
      owner: input.owner.kind === 'seller' ? { kind: 'seller', sellerKey: input.owner.seller_key }
        : input.owner.kind === 'account' ? { kind: 'account', accountId: input.owner.account_id }
          : { kind: 'agreement', accountId: input.owner.account_id, agreementKey: input.owner.agreement_key, dealIds: input.owner.deal_ids },
      expectedCurrentVersion: input.expected_current_version, fields: input.fields, effectiveFrom: input.effective_from,
      effectiveTo: input.effective_to, evidence: input.evidence, classification: input.classification }), true) })
  const proposeCrmOperationVersion = buildTool({ name: 'proposeCrmOperationVersion', isReadOnly: false, ...command(
    'Propose a new version of a commercial operation (such as invoice preparation): the bounded instruction text (optionally linked to the exact Page revision it came from), typed field bindings with draft/issue requirements and override rules, the Office template binding, the review policy and the numbering definition. A proposal is not in force until a workspace owner or admin accepts it in CRM configuration. Requires configure authority and the user\'s confirmation.',
    z.object({ operation_id: OperationId, operation_key: Key, operation_kind: z.enum(['invoice']), label: z.string().trim().min(1).max(200),
      expected_version: z.number().int().min(0), version: CrmOperationVersionInputSchema }).strict(),
    (input) => ({ kind: 'save_operation_definition', operationId: input.operation_id, operationKey: input.operation_key,
      operationKind: input.operation_kind, label: input.label, expectedVersion: input.expected_version, version: input.version }), true) })

  return {
    listCrmCustomerAccounts, listCrmCommercialProfiles, resolveCrmCommercialFields, listCrmOperationDefinitions,
    saveCrmCustomerAccount, saveCrmSellerProfile, acceptCrmCommercialProfile, proposeCrmOperationVersion,
  }
}
