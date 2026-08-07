import { z } from 'zod'
import {
  OfficeArtifactSnapshotSchema,
  OfficeFamilySchema,
  OfficeResourceRefSchema,
  OfficeSensitivitySchema,
  OfficeUuidSchema,
  type PresentationObject,
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

export const OfficeTemplateSlideRoleSchema = z.enum([
  'cover',
  'agenda',
  'section',
  'narrative',
  'comparison',
  'metrics',
  'timeline',
  'process',
  'caseStudy',
  'team',
  'quote',
  'closing',
  'appendix',
])

/**
 * Conservative planning capacity for template-bound presentation text.
 * The renderer remains authoritative for the actual glyph mix and wrapping.
 */
export function presentationTextCapacity(object: PresentationObject): number | undefined {
  const runs = object.kind === 'text' ? object.runs : object.kind === 'shape' ? object.text : undefined
  if (!runs?.length) return undefined
  const maximumFontSizePt = Math.max(1, ...runs.map((run) => run.style.fontSizePt))
  const lineCount = Math.max(1, Math.floor(object.geometry.heightPt / (maximumFontSizePt * 1.15)))
  const charactersPerLine = Math.max(1, Math.floor(object.geometry.widthPt / (maximumFontSizePt * 0.5)))
  return Math.min(4_000, lineCount * charactersPerLine)
}

export const OfficeTemplateSlideRecipeSchema = z
  .object({
    id: OfficeUuidSchema,
    slideId: OfficeUuidSchema,
    name: z.string().min(1).max(200),
    role: OfficeTemplateSlideRoleSchema,
    whenToUse: z.string().min(1).max(2_000),
    whenNotToUse: z.string().max(2_000).default(''),
    enabled: z.boolean().default(true),
    repeatable: z.boolean().default(false),
    minUses: z.number().int().min(0).max(100).default(0),
    maxUses: z.number().int().min(1).max(100).default(1),
    fieldIds: z.array(OfficeUuidSchema).max(1_000),
    confidence: z.number().min(0).max(1),
    inference: z.string().min(1).max(2_000),
    reviewed: z.boolean().default(false),
  })
  .strict()
  .superRefine((recipe, ctx) => {
    if (recipe.maxUses < recipe.minUses) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['maxUses'], message: 'maxUses must be >= minUses' })
    if (!recipe.repeatable && recipe.maxUses !== 1) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['maxUses'], message: 'A non-repeatable slide recipe must have maxUses = 1' })
    if (!recipe.enabled && recipe.minUses !== 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['minUses'], message: 'A disabled slide recipe must have minUses = 0' })
    if (new Set(recipe.fieldIds).size !== recipe.fieldIds.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['fieldIds'], message: 'Slide recipe fieldIds must be unique' })
  })

export const OfficeTemplateRoutingDraftSchema = z.object({
  source: z.enum(['upload', 'guided', 'scratch', 'promote']).default('scratch'),
  fields: z.array(OfficeTemplateFieldSchema).max(10_000),
  slideRecipes: z.array(OfficeTemplateSlideRecipeSchema).max(10_000),
}).strict()

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
    slideRecipes: z.array(OfficeTemplateSlideRecipeSchema).max(10_000).default([]),
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
    const fieldIds = new Set<string>()
    for (const [index, field] of bundle.fields.entries()) {
      if (names.has(field.name)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['fields', index, 'name'], message: 'Template field names must be unique' })
      names.add(field.name)
      if (fieldIds.has(field.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['fields', index, 'id'], message: 'Template field IDs must be unique' })
      fieldIds.add(field.id)
    }
    if (bundle.family === 'document' && bundle.slideRecipes.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['slideRecipes'], message: 'Document templates cannot contain slide recipes' })
    }
    // Empty routing remains readable for presentation versions admitted before
    // recipe selection existed. Generation deterministically materializes that
    // legacy shape in memory; any non-empty catalogue is validated strictly.
    if (bundle.family === 'presentation' && bundle.snapshot.family === 'presentation' && bundle.slideRecipes.length > 0) {
      const slides = new Set(bundle.snapshot.slides.map((slide) => slide.id))
      const recipeIds = new Set<string>()
      const recipeSlides = new Set<string>()
      const assignedFields = new Set<string>()
      for (const [index, recipe] of bundle.slideRecipes.entries()) {
        if (recipeIds.has(recipe.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['slideRecipes', index, 'id'], message: 'Slide recipe IDs must be unique' })
        recipeIds.add(recipe.id)
        if (!slides.has(recipe.slideId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['slideRecipes', index, 'slideId'], message: 'Slide recipe must target a source slide in the template snapshot' })
        if (recipeSlides.has(recipe.slideId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['slideRecipes', index, 'slideId'], message: 'A source slide can have only one slide recipe' })
        recipeSlides.add(recipe.slideId)
        for (const fieldId of recipe.fieldIds) {
          if (!fieldIds.has(fieldId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['slideRecipes', index, 'fieldIds'], message: `Slide recipe references missing field ${fieldId}` })
          if (assignedFields.has(fieldId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['slideRecipes', index, 'fieldIds'], message: `Template field ${fieldId} belongs to more than one slide recipe` })
          assignedFields.add(fieldId)
        }
      }
      for (const [index, slide] of bundle.snapshot.slides.entries()) {
        if (!recipeSlides.has(slide.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['slideRecipes'], message: `Source slide ${index + 1} must have one slide recipe` })
      }
      for (const [index, field] of bundle.fields.entries()) {
        if (!assignedFields.has(field.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['fields', index, 'id'], message: 'Every presentation field must belong to one slide recipe' })
      }
    }
  })

export type OfficeTemplateField = z.infer<typeof OfficeTemplateFieldSchema>
export type OfficeTemplateSlideRole = z.infer<typeof OfficeTemplateSlideRoleSchema>
export type OfficeTemplateSlideRecipe = z.infer<typeof OfficeTemplateSlideRecipeSchema>
export type OfficeTemplateRoutingDraft = z.infer<typeof OfficeTemplateRoutingDraftSchema>
export type OfficeTemplateBundle = z.infer<typeof OfficeTemplateBundleSchema>
