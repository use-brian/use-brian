import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createInMemoryBrowserProfileStore } from '@use-brian/core'
import { verifyBrowserExtPairToken } from '../../auth/browser-ext-pair-token.js'
import { browserExtensionRoutes } from '../browser-extension.js'
import { createTestApp } from './helpers.js'

const SECRET = 'test-secret'
const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'

describe('[COMP:sandbox/browser-tools] Profile-scoped browser-extension pairing routes', () => {
  let profiles: ReturnType<typeof createInMemoryBrowserProfileStore>
  let extensionStatus: ReturnType<typeof vi.fn>

  function app(userId = 'user-1') {
    return createTestApp(
      '/api/browser-extension',
      browserExtensionRoutes({
        jwtSecret: SECRET,
        workspaceStore: {
          getMembership: async (memberId, workspaceId) =>
            memberId === userId && workspaceId === WORKSPACE_ID ? { role: 'member' } : null,
        },
        profileStore: profiles,
        relayWsUrl: 'wss://relay.example/ext',
        extensionStatus,
      }),
      { userId },
    )
  }

  beforeEach(() => {
    profiles = createInMemoryBrowserProfileStore()
    extensionStatus = vi.fn(async () => ({
      connected: true,
      build: 'abc123',
      staleBuild: false,
    }))
  })

  it('binds the short-lived token to the explicitly selected browser profile', async () => {
    const profile = await profiles.create({
      workspaceId: WORKSPACE_ID,
      ownerUserId: 'user-1',
      name: 'Personal Chrome',
      defaultBackend: 'local',
    })

    const response = await request(app())
      .post('/api/browser-extension/pair')
      .send({ workspaceId: WORKSPACE_ID, browserProfileId: profile.id })

    expect(response.status).toBe(200)
    expect(response.body.browserProfileId).toBe(profile.id)
    expect(verifyBrowserExtPairToken(response.body.pairingToken, SECRET)).toMatchObject({
      userId: 'user-1',
      workspaceId: WORKSPACE_ID,
      browserProfileId: profile.id,
    })
  })

  it('keeps the compact one-click path only when one owned local profile is unambiguous', async () => {
    const only = await profiles.create({
      workspaceId: WORKSPACE_ID,
      ownerUserId: 'user-1',
      name: 'Only local profile',
      defaultBackend: 'local',
    })
    const first = await request(app())
      .post('/api/browser-extension/pair')
      .send({ workspaceId: WORKSPACE_ID })
    expect(first.status).toBe(200)
    expect(first.body.browserProfileId).toBe(only.id)

    await profiles.create({
      workspaceId: WORKSPACE_ID,
      ownerUserId: 'user-1',
      name: 'Second local profile',
      defaultBackend: 'local',
    })
    const ambiguous = await request(app())
      .post('/api/browser-extension/pair')
      .send({ workspaceId: WORKSPACE_ID })
    expect(ambiguous.status).toBe(409)
    expect(ambiguous.body.code).toBe('profile_required')
  })

  it('probes the exact profile connection and refuses another owner profile', async () => {
    const mine = await profiles.create({
      workspaceId: WORKSPACE_ID,
      ownerUserId: 'user-1',
      name: 'Mine',
    })
    const theirs = await profiles.create({
      workspaceId: WORKSPACE_ID,
      ownerUserId: 'user-2',
      name: 'Theirs',
    })

    const status = await request(app()).get(
      `/api/browser-extension/status?workspaceId=${WORKSPACE_ID}&browserProfileId=${mine.id}`,
    )
    expect(status.status).toBe(200)
    expect(status.body.connected).toBe(true)
    expect(extensionStatus).toHaveBeenCalledWith('user-1', {
      workspaceId: WORKSPACE_ID,
      browserProfileId: mine.id,
    })

    const forbidden = await request(app())
      .post('/api/browser-extension/pair')
      .send({ workspaceId: WORKSPACE_ID, browserProfileId: theirs.id })
    expect(forbidden.status).toBe(404)
  })
})
