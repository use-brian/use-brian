/** Exact-head Office review/release and safe derivative policy.
 * [COMP:api/office-release] */
import {
  exportOfficeDocument,
  exportOfficePresentation,
  reparseOfficeDocument,
  reparseOfficePresentation,
  type OfficeResourceResolver,
} from '@use-brian/core'
import {
  preflightOfficeCandidate,
  type OfficeArtifactSnapshot,
} from '@use-brian/office-model'

export type OfficeReleaseAction = 'export' | 'share' | 'present' | 'send' | 'publish' | 'derivative'
export type OfficeReleaseClaim = { id: string; classification: string; confidence: number; severity: string; reasonCode: string; status: string }
export type OfficeReleaseMedia = { id: string; provenanceState: string; disclosureRequired: boolean }
export type OfficeReleaseDestination = {
  sensitivity: 'public' | 'internal' | 'confidential'
  external: boolean
  disclosureSatisfied?: boolean
}
export type OfficeReleaseAcknowledgement = { version: number; action: OfficeReleaseAction; codes: string[] }
export type OfficeReleaseIssue = { code: string; message: string; subjectId?: string }
export type OfficeReleaseReceipt = {
  status: 'blocked' | 'needs_ack' | 'ready'
  version: number
  action: OfficeReleaseAction
  blocks: OfficeReleaseIssue[]
  warnings: OfficeReleaseIssue[]
  acknowledgedCodes: string[]
  semanticHash?: string
  layoutSerialization?: string
}

const RANK = { public: 0, internal: 1, confidential: 2 } as const

export function reviewOfficeRelease(params: {
  snapshot: OfficeArtifactSnapshot
  expectedVersion: number
  currentVersion: number
  headVersionId: string | null
  lifecycleState: string
  canEdit: boolean
  artifactSensitivity: 'public' | 'internal' | 'confidential'
  action: OfficeReleaseAction
  destination: OfficeReleaseDestination
  claims: readonly OfficeReleaseClaim[]
  media: readonly OfficeReleaseMedia[]
  acknowledgement?: OfficeReleaseAcknowledgement
}): OfficeReleaseReceipt {
  const blocks: OfficeReleaseIssue[] = []
  const warnings: OfficeReleaseIssue[] = []
  if (!params.canEdit) blocks.push({ code: 'access.edit_required', message: 'Edit access is required to release this artifact.' })
  if (params.lifecycleState !== 'active') blocks.push({ code: 'lifecycle.not_active', message: 'Restore or unarchive the artifact before release.' })
  if (params.expectedVersion !== params.currentVersion) blocks.push({ code: 'version.head_changed', message: 'The artifact changed. Review the current head before releasing.' })
  if (!params.headVersionId) blocks.push({ code: 'version.checkpoint_required', message: 'Create a durable checkpoint before release.' })
  if (RANK[params.destination.sensitivity] < RANK[params.artifactSensitivity]) blocks.push({ code: 'access.derivative_required', message: 'A separately reviewed derivative is required for this broader destination.' })
  const preflight = preflightOfficeCandidate(params.snapshot)
  for (const diagnostic of preflight.diagnostics.filter((item) => item.severity === 'error')) blocks.push({ code: `capability.${diagnostic.code}`, message: diagnostic.message, subjectId: diagnostic.path })
  for (const claim of params.claims) {
    if (claim.status === 'superseded' || claim.status === 'resolved') continue
    if (claim.classification === 'unsupported_conflicted' || claim.confidence < 0.7 || claim.severity === 'high') warnings.push({ code: `claim.${claim.id}.${claim.reasonCode}`, message: 'A weak, stale, unsupported, or conflicted claim needs review.', subjectId: claim.id })
  }
  for (const media of params.media) {
    // A caller-supplied destination flag is not proof that disclosure exists
    // in the exported artifact. Until the media ledger is regenerated with
    // the requirement resolved, this remains a hard barrier.
    if (media.disclosureRequired) blocks.push({ code: `media.${media.id}.disclosure_required`, message: 'Required attribution or AI disclosure has no validated destination location.', subjectId: media.id })
    if (['commercial_or_permission_required', 'rights_unverified', 'source_unavailable'].includes(media.provenanceState)) warnings.push({ code: `media.${media.id}.${media.provenanceState}`, message: 'Media rights are uncertain and need review.', subjectId: media.id })
  }
  const acknowledgement = params.acknowledgement
  const acknowledgedCodes = acknowledgement && acknowledgement.version === params.currentVersion && acknowledgement.action === params.action ? [...new Set(acknowledgement.codes)] : []
  const outstandingWarnings = warnings.filter((warning) => !acknowledgedCodes.includes(warning.code))
  return {
    status: blocks.length ? 'blocked' : outstandingWarnings.length ? 'needs_ack' : 'ready',
    version: params.currentVersion,
    action: params.action,
    blocks,
    warnings,
    acknowledgedCodes,
  }
}

export async function prepareOfficeRelease(params: Parameters<typeof reviewOfficeRelease>[0] & { resolveResource?: OfficeResourceResolver }): Promise<{ receipt: OfficeReleaseReceipt; bytes?: Uint8Array; mime?: string; extension?: 'docx' | 'pptx' }> {
  const receipt = reviewOfficeRelease(params)
  if (receipt.status !== 'ready') return { receipt }
  const resolveResource = params.resolveResource ?? (async () => null)
  try {
    const exported = params.snapshot.family === 'document'
      ? await exportOfficeDocument(params.snapshot, resolveResource)
      : await exportOfficePresentation(params.snapshot, resolveResource)
    const reopened = params.snapshot.family === 'document'
      ? await reparseOfficeDocument(exported.bytes)
      : await reparseOfficePresentation(exported.bytes)
    return {
      receipt: { ...receipt, semanticHash: reopened.semanticHash, layoutSerialization: reopened.layoutSerialization },
      bytes: exported.bytes,
      mime: params.snapshot.family === 'document' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      extension: params.snapshot.family === 'document' ? 'docx' : 'pptx',
    }
  } catch (cause) {
    return { receipt: { ...receipt, status: 'blocked', blocks: [...receipt.blocks, { code: 'export.reparse_failed', message: cause instanceof Error ? cause.message : 'Export or reparse validation failed.' }] } }
  }
}

export function deriveOfficeSnapshot(params: { source: OfficeArtifactSnapshot; artifactId: string; title: string; selectedObjectIds?: string[] }): OfficeArtifactSnapshot {
  const selected = params.selectedObjectIds ? new Set(params.selectedObjectIds) : null
  if (params.source.family === 'document') {
    return {
      ...params.source,
      artifactId: params.artifactId,
      title: params.title,
      sections: selected ? params.source.sections.map((section) => ({ ...section, nodes: section.nodes.filter((node) => selected.has(node.id)) })).filter((section) => section.nodes.length > 0) : params.source.sections,
    }
  }
  return {
    ...params.source,
    artifactId: params.artifactId,
    title: params.title,
    slides: selected ? params.source.slides.map((slide) => ({ ...slide, objects: slide.objects.filter((object) => selected.has(object.id)), readingOrder: slide.readingOrder.filter((id) => selected.has(id)) })).filter((slide) => slide.objects.length > 0) : params.source.slides,
  }
}
