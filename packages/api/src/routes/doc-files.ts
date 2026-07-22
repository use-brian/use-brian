/**
 * Doc-block media routes — durable storage + signed reads for images
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
  AccessContext,
  FilesApi,
  FilesContext,
  WorkspaceFilesStore,
} from '@use-brian/core'
import type { GcsFilesClient } from '../files/gcs-client.js'
import type { FilesClientResolver } from '../files/files-api.js'
import { buildStorageKey } from '../files/gcs-client.js'
import { isAllowedMime } from './files.js'

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
  store: WorkspaceFilesStore
  gcs: GcsFilesClient
  /** Routes reads to the backend recorded in each workspace_files row. */
  resolver?: FilesClientResolver
  membership: DocFilesMembership
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

/**
 * Build the per-viewer `AccessContext` used for RLS-scoped reads. Mirrors
 * the `accessCtx` helper inside `files-api.ts`: a non-assistant caller
 * echoes its `userId` into `assistantId` (workspace-shared rows have
 * `assistant_id IS NULL` and still match), and is treated as a `standard`
 * assistant kind.
 */
function buildAccessContext(
  workspaceId: string,
  userId: string,
  clearance: 'public' | 'internal' | 'confidential',
): AccessContext {
  return {
    workspaceId,
    userId,
    assistantId: userId,
    assistantKind: 'standard',
    clearance,
  }
}

export function docFilesRoutes(deps: DocFilesDeps): Router {
  const { filesApi, store, gcs, resolver, membership } = deps
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

      if (!isAllowedMime(file.mimetype)) {
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
  // Resolve the row under workspace RLS, mint a short-lived signed object read
  // URL, and 302-redirect to it. `?redirect=0` returns `{ url }` as JSON
  // instead — for fetch()-based consumers (PageIcon, chat attachment
  // downloads), which CANNOT follow the redirect: a CORS fetch redirected
  // across origins (app → api → storage.googleapis.com) gets a tainted
  // origin, the browser sends `Origin: null` on the storage leg, the bucket
  // CORS config only matches the app origins, and the browser blocks the
  // response. The client fetches the minted URL directly (single-hop CORS,
  // real app origin) instead. Same auth, same RLS, same short-lived URL as
  // the redirect — the Location header was always delivered to this caller
  // anyway; the signed URL is still never logged.
  router.get('/:workspaceId/:id', async (req, res) => {
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
      const accessCtx = buildAccessContext(workspaceId, userId, member.clearance)
      const row = await store.getById(accessCtx, id)
      if (!row) {
        res.status(404).json({ error: 'File not found' })
        return
      }

      const key = buildStorageKey(workspaceId, id)
      const blobClient = resolver ? await resolver.forUri(workspaceId, row.storageUri) : gcs
      const url = await blobClient.signedReadUrl(key)
      // Cloud backends return a signed HTTPS URL → redirect so the browser fetches
      // the bytes straight from object storage (no API egress, CDN-friendly), and the
      // signed URL never lands in a body/log. The local-disk dev client returns
      // a `file://` URL a browser can't navigate to — stream the bytes through
      // the API instead so `<img src>` works in local dev.
      if (/^https?:\/\//i.test(url)) {
        if (req.query.redirect === '0') {
          res.json({ url })
          return
        }
        res.redirect(302, url)
        return
      }
      const blob = await blobClient.readBlob(key)
      if (!blob) {
        res.status(404).json({ error: 'File not found' })
        return
      }
      res.setHeader('Content-Type', blob.mime || row.mime)
      res.setHeader('Cache-Control', 'private, max-age=3600')
      res.setHeader('Content-Length', String(blob.bytes.length))
      res.send(blob.bytes)
    } catch (err) {
      console.error('[doc-files] signed-read failed:', err)
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
