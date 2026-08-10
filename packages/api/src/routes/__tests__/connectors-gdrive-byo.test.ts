/**
 * Google Drive dual OAuth path, open connector router.
 * Component tag: [COMP:api/connectors-route].
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { connectorRoutes } from '../connectors.js'
import { unpackGoogleRefreshCredential } from '../../google/client.js'
import type { ConnectorAppCredentialStore } from '../../db/connector-app-credential-store.js'
import type { ConnectorStore } from '../../db/connector-store.js'
import type { ConnectorInstanceStore } from '../../db/connector-instance-store.js'

const enqueueGDriveOfflineEnrichment = vi.fn(async (_input: unknown) => ({ accepted: 1, skipped: 0 }))
const getGDriveEnrichmentStatus = vi.fn(async (_input: unknown) => ({
  pending: 1, processing: 0, done: 2, failed: 0, superseded: 0, total: 3, lastUpdatedAt: null,
}))
const assertGDriveWorkspaceAdminAuthority = vi.fn(async (_input: unknown) => {})
vi.mock('../../db/gdrive-enrichment-store.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  enqueueGDriveOfflineEnrichment: (input: unknown) => enqueueGDriveOfflineEnrichment(input),
  getGDriveEnrichmentStatus: (input: unknown) => getGDriveEnrichmentStatus(input),
  assertGDriveWorkspaceAdminAuthority: (input: unknown) => assertGDriveWorkspaceAdminAuthority(input),
}))

const configureGDriveCatalog = vi.fn(async (_input: unknown) => 'generation-1')
const getGDriveCatalogStatus = vi.fn(async (_input: unknown) => ({
  configured: true, syncScope: 'selected_folders', selectedFolders: [{ id: 'folder-1', name: 'Company' }],
  status: 'processing', estimatedFiles: 12, filesSeen: 4, filesIndexed: 3, catalogFiles: 3,
  lastError: null, nextSyncAt: null, lastCompletedAt: null,
}))
vi.mock('../../db/gdrive-catalog-store.js', () => ({
  configureGDriveCatalog: (input: unknown) => configureGDriveCatalog(input),
  getGDriveCatalogStatus: (input: unknown) => getGDriveCatalogStatus(input),
  listGDriveCatalogArtifactsOutsideGeneration: vi.fn(async () => []),
}))

const WS = '22222222-2222-2222-2222-222222222222'
const IID = '11111111-1111-1111-1111-111111111111'
const REDIRECT = 'https://app.example/api/auth/callback/google-connector'

function makeApp(workspaceApp: { clientId: string; clientSecret: string } | null) {
  const resolvedApp = workspaceApp ? {
    ...workspaceApp,
    tenantId: '123456789012',
    pickerApiKey: 'picker-key-1',
  } : null
  const createUserInstance = vi.fn().mockResolvedValue({ id: IID })
  const set = vi.fn().mockResolvedValue({
    provider: 'gdrive', workspaceId: WS, clientId: 'customer-client', tenantId: null,
    hasSecret: true, updatedAt: new Date(0),
  })
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { (req as { userId?: string }).userId = 'user-1'; next() })
  app.use('/api/connectors', connectorRoutes({
    connectorStore: { getConfig: vi.fn(), setConfig: vi.fn(), upsert: vi.fn() } as unknown as ConnectorStore,
    connectorInstanceStore: {
      listByUser: vi.fn().mockResolvedValue([]),
      createUserInstance,
      update: vi.fn(),
      setConfig: vi.fn(),
    } as unknown as ConnectorInstanceStore,
    connectorAppCredentialStore: {
      get: vi.fn().mockResolvedValue(workspaceApp ? {
        provider: 'gdrive', workspaceId: WS, clientId: workspaceApp.clientId,
        tenantId: resolvedApp?.tenantId ?? null, hasSecret: true, updatedAt: new Date(0),
      } : null),
      getSystem: vi.fn().mockResolvedValue(resolvedApp),
      set,
      remove: vi.fn(),
    } as unknown as ConnectorAppCredentialStore,
    gdriveCatalog: {
      mintAccessToken: vi.fn(async () => 'access-1'),
      scan: vi.fn(async () => ({ entries: [], fileCount: 12, totalItems: 15 })),
    },
    filesApi: { delete: vi.fn() } as never,
  }))
  return { app, createUserInstance, set }
}

function stubGoogle() {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ access_token: 'access-1', refresh_token: 'refresh-1' }),
    })
    .mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ email: 'admin@company.example' }),
    })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.GOOGLE_CLIENT_ID
  delete process.env.GOOGLE_CLIENT_SECRET
})

describe('[COMP:api/connectors-route] Google Drive BYO OAuth', () => {
  it('estimates, configures, and reports a selected-folder metadata catalog', async () => {
    configureGDriveCatalog.mockClear()
    const { app } = makeApp({ clientId: 'customer-client', clientSecret: 'customer-secret' })
    const scope = {
      workspaceId: WS,
      connectorInstanceId: IID,
      syncScope: 'selected_folders',
      selectedFolders: [{ id: 'folder-1', name: 'Company' }],
    }
    const estimate = await request(app).post('/api/connectors/gdrive/catalog-estimate').send(scope)
    expect(estimate.status).toBe(200)
    expect(estimate.body).toEqual({ estimatedFiles: 12, totalItems: 15 })

    const configured = await request(app).put('/api/connectors/gdrive/catalog-scope').send({
      ...scope, estimatedFiles: 12,
    })
    expect(configured.status).toBe(200)
    expect(configureGDriveCatalog).toHaveBeenCalledWith(expect.objectContaining({
      actingUserId: 'user-1', workspaceId: WS, connectorInstanceId: IID,
      syncScope: 'selected_folders', estimatedFiles: 12,
    }))

    const status = await request(app).get('/api/connectors/gdrive/catalog-status').query({
      workspaceId: WS, connectorInstanceId: IID,
    })
    expect(status.status).toBe(200)
    expect(status.body).toMatchObject({ status: 'processing', filesSeen: 4 })
  })

  it('accepts a strict offline enrichment batch and exposes queue status', async () => {
    enqueueGDriveOfflineEnrichment.mockClear()
    const { app } = makeApp({ clientId: 'customer-client', clientSecret: 'customer-secret' })
    const imported = await request(app).post('/api/connectors/gdrive/enrichment-import').send({
      workspaceId: WS,
      connectorInstanceId: IID,
      bundle: {
        schemaVersion: 1,
        source: 'google-drive',
        files: [{
          fileId: 'drive-1', version: '128', name: 'Renewal playbook',
          mimeType: 'text/plain', summary: 'Renewal instructions.',
        }],
      },
    })
    expect(imported.status).toBe(200)
    expect(imported.body).toMatchObject({ ok: true, accepted: 1, skipped: 0 })
    expect(enqueueGDriveOfflineEnrichment).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WS, connectorInstanceId: IID,
    }))

    const status = await request(app).get('/api/connectors/gdrive/enrichment-status').query({
      workspaceId: WS, connectorInstanceId: IID,
    })
    expect(status.status).toBe(200)
    expect(status.body).toMatchObject({ done: 2, pending: 1 })
  })

  it('accepts gdrive as a configurable workspace OAuth app', async () => {
    const { app, set } = makeApp(null)
    const res = await request(app).put('/api/connectors/gdrive/app-credentials').send({
      workspaceId: WS, clientId: 'customer-client', clientSecret: 'customer-secret',
      projectNumber: '123456789012', pickerApiKey: 'picker-key-1',
    })
    expect(res.status).toBe(200)
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'gdrive', tenantId: '123456789012', pickerApiKey: 'picker-key-1',
    }))
  })

  it('exchanges with the workspace app and pins it to a full-Drive instance', async () => {
    const fetchMock = stubGoogle()
    const { app, createUserInstance } = makeApp({ clientId: 'customer-client', clientSecret: 'customer-secret' })
    const res = await request(app).post('/api/connectors/gdrive/oauth-callback').send({
      code: 'code-1', redirectUri: REDIRECT, workspaceId: WS,
    })

    expect(res.status).toBe(200)
    const tokenForm = String((fetchMock.mock.calls[0]![1] as { body: URLSearchParams }).body)
    expect(tokenForm).toContain('client_id=customer-client')
    expect(tokenForm).toContain('client_secret=customer-secret')
    const created = createUserInstance.mock.calls[0]![0] as {
      credentials: { client_secret: string }
      config: Record<string, unknown>
      connectedEmail: string
    }
    expect(unpackGoogleRefreshCredential(created.credentials.client_secret)).toEqual({
      refreshToken: 'refresh-1',
      appClientId: 'customer-client',
      appClientSecret: 'customer-secret',
      pickerAppId: '123456789012',
      pickerApiKey: 'picker-key-1',
    })
    expect(created.config).toEqual({ scopeVersion: 3, driveAccessMode: 'full_drive_readonly' })
    expect(created.connectedEmail).toBe('admin@company.example')
  })

  it('never falls back to Brian deployment OAuth on the restricted callback', async () => {
    process.env.GOOGLE_CLIENT_ID = 'brian-client'
    process.env.GOOGLE_CLIENT_SECRET = 'brian-secret'
    const fetchMock = stubGoogle()
    const { app, createUserInstance } = makeApp(null)
    const res = await request(app).post('/api/connectors/gdrive/oauth-callback').send({
      code: 'code-1', redirectUri: REDIRECT, workspaceId: WS,
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('app_credentials_missing')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(createUserInstance).not.toHaveBeenCalled()
  })
})
