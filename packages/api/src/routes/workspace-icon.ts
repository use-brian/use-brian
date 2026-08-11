/**
 * Uploaded workspace-icon routes.
 *
 * Authenticated writes mount at `/api/workspaces/:workspaceId/icon`; the
 * public byte proxy mounts separately at `/api/workspace-icons/:workspaceId`
 * because an `<img>` cannot attach the API Bearer token. The proxy returns
 * image bytes only, never workspace metadata.
 *
 * [COMP:api/workspace-icon]
 */

import { randomUUID } from 'node:crypto'
import { Router, type NextFunction, type Request, type Response } from 'express'
import multer, { MulterError } from 'multer'
import type { WorkspaceStore } from '../db/workspace-store.js'
import type { WorkspaceAuditStore } from '../db/workspace-audit-store.js'
import {
  clearWorkspaceIconPointer,
  getWorkspaceIconPointer,
  replaceWorkspaceIconPointer,
  type WorkspaceIconPointer,
} from '../db/workspace-icon.js'
import type { GcsFilesClient } from '../files/gcs-client.js'
import { buildStorageKey, buildStorageUri } from '../files/gcs-client.js'
import type { FilesClientResolver } from '../files/files-api.js'
import { notifyWorkspaceChange } from '../brain-stream/notify.js'

export const MAX_WORKSPACE_ICON_BYTES = 5 * 1024 * 1024

const WORKSPACE_ICON_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
])

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_WORKSPACE_ICON_BYTES, files: 1 },
})

type WorkspaceIconStorageDeps = {
  blobClient: GcsFilesClient
  filesResolver: FilesClientResolver
}

type WorkspaceIconRouteOptions = {
  workspaceStore: WorkspaceStore
  auditStore?: WorkspaceAuditStore
  blobClient?: GcsFilesClient
  filesResolver?: FilesClientResolver
}

async function clientForPointer(
  workspaceId: string,
  pointer: Pick<WorkspaceIconPointer, 'iconStorageUri'>,
  storage: WorkspaceIconStorageDeps,
): Promise<GcsFilesClient> {
  return pointer.iconStorageUri
    ? storage.filesResolver.forUri(workspaceId, pointer.iconStorageUri)
    : storage.blobClient
}

function storageDeps(
  options: WorkspaceIconRouteOptions,
): WorkspaceIconStorageDeps | null {
  if (!options.blobClient || !options.filesResolver) return null
  return { blobClient: options.blobClient, filesResolver: options.filesResolver }
}

async function requireWorkspaceAdmin(
  req: Request,
  res: Response,
  workspaceStore: WorkspaceStore,
): Promise<string | null> {
  const userId = req.userId
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' })
    return null
  }
  const workspaceId = req.params.workspaceId as string
  const role = await workspaceStore.getRole(userId, workspaceId)
  if (role !== 'owner' && role !== 'admin') {
    res.status(403).json({ error: 'Requires admin role' })
    return null
  }
  return userId
}

/** Authenticated upload/remove routes. */
export function workspaceIconRoutes(options: WorkspaceIconRouteOptions): Router {
  const router = Router()

  router.post('/:workspaceId/icon', upload.single('file'), async (req, res) => {
    const userId = await requireWorkspaceAdmin(req, res, options.workspaceStore)
    if (!userId) return

    const storage = storageDeps(options)
    if (!storage) {
      res.status(503).json({ error: 'Workspace icon storage is not configured' })
      return
    }

    const file = req.file
    if (!file) {
      res.status(400).json({ error: 'No file provided' })
      return
    }
    if (!WORKSPACE_ICON_MIMES.has(file.mimetype.toLowerCase())) {
      res.status(400).json({ error: 'Workspace icon must be PNG, JPEG, WebP, GIF, or AVIF' })
      return
    }

    const { workspaceId } = req.params as { workspaceId: string }
    let written: { client: GcsFilesClient; key: string } | null = null
    try {
      const current = await getWorkspaceIconPointer(workspaceId)
      if (!current) {
        res.status(404).json({ error: 'Workspace not found' })
        return
      }

      const iconId = randomUUID()
      const objectId = `workspace-icons/${iconId}`
      const resolved = await storage.filesResolver.forWorkspace(workspaceId)
      const key = buildStorageKey(workspaceId, objectId)
      const storageUri = buildStorageUri(
        resolved.bucket,
        workspaceId,
        objectId,
        resolved.uriScheme,
      )
      written = { client: resolved.gcs, key }
      await resolved.gcs.writeBlob(key, file.buffer, {
        workspaceId,
        createdByUserId: userId,
        mime: file.mimetype.toLowerCase(),
      })

      const iconUrl = `${req.protocol}://${req.get('host')}/api/workspace-icons/${encodeURIComponent(workspaceId)}?v=${iconId.slice(0, 8)}`
      const replaced = await replaceWorkspaceIconPointer(
        workspaceId,
        current.iconStorageKey,
        { iconUrl, iconStorageKey: key, iconStorageUri: storageUri },
      )
      if (!replaced) {
        await resolved.gcs.deleteBlob(key).catch(() => {})
        written = null
        res.status(409).json({ error: 'Workspace icon changed concurrently. Try again.' })
        return
      }

      // Commit the new pointer before cleaning the old object. A cleanup miss
      // leaves an orphan, never a workspace with a broken current icon.
      if (current.iconStorageKey) {
        const previousClient = await clientForPointer(workspaceId, current, storage).catch(() => null)
        await previousClient?.deleteBlob(current.iconStorageKey).catch(() => {})
      }
      written = null

      if (options.auditStore) {
        void options.auditStore.append({
          workspaceId,
          actorUserId: userId,
          eventType: 'workspace.icon_changed',
          details: { kind: 'uploaded' },
        })
      }
      notifyWorkspaceChange(workspaceId, 'workspace_config', 'update')
      res.json({ iconUrl: replaced.iconUrl })
    } catch (err) {
      if (written) await written.client.deleteBlob(written.key).catch(() => {})
      console.error('[workspace-icon] upload failed:', err)
      res.status(500).json({ error: 'Failed to upload workspace icon' })
    }
  })

  router.delete('/:workspaceId/icon', async (req, res) => {
    const userId = await requireWorkspaceAdmin(req, res, options.workspaceStore)
    if (!userId) return

    const storage = storageDeps(options)
    if (!storage) {
      res.status(503).json({ error: 'Workspace icon storage is not configured' })
      return
    }

    const { workspaceId } = req.params as { workspaceId: string }
    try {
      const current = await getWorkspaceIconPointer(workspaceId)
      if (!current) {
        res.status(404).json({ error: 'Workspace not found' })
        return
      }
      if (!current.iconStorageKey) {
        res.json({ iconUrl: null })
        return
      }

      const cleared = await clearWorkspaceIconPointer(workspaceId, current.iconStorageKey)
      if (!cleared) {
        res.status(409).json({ error: 'Workspace icon changed concurrently. Try again.' })
        return
      }

      const previousClient = await clientForPointer(workspaceId, current, storage).catch(() => null)
      await previousClient?.deleteBlob(current.iconStorageKey).catch(() => {})

      if (options.auditStore) {
        void options.auditStore.append({
          workspaceId,
          actorUserId: userId,
          eventType: 'workspace.icon_changed',
          details: { kind: 'generated' },
        })
      }
      notifyWorkspaceChange(workspaceId, 'workspace_config', 'update')
      res.json({ iconUrl: null })
    } catch (err) {
      console.error('[workspace-icon] remove failed:', err)
      res.status(500).json({ error: 'Failed to remove workspace icon' })
    }
  })

  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({
          error: 'file_too_large',
          detail: 'Workspace icons must be 5 MB or smaller.',
        })
        return
      }
      res.status(400).json({ error: 'upload_rejected', detail: err.message })
      return
    }
    next(err)
  })

  return router
}

/** Public image-byte proxy. Mount without auth before bare `/api` guards. */
export function workspaceIconPublicRoutes(storage: WorkspaceIconStorageDeps): Router {
  const router = Router()

  router.get('/:workspaceId', async (req, res) => {
    const { workspaceId } = req.params as { workspaceId: string }
    try {
      const pointer = await getWorkspaceIconPointer(workspaceId)
      if (!pointer?.iconStorageKey) {
        res.status(404).json({ error: 'Not found' })
        return
      }
      const client = await clientForPointer(workspaceId, pointer, storage)
      const blob = await client.readBlob(pointer.iconStorageKey)
      if (!blob || !WORKSPACE_ICON_MIMES.has(blob.mime.toLowerCase())) {
        res.status(404).json({ error: 'Not found' })
        return
      }
      res.setHeader('Content-Type', blob.mime)
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Cache-Control', 'public, max-age=3600')
      res.send(blob.bytes)
    } catch (err) {
      console.error('[workspace-icon] proxy failed:', err)
      res.status(500).json({ error: 'Failed to load workspace icon' })
    }
  })

  return router
}
