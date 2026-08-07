/** Deterministic presentation-template routing draft inference and validation.
 * [COMP:office/template-routing] */
import {
  OfficeTemplateRoutingDraftSchema,
  presentationTextCapacity,
  type OfficeArtifactSnapshot,
  type OfficeTemplateField,
  type OfficeTemplateRoutingDraft,
  type OfficeTemplateSlideRecipe,
  type OfficeTemplateSlideRole,
  type PresentationObject,
  type PresentationSnapshot,
} from '@use-brian/office-model'
import { stableOfficeUuid } from '../package.js'

const ROLE_GUIDANCE: Record<OfficeTemplateSlideRole, { use: string; avoid: string; repeatable: boolean }> = {
  cover: { use: 'Use at the beginning to introduce the presentation and its central subject.', avoid: 'Do not use for supporting detail or repeated sections.', repeatable: false },
  agenda: { use: 'Use near the beginning to preview the presentation structure or discussion topics.', avoid: 'Do not use when there is no meaningful sequence to preview.', repeatable: false },
  section: { use: 'Use to introduce a new major section or change of subject.', avoid: 'Do not use for dense evidence or detailed explanation.', repeatable: true },
  narrative: { use: 'Use for a focused idea supported by a title and explanatory content.', avoid: 'Do not use when the content requires a specialized comparison, timeline, metric, or process structure.', repeatable: true },
  comparison: { use: 'Use when two or more alternatives, states, products, or approaches must be compared.', avoid: 'Do not use for a single undivided narrative.', repeatable: true },
  metrics: { use: 'Use for key figures, performance indicators, outcomes, or quantified evidence.', avoid: 'Do not use when the section has no evidence-supported numbers.', repeatable: true },
  timeline: { use: 'Use for dated milestones, a roadmap, or events in chronological order.', avoid: 'Do not use for unordered themes or categories.', repeatable: true },
  process: { use: 'Use for ordered steps, a workflow, or an explanation of how something works.', avoid: 'Do not use when sequence and progression are unimportant.', repeatable: true },
  caseStudy: { use: 'Use for a customer example, project story, or before-and-after outcome.', avoid: 'Do not use without evidence for the named example and result.', repeatable: true },
  team: { use: 'Use to introduce people, roles, responsibilities, or leadership.', avoid: 'Do not use for anonymous operational content.', repeatable: true },
  quote: { use: 'Use for one attributed quotation or testimonial that supports the surrounding argument.', avoid: 'Do not use for unattributed or invented quotations.', repeatable: true },
  closing: { use: 'Use at the end for the conclusion, next step, or contact information.', avoid: 'Do not use in the middle of the presentation.', repeatable: false },
  appendix: { use: 'Use after the main narrative for supporting detail, references, or supplementary evidence.', avoid: 'Do not use for a required part of the main argument.', repeatable: true },
}

const ROLE_LABELS: Record<OfficeTemplateSlideRole, string> = {
  cover: 'Cover', agenda: 'Agenda', section: 'Section divider', narrative: 'Narrative', comparison: 'Comparison', metrics: 'Metrics', timeline: 'Timeline', process: 'Process', caseStudy: 'Case study', team: 'Team', quote: 'Quote', closing: 'Closing', appendix: 'Appendix',
}

const RECIPE_NAME_MAX_LENGTH = 200

function recipeName(slide: PresentationSnapshot['slides'][number], slideIndex: number): string {
  const normalized = slide.title.replace(/\s+/g, ' ').trim()
  if (!normalized) return `Slide ${slideIndex + 1}`
  if (normalized.length <= RECIPE_NAME_MAX_LENGTH) return normalized
  return `${normalized.slice(0, RECIPE_NAME_MAX_LENGTH - 3).trimEnd()}...`
}

function objectText(object: PresentationObject): string {
  if (object.kind === 'text') return object.runs.map((run) => run.text).join(' ')
  if (object.kind === 'shape') return object.text.map((run) => run.text).join(' ')
  if (object.kind === 'chart') return `${object.title} ${object.categories.join(' ')} ${object.series.map((series) => series.name).join(' ')}`
  if (object.kind === 'table') return object.rows.flatMap((row) => row.cells.flatMap((cell) => cell.runs.map((run) => run.text))).join(' ')
  return ''
}

function slideText(slide: PresentationSnapshot['slides'][number]): string {
  return `${slide.title} ${slide.objects.map(objectText).join(' ')}`.replace(/\s+/g, ' ').trim()
}

function classifySlide(slide: PresentationSnapshot['slides'][number], index: number, count: number): { role: OfficeTemplateSlideRole; confidence: number; inference: string } {
  const text = slideText(slide).toLowerCase()
  if (index === 0) return { role: 'cover', confidence: 0.78, inference: 'The first source slide is treated as the proposed cover.' }
  const keywordRoles: Array<{ role: OfficeTemplateSlideRole; pattern: RegExp }> = [
    { role: 'appendix', pattern: /\b(appendix|references?|supporting detail)\b/ },
    { role: 'agenda', pattern: /\b(agenda|table of contents|today('|’)s discussion|overview)\b/ },
    { role: 'comparison', pattern: /\b(compare|comparison|versus|vs\.?|before and after|pros and cons)\b/ },
    { role: 'metrics', pattern: /\b(metrics?|kpis?|results?|performance|growth|traction|financials?|numbers?)\b/ },
    { role: 'timeline', pattern: /\b(timeline|roadmap|milestones?|history|schedule)\b/ },
    { role: 'process', pattern: /\b(process|workflow|how it works|steps?|methodology|approach)\b/ },
    { role: 'caseStudy', pattern: /\b(case study|customer story|success story|before and after)\b/ },
    { role: 'team', pattern: /\b(team|leadership|founders?|people|who we are)\b/ },
    { role: 'quote', pattern: /\b(quote|testimonial|what .* say)\b/ },
    { role: 'closing', pattern: /\b(thank you|thanks|questions|contact us|get in touch|next steps?)\b/ },
    { role: 'section', pattern: /\b(section|chapter|part \d+)\b/ },
  ]
  const keyword = keywordRoles.find((candidate) => candidate.pattern.test(text))
  if (keyword) return { role: keyword.role, confidence: 0.9, inference: `Matched the source slide text to the ${ROLE_LABELS[keyword.role].toLowerCase()} purpose.` }
  if (index === count - 1) return { role: 'closing', confidence: 0.62, inference: 'The final source slide is treated as the proposed closing slide.' }
  const editableTextObjects = slide.objects.filter((object) => !object.locked && (object.kind === 'text' || object.kind === 'shape' && object.text.length > 0))
  if (editableTextObjects.length <= 1) return { role: 'section', confidence: 0.58, inference: 'The sparse source slide is proposed as a section divider.' }
  return { role: 'narrative', confidence: 0.52, inference: 'No specialized structure was detected, so this is proposed as a general narrative slide.' }
}

function fieldType(object: PresentationObject): OfficeTemplateField['type'] | null {
  if (object.kind === 'text' || object.kind === 'shape' && object.text.length > 0) return 'richText'
  if (object.kind === 'image') return 'image'
  if (object.kind === 'table') return 'table'
  if (object.kind === 'chart') return 'chartData'
  if (object.kind === 'video') return 'video'
  return null
}

function fieldLabel(object: PresentationObject, index: number): string {
  const text = objectText(object).replace(/\s+/g, ' ').trim()
  if (text) return text.length > 54 ? `${text.slice(0, 53).trim()}...` : text
  if (object.kind === 'image') return `Image ${index + 1}`
  if (object.kind === 'table') return `Table ${index + 1}`
  if (object.kind === 'chart') return `Chart ${index + 1}`
  if (object.kind === 'video') return `Video ${index + 1}`
  return `Content ${index + 1}`
}

function fieldInstruction(type: OfficeTemplateField['type']): string {
  if (type === 'image') return 'Choose one relevant image with permitted reuse rights and useful alternative text.'
  if (type === 'table') return 'Use a compact evidence-supported table that fits the existing rows and columns.'
  if (type === 'chartData') return 'Use evidence-supported categories and series that fit the existing chart structure.'
  if (type === 'video') return 'Use one relevant accessible video with a poster and captions or transcript.'
  return 'Write concise content for this exact visual region and preserve the intended hierarchy.'
}

function inferPresentationRouting(snapshot: PresentationSnapshot, source: OfficeTemplateRoutingDraft['source']): OfficeTemplateRoutingDraft {
  const fields: OfficeTemplateField[] = []
  const slideRecipes: OfficeTemplateSlideRecipe[] = snapshot.slides.map((slide, slideIndex) => {
    const classification = classifySlide(slide, slideIndex, snapshot.slides.length)
    const fieldIds: string[] = []
    let editableIndex = 0
    for (const object of slide.objects) {
      if (object.locked) continue
      const type = fieldType(object)
      if (!type) continue
      const fieldId = stableOfficeUuid(`${slide.id}:template-field:${object.id}`)
      fieldIds.push(fieldId)
      const nameRole = classification.role.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
      fields.push({
        id: fieldId,
        name: `${nameRole}.slide-${slideIndex + 1}.content-${editableIndex + 1}`,
        label: fieldLabel(object, editableIndex),
        type,
        required: editableIndex === 0 && (type === 'plainText' || type === 'richText'),
        repeating: false,
        minItems: 0,
        maxItems: 1,
        maxLength: presentationTextCapacity(object),
        targetIds: [object.id],
        aiInstruction: fieldInstruction(type),
        locked: false,
      })
      editableIndex += 1
    }
    const guidance = ROLE_GUIDANCE[classification.role]
    const repeatable = guidance.repeatable && fieldIds.length > 0
    return {
      id: stableOfficeUuid(`${slide.id}:slide-recipe`),
      slideId: slide.id,
      name: recipeName(slide, slideIndex),
      role: classification.role,
      whenToUse: guidance.use,
      whenNotToUse: guidance.avoid,
      enabled: fieldIds.length > 0,
      repeatable,
      minUses: 0,
      maxUses: repeatable ? 20 : 1,
      fieldIds,
      confidence: classification.confidence,
      inference: classification.inference,
      reviewed: false,
    }
  })
  return OfficeTemplateRoutingDraftSchema.parse({ source, fields, slideRecipes })
}

export function inferOfficeTemplateRouting(snapshot: OfficeArtifactSnapshot, source: OfficeTemplateRoutingDraft['source'] = 'scratch'): OfficeTemplateRoutingDraft {
  return snapshot.family === 'presentation' ? inferPresentationRouting(snapshot, source) : { source, fields: [], slideRecipes: [] }
}

export function officeTemplateRoutingDiagnostics(snapshot: OfficeArtifactSnapshot, input: unknown): string[] {
  const parsed = OfficeTemplateRoutingDraftSchema.safeParse(input)
  if (!parsed.success) return parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
  if (snapshot.family !== 'presentation') return parsed.data.slideRecipes.length === 0 ? [] : [`slideRecipes: ${snapshot.family === 'document' ? 'Document' : 'Spreadsheet'} templates cannot contain slide recipes`]
  const slideObjects = new Map(snapshot.slides.map((slide) => [slide.id, new Map(slide.objects.map((object) => [object.id, object]))]))
  const fields = new Map(parsed.data.fields.map((field) => [field.id, field]))
  const assigned = new Set<string>()
  const recipeSlides = new Set<string>()
  const diagnostics: string[] = []
  for (const [index, recipe] of parsed.data.slideRecipes.entries()) {
    const objects = slideObjects.get(recipe.slideId)
    if (!objects) diagnostics.push(`slideRecipes.${index}.slideId: Source slide is missing`)
    if (recipeSlides.has(recipe.slideId)) diagnostics.push(`slideRecipes.${index}.slideId: Source slide has more than one recipe`)
    recipeSlides.add(recipe.slideId)
    for (const fieldId of recipe.fieldIds) {
      const field = fields.get(fieldId)
      if (!field) diagnostics.push(`slideRecipes.${index}.fieldIds: Field ${fieldId} is missing`)
      if (assigned.has(fieldId)) diagnostics.push(`slideRecipes.${index}.fieldIds: Field ${fieldId} belongs to more than one recipe`)
      assigned.add(fieldId)
      if (field && objects && field.targetIds.some((targetId) => !objects.has(targetId))) diagnostics.push(`slideRecipes.${index}.fieldIds: Field ${fieldId} targets an object outside the source slide`)
      if (field && objects) {
        for (const targetId of field.targetIds) {
          const object = objects.get(targetId)
          const compatible = object && (
            (object.kind === 'text' || object.kind === 'shape' && object.text.length > 0) && ['plainText', 'richText', 'bulletList', 'date', 'number'].includes(field.type)
            || object.kind === 'image' && field.type === 'image'
            || object.kind === 'table' && field.type === 'table'
            || object.kind === 'chart' && field.type === 'chartData'
            || object.kind === 'video' && field.type === 'video'
          )
          if (!compatible) diagnostics.push(`fields.${field.id}.type: Field type ${field.type} is incompatible with target object ${targetId}`)
        }
      }
    }
  }
  for (const [index, slide] of snapshot.slides.entries()) {
    if (!recipeSlides.has(slide.id)) diagnostics.push(`slideRecipes: Source slide ${index + 1} has no recipe`)
  }
  for (const [index, field] of parsed.data.fields.entries()) {
    if (!assigned.has(field.id)) diagnostics.push(`fields.${index}.id: Field must belong to one slide recipe`)
  }
  return diagnostics
}
