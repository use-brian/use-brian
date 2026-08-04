/**
 * Authenticated HTTP boundary for lossless LinkedIn ZIP imports.
 *
 * [COMP:api/linkedin-import-http]
 */

import { Router } from 'express'
import multer, { MulterError } from 'multer'
import type { FilesApi, FilesContext } from '@use-brian/core'

import { getWorkspacePrimaryAssistant } from '../db/users.js'
import {
  createOrGetLinkedInImportRun,
  findLinkedInImportRunByHash,
  getLinkedInImportRun,
} from '../db/linkedin-import-store.js'
import {
  inspectLinkedInArchive,
  LinkedInArchiveError,
  MAX_LINKEDIN_ARCHIVE_BYTES,
  sha256,
} from '../linkedin-import/archive.js'
import type { LinkedInImportRun } from '../linkedin-import/types.js'

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_LINKEDIN_ARCHIVE_BYTES, files: 1 },
})

type PrimaryAssistant = NonNullable<Awaited<ReturnType<typeof getWorkspacePrimaryAssistant>>>

export type LinkedInImportRoutesDeps = {
  filesApi: Pick<FilesApi, 'writeBytes' | 'readBytes'>
  findRunByHash?: typeof findLinkedInImportRunByHash
  createRun?: typeof createOrGetLinkedInImportRun
  getRun?: typeof getLinkedInImportRun
  resolvePrimaryAssistant?: (userId: string, workspaceId: string) => Promise<PrimaryAssistant | null>
  inspectArchive?: typeof inspectLinkedInArchive
}

function runDto(run: LinkedInImportRun) {
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    archiveName: run.archiveName,
    archiveSha256: run.archiveSha256,
    archiveSizeBytes: run.archiveSizeBytes,
    status: run.status,
    stage: run.stage,
    attempts: run.attempts,
    error: run.lastError,
    counts: {
      members: run.memberCount,
      completedMembers: run.completedMemberCount,
      rows: run.rowCount,
      mapped: run.mappedCount,
      stored: run.storedCount,
      unresolved: run.unresolvedCount,
      malformed: run.malformedCount,
      entities: run.entityCount,
      edges: run.edgeCount,
    },
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
  }
}

function filesContext(assistant: PrimaryAssistant, userId: string): FilesContext {
  return {
    workspaceId: assistant.workspaceId!,
    userId,
    assistantId: assistant.id,
    assistantKind: assistant.kind,
    clearance: assistant.clearance,
    compartments: assistant.compartments,
  }
}

function recoverFileName(file: Express.Multer.File): string {
  return Buffer.from(file.originalname, 'latin1').toString('utf8')
}

function looksLikeZip(file: Express.Multer.File, fileName: string): boolean {
  const mimeOk = new Set([
    'application/zip',
    'application/x-zip-compressed',
    'application/octet-stream',
  ]).has(file.mimetype)
  const signature = file.buffer.length >= 4 &&
    file.buffer[0] === 0x50 && file.buffer[1] === 0x4b &&
    [0x03, 0x05, 0x07].includes(file.buffer[2]) &&
    [0x04, 0x06, 0x08].includes(file.buffer[3])
  return mimeOk && fileName.toLowerCase().endsWith('.zip') && signature
}

export function linkedinImportRoutes(deps: LinkedInImportRoutesDeps): Router {
  const router = Router()
  const findRunByHash = deps.findRunByHash ?? findLinkedInImportRunByHash
  const createRun = deps.createRun ?? createOrGetLinkedInImportRun
  const getRun = deps.getRun ?? getLinkedInImportRun
  const resolvePrimaryAssistant = deps.resolvePrimaryAssistant ?? getWorkspacePrimaryAssistant
  const inspectArchive = deps.inspectArchive ?? inspectLinkedInArchive

  router.post('/', upload.single('file'), async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const workspaceId = typeof req.body?.workspaceId === 'string' ? req.body.workspaceId : null
    if (!workspaceId) {
      res.status(400).json({ error: 'workspaceId is required' })
      return
    }
    const file = req.file
    if (!file) {
      res.status(400).json({ error: 'A LinkedIn ZIP is required in multipart field "file".' })
      return
    }

    const assistant = await resolvePrimaryAssistant(userId, workspaceId)
    if (!assistant || !assistant.workspaceId) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    const fileName = recoverFileName(file)
    if (!looksLikeZip(file, fileName)) {
      res.status(400).json({ error: 'Expected a .zip LinkedIn data export.' })
      return
    }

    const archiveSha256 = sha256(file.buffer)
    const existingRun = await findRunByHash(assistant.workspaceId, userId, archiveSha256)
    if (existingRun && existingRun.status !== 'failed') {
      res.status(existingRun.status === 'completed' ? 200 : 202).json({
        duplicate: true,
        run: runDto(existingRun),
      })
      return
    }

    try {
      // Validate the complete container before any byte or queue write. The
      // worker repeats this check against the durable copy before projection.
      await inspectArchive(file.buffer)
      const ctx = filesContext(assistant, userId)
      const path = `/imports/linkedin/${userId}/${archiveSha256}/archive.zip`
      const write = await deps.filesApi.writeBytes(ctx, {
        path,
        bytes: file.buffer,
        mime: 'application/zip',
        title: fileName,
        summary: 'Original, byte-preserved LinkedIn data export',
        tags: ['linkedin-import', 'source-evidence'],
        sensitivity: 'confidential',
      })
      let archiveFileId: string
      if (write.ok) {
        archiveFileId = write.value.id
      } else if (write.error.kind === 'conflict') {
        const stored = await deps.filesApi.readBytes(ctx, path)
        if (!stored.ok || sha256(stored.value.bytes) !== archiveSha256) {
          throw new Error('The LinkedIn archive path already exists with different bytes.')
        }
        archiveFileId = stored.value.file.id
      } else {
        throw new Error(`Could not store LinkedIn archive: ${write.error.kind}`)
      }

      const { run, created } = await createRun({
        workspaceId: assistant.workspaceId,
        actingUserId: userId,
        assistantId: assistant.id,
        archiveFileId,
        archiveName: fileName,
        archiveSha256,
        archiveSizeBytes: file.size,
      })
      res.status(202).json({ duplicate: !created, run: runDto(run) })
    } catch (err) {
      if (err instanceof LinkedInArchiveError) {
        res.status(400).json({ error: err.message, kind: err.kind })
        return
      }
      console.error('[linkedin-import] upload failed:', err)
      res.status(500).json({ error: err instanceof Error ? err.message : 'LinkedIn import failed' })
    }
  })

  router.get('/:runId', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const run = await getRun(req.params.runId)
    if (!run || run.actingUserId !== userId) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    const assistant = await resolvePrimaryAssistant(userId, run.workspaceId)
    if (!assistant) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    res.json({ run: runDto(run) })
  })

  router.use((err: unknown, _req: unknown, res: import('express').Response, next: import('express').NextFunction) => {
    if (err instanceof MulterError) {
      res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'LinkedIn ZIP is too large.' : err.message })
      return
    }
    next(err)
  })

  return router
}
