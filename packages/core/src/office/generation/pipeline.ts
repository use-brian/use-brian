/** Durable-stage Office generation engine. [COMP:office/generation] */
import {
  assertOfficeArtifactSnapshot,
  preflightOfficeCandidate,
  type OfficeArtifactSnapshot,
  type OfficeTemplateBundle,
} from '@use-brian/office-model'
import { fitOfficeArtifact } from '@use-brian/office-renderer'
import { exportOfficeDocument, reparseOfficeDocument } from '../docx/index.js'
import { exportOfficePresentation, reparseOfficePresentation } from '../pptx/index.js'
import { officeSemanticHash, type OfficeResourceResolver } from '../package.js'
import { OfficeGenerationBriefSchema, type OfficeAuthorityProjection, type OfficeClaimPlanEntry, type OfficeEvidencePacket, type OfficeGenerationBrief, type OfficeGenerationEvent, type OfficeGenerationOutcome, type OfficeGenerationStage } from './contracts.js'

export type OfficeGenerationCheckpoint = {
  stage: OfficeGenerationStage
  version: number
  templateVersionId?: string
  snapshot?: OfficeArtifactSnapshot
  evidence?: OfficeEvidencePacket
  claims?: OfficeClaimPlanEntry[]
}

export type OfficeGenerationPipelineDeps = {
  resolveAuthority(brief: OfficeGenerationBrief): Promise<OfficeAuthorityProjection | null>
  selectTemplate(brief: OfficeGenerationBrief, authority: OfficeAuthorityProjection): Promise<{ template?: OfficeTemplateBundle; ambiguous?: string[] }>
  retrieveBrain(brief: OfficeGenerationBrief, authority: OfficeAuthorityProjection): Promise<OfficeEvidencePacket['brain']>
  inspectWebsite(url: string): Promise<OfficeEvidencePacket['website']>
  planClaims(brief: OfficeGenerationBrief, evidence: OfficeEvidencePacket, template: OfficeTemplateBundle): Promise<OfficeClaimPlanEntry[]>
  construct(brief: OfficeGenerationBrief, evidence: OfficeEvidencePacket, claims: OfficeClaimPlanEntry[], template: OfficeTemplateBundle): Promise<OfficeArtifactSnapshot>
  processMedia(snapshot: OfficeArtifactSnapshot, authority: OfficeAuthorityProjection): Promise<OfficeArtifactSnapshot>
  resolveResource: OfficeResourceResolver
  checkpoint(value: OfficeGenerationCheckpoint): Promise<void>
  emit(event: OfficeGenerationEvent): Promise<void>
  cancelled(): Promise<boolean>
  drainSteering(stage: OfficeGenerationStage): Promise<string[]>
  commit(snapshot: OfficeArtifactSnapshot, params: { authority: OfficeAuthorityProjection; templateVersionId: string; summary: string }): Promise<{ artifactId: string; version: number }>
}

async function stage(deps: OfficeGenerationPipelineDeps, checkpoint: OfficeGenerationCheckpoint, code: OfficeGenerationEvent['code'], params: OfficeGenerationEvent['params'] = {}): Promise<boolean> {
  if (await deps.cancelled()) {
    await deps.emit({ stage: 'cancelled', code: 'office.job.cancelled', params: {} })
    return false
  }
  const steering = await deps.drainSteering(checkpoint.stage)
  for (const instruction of steering) await deps.emit({ stage: checkpoint.stage, code: 'office.job.steering_applied', params: { instruction } })
  await deps.checkpoint(checkpoint)
  await deps.emit({ stage: checkpoint.stage, code, params })
  return true
}

export async function runOfficeGenerationPipeline(input: unknown, deps: OfficeGenerationPipelineDeps): Promise<OfficeGenerationOutcome> {
  const parsed = OfficeGenerationBriefSchema.safeParse(input)
  if (!parsed.success) {
    await deps.emit({ stage: 'failed', code: 'office.job.failed', params: { code: 'brief_invalid' } })
    return { status: 'failed', code: 'brief_invalid', message: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') }
  }
  const brief = parsed.data
  await deps.emit({ stage: 'queued', code: 'office.job.queued', params: { family: brief.family } })
  try {
    const authority = await deps.resolveAuthority(brief)
    if (!authority) return { status: 'failed', code: 'authority_denied', message: 'The acting user and assistant do not share authority for this request.' }
    if (!await stage(deps, { stage: 'queued', version: 1 }, 'office.job.authority_resolved', { sensitivity: authority.sensitivity })) return { status: 'cancelled' }

    const selected = await deps.selectTemplate(brief, authority)
    if (!selected.template) {
      await deps.emit({ stage: 'needs_input', code: 'office.job.needs_input', params: { reason: 'template_ambiguous' } })
      return { status: 'needs_input', code: 'template_ambiguous', question: selected.ambiguous?.length ? `Which template should I use: ${selected.ambiguous.join(', ')}?` : 'Which admitted template should I use?' }
    }
    const template = selected.template
    if (template.status !== 'admitted') return { status: 'failed', code: 'template_not_admitted', message: 'Generation requires an admitted immutable template version.' }
    if (!await stage(deps, { stage: 'template', version: 2, templateVersionId: template.id }, 'office.job.template_selected', { templateId: template.id, templateVersion: template.version })) return { status: 'cancelled' }

    if (!brief.canonicalWebsite && !brief.companyHasNoWebsite) {
      await deps.emit({ stage: 'needs_input', code: 'office.job.needs_input', params: { reason: 'website_required' } })
      return { status: 'needs_input', code: 'website_required', question: 'What is the company’s canonical public website, or should I proceed because the company has no website?' }
    }
    await deps.emit({ stage: 'grounding', code: 'office.job.grounding_started', params: {} })
    const [brain, website] = await Promise.all([
      deps.retrieveBrain(brief, authority),
      brief.canonicalWebsite ? deps.inspectWebsite(brief.canonicalWebsite) : Promise.resolve([]),
    ])
    const evidence: OfficeEvidencePacket = { brain, website, conflicts: [] }
    if (brief.canonicalWebsite) await deps.emit({ stage: 'grounding', code: 'office.job.website_inspected', params: { url: brief.canonicalWebsite } })
    if (!await stage(deps, { stage: 'grounding', version: 3, templateVersionId: template.id, evidence }, 'office.job.website_inspected', { sources: brain.length + website.length })) return { status: 'cancelled' }

    const claims = await deps.planClaims(brief, evidence, template)
    if (!await stage(deps, { stage: 'claim_plan', version: 4, templateVersionId: template.id, evidence, claims }, 'office.job.claim_plan_ready', { claims: claims.length })) return { status: 'cancelled' }
    let snapshot = assertOfficeArtifactSnapshot(await deps.construct(brief, evidence, claims, template))
    if (snapshot.family !== brief.family) return { status: 'failed', code: 'family_mismatch', message: 'The constructor returned the wrong Office artifact family.' }
    if (!await stage(deps, { stage: 'construct', version: 5, templateVersionId: template.id, snapshot, evidence, claims }, 'office.job.objects_constructed', {})) return { status: 'cancelled' }

    snapshot = assertOfficeArtifactSnapshot(await deps.processMedia(snapshot, authority))
    if (!await stage(deps, { stage: 'media', version: 6, templateVersionId: template.id, snapshot, evidence, claims }, 'office.job.media_processed', {})) return { status: 'cancelled' }
    const fit = fitOfficeArtifact(snapshot)
    if (!fit.ok) return { status: 'failed', code: 'fit_failed', message: fit.issues.map((issue) => `${issue.objectId}: ${issue.message}`).join('; ') }
    if (!await stage(deps, { stage: 'fit_render', version: 7, templateVersionId: template.id, snapshot, evidence, claims }, 'office.job.fit_validated', { pages: fit.result.pages.length })) return { status: 'cancelled' }
    const candidate = preflightOfficeCandidate(snapshot)
    if (!candidate.ok) return { status: 'failed', code: 'candidate_invalid', message: candidate.diagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join('; ') }
    if (!await stage(deps, { stage: 'validate', version: 8, templateVersionId: template.id, snapshot, evidence, claims }, 'office.job.candidate_validated', {})) return { status: 'cancelled' }

    const exported = snapshot.family === 'document' ? await exportOfficeDocument(snapshot, deps.resolveResource) : await exportOfficePresentation(snapshot, deps.resolveResource)
    const reopened = snapshot.family === 'document' ? await reparseOfficeDocument(exported.bytes) : await reparseOfficePresentation(exported.bytes)
    if (reopened.semanticHash !== officeSemanticHash(snapshot) || reopened.layoutSerialization !== fit.result.serialization) return { status: 'failed', code: 'export_reparse_mismatch', message: 'The generated Office file did not reopen to the validated semantic/layout identity.' }
    if (!await stage(deps, { stage: 'export_reparse', version: 9, templateVersionId: template.id, snapshot, evidence, claims }, 'office.job.export_reopened', { bytes: exported.bytes.byteLength })) return { status: 'cancelled' }
    const committed = await deps.commit(snapshot, { authority, templateVersionId: template.id, summary: brief.outcome })
    await deps.checkpoint({ stage: 'completed', version: 10, templateVersionId: template.id, snapshot, evidence, claims })
    await deps.emit({ stage: 'completed', code: 'office.job.completed', params: { artifactId: committed.artifactId, version: committed.version } })
    return { status: 'completed', artifactId: committed.artifactId, version: committed.version, exportBytes: exported.bytes, semanticHash: exported.semanticHash }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Office generation failed'
    await deps.emit({ stage: 'failed', code: 'office.job.failed', params: { code: 'pipeline_failed' } })
    return { status: 'failed', code: 'pipeline_failed', message }
  }
}
