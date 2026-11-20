/** Generic workspace configuration commands. [COMP:crm/config-commands] */
import { z } from 'zod'
import { CRM_CUSTOM_FIELD_TYPES } from './record-values.js'

export const CRM_CONFIG_ENTITY_KINDS = ['person', 'company', 'deal'] as const
export const CRM_PIPELINE_STAGE_CATEGORIES = ['open', 'won', 'lost'] as const
const Name = z.string().trim().min(1).max(100)
const Options = z.array(z.string().min(1).max(200)).max(200)
const Field = z.object({
  entityKind: z.enum(CRM_CONFIG_ENTITY_KINDS),
  fieldKey: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
  label: Name,
  fieldType: z.enum(CRM_CUSTOM_FIELD_TYPES),
  options: Options.default([]),
  isRequired: z.boolean().default(false),
}).strict()

function validateOptions(value: z.infer<typeof Field>, ctx: z.RefinementCtx) {
  if (['single_select', 'multi_select', 'entity_reference'].includes(value.fieldType) && !value.options.length) {
    ctx.addIssue({ code: 'custom', path: ['options'], message: 'Select and reference fields require at least one option.' })
  }
  if (value.fieldType === 'entity_reference' && value.options.some((option) => !(CRM_CONFIG_ENTITY_KINDS as readonly string[]).includes(option))) {
    ctx.addIssue({ code: 'custom', path: ['options'], message: `Reference targets must be one of: ${CRM_CONFIG_ENTITY_KINDS.join(', ')}.` })
  }
  if (new Set(value.options).size !== value.options.length) {
    ctx.addIssue({ code: 'custom', path: ['options'], message: 'Options must be unique.' })
  }
}
export const CrmRecordFieldDefinitionSchema = Field.superRefine(validateOptions)
export const CreateCrmRecordFieldCommandSchema = Field.extend({ kind: z.literal('create_record_field') }).superRefine(validateOptions)
export const UpdateCrmRecordFieldCommandSchema = z.object({
  kind: z.literal('update_record_field'), fieldId: z.string().uuid(),
  label: Name.optional(), options: Options.optional(), isRequired: z.boolean().optional(),
}).strict()
export const SetCrmRecordFieldArchivedCommandSchema = z.object({
  kind: z.literal('set_record_field_archived'), fieldId: z.string().uuid(), archived: z.boolean(),
}).strict()
export const CreateCrmPipelineCommandSchema = z.object({
  kind: z.literal('create_pipeline'), name: Name, isDefault: z.boolean().default(false),
}).strict()
export const UpdateCrmPipelineCommandSchema = z.object({
  kind: z.literal('update_pipeline'), pipelineId: z.string().uuid(), name: Name.optional(),
  isDefault: z.boolean().optional(), archived: z.boolean().optional(),
}).strict()
const Stage = z.object({
  name: Name, category: z.enum(CRM_PIPELINE_STAGE_CATEGORIES),
  probability: z.number().int().min(0).max(100),
  requiredFields: z.array(z.string().min(1).max(100)).max(200).default([]),
}).strict()
export const CreateCrmPipelineStageCommandSchema = Stage.extend({
  kind: z.literal('create_pipeline_stage'), pipelineId: z.string().uuid(),
})
export const UpdateCrmPipelineStageCommandSchema = Stage.partial().extend({
  kind: z.literal('update_pipeline_stage'), stageId: z.string().uuid(), archived: z.boolean().optional(),
})
export const CrmConfigCommandSchema = z.union([
  CreateCrmRecordFieldCommandSchema, UpdateCrmRecordFieldCommandSchema, SetCrmRecordFieldArchivedCommandSchema,
  CreateCrmPipelineCommandSchema, UpdateCrmPipelineCommandSchema,
  CreateCrmPipelineStageCommandSchema, UpdateCrmPipelineStageCommandSchema,
])
export type CrmConfigCommand = z.infer<typeof CrmConfigCommandSchema>
export function isCrmConfigCommand(command: { kind: string }): command is CrmConfigCommand {
  return ['create_record_field', 'update_record_field', 'set_record_field_archived', 'create_pipeline',
    'update_pipeline', 'create_pipeline_stage', 'update_pipeline_stage'].includes(command.kind)
}
