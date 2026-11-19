/**
 * Website media library routes. [COMP:api/association-media]
 *
 * Staff (member JWT) list, upload and delete the images and PDFs their public
 * websites render; the website backend (CRM integration key with
 * `association.read`) reads one file by id. Rows are ordinary
 * `workspace_files` under `/doc/website-media/` (see website-media-store.ts),
 * so the bytes follow the deployment's app-default blob store: GCS, Azure
 * Blob or local disk.
 *
 * The integration read answers with a 302 to a short-lived signed URL when the
 * backend issues one (GCS, S3, Azure SAS, or the signed local transfer route),
 * so image bytes never pass through the API or the website backend. The
 * website's image optimizer follows the redirect and caches the result.
 */

import { Router, type Request, type Response } from 'express'
import { randomUUID } from 'node:crypto'
import multer from 'multer'
import type { FilesApi, FilesContext } from '@use-brian/core/workspace-files/api.js'
import type { FilesClientResolver } from '../files/files-api.js'
import { parseStorageKey } from '../files/gcs-client.js'
import { WEBSITE_MEDIA_MIME, WEBSITE_MEDIA_PREFIX, type WebsiteMediaFile, type WebsiteMediaStore } from '../db/website-media-store.js'

export const WEBSITE_MEDIA_MAX_BYTES = 15 * 1024 * 1024
const MAX_FILES = 10
/** Signed URLs the redirect hands out live this long; the Location is cacheable for less. */
const SIGNED_URL_TTL_SEC = 3600
const REDIRECT_MAX_AGE_SEC = 600
const PREVIEW_URL_TTL_SEC = 900

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: WEBSITE_MEDIA_MAX_BYTES, files: MAX_FILES } })

export type WebsiteMediaMembership = (
  userId: string,
  workspaceId: string,
) => Promise<{ role: 'owner' | 'admin' | 'member' | string; clearance: 'public' | 'internal' | 'confidential' } | null>

export type WebsiteMediaDeps = {
  store: WebsiteMediaStore
  filesApi: FilesApi
  resolver: FilesClientResolver
  membership: WebsiteMediaMembership
}

const isMediaMime = (mime: string): boolean => (WEBSITE_MEDIA_MIME as readonly string[]).includes(mime)

function safeName(name: string): string {
  const cleaned = name.replace(/[/\\]/g, '_').replace(/\0/g, '').trim().slice(0, 180)
  return cleaned || 'file'
}

/** Public projection: never the storage URI. */
function wire(file: WebsiteMediaFile) {
  return { id: file.id, name: file.title ?? file.name, mime: file.mime, sizeBytes: file.sizeBytes, updatedAt: file.updatedAt }
}

const canManage = (role: string) => role === 'owner' || role === 'admin'

export function websiteMediaMemberRoutes(deps: WebsiteMediaDeps): Router {
  const router = Router({ mergeParams: true })
  const context = async (req: Request, res: Response) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return null }
    const workspaceId = String(req.params.workspaceId ?? '')
    if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) { res.status(400).json({ error: 'invalid_workspace' }); return null }
    const member = await deps.membership(userId, workspaceId)
    if (!member) { res.status(404).json({ error: 'workspace_not_found' }); return null }
    return { userId, workspaceId, member }
  }

  router.get('/', async (req, res) => {
    try {
      const ctx = await context(req, res)
      if (!ctx) return
      res.json({ media: (await deps.store.list(ctx.workspaceId)).map(wire) })
    } catch (error) {
      console.error('[association-media] list failed:', error)
      res.status(500).json({ error: 'media_unavailable' })
    }
  })

  router.post('/', upload.array('files', MAX_FILES), async (req, res) => {
    try {
      const ctx = await context(req, res)
      if (!ctx) return
      if (!canManage(ctx.member.role)) { res.status(403).json({ error: 'association_forbidden' }); return }
      const files = (req.files as Express.Multer.File[] | undefined) ?? []
      if (files.length === 0) { res.status(400).json({ error: 'no_files' }); return }
      const filesCtx: FilesContext = { workspaceId: ctx.workspaceId, userId: ctx.userId, assistantId: null, clearance: ctx.member.clearance }
      const results: Array<{ name: string; media?: ReturnType<typeof wire>; error?: string }> = []
      for (const file of files) {
        const name = Buffer.from(file.originalname, 'latin1').toString('utf8')
        if (!isMediaMime(file.mimetype)) { results.push({ name, error: 'unsupported_type' }); continue }
        const written = await deps.filesApi.writeBytes(filesCtx, {
          path: `${WEBSITE_MEDIA_PREFIX}${randomUUID()}-${safeName(name)}`,
          bytes: file.buffer,
          mime: file.mimetype,
          title: name,
        })
        if (!written.ok) { results.push({ name, error: written.error.kind }); continue }
        const stored = await deps.store.get(ctx.workspaceId, written.value.id)
        results.push(stored ? { name, media: wire(stored) } : { name, error: 'not_stored' })
      }
      res.status(results.some((row) => row.media) ? 201 : 400).json({ results })
    } catch (error) {
      console.error('[association-media] upload failed:', error)
      res.status(500).json({ error: 'upload_failed' })
    }
  })

  // Staff preview: a short-lived signed URL, returned as JSON because an
  // <img> cannot carry the bearer header (same pattern as doc-files ?redirect=0).
  router.get('/:id/url', async (req, res) => {
    try {
      const ctx = await context(req, res)
      if (!ctx) return
      const file = await deps.store.get(ctx.workspaceId, String(req.params.id))
      if (!file) { res.status(404).json({ error: 'media_not_found' }); return }
      const client = await deps.resolver.forUri(ctx.workspaceId, file.storageUri)
      const url = await client.signedReadUrl(parseStorageKey(file.storageUri), PREVIEW_URL_TTL_SEC)
      if (!/^https?:\/\//i.test(url)) { res.status(409).json({ error: 'preview_unavailable' }); return }
      res.setHeader('Cache-Control', 'no-store')
      res.json({ url })
    } catch (error) {
      console.error('[association-media] preview failed:', error)
      res.status(500).json({ error: 'media_unavailable' })
    }
  })

  router.delete('/:id', async (req, res) => {
    try {
      const ctx = await context(req, res)
      if (!ctx) return
      if (!canManage(ctx.member.role)) { res.status(403).json({ error: 'association_forbidden' }); return }
      const file = await deps.store.get(ctx.workspaceId, String(req.params.id))
      if (!file) { res.status(404).json({ error: 'media_not_found' }); return }
      const removed = await deps.filesApi.delete(
        { workspaceId: ctx.workspaceId, userId: ctx.userId, assistantId: null, clearance: ctx.member.clearance },
        file.id,
      )
      if (!removed.ok) { res.status(409).json({ error: removed.error.kind }); return }
      res.json({ deleted: file.id })
    } catch (error) {
      console.error('[association-media] delete failed:', error)
      res.status(500).json({ error: 'delete_failed' })
    }
  })

  return router
}

/**
 * Serve one website media file to an already-authorized integration caller.
 * 404 for anything outside the website media prefix or allow-list.
 */
export async function sendWebsiteMedia(
  res: Response,
  deps: Pick<WebsiteMediaDeps, 'store' | 'resolver'>,
  workspaceId: string,
  id: string,
): Promise<void> {
  const file = await deps.store.get(workspaceId, id)
  if (!file) { res.status(404).json({ error: 'media_not_found' }); return }
  const client = await deps.resolver.forUri(workspaceId, file.storageUri)
  const key = parseStorageKey(file.storageUri)
  const url = await client.signedReadUrl(key, SIGNED_URL_TTL_SEC)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  if (/^https?:\/\//i.test(url)) {
    res.setHeader('Cache-Control', `private, max-age=${REDIRECT_MAX_AGE_SEC}`)
    res.redirect(302, url)
    return
  }
  const blob = await client.readBlob(key)
  if (!blob) { res.status(404).json({ error: 'media_not_found' }); return }
  res.setHeader('Content-Type', file.mime)
  res.setHeader('Content-Length', String(blob.bytes.length))
  res.setHeader('Cache-Control', `private, max-age=${REDIRECT_MAX_AGE_SEC}`)
  res.send(blob.bytes)
}
