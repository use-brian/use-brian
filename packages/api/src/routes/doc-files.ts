/**
 * Doc-block media routes — durable storage + authenticated byte reads for images
 * and files embedded in doc pages.
 *
 * Unlike the transient chat-attachment path (`/api/files` → `file_cache`,
 * 7-day TTL), a doc *page* is durable, so its embedded media must be too.
 * These routes write block bytes straight into the permanent
 * `workspace_files` primitive (GCS-backed) under a reserved `/doc/` path
 * prefix that is EXCLUDED from the brain's retrieval surfaces (`fileSearch`
 * + the L1 `# Workspace Files` block — see
 * `packages/api/src/db/workspace-files.ts`). The media still counts toward
 * the per-workspace storage quota; it is simply not auto-indexed for search.
 *
 * Both endpoints are workspace-membership gated (`requireAuth` sets
 * `req.userId`; the route then confirms the caller is a member of
 * `:workspaceId`). This is security-critical: a user must never upload to,
 * or read from, a workspace they are not a member of.
 *
 * See docs/architecture/features/files.md → "Doc-embedded media".
 *
 * [COMP:api/doc-files]
 */

import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import multer from 'multer'
import type {
  FilesApi,
  FilesContext,
} from '@use-brian/core'
import { isAllowedMime } from './files.js'
import type { getWorkspaceFileReadProjection } from '../db/workspace-files.js'
import { workspaceFileReadRevision } from '../files/files-api.js'

const MAX_FILE_SIZE = 20 * 1024 * 1024 // 20 MB
const MAX_FILES_PER_REQUEST = 10

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: MAX_FILES_PER_REQUEST,
  },
})

/** Reserved path prefix for doc-block media (brain-exclusion key). */
const DOC_PATH_PREFIX = '/doc/'

/**
 * Membership + clearance lookup. Returns null when the user is not a member
 * of the workspace (route → 403). Injected so tests can stub it without a DB.
 */
export type DocFilesMembership = (
  userId: string,
  workspaceId: string,
) => Promise<{ clearance: 'public' | 'internal' | 'confidential' } | null>

export type DocFilesDeps = {
  filesApi: FilesApi
  membership: DocFilesMembership
  readProjection: typeof getWorkspaceFileReadProjection
}

/**
 * Strip path separators (and other path-hostile chars) from a multipart
 * filename so it is safe to splice into the `/doc/<uuid>-<name>` path.
 * The `/doc/<uuid>-` prefix keeps every upload unique even when names
 * collide, so this only needs to neutralize separators, not enforce
 * uniqueness.
 */
function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[/\\]/g, '_')
    .replace(/\0/g, '')
    .trim()
  return cleaned.length > 0 ? cleaned : 'file'
}

export function docFilesRoutes(deps: DocFilesDeps): Router {
  const { filesApi, membership } = deps
  const router = Router({ mergeParams: true })

  // ── POST /:workspaceId/upload ───────────────────────────────────
  router.post('/:workspaceId/upload', upload.array('files', MAX_FILES_PER_REQUEST), async (req, res) => {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    // The multer middleware overload widens `req.params` values to
    // `string | string[]`; a named route param is always a single string.
    const workspaceId = req.params.workspaceId as string
    const files = (req.files as Express.Multer.File[] | undefined) ?? []
    if (files.length === 0) {
      res.status(400).json({ error: 'No files provided' })
      return
    }

    // SECURITY: membership gate. Never let a user write into a workspace
    // they are not a member of. The clearance is the upload ceiling.
    const member = await membership(userId, workspaceId)
    if (!member) {
      res.status(403).json({ error: 'Not a member of this workspace' })
      return
    }

    const ctx: FilesContext = {
      workspaceId,
      userId,
      assistantId: null,
      clearance: member.clearance,
    }

    const results: Array<{
      id?: string
      bucket?: 'workspace_files'
      path?: string
      mimeType?: string
      sizeBytes?: number
      name: string
      error?: string
    }> = []

    for (const file of files) {
      // multer/busboy decodes the multipart filename header as latin1;
      // re-decode latin1→UTF-8 to recover UTF-8 names (no-op for ASCII).
      const fileName = Buffer.from(file.originalname, 'latin1').toString('utf8')

      if (!isAllowedMime(file.mimetype, file.originalname)) {
        results.push({ error: `Unsupported file type: ${file.mimetype}`, name: fileName })
        continue
      }

      const path = `${DOC_PATH_PREFIX}${randomUUID()}-${sanitizeFilename(fileName)}`

      try {
        const result = await filesApi.writeBytes(ctx, {
          path,
          bytes: file.buffer,
          mime: file.mimetype,
          title: fileName,
        })

        if (!result.ok) {
          results.push({ error: mapFilesError(result.error), name: fileName })
          continue
        }

        const row = result.value
        results.push({
          id: row.id,
          bucket: 'workspace_files',
          path: row.id, // path === id by contract — callers resolve by row id
          mimeType: row.mime,
          sizeBytes: row.sizeBytes,
          name: fileName,
        })
      } catch (err) {
        console.error('[doc-files] upload failed:', err)
        results.push({ error: 'Failed to store file', name: fileName })
      }
    }

    res.json({ files: results })
  })

  // ── GET /:workspaceId/:id ───────────────────────────────────────
  // Every backend returns authenticated bytes through the canonical reader.
  // A retained provider capability must not bypass later access revocation.
  router.get('/:workspaceId/:id', async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store')
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const { workspaceId, id } = req.params

    const member = await membership(userId, workspaceId)
    if (!member) {
      res.status(403).json({ error: 'Not a member of this workspace' })
      return
    }

    try {
      const result = await filesApi.readBytes({
        workspaceId, userId, assistantId: null, clearance: member.clearance,
      }, id)
      if (!result.ok) {
        res.status(404).json({ error: 'File not found' })
        return
      }
      const revision=workspaceFileReadRevision(result.value.file)
      const projectionStarted=performance.now()
      const projection=await deps.readProjection({workspaceId,userId,assistantId:userId,assistantKind:'standard',clearance:member.clearance},id)
      const validForMs=Math.floor((projection?.validForMs??0)-(performance.now()-projectionStarted))
      if(!projection||!Number.isFinite(validForMs)||validForMs<=0||workspaceFileReadRevision(projection.file)!==revision){
        res.status(404).json({error:'File not found'})
        return
      }
      res.setHeader('X-Brian-Media-Valid-For-Ms',String(Math.min(30_000,validForMs)))
      res.append('Access-Control-Expose-Headers','X-Brian-Media-Valid-For-Ms')
      res.setHeader('Content-Type', result.value.file.mime)
      res.setHeader('Content-Length', String(result.value.bytes.length))
      res.send(result.value.bytes)
    } catch (err) {
      console.error('[doc-files] byte-read failed:', err)
      res.status(500).json({ error: 'Failed to load file' })
    }
  })

  return router
}

/** Map a FilesApi error kind to a clean, user-safe message. */
function mapFilesError(error: { kind: string }): string {
  switch (error.kind) {
    case 'quota_exceeded':
      return 'Workspace storage quota exceeded'
    case 'conflict':
      return 'A file already exists at this path'
    case 'not_found':
      return 'File not found'
    default:
      return 'Failed to store file'
  }
}
