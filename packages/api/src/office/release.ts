/** Exact-head Office review/release and safe derivative policy.
 * [COMP:api/office-release] */
import {
  exportOfficeDocument,
  exportOfficePresentation,
  exportOfficePresentationPdf,
  exportOfficeSpreadsheet,
  exportOfficeSpreadsheetPdf,
  preflightSpreadsheetPdf,
  reparseOfficeDocument,
  reparseOfficePresentation,
  reparseOfficeSpreadsheet,
  type SpreadsheetPdfReceipt,
  type SpreadsheetPdfRequest,
  type OfficeResourceResolver,
  type PresentationPdfPort,
  type PresentationPdfReceipt,
} from '@use-brian/core'
import {
  preflightOfficeCandidate,
  type OfficeArtifactSnapshot,
} from '@use-brian/office-model'
import type { BrandClaim } from '@use-brian/shared'
import { reviewBrandClaims } from './brand-claims.js'

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
  spreadsheetPdf?: SpreadsheetPdfReceipt
  presentationPdf?: PresentationPdfReceipt
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
  /**
   * The ACTIVE APPROVED brand record's claims register, when the workspace has
   * one. Distinct from `claims` above: those are provenance findings about
   * statements this artifact makes, these are standing decisions about what
   * the company may say at all. Absent (no brand, no `brand` capability, a
   * draft-only brand) → the brand check contributes nothing, which is the
   * state of every workspace that has not configured a brand.
   */
  brandClaims?: readonly BrandClaim[]
  media: readonly OfficeReleaseMedia[]
  acknowledgement?: OfficeReleaseAcknowledgement
  format?: 'native' | 'pdf'
  spreadsheetPdf?: SpreadsheetPdfRequest
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
  const spreadsheetPdf = params.snapshot.family === 'spreadsheet' && params.format === 'pdf' && params.spreadsheetPdf
    ? preflightSpreadsheetPdf(params.snapshot, params.spreadsheetPdf).receipt
    : undefined
  if (params.format === 'pdf' && params.snapshot.family === 'document') blocks.push({ code: 'format.pdf_unsupported', message: 'PDF release is not available for this artifact.' })
  if (params.snapshot.family === 'spreadsheet' && params.format === 'pdf' && !params.spreadsheetPdf) blocks.push({ code: 'format.pdf_request_required', message: 'Spreadsheet PDF release requires an explicit worksheet and print area.' })
  for (const issue of spreadsheetPdf?.issues ?? []) (issue.severity === 'error' ? blocks : warnings).push({ code: `spreadsheet.${issue.code}`, message: issue.message, subjectId: issue.address })
  for (const claim of params.claims) {
    if (claim.status === 'superseded' || claim.status === 'resolved') continue
    if (claim.classification === 'unsupported_conflicted' || claim.confidence < 0.7 || claim.severity === 'high') warnings.push({ code: `claim.${claim.id}.${claim.reasonCode}`, message: 'A weak, stale, unsupported, or conflicted claim needs review.', subjectId: claim.id })
  }
  if (params.brandClaims && params.brandClaims.length > 0) {
    const brand = reviewBrandClaims({ snapshot: params.snapshot, claims: params.brandClaims })
    blocks.push(...brand.blocks)
    warnings.push(...brand.warnings)
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
    spreadsheetPdf,
  }
}

export async function prepareOfficeRelease(params: Parameters<typeof reviewOfficeRelease>[0] & { resolveResource?: OfficeResourceResolver; presentationPdfPort?: PresentationPdfPort }): Promise<{ receipt: OfficeReleaseReceipt; bytes?: Uint8Array; mime?: string; extension?: 'docx' | 'pptx' | 'xlsx' | 'pdf' }> {
  const receipt = reviewOfficeRelease(params)
  if (receipt.status !== 'ready') return { receipt }
  const resolveResource = params.resolveResource ?? (async () => null)
  try {
    if (params.snapshot.family === 'spreadsheet' && params.format === 'pdf' && params.spreadsheetPdf) {
      const exportedPdf = await exportOfficeSpreadsheetPdf(params.snapshot, params.spreadsheetPdf, resolveResource)
      const spreadsheetPdf = exportedPdf.receipt
      if (!exportedPdf.bytes || spreadsheetPdf.issues.some((issue) => issue.severity === 'error')) {
        return { receipt: { ...receipt, status: 'blocked', spreadsheetPdf, blocks: [...receipt.blocks, ...spreadsheetPdf.issues.filter((issue) => issue.severity === 'error').map((issue) => ({ code: `spreadsheet.${issue.code}`, message: issue.message, subjectId: issue.address }))] } }
      }
      return { receipt: { ...receipt, spreadsheetPdf }, bytes: exportedPdf.bytes, mime: exportedPdf.mime, extension: 'pdf' }
    }
    if (params.snapshot.family === 'presentation' && params.format === 'pdf') {
      const exportedPdf = await exportOfficePresentationPdf(params.snapshot, resolveResource, params.presentationPdfPort)
      const presentationPdf = exportedPdf.receipt
      if (!exportedPdf.bytes || presentationPdf.issues.length) {
        return { receipt: { ...receipt, status: 'blocked', presentationPdf, blocks: [...receipt.blocks, ...presentationPdf.issues.map((issue) => ({ code: `presentation.${issue.code}`, message: issue.message }))] } }
      }
      return { receipt: { ...receipt, presentationPdf }, bytes: exportedPdf.bytes, mime: exportedPdf.mime, extension: 'pdf' }
    }
    const exported = params.snapshot.family === 'document'
      ? await exportOfficeDocument(params.snapshot, resolveResource)
      : params.snapshot.family === 'presentation'
        ? await exportOfficePresentation(params.snapshot, resolveResource)
        : await exportOfficeSpreadsheet(params.snapshot, resolveResource)
    const reopened = params.snapshot.family === 'document'
      ? await reparseOfficeDocument(exported.bytes)
      : params.snapshot.family === 'presentation'
        ? await reparseOfficePresentation(exported.bytes)
        : await reparseOfficeSpreadsheet(exported.bytes)
    return {
      receipt: { ...receipt, semanticHash: reopened.semanticHash, layoutSerialization: reopened.layoutSerialization },
      bytes: exported.bytes,
      mime: params.snapshot.family === 'document' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : params.snapshot.family === 'presentation' ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      extension: params.snapshot.family === 'document' ? 'docx' : params.snapshot.family === 'presentation' ? 'pptx' : 'xlsx',
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
  if (params.source.family === 'spreadsheet') {
    return {
      ...params.source,
      artifactId: params.artifactId,
      title: params.title,
      worksheets: selected ? params.source.worksheets.map((sheet) => ({ ...sheet, cells: sheet.cells.filter((cell) => selected.has(cell.id)) })).filter((sheet) => sheet.cells.length > 0) : params.source.worksheets,
    }
  }
  return {
    ...params.source,
    artifactId: params.artifactId,
    title: params.title,
    slides: selected ? params.source.slides.map((slide) => ({ ...slide, objects: slide.objects.filter((object) => selected.has(object.id)), readingOrder: slide.readingOrder.filter((id) => selected.has(id)) })).filter((slide) => slide.objects.length > 0) : params.source.slides,
  }
}
