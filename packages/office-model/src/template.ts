import { z } from 'zod'
import {
  OfficeArtifactSnapshotSchema,
  OfficeFamilySchema,
  OfficeResourceRefSchema,
  OfficeSensitivitySchema,
  OfficeUuidSchema,
} from './model.js'

export const OfficeTemplateFieldSchema = z
  .object({
    id: OfficeUuidSchema,
    name: z.string().regex(/^[a-z][a-z0-9_.-]{1,127}$/),
    label: z.string().min(1).max(200),
    type: z.enum(['plainText', 'richText', 'image', 'date', 'number', 'bulletList', 'table', 'chartData', 'video']),
    required: z.boolean(),
    repeating: z.boolean(),
    minItems: z.number().int().min(0).max(10_000).default(0),
    maxItems: z.number().int().min(1).max(10_000).default(1),
    maxLength: z.number().int().min(1).max(1_000_000).optional(),
    targetIds: z.array(OfficeUuidSchema).min(1),
    aiInstruction: z.string().min(1).max(4_000),
    locked: z.boolean().default(false),
  })
  .strict()
  .refine((field) => field.maxItems >= field.minItems, { message: 'maxItems must be >= minItems' })

export const OfficeTemplateBundleSchema = z
  .object({
    id: OfficeUuidSchema,
    workspaceId: OfficeUuidSchema,
    family: OfficeFamilySchema,
    version: z.number().int().positive(),
    status: z.enum(['draft', 'admitted', 'deprecated', 'trash']),
    name: z.string().min(1).max(255),
    description: z.string().min(1).max(4_000),
    tags: z.array(z.string().min(1).max(100)).max(100),
    locales: z.array(z.string().min(2).max(35)).min(1),
    whenToUse: z.array(z.string().min(1).max(1_000)).min(1),
    whenNotToUse: z.array(z.string().min(1).max(1_000)).min(1),
    exampleRequests: z.array(z.string().min(1).max(1_000)).min(1),
    fields: z.array(OfficeTemplateFieldSchema).max(10_000),
    snapshot: OfficeArtifactSnapshotSchema,
    resources: z.array(OfficeResourceRefSchema).max(20_000),
    lockedObjectIds: z.array(OfficeUuidSchema),
    allowedRepeatTargetIds: z.array(OfficeUuidSchema),
    requiredEvidence: z.array(z.string().min(1).max(500)),
    sensitivity: OfficeSensitivitySchema,
    visibilityUserIds: z.array(OfficeUuidSchema),
    capabilityVersion: z.number().int().positive(),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((bundle, ctx) => {
    if (bundle.snapshot.family !== bundle.family) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['snapshot', 'family'], message: 'Template family must match snapshot family' })
    }
    const names = new Set<string>()
    for (const [index, field] of bundle.fields.entries()) {
      if (names.has(field.name)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['fields', index, 'name'], message: 'Template field names must be unique' })
      names.add(field.name)
    }
  })

export type OfficeTemplateField = z.infer<typeof OfficeTemplateFieldSchema>
export type OfficeTemplateBundle = z.infer<typeof OfficeTemplateBundleSchema>
