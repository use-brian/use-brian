import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { packGoogleRefreshCredential } from '../../google/client.js'
import { createTestApp } from './helpers.js'
import { gdriveAuthorizedFilesRoutes } from '../gdrive-authorized-files.js'

const store = { getConfig: vi.fn(), setConfig: vi.fn(), getCredentials: vi.fn() }
const instances = { getCredentials: vi.fn() }
const refresh = vi.fn()
const app = (userId?: string) => createTestApp('/api/connectors/gdrive', gdriveAuthorizedFilesRoutes({
  connectorStore: store as never,
  connectorInstanceStore: instances as never,
  refreshAccessToken: refresh,
  getGoogleConfig: () => ({ clientId: 'client', clientSecret: 'secret' }),
}), userId ? { userId } : undefined)

beforeEach(() => { vi.resetAllMocks(); store.getConfig.mockResolvedValue({}) })

describe('[COMP:api/gdrive-authorized-files-route] Drive Picker authorization', () => {
  it('lists authorized files newest-first with pagination', async () => {
    store.getConfig.mockResolvedValueOnce({ authorizedFiles: [
      { id: 'old', name: 'Old', mimeType: 'x', addedAt: '2026-01-01T00:00:00Z' },
      { id: 'new', name: 'New', mimeType: 'x', addedAt: '2026-05-01T00:00:00Z' },
    ] })
    expect((await request(app('u-1')).get('/api/connectors/gdrive/authorized-files?limit=1')).body)
      .toMatchObject({ total: 2, files: [{ id: 'new' }] })
  })

  it('upserts and revokes files', async () => {
    store.getConfig.mockResolvedValueOnce({ authorizedFiles: [] })
    expect((await request(app('u-1')).post('/api/connectors/gdrive/authorized-files').send({ files: [{ id: 'f1', name: 'Doc' }] })).status).toBe(200)
    store.getConfig.mockResolvedValueOnce({ authorizedFiles: [{ id: 'f1', name: 'Doc', mimeType: 'x', addedAt: '2026-01-01' }] })
    expect((await request(app('u-1')).delete('/api/connectors/gdrive/authorized-files/f1')).status).toBe(200)
  })

  it('mints a Picker token from the selected connector instance', async () => {
    const id = '11111111-1111-1111-1111-111111111111'
    instances.getCredentials.mockResolvedValueOnce({
      client_id: 'google_refresh',
      client_secret: packGoogleRefreshCredential({
        refreshToken: 'refresh', appClientId: 'byo-client', appClientSecret: 'byo-secret', pickerAppId: 'app', pickerApiKey: 'key',
      }),
    })
    refresh.mockResolvedValueOnce('token')
    expect((await request(app('u-1')).get(`/api/connectors/gdrive/access-token?connectorInstanceId=${id}`)).body)
      .toEqual({ accessToken: 'token', expiresIn: 3000, pickerAppId: 'app', pickerApiKey: 'key' })
  })

  it('mints a Picker token from a legacy blank-client_id row (pre-stamp open store)', async () => {
    // The open store wrote `client_id: ''` for managed Google connects until
    // 2026-08-29; existing self-host rows must keep minting without a reconnect.
    store.getCredentials.mockResolvedValueOnce({ client_id: '', client_secret: 'raw-refresh-token' })
    refresh.mockResolvedValueOnce('token')
    const res = await request(app('u-1')).get('/api/connectors/gdrive/access-token')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ accessToken: 'token', expiresIn: 3000 })
    expect(refresh).toHaveBeenCalledWith('raw-refresh-token', 'client', 'secret')
  })

  it('returns 409 when Drive is disconnected', async () => {
    store.getCredentials.mockResolvedValueOnce(null)
    expect((await request(app('u-1')).get('/api/connectors/gdrive/access-token')).status).toBe(409)
  })
})
