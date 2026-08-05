/** Model-backed recipe selection, field construction, and targeted revision.
 * [COMP:api/office-generation] */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  collectStream,
  inferOfficeTemplateRouting,
  type LLMProvider,
  type Message,
  type OfficeClaimPlanEntry,
  type OfficeEvidencePacket,
} from '@use-brian/core'
import {
  assertOfficeArtifactSnapshot,
  OfficeArtifactSnapshotSchema,
  OfficeTemplateBundleSchema,
  type OfficeRichTextRun,
  type OfficeTemplateBundle,
  type OfficeTemplateField,
  type PresentationObject,
  type PresentationSnapshot,
} from '@use-brian/office-model'

const TEXT_FIELD_TYPES = new Set<OfficeTemplateField['type']>(['plainText', 'richText', 'bulletList', 'date', 'number'])

const PresentationPlanSchema = z.object({
  title: z.string().min(1).max(1_000),
  slides: z.array(z.object({
    recipeId: z.string().uuid(),
    title: z.string().min(1).max(500),
    fields: z.array(z.object({
      fieldId: z.string().uuid(),
      text: z.string().max(100_000),
    }).strict()).max(1_000),
  }).strict()).min(1).max(100),
}).strict()

const RevisionSchema = z.object({
  replacements: z.array(z.object({
    targetId: z.string().uuid(),
    text: z.string().max(100_000),
  }).strict()).min(1).max(100),
}).strict()

const PRESENTATION_SYSTEM_PROMPT = `You plan a concise presentation from an admitted slide-template catalogue. Return one JSON object and nothing else. Use only the supplied recipeId and fieldId values. Never invent a customer, metric, date, quote, award, integration, price, or commitment. Facts may come only from the user's request or supplied evidence. Prefer a coherent progression: opening, explanation, proof or detail, and closing. Respect every recipe's use guidance and repetition limit. Fill every required textual field. Omit optional fields that do not need to change so admitted brand copy and media remain intact. Use this exact shape: {"title":"...","slides":[{"recipeId":"uuid","title":"...","fields":[{"fieldId":"uuid","text":"..."}]}]}`

const REVISION_SYSTEM_PROMPT = `You revise only the selected text in a presentation. The complete presentation context is read-only and exists only so you can preserve meaning, narrative flow, and facts. Preserve every fact and the intended slide role unless the instruction explicitly changes it. Do not copy surrounding text into the replacement. Return one JSON object and nothing else with this exact shape: {"replacements":[{"targetId":"uuid","text":"replacement"}]}. Include every supplied target exactly once and no other target.`

function responseText(response: { content: Array<{ type: string; text?: string }> }): string {
  return response.content.map((block) => block.type === 'text' ? block.text ?? '' : '').join('').trim()
}

function parseJsonObject(raw: string): unknown {
  const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
  const match = cleaned.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('Office model response did not contain JSON')
  return JSON.parse(match[0])
}

function replaceRuns(runs: OfficeRichTextRun[], text: string): OfficeRichTextRun[] {
  const first = runs[0]
  if (!first) {
    return [{
      id: randomUUID(),
      text,
      style: {
        fontFamily: 'Arial',
        fontSizePt: 18,
        bold: false,
        italic: false,
        underline: false,
        strike: false,
        color: '#111111',
      },
    }]
  }
  if (runs.length === 1) return [{ ...first, text }]

  const words = text.trim() ? text.trim().split(/\s+/) : []
  const weights = runs.map((run) => Math.max(1, run.text.replace(/\s+/g, '').length))
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
  let consumed = 0
  let wordStart = 0
  return runs.map((run, index) => {
    consumed += weights[index] ?? 0
    const wordEnd = index === runs.length - 1 ? words.length : Math.round((consumed / totalWeight) * words.length)
    const segment = words.slice(wordStart, wordEnd).join(' ')
    wordStart = wordEnd
    return { ...run, text: segment + (segment && index < runs.length - 1 ? ' ' : '') }
  })
}

function textOfObject(object: PresentationObject): string | null {
  if (object.kind === 'text') return object.runs.map((run) => run.text).join('')
  if (object.kind === 'shape') return object.text.map((run) => run.text).join('')
  return null
}

function withObjectText(object: PresentationObject, text: string): PresentationObject {
  if (object.kind === 'text') return { ...object, runs: replaceRuns(object.runs, text) }
  if (object.kind === 'shape') return { ...object, text: replaceRuns(object.text, text) }
  throw new Error(`Presentation target ${object.id} is not textual`)
}

function collectIdentityMap(value: unknown, identities = new Map<string, string>()): Map<string, string> {
  if (!value || typeof value !== 'object') return identities
  if (!Array.isArray(value)) {
    const object = value as Record<string, unknown>
    if (typeof object.id === 'string') identities.set(object.id, randomUUID())
  }
  for (const child of Object.values(value)) collectIdentityMap(child, identities)
  return identities
}

function remapIdentities(value: unknown, identities: Map<string, string>): unknown {
  if (typeof value === 'string') return identities.get(value) ?? value
  if (Array.isArray(value)) return value.map((item) => remapIdentities(item, identities))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, remapIdentities(child, identities)]))
}

function catalogueOf(template: OfficeTemplateBundle): unknown[] {
  const fields = new Map(template.fields.map((field) => [field.id, field]))
  return template.slideRecipes.filter((recipe) => recipe.enabled).map((recipe) => ({
    recipeId: recipe.id,
    name: recipe.name,
    role: recipe.role,
    whenToUse: recipe.whenToUse,
    whenNotToUse: recipe.whenNotToUse,
    repeatable: recipe.repeatable,
    minUses: recipe.minUses,
    maxUses: recipe.maxUses,
    fields: recipe.fieldIds.map((fieldId) => fields.get(fieldId)).filter((field): field is OfficeTemplateField => Boolean(field) && TEXT_FIELD_TYPES.has(field!.type) && !field!.locked).map((field) => ({
      fieldId: field.id,
      label: field.label,
      type: field.type,
      required: field.required,
      maxLength: field.maxLength,
      instruction: field.aiInstruction,
    })),
  }))
}

function validatePlan(template: OfficeTemplateBundle, rawPlan: unknown): z.infer<typeof PresentationPlanSchema> {
  const plan = PresentationPlanSchema.parse(rawPlan)
  const recipes = new Map(template.slideRecipes.map((recipe) => [recipe.id, recipe]))
  const fields = new Map(template.fields.map((field) => [field.id, field]))
  const sourceSlides = new Map(template.snapshot.family === 'presentation' ? template.snapshot.slides.map((slide) => [slide.id, slide]) : [])
  const recipeUses = new Map<string, number>()

  for (const slide of plan.slides) {
    const recipe = recipes.get(slide.recipeId)
    if (!recipe || !recipe.enabled) throw new Error('Presentation plan selected an unavailable slide recipe')
    if (!sourceSlides.has(recipe.slideId)) throw new Error('Presentation plan selected a recipe without a source slide')
    const uses = (recipeUses.get(recipe.id) ?? 0) + 1
    recipeUses.set(recipe.id, uses)
    if (uses > recipe.maxUses || (uses > 1 && !recipe.repeatable)) throw new Error(`Presentation plan exceeded the repetition limit for ${recipe.name}`)

    const allowedFields = new Set(recipe.fieldIds)
    const suppliedFields = new Set<string>()
    for (const plannedField of slide.fields) {
      if (suppliedFields.has(plannedField.fieldId)) throw new Error('Presentation plan wrote one field more than once')
      suppliedFields.add(plannedField.fieldId)
      const field = fields.get(plannedField.fieldId)
      if (!field || !allowedFields.has(field.id) || field.locked || !TEXT_FIELD_TYPES.has(field.type)) throw new Error('Presentation plan wrote an unavailable template field')
      if (field.maxLength !== undefined && plannedField.text.length > field.maxLength) throw new Error(`Presentation field ${field.label} exceeds its maximum length`)
      if (field.required && !plannedField.text.trim()) throw new Error(`Presentation field ${field.label} is required`)
    }
    for (const fieldId of recipe.fieldIds) {
      const field = fields.get(fieldId)
      if (field?.required && TEXT_FIELD_TYPES.has(field.type) && !field.locked && !suppliedFields.has(field.id)) throw new Error(`Presentation plan omitted required field ${field.label}`)
    }
  }

  for (const recipe of template.slideRecipes) {
    if ((recipeUses.get(recipe.id) ?? 0) < recipe.minUses) throw new Error(`Presentation plan omitted required recipe ${recipe.name}`)
  }
  return plan
}

export function materializeOfficeTemplateBundleForGeneration(input: unknown, identity: {
  id: string
  version: number
  status: 'admitted'
}): OfficeTemplateBundle {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
  const candidate = { ...source, ...identity }
  const current = OfficeTemplateBundleSchema.safeParse(candidate)
  if (current.success && (current.data.family !== 'presentation' || current.data.slideRecipes.length > 0)) return current.data

  const snapshot = OfficeArtifactSnapshotSchema.safeParse(source.snapshot)
  const isLegacyPresentation = snapshot.success
    && snapshot.data.family === 'presentation'
    && Array.isArray(source.fields)
    && source.fields.length === 0
    && (source.slideRecipes === undefined || Array.isArray(source.slideRecipes) && source.slideRecipes.length === 0)
  if (!isLegacyPresentation) {
    if (current.success) return current.data
    throw current.error
  }

  const routing = inferOfficeTemplateRouting(snapshot.data, 'promote')
  return OfficeTemplateBundleSchema.parse({
    ...candidate,
    fields: routing.fields,
    slideRecipes: routing.slideRecipes,
  })
}

export async function generatePresentationFromTemplate(params: {
  provider: LLMProvider
  model: string
  artifactId: string
  workspaceId: string
  templateVersionId: string
  outcome: string
  audience: string
  evidence: OfficeEvidencePacket
  claims: OfficeClaimPlanEntry[]
  template: OfficeTemplateBundle
}): Promise<PresentationSnapshot> {
  if (params.template.family !== 'presentation' || params.template.snapshot.family !== 'presentation') throw new Error('Presentation generation requires a presentation template')
  const catalogue = catalogueOf(params.template)
  if (catalogue.length === 0) throw new Error('Presentation template has no enabled slide recipes')
  const evidence = {
    brain: params.evidence.brain.slice(0, 12).map((entry) => ({ ...entry, excerpt: entry.excerpt.slice(0, 4_000) })),
    website: params.evidence.website.slice(0, 2).map((entry) => ({ ...entry, excerpt: entry.excerpt.slice(0, 8_000) })),
    claims: params.claims.slice(0, 100),
  }
  const response = await collectStream(params.provider.stream({
    model: params.model,
    systemPrompt: PRESENTATION_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Outcome:\n${params.outcome}\n\nAudience:\n${params.audience}\n\nTemplate guidance:\n${params.template.description}\n\nAdmitted slide catalogue:\n${JSON.stringify(catalogue)}\n\nGrounding:\n${JSON.stringify(evidence)}`,
    }] as Message[],
    maxTokens: 8_000,
    temperature: 0.2,
  }))
  const plan = validatePlan(params.template, parseJsonObject(responseText(response)))
  const recipes = new Map(params.template.slideRecipes.map((recipe) => [recipe.id, recipe]))
  const fields = new Map(params.template.fields.map((field) => [field.id, field]))
  const sourceSlides = new Map(params.template.snapshot.slides.map((slide) => [slide.id, slide]))

  const slides = plan.slides.map((plannedSlide) => {
    const recipe = recipes.get(plannedSlide.recipeId)!
    const sourceSlide = sourceSlides.get(recipe.slideId)!
    const identities = collectIdentityMap(sourceSlide)
    const slide = remapIdentities(sourceSlide, identities) as PresentationSnapshot['slides'][number]
    const replacements = new Map<string, string>()
    for (const plannedField of plannedSlide.fields) {
      const field = fields.get(plannedField.fieldId)!
      for (const targetId of field.targetIds) {
        const mappedTargetId = identities.get(targetId)
        if (!mappedTargetId) throw new Error(`Presentation field ${field.label} targets a missing object`)
        replacements.set(mappedTargetId, plannedField.text)
      }
    }
    slide.objects = slide.objects.map((object) => replacements.has(object.id) ? withObjectText(object, replacements.get(object.id)!) : object)
    slide.title = plannedSlide.title
    return slide
  })

  const source = params.template.snapshot
  return assertOfficeArtifactSnapshot({
    ...source,
    artifactId: params.artifactId,
    workspaceId: params.workspaceId,
    templateVersionId: params.templateVersionId,
    rootId: randomUUID(),
    title: plan.title,
    resources: params.template.resources,
    accessibility: { ...source.accessibility, title: plan.title },
    slides,
  }) as PresentationSnapshot
}

export async function revisePresentationTargets(params: {
  provider: LLMProvider
  model: string
  snapshot: PresentationSnapshot
  targetIds: string[]
  instruction: string
}): Promise<PresentationSnapshot> {
  const targetSet = new Set(params.targetIds)
  const selected: Array<{ targetId: string; text: string }> = []
  for (const slide of params.snapshot.slides) {
    for (const object of slide.objects) {
      const text = targetSet.has(object.id) ? textOfObject(object) : null
      if (text !== null) selected.push({ targetId: object.id, text })
    }
  }
  if (selected.length !== targetSet.size) throw new Error('One or more presentation revision targets are missing or non-textual')
  const context = params.snapshot.slides.map((slide, slideIndex) => ({
    slide: slideIndex + 1,
    title: slide.title,
    objects: slide.objects.flatMap((object) => {
      const text = textOfObject(object)
      return text === null ? [] : [{ targetId: object.id, selected: targetSet.has(object.id), text }]
    }),
  }))
  const response = await collectStream(params.provider.stream({
    model: params.model,
    systemPrompt: REVISION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `Instruction:\n${params.instruction.replace(/(^|\s)@Brian\b/gi, '$1').trim()}\n\nSelected text:\n${JSON.stringify(selected)}\n\nComplete presentation context (read-only):\n${JSON.stringify(context)}` }] as Message[],
    maxTokens: 3_000,
    temperature: 0.2,
  }))
  const revision = RevisionSchema.parse(parseJsonObject(responseText(response)))
  const replacements = new Map(revision.replacements.map((item) => [item.targetId, item.text]))
  if (replacements.size !== targetSet.size || [...targetSet].some((id) => !replacements.has(id))) throw new Error('Presentation revision did not return every selected target')
  const next = structuredClone(params.snapshot)
  next.slides = next.slides.map((slide) => ({
    ...slide,
    objects: slide.objects.map((object) => replacements.has(object.id) ? withObjectText(object, replacements.get(object.id)!) : object),
  }))
  return assertOfficeArtifactSnapshot(next) as PresentationSnapshot
}
