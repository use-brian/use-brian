/** Model-backed recipe selection, field construction, and targeted revision.
 * [COMP:api/office-generation] */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  collectStream,
  fitOfficeArtifact,
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
const MAX_FIT_ATTEMPTS = 3

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

const REVISION_SYSTEM_PROMPT = `You revise only the selected text in a presentation. The complete presentation context is read-only and exists only so you can preserve meaning, narrative flow, and facts. Preserve every fact and the intended slide role unless the instruction explicitly changes it. Do not copy surrounding text into the replacement. Return one JSON object and nothing else with this exact shape: {"replacements":[{"targetId":"uuid","text":"replacement"}]}. Every selected entry marked required must appear exactly once. A slide-scoped entry not marked required is allowed but should appear only when the instruction requires changing it. Never return a target outside the selected entries.`

type PresentationPlan = z.infer<typeof PresentationPlanSchema>
type RevisionPlan = z.infer<typeof RevisionSchema>

type MaterializedPresentation = {
  snapshot: PresentationSnapshot
  fieldByIdentity: Map<string, OfficeTemplateField>
  readabilityExemptIds: string[]
}

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

  const weights = runs.map((run) => Math.max(1, run.text.replace(/\s+/g, '').length))
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
  const characters = [...text]
  const contentLength = characters.filter((character) => !/\s/.test(character)).length
  let consumedWeight = 0
  let consumedContent = 0
  let characterStart = 0
  return runs.map((run, index) => {
    consumedWeight += weights[index] ?? 0
    if (index === runs.length - 1) return { ...run, text: characters.slice(characterStart).join('') }
    const targetContent = Math.round((consumedWeight / totalWeight) * contentLength)
    let characterEnd = characterStart
    while (characterEnd < characters.length && consumedContent < targetContent) {
      if (!/\s/.test(characters[characterEnd]!)) consumedContent += 1
      characterEnd += 1
    }
    if (characterEnd > characterStart && characterEnd < characters.length && !/\s/.test(characters[characterEnd - 1]!) && !/\s/.test(characters[characterEnd]!)) {
      while (characterEnd < characters.length && !/\s/.test(characters[characterEnd]!)) {
        consumedContent += 1
        characterEnd += 1
      }
    }
    while (characterEnd < characters.length && /\s/.test(characters[characterEnd]!)) characterEnd += 1
    const segment = characters.slice(characterStart, characterEnd).join('')
    characterStart = characterEnd
    return { ...run, text: segment }
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

function collectReadabilityExemptIds(value: unknown, ids = new Set<string>()): Set<string> {
  if (!value || typeof value !== 'object') return ids
  if (!Array.isArray(value)) {
    const object = value as Record<string, unknown>
    const style = object.style as Record<string, unknown> | undefined
    if (typeof object.id === 'string' && style && typeof style.fontSizePt === 'number' && style.fontSizePt < 8) ids.add(object.id)
  }
  for (const child of Object.values(value)) collectReadabilityExemptIds(child, ids)
  return ids
}

function collectIds(value: unknown, ids = new Set<string>()): Set<string> {
  if (!value || typeof value !== 'object') return ids
  if (!Array.isArray(value)) {
    const object = value as Record<string, unknown>
    if (typeof object.id === 'string') ids.add(object.id)
  }
  for (const child of Object.values(value)) collectIds(child, ids)
  return ids
}

function fitDiagnostics(materialized: MaterializedPresentation): Array<Record<string, unknown>> {
  const fit = fitOfficeArtifact(materialized.snapshot, { readabilityExemptObjectIds: materialized.readabilityExemptIds })
  if (fit.ok) return []
  const objectContext = new Map<string, { slide: number; slideTitle: string; text: string | null }>()
  for (const [slideIndex, slide] of materialized.snapshot.slides.entries()) {
    for (const object of slide.objects) {
      const context = { slide: slideIndex + 1, slideTitle: slide.title, text: textOfObject(object) }
      for (const id of collectIds(object)) objectContext.set(id, context)
    }
  }
  return fit.issues.map((issue) => {
    const field = materialized.fieldByIdentity.get(issue.objectId)
    const relatedId = issue.message.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i)?.[0]
    const relatedField = relatedId ? materialized.fieldByIdentity.get(relatedId) : undefined
    const message = relatedId
      ? relatedField ? `Text overlaps field ${relatedField.label}` : 'Text overlaps another text region on this slide'
      : issue.message
    return {
      code: issue.code,
      message,
      fieldId: field?.id,
      fieldLabel: field?.label,
      ...objectContext.get(issue.objectId),
    }
  })
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

function materializePresentation(params: {
  artifactId: string
  workspaceId: string
  templateVersionId: string
  template: OfficeTemplateBundle & { family: 'presentation'; snapshot: PresentationSnapshot }
}, plan: PresentationPlan): MaterializedPresentation {
  const recipes = new Map(params.template.slideRecipes.map((recipe) => [recipe.id, recipe]))
  const fields = new Map(params.template.fields.map((field) => [field.id, field]))
  const sourceSlides = new Map(params.template.snapshot.slides.map((slide) => [slide.id, slide]))
  const fieldByIdentity = new Map<string, OfficeTemplateField>()
  const readabilityExemptIds = new Set<string>()

  const slides = plan.slides.map((plannedSlide) => {
    const recipe = recipes.get(plannedSlide.recipeId)!
    const sourceSlide = sourceSlides.get(recipe.slideId)!
    const identities = collectIdentityMap(sourceSlide)
    const slide = remapIdentities(sourceSlide, identities) as PresentationSnapshot['slides'][number]
    for (const sourceId of collectReadabilityExemptIds(sourceSlide)) {
      const generatedId = identities.get(sourceId)
      if (generatedId) readabilityExemptIds.add(generatedId)
    }
    const replacements = new Map<string, { text: string; field: OfficeTemplateField }>()
    for (const plannedField of plannedSlide.fields) {
      const field = fields.get(plannedField.fieldId)!
      for (const targetId of field.targetIds) {
        const mappedTargetId = identities.get(targetId)
        if (!mappedTargetId) throw new Error(`Presentation field ${field.label} targets a missing object`)
        replacements.set(mappedTargetId, { text: plannedField.text, field })
      }
    }
    slide.objects = slide.objects.map((object) => {
      const replacement = replacements.get(object.id)
      const next = replacement ? withObjectText(object, replacement.text) : object
      if (replacement) for (const id of collectIds(next)) fieldByIdentity.set(id, replacement.field)
      return next
    })
    slide.title = plannedSlide.title
    return slide
  })

  const source = params.template.snapshot
  const snapshot = assertOfficeArtifactSnapshot({
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
  return { snapshot, fieldByIdentity, readabilityExemptIds: [...readabilityExemptIds] }
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
  const template = params.template as OfficeTemplateBundle & { family: 'presentation'; snapshot: PresentationSnapshot }
  const catalogue = catalogueOf(template)
  if (catalogue.length === 0) throw new Error('Presentation template has no enabled slide recipes')
  const evidence = {
    brain: params.evidence.brain.slice(0, 12).map((entry) => ({ ...entry, excerpt: entry.excerpt.slice(0, 4_000) })),
    website: params.evidence.website.slice(0, 2).map((entry) => ({ ...entry, excerpt: entry.excerpt.slice(0, 8_000) })),
    claims: params.claims.slice(0, 100),
  }
  const requestContext = `Outcome:\n${params.outcome}\n\nAudience:\n${params.audience}\n\nTemplate guidance:\n${template.description}\n\nAdmitted slide catalogue:\n${JSON.stringify(catalogue)}\n\nGrounding:\n${JSON.stringify(evidence)}`
  let rejectedPlan: PresentationPlan | undefined
  let diagnostics: Array<Record<string, unknown>> = []
  for (let attempt = 1; attempt <= MAX_FIT_ATTEMPTS; attempt += 1) {
    const repairContext = rejectedPlan
      ? `\n\nThe previous plan was rejected by deterministic layout validation. Rewrite it more concisely or choose another admitted recipe without dropping required grounded meaning.\nRejected plan:\n${JSON.stringify(rejectedPlan)}\n\nFit diagnostics:\n${JSON.stringify(diagnostics)}`
      : ''
    const response = await collectStream(params.provider.stream({
      model: params.model,
      systemPrompt: PRESENTATION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `${requestContext}${repairContext}` }] as Message[],
      maxTokens: 8_000,
      temperature: 0.2,
    }))
    const plan = validatePlan(template, parseJsonObject(responseText(response)))
    const materialized = materializePresentation({ ...params, template }, plan)
    diagnostics = fitDiagnostics(materialized)
    if (diagnostics.length === 0) return materialized.snapshot
    rejectedPlan = plan
  }
  throw new Error(`Presentation generation could not satisfy the admitted template fit constraints after ${MAX_FIT_ATTEMPTS} attempts: ${JSON.stringify(diagnostics)}`)
}

export async function revisePresentationTargets(params: {
  provider: LLMProvider
  model: string
  snapshot: PresentationSnapshot
  targetIds: string[]
  instruction: string
}): Promise<PresentationSnapshot> {
  const requestedTargetSet = new Set(params.targetIds)
  const resolvedRequestedTargets = new Set<string>()
  const selected: Array<{ targetId: string; text: string; required: boolean }> = []
  for (const slide of params.snapshot.slides) {
    const slideSelected = requestedTargetSet.has(slide.id)
    let slideHasEditableText = false
    for (const object of slide.objects) {
      const objectSelected = requestedTargetSet.has(object.id)
      const text = textOfObject(object)
      if (text === null || object.locked || !slideSelected && !objectSelected) continue
      selected.push({ targetId: object.id, text, required: objectSelected })
      if (slideSelected) slideHasEditableText = true
      if (objectSelected) resolvedRequestedTargets.add(object.id)
    }
    if (slideSelected && slideHasEditableText) resolvedRequestedTargets.add(slide.id)
  }
  if (resolvedRequestedTargets.size !== requestedTargetSet.size || selected.length === 0) throw new Error('One or more presentation revision targets are missing, locked, or non-textual')
  const allowedTargetSet = new Set(selected.map((entry) => entry.targetId))
  const requiredTargetSet = new Set(selected.filter((entry) => entry.required).map((entry) => entry.targetId))
  const context = params.snapshot.slides.map((slide, slideIndex) => ({
    slide: slideIndex + 1,
    title: slide.title,
    objects: slide.objects.flatMap((object) => {
      const text = textOfObject(object)
      return text === null ? [] : [{ targetId: object.id, selected: allowedTargetSet.has(object.id), text }]
    }),
  }))
  const requestContext = `Instruction:\n${params.instruction.replace(/(^|\s)@Brian\b/gi, '$1').trim()}\n\nSelected text:\n${JSON.stringify(selected)}\n\nComplete presentation context (read-only):\n${JSON.stringify(context)}`
  const readabilityExemptIds = [...collectReadabilityExemptIds(params.snapshot)]
  let rejectedRevision: RevisionPlan | undefined
  let diagnostics: Array<Record<string, unknown>> = []
  for (let attempt = 1; attempt <= MAX_FIT_ATTEMPTS; attempt += 1) {
    const repairContext = rejectedRevision
      ? `\n\nThe previous replacement was rejected by deterministic layout validation. Rewrite only the selected text more concisely.\nRejected replacement:\n${JSON.stringify(rejectedRevision)}\n\nFit diagnostics:\n${JSON.stringify(diagnostics)}`
      : ''
    const response = await collectStream(params.provider.stream({
      model: params.model,
      systemPrompt: REVISION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `${requestContext}${repairContext}` }] as Message[],
      maxTokens: 3_000,
      temperature: 0.2,
    }))
    const revision = RevisionSchema.parse(parseJsonObject(responseText(response)))
    const replacements = new Map(revision.replacements.map((item) => [item.targetId, item.text]))
    const hasDuplicateTargets = replacements.size !== revision.replacements.length
    const hasOutOfScopeTargets = [...replacements.keys()].some((id) => !allowedTargetSet.has(id))
    const missesRequiredTarget = [...requiredTargetSet].some((id) => !replacements.has(id))
    if (hasDuplicateTargets || hasOutOfScopeTargets || missesRequiredTarget) throw new Error('Presentation revision escaped its selected target boundary')
    const next = structuredClone(params.snapshot)
    next.slides = next.slides.map((slide) => ({
      ...slide,
      objects: slide.objects.map((object) => replacements.has(object.id) ? withObjectText(object, replacements.get(object.id)!) : object),
    }))
    const snapshot = assertOfficeArtifactSnapshot(next) as PresentationSnapshot
    diagnostics = fitDiagnostics({ snapshot, fieldByIdentity: new Map(), readabilityExemptIds })
    if (diagnostics.length === 0) return snapshot
    rejectedRevision = revision
  }
  throw new Error(`Presentation revision could not satisfy the admitted template fit constraints after ${MAX_FIT_ATTEMPTS} attempts: ${JSON.stringify(diagnostics)}`)
}
