/** One compiler for upload, scratch, and promote-version template paths.
 * [COMP:office/template-compiler] */
import { createHash } from 'node:crypto'
import {
  OfficeTemplateBundleSchema,
  officeCapabilityManifest,
  preflightOfficeCandidate,
  validateOfficeCapabilityManifest,
  type OfficeArtifactSnapshot,
  type OfficePreflightDiagnostic,
  type OfficeTemplateBundle,
} from '@use-brian/office-model'
import { fitOfficeArtifact, officeGoldenSerialization, type OfficeFitBudget } from '@use-brian/office-renderer'
import { exportOfficeDocument, reparseOfficeDocument } from '../docx/index.js'
import { exportOfficePresentation, reparseOfficePresentation } from '../pptx/index.js'
import { officeSemanticHash, type OfficeResourcePayload, type OfficeResourceResolver } from '../package.js'

export type OfficeTemplateAuthoringPath = 'upload' | 'scratch' | 'promote_version'

export type OfficeTemplateResourceAdmission = OfficeResourcePayload & {
  id: string
  hash: string
  licence: { name: string; url?: string; attribution?: string }
  embeddingRights: 'allowed' | 'subset_only' | 'prohibited' | 'unknown'
}

export type OfficeTemplateAdmissionReceipt = {
  ok: boolean
  authoringPath: OfficeTemplateAuthoringPath
  capabilityVersion: number
  semanticHash?: string
  exportHash?: string
  layoutSerialization?: string
  previewGolden?: string
  diagnostics: OfficePreflightDiagnostic[]
}

export type CompiledOfficeTemplate = {
  bundle?: OfficeTemplateBundle
  receipt: OfficeTemplateAdmissionReceipt
}

const runtimeCapabilityIds = new Set(
  officeCapabilityManifest.capabilities
    .filter((capability) => capability.disposition === 'editable')
    .map((capability) => capability.id),
)

/** Structural feature-enablement gate used by template admission and, later,
 * tool/UI registration. It is deliberately independent of prompts/flags. */
export function officeAdmissionBarrierDiagnostics(family: OfficeArtifactSnapshot['family']): OfficePreflightDiagnostic[] {
  const diagnostics: OfficePreflightDiagnostic[] = validateOfficeCapabilityManifest().map((message) => ({ severity: 'error', code: 'capability.manifest_invalid', path: '', message }))
  for (const capability of officeCapabilityManifest.capabilities) {
    if (capability.disposition !== 'editable' || capability.family !== 'shared' && capability.family !== family) continue
    if (!runtimeCapabilityIds.has(capability.id)) diagnostics.push({ severity: 'error', code: 'capability.runtime_missing', path: capability.id, capabilityId: capability.id, message: `No complete runtime slice is registered for ${capability.id}` })
    const implementation = capability.implementation
    if (!implementation || Object.values(implementation).some((entry) => entry.length === 0)) diagnostics.push({ severity: 'error', code: 'capability.implementation_missing', path: capability.id, capabilityId: capability.id, message: `Capability ${capability.id} is not complete across model/editor/render/import/export/reparse/accessibility/offline` })
  }
  return diagnostics
}

export function canEnableOfficeCreation(family: OfficeArtifactSnapshot['family']): boolean {
  return officeAdmissionBarrierDiagnostics(family).length === 0
}

function collectIds(value: unknown, target = new Set<string>()): Set<string> {
  if (!value || typeof value !== 'object') return target
  if (!Array.isArray(value) && typeof (value as Record<string, unknown>).id === 'string') target.add((value as { id: string }).id)
  for (const child of Object.values(value)) collectIds(child, target)
  return target
}

function fitBudget(bundle: OfficeTemplateBundle): OfficeFitBudget {
  const maxTextCharsByObject: Record<string, number> = {}
  for (const field of bundle.fields) {
    if (field.maxLength === undefined) continue
    for (const targetId of field.targetIds) maxTextCharsByObject[targetId] = field.maxLength
  }
  return {
    maxTextCharsByObject,
    minimumFontSizePt: 8,
  }
}

function resourceDiagnostics(bundle: OfficeTemplateBundle, resources: readonly OfficeTemplateResourceAdmission[]): OfficePreflightDiagnostic[] {
  const diagnostics: OfficePreflightDiagnostic[] = []
  const byId = new Map(resources.map((resource) => [resource.id, resource]))
  for (const ref of bundle.resources) {
    const resource = byId.get(ref.id)
    if (!resource) {
      diagnostics.push({ severity: 'error', code: 'template.resource_missing', path: `resources.${ref.id}`, message: `Template resource ${ref.id} has no immutable payload` })
      continue
    }
    const digest = createHash('sha256').update(resource.bytes).digest('hex')
    if (digest !== ref.hash || resource.hash !== ref.hash) diagnostics.push({ severity: 'error', code: 'template.resource_hash_mismatch', path: `resources.${ref.id}`, message: `Template resource ${ref.id} does not match its content hash` })
    if (resource.mime !== ref.mime) diagnostics.push({ severity: 'error', code: 'template.resource_mime_mismatch', path: `resources.${ref.id}`, message: `Template resource ${ref.id} MIME does not match its admitted metadata` })
    if (!resource.licence.name.trim()) diagnostics.push({ severity: 'error', code: 'template.resource_licence_missing', path: `resources.${ref.id}`, message: `Template resource ${ref.id} needs explicit licence metadata` })
    if (ref.kind === 'font' && (resource.embeddingRights === 'prohibited' || resource.embeddingRights === 'unknown')) diagnostics.push({ severity: 'error', code: 'template.font_embedding_blocked', path: `resources.${ref.id}`, message: `Font ${ref.id} is not admitted for server/browser/export embedding` })
  }
  return diagnostics
}

export async function compileOfficeTemplate(params: {
  authoringPath: OfficeTemplateAuthoringPath
  draft: unknown
  resources: readonly OfficeTemplateResourceAdmission[]
}): Promise<CompiledOfficeTemplate> {
  const parsed = OfficeTemplateBundleSchema.safeParse(params.draft)
  if (!parsed.success) {
    return { receipt: { ok: false, authoringPath: params.authoringPath, capabilityVersion: officeCapabilityManifest.version, diagnostics: parsed.error.issues.map((issue) => ({ severity: 'error', code: 'template.invalid', path: issue.path.join('.'), message: issue.message })) } }
  }
  const draft = parsed.data
  const diagnostics: OfficePreflightDiagnostic[] = []
  if (draft.status !== 'draft') diagnostics.push({ severity: 'error', code: 'template.not_draft', path: 'status', message: 'Only a draft can enter template admission' })
  diagnostics.push(...officeAdmissionBarrierDiagnostics(draft.family))
  diagnostics.push(...preflightOfficeCandidate(draft.snapshot).diagnostics)
  diagnostics.push(...resourceDiagnostics(draft, params.resources))

  const ids = collectIds(draft.snapshot)
  for (const [index, field] of draft.fields.entries()) {
    for (const targetId of field.targetIds) if (!ids.has(targetId)) diagnostics.push({ severity: 'error', code: 'template.field_target_missing', path: `fields.${index}.targetIds`, message: `Field ${field.name} targets missing object ${targetId}` })
  }
  for (const targetId of [...draft.lockedObjectIds, ...draft.allowedRepeatTargetIds]) if (!ids.has(targetId)) diagnostics.push({ severity: 'error', code: 'template.rule_target_missing', path: targetId, message: `Template rule targets missing object ${targetId}` })

  const fit = fitOfficeArtifact(draft.snapshot, fitBudget(draft))
  diagnostics.push(...fit.issues.map((issue) => ({ severity: 'error' as const, code: `layout.${issue.code}`, path: issue.objectId, message: issue.message })))
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return { receipt: { ok: false, authoringPath: params.authoringPath, capabilityVersion: officeCapabilityManifest.version, diagnostics } }

  const resources = new Map(params.resources.map((resource) => [resource.id, resource]))
  const resolveResource: OfficeResourceResolver = async (resourceId) => resources.get(resourceId) ?? null
  try {
    let exported: Awaited<ReturnType<typeof exportOfficeDocument>>
    let reparsed: Awaited<ReturnType<typeof reparseOfficeDocument>> | Awaited<ReturnType<typeof reparseOfficePresentation>>
    const snapshot = draft.snapshot
    if (snapshot.family === 'document') {
      exported = await exportOfficeDocument(snapshot, resolveResource)
      reparsed = await reparseOfficeDocument(exported.bytes)
    } else {
      exported = await exportOfficePresentation(snapshot, resolveResource)
      reparsed = await reparseOfficePresentation(exported.bytes)
    }
    if (reparsed.semanticHash !== officeSemanticHash(draft.snapshot)) diagnostics.push({ severity: 'error', code: 'template.reparse_mismatch', path: 'snapshot', message: 'Exported template does not reopen to the admitted canonical snapshot' })
    if (reparsed.layoutSerialization !== fit.result.serialization) diagnostics.push({ severity: 'error', code: 'template.layout_mismatch', path: 'snapshot', message: 'Reopened template layout does not match the admitted display list' })
    const ok = diagnostics.every((diagnostic) => diagnostic.severity !== 'error')
    return {
      bundle: ok ? { ...draft, status: 'admitted' } : undefined,
      receipt: {
        ok,
        authoringPath: params.authoringPath,
        capabilityVersion: officeCapabilityManifest.version,
        semanticHash: officeSemanticHash(draft.snapshot),
        exportHash: createHash('sha256').update(exported.bytes).digest('hex'),
        layoutSerialization: fit.result.serialization,
        previewGolden: officeGoldenSerialization(draft.snapshot),
        diagnostics,
      },
    }
  } catch (cause) {
    diagnostics.push({ severity: 'error', code: 'template.export_failed', path: 'snapshot', message: cause instanceof Error ? cause.message : 'Template export/reopen failed' })
    return { receipt: { ok: false, authoringPath: params.authoringPath, capabilityVersion: officeCapabilityManifest.version, diagnostics } }
  }
}
