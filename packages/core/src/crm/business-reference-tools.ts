/**
 * Brian and Brain-MCP tools for business references. Each tool submits the
 * same typed command to the canonical CRM operations service as the UI and
 * REST adapters, or reads through the same permission-scoped read port.
 * Spec: docs/architecture/features/crm-commercial-operations.md
 *
 * [COMP:crm/business-reference-tools]
 */

import { z } from 'zod'
import { buildTool, type Tool, type ToolContext, type ToolInput } from '../tools/types.js'
import { missingToolCapability } from '../tools/capability-gate.js'
import { crmOperationsToolContext, crmOperationsToolFailure } from './operations-tools.js'
import type { CrmOperationsCommand, CrmOperationsServicePort } from './operations-types.js'
import {
  CrmBusinessReferenceValueSchema,
  CrmReferenceDefinitionInputSchema,
  CrmReferenceTargetKindSchema,
  type CrmReferenceReadPort,
} from './business-references.js'

const Uuid = z.string().uuid()
const Key = z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_-]{0,62}$/)
const OperationId = Uuid.describe('Stable operation id. Reuse the SAME id when retrying an uncertain result; never invent a new one to retry.')

export type CrmBusinessReferenceTools = {
  listCrmReferenceDefinitions: Tool
  previewCrmReference: Tool
  findCrmReference: Tool
  getCrmReferenceHistory: Tool
  assignCrmReference: Tool
  saveCrmReferenceDefinition: Tool
  replaceCrmReference: Tool
  retireCrmReference: Tool
  importCrmReferences: Tool
}

function notScoped() {
  return { isError: true as const, data: 'Business references require a workspace-scoped assistant or programmatic credential.' }
}

export function createCrmBusinessReferenceTools(options: {
  reads: CrmReferenceReadPort
  service: CrmOperationsServicePort
}): CrmBusinessReferenceTools {
  function read<Input extends z.ZodType>(description: string, inputSchema: Input,
    run: (workspaceId: string, viewer: { userId: string }, input: z.infer<Input>) => Promise<unknown>): Omit<ToolInput<Input>, 'name' | 'isReadOnly'> {
    return {
      description, inputSchema, requiresCapability: 'crm',
      homeAppToolSet: { app: 'crm', set: 'read' },
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
      description, inputSchema, ...gate,
      requiresConfirmation: configure,
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

  const listCrmReferenceDefinitions: Tool = buildTool({ name: 'listCrmReferenceDefinitions', isReadOnly: true, ...read(
    'List the workspace business reference definitions (customer codes, engagement codes, document numbers): stable definitionKey, label, target kinds, assignment mode (native allocation, finance-entered or externally assigned), format segments, partition dimensions, categories and assignment event. Call this before assigning or searching by a code; never invent a definitionKey or a number.',
    z.object({ include_archived: z.boolean().default(false) }).strict(),
    (workspaceId, viewer, input) => options.reads.listDefinitions(workspaceId, viewer, { includeArchived: input.include_archived })) })
  const previewCrmReference: Tool = buildTool({ name: 'previewCrmReference', isReadOnly: true, ...read(
    'Explain how a reference definition formats a value for one record: the segment breakdown, which inputs it needs (business date, category, parent code) and a masked example such as INV-2026-######. A preview reserves nothing and never promises a specific next number. Never quote a preview as an assigned value.',
    z.object({
      definition_key: Key,
      target_kind: CrmReferenceTargetKindSchema.optional(),
      target_id: Uuid.optional(),
      business_date: z.string().trim().min(10).max(40).optional().describe('Explicit business date (YYYY-MM-DD or ISO instant). Ask the user; never assume today.'),
      category_key: Key.optional(),
    }).strict(),
    (workspaceId, viewer, input) => options.reads.preview(workspaceId, viewer, {
      definitionKey: input.definition_key, targetKind: input.target_kind, targetId: input.target_id,
      businessDate: input.business_date, categoryKey: input.category_key,
    })) })
  const findCrmReference: Tool = buildTool({ name: 'findCrmReference', isReadOnly: true, ...read(
    'Find the company or deal behind a business reference code (exact or prefix match), including former and retired codes, or list every code on one record by target_id. A former code resolves to the same stable record id. Only records visible in your current scope are returned. Follow nextCursor until it is null.',
    z.object({
      code: z.string().trim().min(1).max(128).optional(),
      match: z.enum(['exact', 'prefix']).default('exact'),
      target_id: Uuid.optional(),
      definition_key: Key.optional(),
      include_former: z.boolean().default(true),
      cursor: z.string().min(1).max(4096).optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }).strict().refine((value) => value.code !== undefined || value.target_id !== undefined, 'Supply code or target_id'),
    (workspaceId, viewer, input) => options.reads.lookup(workspaceId, viewer, {
      q: input.code, match: input.match, targetId: input.target_id, definitionKey: input.definition_key,
      includeFormer: input.include_former, cursor: input.cursor, limit: input.limit,
    })) })
  const getCrmReferenceHistory: Tool = buildTool({ name: 'getCrmReferenceHistory', isReadOnly: true, ...read(
    'Show one reference and its record\'s reference history: assignments, corrections with reasons, retirements and imports, with actor kinds and effective times.',
    z.object({ reference_id: Uuid }).strict(),
    async (workspaceId, viewer, input) => (await options.reads.history(workspaceId, viewer, input.reference_id))
      ?? { error: 'not_found', message: 'The reference is unavailable in your current scope.' }) })
  const assignCrmReference: Tool = buildTool({ name: 'assignCrmReference', isReadOnly: false, ...command(
    'Assign a company or deal its business reference through the workspace definition. Native definitions allocate the next number in one database transaction; finance-entered or external definitions take value (and provider evidence for external). If the record already has a current reference in this definition it is returned unchanged. Supply the explicit business_date and category_key the definition needs; never guess them. Reuse the same operation_id to retry an uncertain result.',
    z.object({
      operation_id: OperationId,
      definition_key: Key,
      target_kind: CrmReferenceTargetKindSchema,
      target_id: Uuid,
      business_date: z.string().trim().min(10).max(40).optional(),
      category_key: Key.optional(),
      value: CrmBusinessReferenceValueSchema.optional(),
      external_provider: Key.optional(),
      external_remote_id: z.string().trim().min(1).max(500).optional(),
    }).strict(),
    (input) => ({
      kind: 'assign_business_reference', operationId: input.operation_id, definitionKey: input.definition_key,
      target: { kind: input.target_kind, id: input.target_id }, businessDate: input.business_date, categoryKey: input.category_key,
      value: input.value,
      external: input.external_provider && input.external_remote_id ? { provider: input.external_provider, remoteId: input.external_remote_id } : undefined,
    }), false) })
  const saveCrmReferenceDefinition: Tool = buildTool({ name: 'saveCrmReferenceDefinition', isReadOnly: false, ...command(
    'Propose a business reference definition for an authorized operator to accept: stable key, namespace, target kinds, assignment mode, a declarative format (literal, parent, date part, category and padded counter segments only), partitions, categories, timezone, assignment event and change policy. Requires configure authority and the user\'s confirmation. Update an existing definition with its definition_id and expected_version. Once values exist, settings that would renumber or reinterpret them are refused. Never seed real seller numbering, tax or payment terms the user did not supply.',
    z.object({
      operation_id: OperationId,
      definition_id: Uuid.optional(),
      expected_version: z.number().int().min(1).optional(),
      definition: CrmReferenceDefinitionInputSchema,
    }).strict(),
    (input) => ({
      kind: 'save_reference_definition', operationId: input.operation_id, definitionId: input.definition_id,
      expectedVersion: input.expected_version, definition: input.definition,
    }), true) })
  const replaceCrmReference: Tool = buildTool({ name: 'replaceCrmReference', isReadOnly: false, ...command(
    'Correct a current reference under a correctable definition. The former value stays reserved and in history; a new value is allocated (native) or supplied. Requires configure authority, the reference expected_version, a reason and the user\'s confirmation.',
    z.object({
      operation_id: OperationId,
      reference_id: Uuid,
      expected_version: z.number().int().min(1),
      reason: z.string().trim().min(1).max(2000),
      value: CrmBusinessReferenceValueSchema.optional(),
      business_date: z.string().trim().min(10).max(40).optional(),
      category_key: Key.optional(),
    }).strict(),
    (input) => ({
      kind: 'replace_business_reference', operationId: input.operation_id, referenceId: input.reference_id,
      expectedVersion: input.expected_version, reason: input.reason, value: input.value,
      businessDate: input.business_date, categoryKey: input.category_key,
    }), true) })
  const retireCrmReference: Tool = buildTool({ name: 'retireCrmReference', isReadOnly: false, ...command(
    'Retire a current reference with a reason. The value stays reserved forever and is never reused. Requires configure authority, the expected_version and the user\'s confirmation.',
    z.object({
      operation_id: OperationId,
      reference_id: Uuid,
      expected_version: z.number().int().min(1),
      reason: z.string().trim().min(1).max(2000),
    }).strict(),
    (input) => ({
      kind: 'retire_business_reference', operationId: input.operation_id, referenceId: input.reference_id,
      expectedVersion: input.expected_version, reason: input.reason,
    }), true) })
  const importCrmReferences: Tool = buildTool({ name: 'importCrmReferences', isReadOnly: false, ...command(
    'Import an operator-reviewed registry of existing codes and partition counters for one definition, all or nothing. Conflicts (reserved values, duplicate rows, records already referenced, counters that would decrease) are returned for review and nothing is written. Never derive a counter from the textual maximum of historic codes; use the reviewed starting value. Requires configure authority and the user\'s confirmation.',
    z.object({
      operation_id: OperationId,
      definition_key: Key,
      rows: z.array(z.object({
        target_kind: CrmReferenceTargetKindSchema,
        target_id: Uuid,
        value: CrmBusinessReferenceValueSchema,
        status: z.enum(['active', 'retired']).default('active'),
        business_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        category_key: Key.optional(),
      }).strict()).max(1000).default([]),
      partition_counters: z.array(z.object({
        partition_key: z.string().trim().min(1).max(300),
        next_value: z.number().int().min(0).max(999_999_999_999),
      }).strict()).max(1000).default([]),
    }).strict(),
    (input) => ({
      kind: 'import_business_references', operationId: input.operation_id, definitionKey: input.definition_key,
      rows: input.rows.map((row) => ({ target: { kind: row.target_kind, id: row.target_id }, value: row.value, status: row.status,
        businessDate: row.business_date, categoryKey: row.category_key })),
      partitionCounters: input.partition_counters.map((counter) => ({ partitionKey: counter.partition_key, nextValue: counter.next_value })),
    }), true) })

  return {
    listCrmReferenceDefinitions, previewCrmReference, findCrmReference, getCrmReferenceHistory,
    assignCrmReference, saveCrmReferenceDefinition, replaceCrmReference, retireCrmReference, importCrmReferences,
  }
}
