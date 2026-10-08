import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createInMemoryBrowserProfileStore, type DepartmentReadGrant } from '@use-brian/core'
import { signBrowserExtPairToken, signBrowserExtSessionToken, verifyBrowserExtPairToken } from '../../auth/browser-ext-pair-token.js'
import { browserExtensionAuthorityRoutes, browserExtensionRoutes } from '../browser-extension.js'
import { createTestApp } from './helpers.js'
import { createTokens } from '../../auth/jwt.js'

const SECRET = 'test-secret'
const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'

describe('[COMP:sandbox/browser-tools] Profile-scoped browser-extension pairing routes', () => {
  let profiles: ReturnType<typeof createInMemoryBrowserProfileStore>
  let extensionStatus: ReturnType<typeof vi.fn>
  let departmentRead: DepartmentReadGrant | null

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
        getProfileReadGrant: async () => departmentRead,
        relayWsUrl: 'wss://relay.example/ext',
        extensionStatus,
      }),
      { userId },
    )
  }

  beforeEach(() => {
    profiles = createInMemoryBrowserProfileStore()
    departmentRead = null
    extensionStatus = vi.fn(async () => ({
      connected: true,
      build: 'abc123',
      staleBuild: false,
    }))
  })

  it('renews signed pairing and session authority without trusting request identity', async () => {
    const profile = await profiles.create({ workspaceId: WORKSPACE_ID, ownerUserId: 'user-1',
      name: 'Department browser', defaultBackend: 'local', departmentId: 'department-1' })
    departmentRead = { workspaceId: WORKSPACE_ID, userId: 'user-1', assistantId: null,
      base: 'public', departments: { 'department-1': 'confidential' },
      contextDepartment: null, binding: null, cap: null }
    const getMembership = vi.fn(async () => ({ role: 'member' } as unknown | null))
    const getProfileReadGrant = vi.fn(async () => departmentRead)
    const authorityApp = createTestApp('/api/browser-extension', browserExtensionAuthorityRoutes({
      jwtSecret: SECRET, workspaceStore: { getMembership }, profileStore: profiles, getProfileReadGrant,
    }))
    const claims = { userId: 'user-1', workspaceId: WORKSPACE_ID, browserProfileId: profile.id }
    const check = (token: string) => request(authorityApp).post('/api/browser-extension/authority')
      .set('Authorization', `Bearer ${token}`).send({ userId: 'other', workspaceId: 'other' })
    const pair = signBrowserExtPairToken(claims, SECRET)
    const session = signBrowserExtSessionToken(claims, SECRET)
    expect((await check(pair)).status).toBe(204)
    expect((await check(session)).headers['cache-control']).toBe('no-store')
    expect(getMembership).toHaveBeenCalledWith('user-1', WORKSPACE_ID)
    departmentRead.departments = {}
    expect((await check(pair)).status).toBe(403)
    expect((await check(session)).body).toEqual({ code: 'not_authorized' })
    departmentRead.departments = { 'department-1': 'confidential' }
    getMembership.mockResolvedValueOnce(null)
    expect((await check(session)).status).toBe(403)
    getProfileReadGrant.mockRejectedValueOnce(new Error('private diagnostic'))
    expect((await check(session)).body).toEqual({ code: 'not_authorized' })
    for (const changed of [{ userId: 'other' }, { workspaceId: 'other' }, { browserProfileId: 'missing' }]) {
      expect((await check(signBrowserExtSessionToken({ ...claims, ...changed }, SECRET))).status).toBe(403)
    }
    expect((await check('invalid')).status).toBe(401)
    expect((await check(signBrowserExtPairToken(claims, 'wrong-secret'))).status).toBe(401)
    expect((await check(createTokens('user-1', SECRET).accessToken)).status).toBe(401)
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now - 601_000)
    const expired = signBrowserExtPairToken(claims, SECRET)
    clock.mockRestore()
    expect((await check(expired)).status).toBe(401)
  })

  it('requires current department authority for pairing and status, including after the relay probe', async () => {
    const profile = await profiles.create({ workspaceId: WORKSPACE_ID, ownerUserId: 'user-1',
      name: 'Department browser', defaultBackend: 'local', departmentId: 'department-1' })
    departmentRead = { workspaceId: WORKSPACE_ID, userId: 'user-1', assistantId: null,
      base: 'public', departments: { 'department-1': 'confidential' },
      contextDepartment: null, binding: null, cap: null }
    const pair = () => request(app()).post('/api/browser-extension/pair')
      .send({ workspaceId: WORKSPACE_ID, browserProfileId: profile.id })
    const status = () => request(app()).get(`/api/browser-extension/status?browserProfileId=${profile.id}`)
    expect((await pair()).status).toBe(200)
    expect((await status()).body.connected).toBe(true)
    departmentRead.departments = {}
    extensionStatus.mockClear()
    expect((await pair()).status).toBe(404)
    expect((await status()).status).toBe(404)
    expect(extensionStatus).not.toHaveBeenCalled()
    departmentRead.departments = { 'department-1': 'confidential' }
    extensionStatus.mockImplementationOnce(async () => {
      departmentRead!.departments = {}
      return { connected: true, build: 'private-build', staleBuild: false }
    })
    const revoked = await status()
    expect(revoked.status).toBe(404)
    expect(JSON.stringify(revoked.body)).not.toContain('private-build')
  })

  it('does not probe aggregate connections when no protected profile is selected', async () => {
    const response = await request(app()).get(`/api/browser-extension/status?workspaceId=${WORKSPACE_ID}`)
    expect(response.body).toEqual({ configured: true, connected: false, build: null, staleBuild: false })
    expect(extensionStatus).not.toHaveBeenCalled()
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
