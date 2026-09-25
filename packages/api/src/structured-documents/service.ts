import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { FilesApi, FilesContext, WorkspaceFile, ScopeEvidence } from '@use-brian/core'
import type { OfficeCommand } from '@use-brian/office-model'
import type { OfficeArtifactRow } from '../db/office-artifacts.js'
import type { OfficeLiveSnapshot } from '../db/office-live.js'
import type { ResolvedOfficeAccess } from '../office/access.js'
import type { StructuredExtractionJob, StructuredExtractionStore } from '../db/structured-document-extractions.js'
import type { createStructuredFillProposalStore } from '../db/structured-fill-proposals.js'
import { FillMappingSchema, prepareStructuredFill, type FillMapping } from '../office/structured-fill.js'
import { ConnectorBindingSchema, type StructuredOcrConnectorResolver } from './connector.js'
import { StructuredOcrError } from './client.js'
import { parseSourceRecords } from './records.js'
import { storageKeyForWorkspaceFile } from '../files/local-directory-import.js'

const uuid = z.string().uuid()
const grant = z.array(z.string().min(1).max(512)).max(10_000).nullable()
export const SavedPrincipalSchema = z.object({
  userId: uuid, workspaceId: uuid, assistantId: uuid,
  assistantKind: z.enum(['primary', 'standard', 'app']),
  clearance: z.enum(['public', 'internal', 'confidential']),
  compartments: grant, projectIds: grant,
}).strict()
type Principal = z.infer<typeof SavedPrincipalSchema>
const savedContextSchema = z.object({ principal: SavedPrincipalSchema, sourceVersion: z.string().regex(/^[a-f0-9]{64}$/), connector: ConnectorBindingSchema.optional() }).strict()
export const PrepareExtractionSchema = z.object({ fileId: uuid, connectorInstanceId: uuid }).strict()
export const StartExtractionSchema = z.object({ extractionId: uuid }).strict()
export const ReadExtractionSchema = z.object({
  extractionId: uuid, view: z.enum(['summary', 'records', 'entities', 'context']).optional(),
  offset: z.number().int().safe().min(0).max(100_000).optional(),
  limit: z.number().int().min(1).max(50).optional(),
}).strict()
export const ProposeEvidenceFillSchema = z.object({
  extractionId: uuid, artifactId: uuid, expectedVersion: z.number().int().safe().nonnegative(),
  mappings: z.array(FillMappingSchema).min(1).max(100),
}).strict()
const rank = { public: 0, internal: 1, confidential: 2 }
const MiB = 1024 * 1024
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const unique = (values: string[]) => [...new Set(values)].sort()
const safeMessages = {
  invalid_context: 'A workspace assistant with explicit current clearance and Team/Project grants is required.',
  access_denied: 'This extraction or evidence is unavailable under your current workspace, assistant or source permissions.',
  source_changed: 'The source file or its scope changed. Prepare a new extraction.',
  invalid_pdf: 'Choose an active workspace-shared PDF with a PDF signature, at most 15 MiB.',
  private_source: 'This first release supports workspace-shared files only, not user- or assistant-partitioned files.',
  unavailable: 'The selected extraction connector is unavailable or incompatible. Ask your administrator to check it.',
  invalid_request: 'Use valid extraction/file IDs and bounded source-reference-only mappings.',
  connector_required: 'Connector approval is missing or changed. Prepare a new extraction preflight.',
  connector_limit_exceeded: 'More than 100 extraction connectors are available. Ask an administrator to narrow access.',
  connector_health_approval_required: 'OCR preflight requires ocr_capabilities to be Allow in the applicable connector policies. For a workspace-owned connector, check the workspace policy; for a shared personal connector, check the connector owner\'s application policy and this assistant\'s policy. Approving one MCP call is not persistent permission. Ask an authorized administrator to change the policy, then retry preflight. OCR has not started.',
  connector_policy_blocked: 'A required OCR connector tool is blocked by the applicable connector policies. Review ocr_capabilities, ocr_start, ocr_status, ocr_records and ocr_source_page with an authorized administrator before retrying. No policy was changed or bypassed.',
  connector_unavailable: 'The selected OCR connector could not be authorized or its credentials could not be loaded. Check its connection, bearer authentication, workspace exposure, Team/Project restrictions and assistant enablement, then retry preflight.',
  connector_configuration_invalid: 'The registered OCR connector configuration is unsupported. Use an HTTP(S) URL ending exactly in /mcp, without a trailing slash, embedded credentials, query or fragment, and a valid bearer token. Update it in Studio and prepare a new extraction.',
  connector_changed: 'The OCR connector endpoint, credentials or policies changed since preflight. Prepare a new extraction; the previous approval cannot authorize the changed connection.',
  source_storage_unavailable: 'The PDF storage could not be read during preflight. Check Brian file-storage availability and retry preflight using the existing durable file. No PDF was uploaded to OCR.',
  extraction_schema_missing: 'The extraction queue schema is unavailable or incompatible. Ask the operator to verify migration 557_structured_document_extractions.sql through Brian\'s normal migration runner, then retry preflight. No OCR was started; do not recreate tables manually.',
  extraction_store_unavailable: 'The extraction preflight could not be saved to Brian\'s queue. Ask the operator to check database availability and permissions, then retry preflight with the existing file. No OCR was started.',
  restart_required: 'This extraction failed or was cancelled. Prepare a new extraction; do not resubmit this job.',
  not_complete: 'Extraction is not complete. Read its status before requesting evidence or a proposal.',
  archive_changed: 'Durable evidence is missing, changed or incomplete. Prepare a new extraction.',
  result_too_large: 'The complete requested result exceeds the display budget. Request fewer items; oversized individual observations require a smaller source PDF.',
  destination_denied: 'Use an active, accessible spreadsheet in this workspace with compatible sensitivity, Team and Project restrictions.',
  stale_destination: 'The spreadsheet changed. Read its current version and selected cells, then propose again.',
  unsafe_mapping: 'The mapping cannot be copied safely. Review ambiguous evidence, precision, source/target duplicates, and unlocked non-formula cells in the active worksheet.',
  proposal_conflict: 'The proposal could not be saved against the current spreadsheet. Refresh the version and retry.',
  operation_failed: 'The operation could not be completed safely. Retry after checking source access and extraction status.',
} as const
export class StructuredDocumentServiceError extends Error {
  constructor(public readonly code: keyof typeof safeMessages) { super(safeMessages[code]); this.name = 'StructuredDocumentServiceError' }
}
function reject(code: keyof typeof safeMessages): never { throw new StructuredDocumentServiceError(code) }
function parsed<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input)
  if (!result.success) reject('invalid_request')
  return result.data
}
function principal(ctx: FilesContext): Principal {
  // Presence is authority: missing/undefined is NOT the universe grant.
  if (!Object.hasOwn(ctx, 'compartments') || !Object.hasOwn(ctx, 'projectIds')) reject('invalid_context')
  const result = SavedPrincipalSchema.safeParse({
    userId: ctx.userId, workspaceId: ctx.workspaceId, assistantId: ctx.assistantId,
    assistantKind: ctx.assistantKind ?? 'standard', clearance: ctx.clearance,
    compartments: ctx.compartments, projectIds: ctx.projectIds,
  })
  if (!result.success) reject('invalid_context')
  return result.data
}
function sameActor(a: Principal, b: Principal) {
  if (a.userId !== b.userId || a.workspaceId !== b.workspaceId || a.assistantId !== b.assistantId || a.assistantKind !== b.assistantKind) reject('access_denied')
}
function intersection(a: string[] | null, b: string[] | null) {
  return a === null ? b === null ? null : unique(b) : b === null ? unique(a) : unique(a.filter(v => b.includes(v)))
}
function intersect(a: Principal, b: Principal): Principal {
  sameActor(a, b)
  return { ...a, clearance: rank[a.clearance] <= rank[b.clearance] ? a.clearance : b.clearance,
    compartments: intersection(a.compartments, b.compartments), projectIds: intersection(a.projectIds, b.projectIds) }
}
const contains = (grant: string[] | null, required: string[]) => grant === null || required.every(v => grant.includes(v))
function requirements(file: WorkspaceFile): Required<ScopeEvidence> {
  if (!Object.hasOwn(rank, file.sensitivity) || !Array.isArray(file.compartments ?? []) || !Array.isArray(file.projectIds ?? [])) reject('access_denied')
  return { sensitivity: file.sensitivity, compartments: unique(file.compartments ?? []), projectIds: unique(file.projectIds ?? []) }
}
function highWater(rows: WorkspaceFile[]): Required<ScopeEvidence> {
  const values = rows.map(requirements)
  return { sensitivity: values.reduce<Required<ScopeEvidence>['sensitivity']>((a, b) => rank[a] >= rank[b.sensitivity] ? a : b.sensitivity, 'public'),
    compartments: unique(values.flatMap(v => v.compartments)), projectIds: unique(values.flatMap(v => v.projectIds)) }
}
function eligible(file: WorkspaceFile, ctx: Principal, id: string) {
  const scope = requirements(file)
  if (file.id !== id || file.workspaceId !== ctx.workspaceId || file.validTo !== null || file.retractedAt !== null || file.supersededBy !== null ||
      rank[file.sensitivity] > rank[ctx.clearance] || !contains(ctx.compartments, scope.compartments) || !contains(ctx.projectIds, scope.projectIds)) reject('access_denied')
  if (file.userId !== null || file.assistantId !== null) reject('private_source')
}
function sourceVersion(file: WorkspaceFile) {
  const iso = (date: Date) => { if (!(date instanceof Date) || !Number.isFinite(date.getTime())) reject('source_changed'); return date.toISOString() }
  // updatedAt also advances for indexing/embedding metadata, not just source changes.
  // Version the hash payload: legacy snapshots must mismatch and require fresh prepare.
  return hash(JSON.stringify({ fingerprintVersion: 2, id: file.id, workspaceId: file.workspaceId,
    storageUri: file.storageUri, storageKey: storageKeyForWorkspaceFile(file), mime: file.mime,
    sizeBytes: file.sizeBytes, validFrom: iso(file.validFrom), scope: requirements(file) }))
}
function displayBound<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 64 * 1024) reject('result_too_large')
  return value
}
function manifest(job: StructuredExtractionJob) {
  return { extractionId: job.id, sourceFileId: job.sourceFileId, pdfSha256: job.pdfSha256,
    recordsFileId: job.recordsFileId, recordsSha256: job.recordsSha256, documentId: job.documentId,
    schemaVersion: '1.1' as const, imageFiles: [...job.imageFiles].sort((a, b) => a.page - b.page) }
}
function stableCommandId(seed: string) {
  const hex = hash(`structured-evidence-command:${seed}`)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
function stableCommand(command: OfficeCommand, seed: string): OfficeCommand {
  return { ...command, commandId: stableCommandId(seed), ...(command.kind === 'batch' ? {
    commands: command.commands.map((c, i) => stableCommand(c, `${seed}:${i}`)),
  } : {}) } as OfficeCommand
}
export type StructuredDocumentServiceOptions = {
  files: FilesApi
  store: StructuredExtractionStore
  connectors: StructuredOcrConnectorResolver
  resolveContext(saved: FilesContext): Promise<FilesContext>
  getOffice(userId: string, artifactId: string): Promise<{ artifact: OfficeArtifactRow; access: ResolvedOfficeAccess; live: OfficeLiveSnapshot } | null>
  saveProposal: ReturnType<typeof createStructuredFillProposalStore>['save']
}

export function createStructuredDocumentService(options: StructuredDocumentServiceOptions) {
  const { files, store } = options
  async function fresh(saved: Principal) {
    try { return intersect(saved, principal(await options.resolveContext(structuredClone(saved)))) }
    catch (error) { if (error instanceof StructuredDocumentServiceError) throw error; reject('access_denied') }
  }
  async function source(ctx: Principal, fileId: string) {
    const stat = await files.stat(ctx, fileId)
    if (!stat.ok) reject('access_denied')
    eligible(stat.value, ctx, fileId)
    if (stat.value.mime !== 'application/pdf' || !Number.isSafeInteger(stat.value.sizeBytes) || stat.value.sizeBytes < 5 || stat.value.sizeBytes > 15 * MiB) reject('invalid_pdf')
    const read = await files.readBytes(ctx, fileId)
    if (!read.ok) reject('access_denied')
    eligible(read.value.file, ctx, fileId)
    if (sourceVersion(stat.value) !== sourceVersion(read.value.file)) reject('source_changed')
    const { file, bytes } = read.value
    if (bytes.length !== file.sizeBytes || bytes.length > 15 * MiB || Buffer.from(bytes.subarray(0, 5)).toString() !== '%PDF-') reject('invalid_pdf')
    return { file, pdfSha256: hash(bytes), sourceVersion: sourceVersion(file) }
  }
  function savedContext(job: StructuredExtractionJob) {
    const result = savedContextSchema.safeParse(job.context)
    if (!result.success || result.data.principal.userId !== job.userId || result.data.principal.workspaceId !== job.workspaceId) reject('access_denied')
    return result.data
  }
  async function authorizeSource(job: StructuredExtractionJob, current?: Principal) {
    const saved = savedContext(job)
    if (current) sameActor(saved.principal, current)
    let ctx = await fresh(saved.principal)
    if (current) ctx = intersect(ctx, current)
    const original = await source(ctx, job.sourceFileId)
    if (original.pdfSha256 !== job.pdfSha256 || original.sourceVersion !== saved.sourceVersion) reject('source_changed')
    return { context: ctx, source: original.file }
  }
  async function load(ctx: FilesContext, extractionId: string) {
    const current = principal(ctx)
    parsed(uuid, extractionId)
    const job = await store.get(current.userId, extractionId)
    if (!job || job.id !== extractionId || job.userId !== current.userId || job.workspaceId !== current.workspaceId) reject('access_denied')
    return { job, ...await authorizeSource(job, current) }
  }
  async function completeEvidence(loaded: Awaited<ReturnType<typeof load>>) {
    const { job, context, source: original } = loaded
    if (job.status !== 'completed') reject('not_complete')
    if (!job.recordsFileId || !job.recordsSha256 || !job.documentId) reject('archive_changed')
    const rows = [original]
    let total = 0
    async function archive(id: string, sha256: string, limit: number, mime: string, size?: number) {
      if (!z.string().regex(/^[a-f0-9]{64}$/).safeParse(sha256).success) reject('archive_changed')
      const stat = await files.stat(context, id)
      if (!stat.ok) reject('archive_changed')
      eligible(stat.value, context, id)
      if (stat.value.mime !== mime || !Number.isSafeInteger(stat.value.sizeBytes) || stat.value.sizeBytes < 1 || stat.value.sizeBytes > limit) reject('archive_changed')
      const read = await files.readBytes(context, id)
      if (!read.ok) reject('archive_changed')
      const file = read.value.file
      eligible(file, context, id)
      if (sourceVersion(file) !== sourceVersion(stat.value)) reject('archive_changed')
      const scope = requirements(file), originalScope = requirements(original)
      if (rank[scope.sensitivity] < rank[originalScope.sensitivity] || !contains(scope.compartments, originalScope.compartments) || !contains(scope.projectIds, originalScope.projectIds)) reject('archive_changed')
      const bytes = read.value.bytes
      total += bytes.length
      if (total > 128 * MiB || bytes.length > limit || bytes.length !== file.sizeBytes || (size !== undefined && size !== bytes.length) || hash(bytes) !== sha256) reject('archive_changed')
      rows.push(file)
      return bytes
    }
    const raw = await archive(job.recordsFileId, job.recordsSha256, 16 * MiB, 'application/json')
    let records: ReturnType<typeof parseSourceRecords>
    try { records = parseSourceRecords(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))) }
    catch { reject('archive_changed') }
    const pages = records.document.pages.map(p => p.page).sort((a, b) => a - b)
    if (records.document.id !== job.documentId || JSON.stringify([...job.pageNumbers].sort((a, b) => a - b)) !== JSON.stringify(pages) ||
        job.imageFiles.length !== pages.length || new Set(job.imageFiles.map(i => i.page)).size !== pages.length ||
        new Set([job.sourceFileId, job.recordsFileId, ...job.imageFiles.map(i => i.fileId)]).size !== pages.length + 2) reject('archive_changed')
    for (const image of job.imageFiles) {
      if (!pages.includes(image.page)) reject('archive_changed')
      const bytes = await archive(image.fileId, image.sha256, 20 * MiB, 'image/png', image.sizeBytes)
      if (![137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)) reject('archive_changed')
    }
    return { job, records, source: original, context, scopeEvidence: highWater(rows) }
  }
  async function resolveClient(job: StructuredExtractionJob, context: FilesContext) {
    const binding = ConnectorBindingSchema.safeParse(job.context.connector)
    if (!binding.success) reject('connector_required')
    try { return (await options.connectors.resolve(context, job.sourceFileId, binding.data.connectorInstanceId, binding.data)).client }
    catch (error) { if (error instanceof StructuredOcrError) throw error; reject('connector_required') }
  }
  const api = {
    resolveClient,
    async listConnectors(ctx: FilesContext) {
      const context = await fresh(principal(ctx))
      const connectors = await options.connectors.list(context)
      if (connectors.length > 100) reject('connector_limit_exceeded')
      return { connectors, scopeEvidence: { sensitivity: context.clearance, compartments: context.compartments ?? [], projectIds: context.projectIds ?? [] } }
    },
    async authorize(job: StructuredExtractionJob): Promise<FilesContext> { return (await authorizeSource(job)).context },
    async evidence(ctx: FilesContext, extractionId: string) { return completeEvidence(await load(ctx, extractionId)) },
    async prepare(ctx: FilesContext, input: { fileId: string; connectorInstanceId: string }) {
      const { fileId, connectorInstanceId } = parsed(PrepareExtractionSchema, input)
      const context = await fresh(principal(ctx))
      let original: Awaited<ReturnType<typeof source>>
      try { original = await source(context, fileId) }
      catch (error) { if (error instanceof StructuredDocumentServiceError) throw error; reject('source_storage_unavailable') }
      const resolved = await options.connectors.resolve(context, fileId, connectorInstanceId)
      try { if ((await resolved.client.health()).version !== '1.1') reject('unavailable') }
      catch { reject('unavailable') }
      let job: StructuredExtractionJob
      try {
        job = await store.prepare({ userId: context.userId, workspaceId: context.workspaceId, sourceFileId: fileId,
          pdfSha256: original.pdfSha256, context: { principal: context, sourceVersion: original.sourceVersion, connector: resolved.binding } })
      } catch (error) {
        // A known SQLSTATE is safe to classify; SQL text/parameters are not.
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
        reject(code === '42P01' || code === '42703' ? 'extraction_schema_missing' : 'extraction_store_unavailable')
      }
      return { extractionId: job.id, status: job.status, sourceFileId: fileId, pdfSha256: original.pdfSha256,
        cost: { maximumPages: 10, maximumPdfBytes: 15 * MiB, processing: 'Local CPU OCR may take minutes; no exact duration estimate.', ocrLlmCall: false },
        approval: { connectorInstanceId, connectorLabel: resolved.label, operations: ['PDF upload', 'ocr_start', 'ocr_status', 'ocr_records', 'ocr_source_page'], scope: 'Confirmed start authorizes this fixed operation set for this document, including operations whose connector policy is ASK; no persistent approval or other documents are authorized.' },
        warning: 'No PDF uploaded yet. Starting requires confirmation. Selected reasoning providers may receive retrieved evidence.',
        scopeEvidence: highWater([original.file]) }
    },
    async start(ctx: FilesContext, input: { extractionId: string }) {
      const { extractionId } = parsed(StartExtractionSchema, input)
      const loaded = await load(ctx, extractionId)
      if (loaded.job.status === 'failed' || loaded.job.status === 'cancelled') reject('restart_required')
      await resolveClient(loaded.job, loaded.context)
      const job = await store.enqueue(loaded.context.userId, extractionId)
      if (!job || job.id !== loaded.job.id || job.userId !== loaded.job.userId || job.workspaceId !== loaded.job.workspaceId) reject('access_denied')
      return { extractionId, status: job.status, message: 'Queued work is handled asynchronously. An uncertain submission requires a new preflight, never a blind retry.', scopeEvidence: highWater([loaded.source]) }
    },
    async read(ctx: FilesContext, input: z.infer<typeof ReadExtractionSchema>) {
      const { extractionId, view = 'summary', offset = 0, limit = 20 } = parsed(ReadExtractionSchema, input)
      const loaded = await load(ctx, extractionId)
      if (loaded.job.status !== 'completed') {
        if (view !== 'summary') reject('not_complete')
        return { extractionId, status: loaded.job.status, complete: false,
          message: loaded.job.status === 'failed' ? 'Extraction failed. Review source access and prepare a new extraction; no evidence is available.' : 'Extraction is not complete; read status again later.',
          scopeEvidence: highWater([loaded.source]) }
      }
      const { job, records, scopeEvidence } = await completeEvidence(loaded)
      const total = view === 'summary' ? 1 : records[view].length
      if (offset > total || (view === 'summary' && offset !== 0)) reject('invalid_request')
      const count = view === 'summary' ? 1 : Math.min(limit, total - offset)
      const data = view === 'summary' ? { document: records.document, limitations: records.limitations, reviewContextPresent: records.review_context !== null } : records[view].slice(offset, offset + count)
      return displayBound({ extractionId, status: job.status, complete: true, view, offset, limit, total, nextOffset: offset + count < total ? offset + count : null,
        data, totals: { records: records.records.length, entities: records.entities.length, context: records.context.length, tables: records.tables.length, evidence: records.evidence.length },
        warnings: records.issues, documentNotes: records.document_notes, limitations: records.limitations,
        coverage: { numericCandidates: records.coverage.numeric_candidates.length, unresolved: records.coverage.unresolved_refs.length },
        manifest: manifest(job), scopeEvidence })
    },
    async propose(ctx: FilesContext, input: { extractionId: string; artifactId: string; expectedVersion: number; mappings: FillMapping[] }) {
      const params = parsed(ProposeEvidenceFillSchema, input)
      const { job, records, source: original, context, scopeEvidence } = await api.evidence(ctx, params.extractionId)
      const office = await options.getOffice(context.userId, params.artifactId)
      if (!office) reject('destination_denied')
      const { artifact, access, live } = office
      if (!Array.isArray(artifact.compartments) || !Array.isArray(artifact.projectIds) || !Object.hasOwn(rank, artifact.sensitivity)) reject('destination_denied')
      if (artifact.id !== params.artifactId || access.artifactId !== artifact.id || artifact.workspaceId !== context.workspaceId || access.workspaceId !== context.workspaceId ||
          artifact.mode !== 'artifact' || artifact.family !== 'spreadsheet' || artifact.lifecycleState !== 'active' || access.lifecycleState !== 'active' || !access.canView || !access.canComment ||
          live.snapshot.artifactId !== artifact.id || live.snapshot.workspaceId !== context.workspaceId || live.snapshot.family !== 'spreadsheet' ||
          rank[artifact.sensitivity] < rank[scopeEvidence.sensitivity] || rank[artifact.sensitivity] > rank[context.clearance] ||
          !contains(artifact.compartments, scopeEvidence.compartments) || !contains(artifact.projectIds, scopeEvidence.projectIds) ||
          !contains(context.compartments, artifact.compartments) || !contains(context.projectIds, artifact.projectIds)) reject('destination_denied')
      if (artifact.headVersion !== params.expectedVersion || live.baseVersion !== params.expectedVersion || !artifact.headVersionId || !Number.isSafeInteger(live.seq) || live.seq < 1) reject('stale_destination')
      const snapshot = live.snapshot
      const active = snapshot.worksheets.find(s => s.id === snapshot.activeSheetId)
      if (!active || params.mappings.some(m => !active.cells.some(c => c.id === m.targetId))) reject('unsafe_mapping')
      let plan: ReturnType<typeof prepareStructuredFill>
      try { plan = prepareStructuredFill({ snapshot: live.snapshot, records, artifactId: artifact.id, assistantId: context.assistantId, expectedVersion: params.expectedVersion, mappings: params.mappings }) }
      catch { reject('unsafe_mapping') }
      const evidenceManifest = manifest(job)
      const evidenceHash = hash(JSON.stringify({ manifest: evidenceManifest, fillEvidenceHash: plan.evidenceHash, baseVersionId: artifact.headVersionId, seq: live.seq }))
      const command = stableCommand(plan.command, evidenceHash)
      const lineage = { version: 1, ...evidenceManifest, evidenceHash, sourceScope: requirements(original), evidenceScope: scopeEvidence,
        artifactId: artifact.id, baseVersionId: artifact.headVersionId, expectedVersion: params.expectedVersion, expectedSeq: live.seq,
        mappings: plan.preview }
      const body = [
        'Unreviewed source-linked worksheet suggestion - NOT an approved fact or completed worksheet.',
        `Extraction ${job.id}; PDF ${job.sourceFileId} SHA-256 ${job.pdfSha256}; records ${job.recordsFileId} SHA-256 ${job.recordsSha256}.`,
        `Snapshot ${job.documentId}; schema 1.1. Page images: ${JSON.stringify(evidenceManifest.imageFiles)}.`,
        ...plan.preview.map(p => `${p.sheet}!${p.address}: ${JSON.stringify(p.meaning)} - observed ${JSON.stringify(p.rawText)} (page ${p.page}, refs ${JSON.stringify(p.sourceRefs)}). Reason: ${JSON.stringify(p.reason)}. Flags: ${JSON.stringify(p.flags)}.`),
        `Unresolved numeric coverage: ${records.coverage.unresolved_refs.length}; attachment/reference notes: ${records.document_notes.length}. Unselected observations remain unreviewed.`,
      ].join('\n')
      if (body.length > 20_000 || Buffer.byteLength(JSON.stringify(lineage)) > 4 * MiB) reject('result_too_large')
      // Check result size before the only persistence effect; do not save a proposal
      // whose complete preview cannot be returned for human review.
      displayBound({ preview: plan.preview, manifest: evidenceManifest, scopeEvidence })
      const saved = await options.saveProposal({ userId: context.userId, workspaceId: context.workspaceId, artifactId: artifact.id,
        baseVersionId: artifact.headVersionId, expectedSeq: live.seq, assistantId: context.assistantId, extractionId: job.id,
        evidenceHash, command, preview: plan.preview, lineage, body, targetIds: plan.preview.map(p => p.targetId) })
      if (!saved) reject('proposal_conflict')
      return { proposalId: saved.id, threadId: saved.threadId, status: 'suggested' as const, requiresHumanReview: true,
        evidenceHash, preview: plan.preview, manifest: evidenceManifest, scopeEvidence }
    },
  }
  // No vendor bodies, database diagnostics, URLs or source text in error messages.
  const safe = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    try { return await fn(...args) } catch (error) {
      if (error instanceof StructuredDocumentServiceError) throw error
      if (error instanceof StructuredOcrError) {
        switch (error.code) {
          case 'connector_health_approval_required': reject('connector_health_approval_required')
          case 'connector_policy_blocked': reject('connector_policy_blocked')
          case 'connector_binding_changed': reject('connector_changed')
          case 'invalid_configuration': reject('connector_configuration_invalid')
          case 'connector_context_missing': reject('invalid_context')
          case 'connector_limit_exceeded': reject('connector_limit_exceeded')
          default: reject('connector_unavailable')
        }
      }
      reject('operation_failed')
    }
  }
  return { resolveClient: safe(api.resolveClient), listConnectors: safe(api.listConnectors), prepare: safe(api.prepare), start: safe(api.start), read: safe(api.read), propose: safe(api.propose), authorize: safe(api.authorize), evidence: safe(api.evidence) }
}
export type StructuredDocumentService = ReturnType<typeof createStructuredDocumentService>
