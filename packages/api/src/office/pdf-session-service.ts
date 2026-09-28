/** Transactional PDF intake, protected assets, and flattened outputs.
 * [COMP:api/office-pdf-sessions] */
import { createHash, randomUUID } from 'node:crypto'
import {
  createPdfWriterPort,
  parsePdfSession,
  renderPdfApprovalPage,
  validateRenderedPdf,
  type PdfWriterResult,
} from '@use-brian/core'
import {
  encodeOfficeState,
  applyOfficeCommand,
  officeStateVector,
  snapshotToYDoc,
  type OfficeCommand,
  type PdfSnapshot,
} from '@use-brian/office-model'
import { officeLiveStore, type OfficeLiveSnapshot } from '../db/office-live.js'
import { createOfficePdfSessionStore, type OfficePdfSessionStore, type PdfSessionRow } from '../db/office-pdf-sessions.js'
import {
  PDF_SESSION_FILE_METADATA,
  normalizePdfSignatureImage,
  pdfSessionAssetPath,
  type PdfSessionAssetPort,
} from './pdf-session-assets.js'

export type PdfSessionSource =
  | { kind: 'file_cache'; id: string; expectedSessionId?: string }
  | { kind: 'workspace_file'; id: string }

export type ResolvedPdfSessionSource = {
  bytes: Uint8Array
  mime: string
  fileName: string
  sensitivity: 'public' | 'internal' | 'confidential'
  compartments: string[]
  projectIds: string[]
}

export type PdfSessionSourcePort = (params: {
  userId: string
  workspaceId: string
  source: PdfSessionSource
  signal?: AbortSignal
}) => Promise<ResolvedPdfSessionSource | null>

export type PdfSessionTarget = {
  targetId: string
  pageId: string
  pageNumber: number
  rect: { x: number; y: number; width: number; height: number }
}

export type PdfSessionReady = {
  artifactId: string
  version: number
  expiresAt: string
  editorUrl: string
  targets: PdfSessionTarget[]
  sourceHash: string
  signatureResourceId?: string
}

export class PdfSessionServiceError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message)
    this.name = 'PdfSessionServiceError'
  }
}

type LiveStore = Pick<typeof officeLiveStore, 'get' | 'appendCommand'>

export type PdfSessionServiceDeps = {
  assertWorkspaceMember(params: { userId: string; workspaceId: string }): Promise<boolean>
  resolveSource: PdfSessionSourcePort
  assets: PdfSessionAssetPort
  sessions?: OfficePdfSessionStore
  live?: LiveStore
  now?: () => Date
}

const scopeRank = { public: 0, internal: 1, confidential: 2 } as const

function strongestSensitivity(...values: Array<'public' | 'internal' | 'confidential'>) {
  return values.reduce((strongest, value) => scopeRank[value] > scopeRank[strongest] ? value : strongest, 'public')
}

function union<T>(...values: T[][]): T[] {
  return [...new Set(values.flat())]
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function stableUuid(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32).split('')
  hex[12] = '4'
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`
}

function sessionTargets(snapshot: PdfSnapshot): PdfSessionTarget[] {
  return snapshot.pages.flatMap((page, pageIndex) => page.placementTargets.map((target) => ({
    targetId: target.id,
    pageId: page.id,
    pageNumber: pageIndex + 1,
    rect: target.rect,
  })))
}

function signatureResourceId(snapshot: PdfSnapshot): string | undefined {
  return snapshot.resources.find((resource) => resource.kind === 'image' && resource.mime === 'image/png')?.id
}

function ready(row: PdfSessionRow, snapshot: PdfSnapshot): PdfSessionReady {
  return {
    artifactId: row.id,
    version: row.headVersion,
    expiresAt: row.expiresAt.toISOString(),
    editorUrl: `/w/${row.workspaceId}/office/${row.id}`,
    targets: sessionTargets(snapshot),
    sourceHash: snapshot.source.sha256,
    ...(signatureResourceId(snapshot) ? { signatureResourceId: signatureResourceId(snapshot) } : {}),
  }
}

function assertIdempotencyKey(value: string): void {
  if (value.length < 8 || value.length > 255) {
    throw new PdfSessionServiceError('idempotency_key_invalid', 'Use an idempotency key between 8 and 255 characters.')
  }
}

function assertPdfMimeAndMagic(source: ResolvedPdfSessionSource): void {
  const magic = Buffer.from(source.bytes.subarray(0, 5)).toString('ascii')
  if (source.mime !== 'application/pdf' || magic !== '%PDF-') {
    throw new PdfSessionServiceError('pdf_malformed', 'Choose a valid PDF file.')
  }
}

export function createPdfSessionService(deps: PdfSessionServiceDeps) {
  const sessions = deps.sessions ?? createOfficePdfSessionStore()
  const live = deps.live ?? officeLiveStore

  async function requireSession(userId: string, artifactId: string): Promise<PdfSessionRow> {
    const session = await sessions.get(userId, artifactId)
    if (!session) throw new PdfSessionServiceError('session_unavailable', 'This PDF editing session is unavailable.', 404)
    return session
  }

  async function requireLive(userId: string, artifactId: string): Promise<OfficeLiveSnapshot & { snapshot: PdfSnapshot }> {
    const current = await live.get(userId, artifactId)
    if (!current || current.snapshot.family !== 'pdf') {
      throw new PdfSessionServiceError('session_unavailable', 'This PDF editing session is unavailable.', 404)
    }
    return current as OfficeLiveSnapshot & { snapshot: PdfSnapshot }
  }

  async function loadReady(userId: string, row: PdfSessionRow): Promise<PdfSessionReady> {
    const current = await requireLive(userId, row.id)
    return ready(row, current.snapshot)
  }

  async function writerContext(userId: string, session: PdfSessionRow, snapshot: PdfSnapshot) {
    const assets = await sessions.listAssets(userId, session.id)
    const sourceAsset = assets.find((asset) => asset.role === 'source')
    if (!sourceAsset || sourceAsset.contentSha256 !== snapshot.source.sha256) {
      throw new PdfSessionServiceError('source_unavailable', 'The PDF source is unavailable.', 404)
    }
    const source = await deps.assets.read({ userId, workspaceId: session.workspaceId, fileId: sourceAsset.fileId })
    if (!source || sha256(source.bytes) !== snapshot.source.sha256) {
      throw new PdfSessionServiceError('source_unavailable', 'The PDF source is unavailable.', 404)
    }
    const writer = createPdfWriterPort({
      resolveResource: async (resourceId) => {
        const asset = assets.find((candidate) => candidate.fileId === resourceId && candidate.role === 'signature')
        if (!asset) return null
        const resource = await deps.assets.read({ userId, workspaceId: session.workspaceId, fileId: resourceId })
        if (!resource
          || (resource.file.mime !== 'image/png' && resource.file.mime !== 'image/jpeg')
          || sha256(resource.bytes) !== asset.contentSha256) return null
        return { bytes: resource.bytes, mime: resource.file.mime, sha256: asset.contentSha256 }
      },
    })
    return { assets, source, writer }
  }

  async function validateSignatureAnchors(params: {
    userId: string
    approverUserId: string
    artifactId: string
    targetId: string
    signatureResourceId: string
    expectedSourceHash: string
    expectedVersion: number
  }) {
    if (params.userId !== params.approverUserId) return null
    let session: PdfSessionRow
    try {
      session = await requireSession(params.userId, params.artifactId)
    } catch (error) {
      if (error instanceof PdfSessionServiceError) return null
      throw error
    }
    if (session.ownerUserId !== params.approverUserId || session.headVersion !== params.expectedVersion) return null
    let live: OfficeLiveSnapshot & { snapshot: PdfSnapshot }
    try {
      live = await requireLive(params.userId, params.artifactId)
    } catch (error) {
      if (error instanceof PdfSessionServiceError) return null
      throw error
    }
    if (live.baseVersion !== params.expectedVersion || live.snapshot.source.sha256 !== params.expectedSourceHash) return null
    const pageIndex = live.snapshot.pages.findIndex((page) => page.placementTargets.some((target) => target.id === params.targetId))
    if (pageIndex < 0) return null
    const target = live.snapshot.pages[pageIndex]!.placementTargets.find((candidate) => candidate.id === params.targetId)!
    if (target.creatorUserId !== params.approverUserId || target.creationVersion > params.expectedVersion) return null
    const resource = live.snapshot.resources.find((candidate) => candidate.id === params.signatureResourceId)
    const assets = await sessions.listAssets(params.userId, params.artifactId)
    const signatureAsset = assets.find((candidate) => candidate.fileId === params.signatureResourceId && candidate.role === 'signature')
    if (!resource || resource.kind !== 'image' || resource.mime !== 'image/png' || !signatureAsset || signatureAsset.contentSha256 !== resource.hash) return null
    return { session, live, pageIndex, target, signatureAsset }
  }

  return {
    async create(params: {
      userId: string
      workspaceId: string
      source: PdfSessionSource
      signatureSource?: PdfSessionSource
      title: string
      sensitivity: 'public' | 'internal' | 'confidential'
      idempotencyKey: string
      locale?: string
      signal?: AbortSignal
    }): Promise<PdfSessionReady> {
      assertIdempotencyKey(params.idempotencyKey)
      if (!await deps.assertWorkspaceMember({ userId: params.userId, workspaceId: params.workspaceId })) {
        throw new PdfSessionServiceError('source_unavailable', 'The selected source is unavailable.', 404)
      }
      const existing = await sessions.findByIdempotency(params.userId, params.workspaceId, params.idempotencyKey)
      if (existing) return loadReady(params.userId, existing)

      const source = await deps.resolveSource({
        userId: params.userId,
        workspaceId: params.workspaceId,
        source: params.source,
        signal: params.signal,
      })
      if (!source) throw new PdfSessionServiceError('source_unavailable', 'The selected source is unavailable.', 404)
      assertPdfMimeAndMagic(source)

      const signature = params.signatureSource
        ? await deps.resolveSource({ userId: params.userId, workspaceId: params.workspaceId, source: params.signatureSource, signal: params.signal })
        : null
      if (params.signatureSource && !signature) {
        throw new PdfSessionServiceError('source_unavailable', 'The selected source is unavailable.', 404)
      }
      const normalizedSignature = signature
        ? await normalizePdfSignatureImage(signature.bytes, signature.mime)
        : null

      const artifactId = randomUUID()
      const versionId = randomUUID()
      const provisionalSourceFileId = randomUUID()
      const effectiveSensitivity = strongestSensitivity(
        params.sensitivity,
        source.sensitivity,
        ...(signature ? [signature.sensitivity] : []),
        ...(normalizedSignature ? ['confidential' as const] : []),
      )
      const compartments = union(source.compartments, signature?.compartments ?? [])
      const projectIds = union(source.projectIds, signature?.projectIds ?? [])
      const parsed = await parsePdfSession({
        bytes: source.bytes,
        artifactId,
        workspaceId: params.workspaceId,
        ownerUserId: params.userId,
        fileId: provisionalSourceFileId,
        sha256: sha256(source.bytes),
        originalFileName: source.fileName,
        title: params.title,
        locale: params.locale,
        signal: params.signal,
      })
      const written: Array<{ id: string }> = []
      try {
        const storedSource = await deps.assets.write({
          userId: params.userId,
          workspaceId: params.workspaceId,
          path: pdfSessionAssetPath(artifactId, 'source', 'source.pdf'),
          bytes: source.bytes,
          mime: 'application/pdf',
          sensitivity: effectiveSensitivity,
          compartments,
          projectIds,
          metadata: PDF_SESSION_FILE_METADATA,
        })
        written.push(storedSource)
        let storedSignature: { id: string } | undefined
        if (normalizedSignature) {
          storedSignature = await deps.assets.write({
            userId: params.userId,
            workspaceId: params.workspaceId,
            path: pdfSessionAssetPath(artifactId, 'signature', 'signature.png'),
            bytes: normalizedSignature.bytes,
            mime: 'image/png',
            sensitivity: 'confidential',
            compartments,
            projectIds,
            metadata: PDF_SESSION_FILE_METADATA,
          })
          written.push(storedSignature)
          const signatureId = storedSignature.id
          const withSignature = {
            ...parsed,
            source: { ...parsed.source, fileId: storedSource.id },
            resources: [...parsed.resources, {
              id: signatureId,
              kind: 'image' as const,
              hash: normalizedSignature.sha256,
              mime: 'image/png',
              sensitivity: 'confidential' as const,
            }],
          }
          Object.assign(parsed, withSignature)
        }
        const snapshot: PdfSnapshot = { ...parsed, source: { ...parsed.source, fileId: storedSource.id } }
        const snapshotBody = Buffer.from(JSON.stringify(snapshot))
        const snapshotHash = sha256(snapshotBody)
        const doc = snapshotToYDoc(snapshot)
        const ydoc = encodeOfficeState(doc)
        const stateVector = officeStateVector(doc)
        const storedSnapshot = await deps.assets.write({
          userId: params.userId,
          workspaceId: params.workspaceId,
          path: pdfSessionAssetPath(artifactId, 'snapshot', 'version-0.json'),
          bytes: snapshotBody,
          mime: 'application/json',
          sensitivity: effectiveSensitivity,
          compartments,
          projectIds,
          metadata: PDF_SESSION_FILE_METADATA,
        })
        written.push(storedSnapshot)

        const created = await sessions.create({
          userId: params.userId,
          artifactId,
          versionId,
          workspaceId: params.workspaceId,
          title: params.title,
          sensitivity: effectiveSensitivity,
          compartments,
          projectIds,
          idempotencyKey: params.idempotencyKey,
          snapshot,
          snapshotFileId: storedSnapshot.id,
          snapshotHash,
          snapshotBytes: ydoc,
          stateVector,
          sourceFileId: storedSource.id,
          sourceSha256: snapshot.source.sha256,
          signatureFileId: storedSignature?.id,
          signatureSha256: normalizedSignature?.sha256,
        })
        if (created) return ready(created, snapshot)
        const raced = await sessions.findByIdempotency(params.userId, params.workspaceId, params.idempotencyKey)
        if (!raced) throw new Error('PDF session idempotency conflict did not resolve')
        for (const file of written.reverse()) await deps.assets.delete({ userId: params.userId, workspaceId: params.workspaceId, fileId: file.id })
        return loadReady(params.userId, raced)
      } catch (error) {
        for (const file of written.reverse()) {
          try { await deps.assets.delete({ userId: params.userId, workspaceId: params.workspaceId, fileId: file.id }) } catch { /* retryable orphan cleanup owns the residual */ }
        }
        throw error
      }
    },

    async get(userId: string, artifactId: string): Promise<{ session: PdfSessionRow; live: OfficeLiveSnapshot & { snapshot: PdfSnapshot } }> {
      const session = await requireSession(userId, artifactId)
      return { session, live: await requireLive(userId, artifactId) }
    },

    async describeSignature(params: {
      userId: string
      artifactId: string
      targetId: string
      signatureResourceId: string
      expectedSourceHash: string
      expectedVersion: number
    }) {
      const anchors = await validateSignatureAnchors({ ...params, approverUserId: params.userId })
      if (!anchors) return null
      return {
        title: anchors.live.snapshot.title,
        fileName: anchors.live.snapshot.source.originalFileName,
        pageNumber: anchors.pageIndex + 1,
        rect: anchors.target.rect,
        sourceHash: anchors.live.snapshot.source.sha256,
        version: anchors.session.headVersion,
        expiresAt: anchors.session.expiresAt.toISOString(),
      }
    },

    async previewSignature(params: {
      userId: string
      approverUserId: string
      assistantId: string
      approvalId: string
      artifactId: string
      targetId: string
      signatureResourceId: string
      expectedSourceHash: string
      expectedVersion: number
      idempotencyKey: string
    }): Promise<{ bytes: Buffer; validForMs: number } | null> {
      const anchors = await validateSignatureAnchors(params)
      if (!anchors) return null
      const command: OfficeCommand = {
        commandId: stableUuid(`${params.artifactId}:${params.idempotencyKey}`),
        artifactId: params.artifactId,
        baseVersion: params.expectedVersion,
        actor: { type: 'assistant', id: params.assistantId },
        origin: 'ai',
        kind: 'placePdfSignature',
        targetId: params.targetId,
        signatureResourceId: params.signatureResourceId,
        approvalReceiptId: params.approvalId,
      }
      const candidate = applyOfficeCommand(anchors.live.snapshot, command) as PdfSnapshot
      const context = await writerContext(params.userId, anchors.session, candidate)
      const rendered = await context.writer.render(context.source.bytes, candidate)
      await validateRenderedPdf(candidate, rendered)
      return {
        bytes: await renderPdfApprovalPage(rendered.bytes, anchors.pageIndex + 1),
        validForMs: Math.max(1, Math.min(30_000, anchors.session.expiresAt.getTime() - Date.now())),
      }
    },

    async placeSignature(params: {
      userId: string
      assistantId: string
      approverUserId: string
      approvalId: string
      artifactId: string
      targetId: string
      signatureResourceId: string
      expectedSourceHash: string
      expectedVersion: number
      idempotencyKey: string
    }): Promise<{ artifactId: string; version: number } | 'pdf_signature_approval_stale'> {
      assertIdempotencyKey(params.idempotencyKey)
      let session: PdfSessionRow
      let current: OfficeLiveSnapshot & { snapshot: PdfSnapshot }
      try {
        session = await requireSession(params.userId, params.artifactId)
        current = await requireLive(params.userId, params.artifactId)
      } catch (error) {
        if (error instanceof PdfSessionServiceError) return 'pdf_signature_approval_stale'
        throw error
      }
      const commandId = stableUuid(`${params.artifactId}:${params.idempotencyKey}`)
      const prior = current.snapshot.pages.flatMap((page) => page.overlays).find((overlay) => overlay.id === commandId)
      if (prior) {
        return prior.kind === 'signature'
          && prior.resourceId === params.signatureResourceId
          && prior.authorizingUserId === params.approverUserId
          && prior.approvalReceiptId === params.approvalId
          && current.snapshot.source.sha256 === params.expectedSourceHash
          ? { artifactId: params.artifactId, version: params.expectedVersion + 1 }
          : 'pdf_signature_approval_stale'
      }
      const anchors = await validateSignatureAnchors(params)
      if (!anchors) return 'pdf_signature_approval_stale'
      const command: OfficeCommand = {
        commandId,
        artifactId: params.artifactId,
        baseVersion: params.expectedVersion,
        actor: { type: 'assistant', id: params.assistantId },
        origin: 'ai',
        kind: 'placePdfSignature',
        targetId: params.targetId,
        signatureResourceId: params.signatureResourceId,
        approvalReceiptId: params.approvalId,
      }
      const candidate = applyOfficeCommand(anchors.live.snapshot, command) as PdfSnapshot
      let renderContext: Awaited<ReturnType<typeof writerContext>>
      try {
        renderContext = await writerContext(params.userId, anchors.session, candidate)
      } catch (error) {
        if (error instanceof PdfSessionServiceError) return 'pdf_signature_approval_stale'
        throw error
      }
      const rendered = await renderContext.writer.render(renderContext.source.bytes, candidate)
      await validateRenderedPdf(candidate, rendered)
      const snapshotBytes = new TextEncoder().encode(JSON.stringify(candidate))
      const snapshotHash = sha256(snapshotBytes)
      const doc = snapshotToYDoc(candidate)
      const stored = await deps.assets.write({
        userId: params.userId,
        workspaceId: session.workspaceId,
        path: pdfSessionAssetPath(session.id, 'snapshot', `${params.expectedVersion + 1}-${snapshotHash}.json`),
        bytes: snapshotBytes,
        mime: 'application/json',
        sensitivity: session.sensitivity,
        compartments: session.compartments,
        projectIds: session.projectIds,
        metadata: PDF_SESSION_FILE_METADATA,
      })
      try {
        if (!await sessions.trackAsset({ userId: params.userId, artifactId: session.id, fileId: stored.id, role: 'snapshot', contentSha256: snapshotHash })) {
          throw new PdfSessionServiceError('pdf_signature_approval_stale', 'The PDF signature approval is stale.', 409)
        }
        const committed = await sessions.commitSignaturePlacement({
          userId: params.userId,
          assistantId: params.assistantId,
          artifactId: params.artifactId,
          expectedVersion: params.expectedVersion,
          expectedSeq: anchors.live.seq,
          snapshot: candidate,
          snapshotFileId: stored.id,
          snapshotHash,
          snapshotBytes: encodeOfficeState(doc),
          stateVector: officeStateVector(doc),
          sourceHash: params.expectedSourceHash,
          targetId: params.targetId,
          signatureResourceId: params.signatureResourceId,
          approvalId: params.approvalId,
          commandId,
        })
        if (!committed) throw new PdfSessionServiceError('pdf_signature_approval_stale', 'The PDF signature approval is stale.', 409)
        return { artifactId: params.artifactId, version: committed.version }
      } catch (error) {
        await sessions.untrackAsset(params.userId, session.id, stored.id)
        await deps.assets.delete({ userId: params.userId, workspaceId: session.workspaceId, fileId: stored.id })
        if (error instanceof PdfSessionServiceError && error.code === 'pdf_signature_approval_stale') return 'pdf_signature_approval_stale'
        throw error
      }
    },

    async readSource(userId: string, artifactId: string) {
      const session = await requireSession(userId, artifactId)
      const source = await deps.assets.read({ userId, workspaceId: session.workspaceId, fileId: session.sourceFileId })
      if (!source || sha256(source.bytes) !== (await requireLive(userId, artifactId)).snapshot.source.sha256) {
        throw new PdfSessionServiceError('source_unavailable', 'The PDF source is unavailable.', 404)
      }
      return source
    },

    async appendCommand(params: { userId: string; artifactId: string; expectedSeq: number; command: OfficeCommand }) {
      await requireSession(params.userId, params.artifactId)
      const result = await live.appendCommand(params)
      if (result === 'conflict') throw new PdfSessionServiceError('version_conflict', 'The PDF changed. Reload it and try again.', 409)
      if (!result) throw new PdfSessionServiceError('session_unavailable', 'This PDF editing session is unavailable.', 404)
      return result
    },

    async attachSignature(params: {
      userId: string
      artifactId: string
      source: PdfSessionSource
      expectedSeq: number
      signal?: AbortSignal
    }): Promise<{ signatureResourceId: string; seq: number }> {
      const session = await requireSession(params.userId, params.artifactId)
      const source = await deps.resolveSource({
        userId: params.userId,
        workspaceId: session.workspaceId,
        source: params.source,
        signal: params.signal,
      })
      if (!source) throw new PdfSessionServiceError('source_unavailable', 'The selected source is unavailable.', 404)
      const normalized = await normalizePdfSignatureImage(source.bytes, source.mime)
      const stored = await deps.assets.write({
        userId: params.userId,
        workspaceId: session.workspaceId,
        path: pdfSessionAssetPath(session.id, 'signature', `${randomUUID()}.png`),
        bytes: normalized.bytes,
        mime: 'image/png',
        sensitivity: 'confidential',
        compartments: union(session.compartments, source.compartments),
        projectIds: union(session.projectIds, source.projectIds),
        metadata: PDF_SESSION_FILE_METADATA,
      })
      const fileId = stored.id
      try {
        if (!await sessions.trackAsset({ userId: params.userId, artifactId: session.id, fileId, role: 'signature', contentSha256: normalized.sha256 })) {
          throw new PdfSessionServiceError('session_unavailable', 'This PDF editing session is unavailable.', 404)
        }
        const current = await requireLive(params.userId, session.id)
        const result = await live.appendCommand({
          userId: params.userId,
          artifactId: session.id,
          expectedSeq: params.expectedSeq,
          command: {
            commandId: randomUUID(),
            artifactId: session.id,
            baseVersion: current.baseVersion,
            actor: { type: 'user', id: params.userId },
            origin: 'manual',
            kind: 'attachResource',
            resource: { id: fileId, kind: 'image', hash: normalized.sha256, mime: 'image/png', sensitivity: 'confidential' },
          },
        })
        if (!result || result === 'conflict') {
          throw new PdfSessionServiceError('version_conflict', 'The PDF changed. Reload it and try again.', 409)
        }
        await sessions.elevateScope({
          userId: params.userId,
          artifactId: session.id,
          sensitivity: 'confidential',
          compartments: source.compartments,
          projectIds: source.projectIds,
        })
        return { signatureResourceId: fileId, seq: result.seq }
      } catch (error) {
        await sessions.untrackAsset(params.userId, session.id, fileId)
        await deps.assets.delete({ userId: params.userId, workspaceId: session.workspaceId, fileId })
        throw error
      }
    },

    async renderValidated(params: { userId: string; artifactId: string; expectedSeq: number }): Promise<{
      result: PdfWriterResult
      snapshot: PdfSnapshot
      session: PdfSessionRow
    }> {
      const session = await requireSession(params.userId, params.artifactId)
      const current = await requireLive(params.userId, params.artifactId)
      if (current.seq !== params.expectedSeq) throw new PdfSessionServiceError('version_conflict', 'The PDF changed. Reload it and try again.', 409)
      const context = await writerContext(params.userId, session, current.snapshot)
      const result = await context.writer.render(context.source.bytes, current.snapshot)
      await validateRenderedPdf(current.snapshot, result)
      return { result, snapshot: current.snapshot, session }
    },

    async commitRevision(params: {
      userId: string
      assistantId: string
      artifactId: string
      expectedVersion: number
      expectedSeq: number
      snapshot: PdfSnapshot
    }): Promise<{ version: number }> {
      const session = await requireSession(params.userId, params.artifactId)
      const current = await requireLive(params.userId, params.artifactId)
      if (session.headVersion !== params.expectedVersion
        || current.baseVersion !== params.expectedVersion
        || current.seq !== params.expectedSeq
        || params.snapshot.artifactId !== params.artifactId
        || params.snapshot.source.sha256 !== current.snapshot.source.sha256
        || JSON.stringify(params.snapshot.source) !== JSON.stringify(current.snapshot.source)
        || JSON.stringify(params.snapshot.resources) !== JSON.stringify(current.snapshot.resources)) {
        throw new PdfSessionServiceError('version_conflict', 'The PDF changed. Reload it and try again.', 409)
      }
      const renderContext = await writerContext(params.userId, session, params.snapshot)
      const rendered = await renderContext.writer.render(renderContext.source.bytes, params.snapshot)
      await validateRenderedPdf(params.snapshot, rendered)
      const snapshotBytes = new TextEncoder().encode(JSON.stringify(params.snapshot))
      const snapshotHash = sha256(snapshotBytes)
      const doc = snapshotToYDoc(params.snapshot)
      const stored = await deps.assets.write({
        userId: params.userId,
        workspaceId: session.workspaceId,
        path: pdfSessionAssetPath(session.id, 'snapshot', `${params.expectedVersion + 1}-${snapshotHash}.json`),
        bytes: snapshotBytes,
        mime: 'application/json',
        sensitivity: session.sensitivity,
        compartments: session.compartments,
        projectIds: session.projectIds,
        metadata: PDF_SESSION_FILE_METADATA,
      })
      try {
        if (!await sessions.trackAsset({ userId: params.userId, artifactId: session.id, fileId: stored.id, role: 'snapshot', contentSha256: snapshotHash })) {
          throw new PdfSessionServiceError('version_conflict', 'The PDF changed. Reload it and try again.', 409)
        }
        const committed = await sessions.commitRevision({
          ...params,
          snapshotFileId: stored.id,
          snapshotHash,
          snapshotBytes: encodeOfficeState(doc),
          stateVector: officeStateVector(doc),
          sourceHash: params.snapshot.source.sha256,
        })
        if (!committed) throw new PdfSessionServiceError('version_conflict', 'The PDF changed. Reload it and try again.', 409)
        return committed
      } catch (error) {
        await sessions.untrackAsset(params.userId, session.id, stored.id)
        await deps.assets.delete({ userId: params.userId, workspaceId: session.workspaceId, fileId: stored.id })
        throw error
      }
    },

    async createRelease(params: { userId: string; artifactId: string; expectedSeq: number }) {
      const rendered = await this.renderValidated(params)
      const stored = await deps.assets.write({
        userId: params.userId,
        workspaceId: rendered.session.workspaceId,
        path: pdfSessionAssetPath(params.artifactId, 'release', `${rendered.result.sha256}.pdf`),
        bytes: rendered.result.bytes,
        mime: 'application/pdf',
        sensitivity: rendered.session.sensitivity,
        compartments: rendered.session.compartments,
        projectIds: rendered.session.projectIds,
        metadata: PDF_SESSION_FILE_METADATA,
      })
      const fileId = stored.id
      if (!await sessions.trackAsset({ userId: params.userId, artifactId: params.artifactId, fileId, role: 'release', contentSha256: rendered.result.sha256 })) {
        await deps.assets.delete({ userId: params.userId, workspaceId: rendered.session.workspaceId, fileId })
        throw new PdfSessionServiceError('session_unavailable', 'This PDF editing session is unavailable.', 404)
      }
      return { fileId, sha256: rendered.result.sha256, bytes: rendered.result.bytes, pageCount: rendered.result.pages.length }
    },

    async saveToFiles(params: {
      userId: string
      artifactId: string
      expectedSeq: number
      releaseHash: string
      path: string
    }): Promise<{ fileId: string }> {
      const session = await requireSession(params.userId, params.artifactId)
      const current = await requireLive(params.userId, params.artifactId)
      if (current.seq !== params.expectedSeq) throw new PdfSessionServiceError('version_conflict', 'The PDF changed. Reload it and try again.', 409)
      const release = (await sessions.listAssets(params.userId, params.artifactId))
        .find((asset) => asset.role === 'release' && asset.contentSha256 === params.releaseHash)
      if (!release) throw new PdfSessionServiceError('release_unavailable', 'Create a fresh flattened PDF before saving it.', 409)
      const content = await deps.assets.read({ userId: params.userId, workspaceId: session.workspaceId, fileId: release.fileId })
      if (!content || sha256(content.bytes) !== params.releaseHash) {
        throw new PdfSessionServiceError('release_unavailable', 'Create a fresh flattened PDF before saving it.', 409)
      }
      const saved = await deps.assets.saveDurable({
        userId: params.userId,
        workspaceId: session.workspaceId,
        path: params.path,
        bytes: content.bytes,
        mime: 'application/pdf',
        sensitivity: session.sensitivity,
        compartments: session.compartments,
        projectIds: session.projectIds,
      })
      return { fileId: saved.id }
    },
  }
}

export type PdfSessionService = ReturnType<typeof createPdfSessionService>
