/** Google Drive Picker authorization shared by OSS and hosted.
 * [COMP:api/gdrive-authorized-files-route] */
import { Router } from 'express'
import { z } from 'zod'
import type { ConnectorStore } from '../db/connector-store.js'
import type { ConnectorInstanceStore } from '../db/connector-instance-store.js'
import { getConnectorConfig } from '../connector-config.js'
import { refreshGoogleAccessToken, unpackGoogleRefreshCredential } from '../google/client.js'

type AuthorizedFile = { id: string; name: string; mimeType: string; addedAt: string }

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})
const upsertBody = z.object({
  files: z.array(z.object({
    id: z.string().min(1).max(1024),
    name: z.string().min(1).max(1024),
    mimeType: z.string().max(255).optional(),
  })).min(1).max(200),
}).strict()
const tokenQuery = z.object({ connectorInstanceId: z.string().uuid().optional() })

export type GDriveAuthorizedFilesRouteOptions = {
  connectorStore: Pick<ConnectorStore, 'getConfig' | 'setConfig' | 'getCredentials'>
  connectorInstanceStore?: Pick<ConnectorInstanceStore, 'getCredentials'>
  refreshAccessToken?: typeof refreshGoogleAccessToken
  getGoogleConfig?: typeof getConnectorConfig
}

export function gdriveAuthorizedFilesRoutes(options: GDriveAuthorizedFilesRouteOptions): Router {
  const router = Router()
  async function load(userId: string): Promise<AuthorizedFile[]> {
    const raw = (await options.connectorStore.getConfig(userId, 'gdrive')).authorizedFiles
    if (!Array.isArray(raw)) return []
    return raw.flatMap((file) => {
      if (!file || typeof file !== 'object') return []
      const value = file as Partial<AuthorizedFile>
      if (typeof value.id !== 'string' || typeof value.name !== 'string') return []
      return [{
        id: value.id,
        name: value.name,
        mimeType: typeof value.mimeType === 'string' ? value.mimeType : 'application/octet-stream',
        addedAt: typeof value.addedAt === 'string' ? value.addedAt : '',
      }]
    })
  }

  router.get('/authorized-files', async (req, res) => {
    if (!req.userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const parsed = listQuery.safeParse(req.query)
    if (!parsed.success) { res.status(400).json({ error: 'Invalid pagination' }); return }
    try {
      const files = (await load(req.userId)).sort((a, b) => b.addedAt.localeCompare(a.addedAt))
      res.json({ files: files.slice(parsed.data.offset, parsed.data.offset + parsed.data.limit), total: files.length })
    } catch (err) {
      console.error('[connectors] list authorized files failed:', err)
      res.status(500).json({ error: 'Failed to list authorized files' })
    }
  })

  router.post('/authorized-files', async (req, res) => {
    if (!req.userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const parsed = upsertBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'No valid files provided' }); return }
    try {
      const byId = new Map((await load(req.userId)).map((file) => [file.id, file]))
      const now = new Date().toISOString()
      for (const file of parsed.data.files) {
        byId.set(file.id, { ...file, mimeType: file.mimeType ?? 'application/octet-stream', addedAt: byId.get(file.id)?.addedAt ?? now })
      }
      const authorizedFiles = [...byId.values()]
      await options.connectorStore.setConfig(req.userId, 'gdrive', { authorizedFiles })
      res.json({ added: parsed.data.files.length, total: authorizedFiles.length })
    } catch (err) {
      console.error('[connectors] add authorized files failed:', err)
      res.status(500).json({ error: 'Failed to add authorized files' })
    }
  })

  router.delete('/authorized-files/:fileId', async (req, res) => {
    if (!req.userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    try {
      const existing = await load(req.userId)
      const authorizedFiles = existing.filter((file) => file.id !== req.params.fileId)
      if (authorizedFiles.length === existing.length) { res.status(404).json({ error: 'File not in authorized list' }); return }
      await options.connectorStore.setConfig(req.userId, 'gdrive', { authorizedFiles })
      res.json({ removed: req.params.fileId, total: authorizedFiles.length })
    } catch (err) {
      console.error('[connectors] remove authorized file failed:', err)
      res.status(500).json({ error: 'Failed to remove authorized file' })
    }
  })

  router.get('/access-token', async (req, res) => {
    if (!req.userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const parsed = tokenQuery.safeParse(req.query)
    if (!parsed.success) { res.status(400).json({ error: 'Invalid connectorInstanceId' }); return }
    try {
      const creds = parsed.data.connectorInstanceId
        ? await options.connectorInstanceStore?.getCredentials(req.userId, parsed.data.connectorInstanceId)
        : await options.connectorStore.getCredentials(req.userId, 'gdrive')
      if (!creds || creds.client_id !== 'google_refresh' || !creds.client_secret) {
        res.status(409).json({ error: 'gdrive not connected' }); return
      }
      const grant = unpackGoogleRefreshCredential(creds.client_secret)
      const deployment = (options.getGoogleConfig ?? getConnectorConfig)('google')
      const clientId = grant.appClientId ?? deployment?.clientId
      const clientSecret = grant.appClientSecret ?? deployment?.clientSecret
      if (!clientId || !clientSecret) { res.status(500).json({ error: 'Google OAuth not configured' }); return }
      const accessToken = await (options.refreshAccessToken ?? refreshGoogleAccessToken)(grant.refreshToken, clientId, clientSecret)
      res.json({
        accessToken,
        expiresIn: 3000,
        ...(grant.pickerAppId && grant.pickerApiKey ? { pickerAppId: grant.pickerAppId, pickerApiKey: grant.pickerApiKey } : {}),
      })
    } catch (err) {
      console.error('[connectors] gdrive access-token failed:', err)
      res.status(500).json({ error: 'Failed to mint access token' })
    }
  })
  return router
}
