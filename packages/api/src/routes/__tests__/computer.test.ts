import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'
import { computerRoutes } from '../computer.js'
import {
  StubSandboxProvider,
  createCloudBrowserProvider,
  createInMemoryBrowserProfileStore,
  createInMemorySandboxTaskStore,
  createInMemorySessionVault,
  createSandboxOrchestrator,
} from '@sidanclaw/core'

const MEMBER_ROLE = async (_userId: string, _workspaceId: string) => 'member'

describe('[COMP:routes/computer] Take-Over live view + backend toggle + Profile-Management routes', () => {
  let provider: StubSandboxProvider
  let orchestrator: ReturnType<typeof createSandboxOrchestrator>
  let vault: ReturnType<typeof createInMemorySessionVault>
  let profileStore: ReturnType<typeof createInMemoryBrowserProfileStore>
  let profileId: string
  let backendFlips: Array<{ sessionId: string; backend: string | null }>
  let app: ReturnType<typeof createTestApp>

  function makeApp(userId: string) {
    return createTestApp(
      '/api/computer',
      computerRoutes({
        orchestrator,
        provider,
        vault,
        profileStore,
        getWorkspaceRole: MEMBER_ROLE,
        setSessionBackend: (sessionId, backend) => void backendFlips.push({ sessionId, backend }),
      }),
      { userId },
    )
  }

  beforeEach(async () => {
    provider = new StubSandboxProvider()
    vault = createInMemorySessionVault()
    profileStore = createInMemoryBrowserProfileStore()
    backendFlips = []
    const profile = await profileStore.create({
      workspaceId: 'ws-1',
      ownerUserId: 'user-1',
      name: 'Personal',
    })
    profileId = profile.id
    orchestrator = createSandboxOrchestrator({
      provider,
      taskStore: createInMemorySandboxTaskStore(),
      vault,
      profileStore,
    })
    // Start a cloud task for user-1's chat session the way the tools would —
    // browsing AS the profile (R2-4).
    const browser = createCloudBrowserProvider({ provider, binding: orchestrator.binding })
    await browser.navigate(
      { userId: 'user-1', workspaceId: 'ws-1', sessionId: 'sess-1', profileId },
      'https://github.com/notifications',
    )
    app = makeApp('user-1')
  })

  it('lists the CALLER\'s live tasks for the workspace pill; teammates see an empty list', async () => {
    const mine = await request(app).get('/api/computer/tasks?workspaceId=ws-1')
    expect(mine.status).toBe(200)
    expect(mine.body.tasks).toHaveLength(1)
    expect(mine.body.tasks[0]).toMatchObject({ sessionId: 'sess-1', status: 'running' })

    // A member who does not own the task cannot open its live view, so the
    // list must not advertise it to them.
    const teammate = makeApp('user-2')
    const theirs = await request(teammate).get('/api/computer/tasks?workspaceId=ws-1')
    expect(theirs.status).toBe(200)
    expect(theirs.body.tasks).toEqual([])

    const missing = await request(app).get('/api/computer/tasks')
    expect(missing.status).toBe(400)
  })

  it('hides the workspace task list from non-members', async () => {
    const outsider = createTestApp(
      '/api/computer',
      computerRoutes({
        orchestrator,
        provider,
        vault,
        profileStore,
        getWorkspaceRole: async () => null,
        setSessionBackend: () => {},
      }),
      { userId: 'user-1' },
    )
    const res = await request(outsider).get('/api/computer/tasks?workspaceId=ws-1')
    expect(res.status).toBe(404)
  })

  it('returns the active task (with its profile) for its owner and 404 for a session with none', async () => {
    const ok = await request(app).get('/api/computer/tasks/sess-1')
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ status: 'running', workspaceId: 'ws-1', profileId })

    const none = await request(app).get('/api/computer/tasks/sess-9')
    expect(none.status).toBe(404)
  })

  it('hides another user\'s task (ownership check)', async () => {
    const stranger = makeApp('intruder')
    const res = await request(stranger).get('/api/computer/tasks/sess-1')
    expect(res.status).toBe(404)
  })

  it('serves screencast frames and relays takeover input (§4.8)', async () => {
    const frame = await request(app).get('/api/computer/tasks/sess-1/frame')
    expect(frame.status).toBe(200)
    expect(frame.body.mimeType).toBe('image/png')
    expect(typeof frame.body.data).toBe('string')

    const input = await request(app)
      .post('/api/computer/tasks/sess-1/input')
      .send({ kind: 'click', x: 100, y: 60 })
    expect(input.status).toBe(200)

    const bad = await request(app)
      .post('/api/computer/tasks/sess-1/input')
      .send({ kind: 'teleport' })
    expect(bad.status).toBe(400)

    const task = await orchestrator.getActiveTask('sess-1')
    const ops = provider.sandboxes.get(task!.sandboxId)?.actions.map((a) => a.op)
    expect(ops).toContain('takeoverInput')
  })

  it('captures the signed-in session into the PROFILE\'s vault ("I signed in", §4.4/R2-4)', async () => {
    const res = await request(app)
      .post('/api/computer/tasks/sess-1/captured')
      .send({ site: 'github.com' })
    expect(res.status).toBe(200)
    expect(vault.bundles.get(`${profileId}:github.com`)).toBeTruthy()
  })

  it('capture on an identity-less task demands a profile (409 profile_required)', async () => {
    const browser = createCloudBrowserProvider({ provider, binding: orchestrator.binding })
    await browser.navigate(
      { userId: 'user-1', workspaceId: 'ws-1', sessionId: 'sess-2' },
      'https://example.com/',
    )
    const refused = await request(app)
      .post('/api/computer/tasks/sess-2/captured')
      .send({ site: 'example.com' })
    expect(refused.status).toBe(409)
    expect(refused.body.code).toBe('profile_required')

    const bound = await request(app)
      .post('/api/computer/tasks/sess-2/captured')
      .send({ site: 'example.com', profileId })
    expect(bound.status).toBe(200)
    expect(vault.bundles.get(`${profileId}:example.com`)).toBeTruthy()
  })

  it('resume + complete drive the task lifecycle (close-to-stop)', async () => {
    await orchestrator.pauseForTakeover('sess-1')
    const resumed = await request(app).post('/api/computer/tasks/sess-1/resume')
    expect(resumed.status).toBe(200)
    expect((await orchestrator.getActiveTask('sess-1'))?.status).toBe('running')

    const done = await request(app)
      .post('/api/computer/tasks/sess-1/complete')
      .send({ outcome: 'failed' })
    expect(done.status).toBe(200)
    expect(await orchestrator.getActiveTask('sess-1')).toBeNull()
  })

  it('flips the live backend toggle for a session (R2-3)', async () => {
    const flip = await request(app)
      .post('/api/computer/sessions/sess-1/backend')
      .send({ backend: 'local' })
    expect(flip.status).toBe(200)
    const clear = await request(app)
      .post('/api/computer/sessions/sess-1/backend')
      .send({ backend: null })
    expect(clear.status).toBe(200)
    expect(backendFlips).toEqual([
      { sessionId: 'sess-1', backend: 'local' },
      { sessionId: 'sess-1', backend: null },
    ])
    const bad = await request(app)
      .post('/api/computer/sessions/sess-1/backend')
      .send({ backend: 'teleport' })
    expect(bad.status).toBe(400)
  })

  describe('Profile-Management (R2-4)', () => {
    it('lists workspace profiles with their per-site sessions', async () => {
      await vault.put({
        profileId,
        site: 'github.com',
        bundle: { site: 'github.com', cookies: [], capturedAt: new Date().toISOString() },
      })
      const list = await request(app).get('/api/computer/profiles?workspaceId=ws-1')
      expect(list.status).toBe(200)
      expect(list.body.configured).toBe(true)
      expect(list.body.profiles).toEqual([
        expect.objectContaining({
          id: profileId,
          name: 'Personal',
          clearance: 'confidential',
          sessions: [expect.objectContaining({ site: 'github.com' })],
        }),
      ])
      expect((await request(app).get('/api/computer/profiles')).status).toBe(400)
    })

    it('creates a profile owned by the caller, defaulting to the top rung', async () => {
      const created = await request(app)
        .post('/api/computer/profiles')
        .send({ workspaceId: 'ws-1', name: 'Company IG', defaultBackend: 'local' })
      expect(created.status).toBe(200)
      expect(created.body.profile).toMatchObject({
        name: 'Company IG',
        ownerUserId: 'user-1',
        clearance: 'confidential',
        defaultBackend: 'local',
      })
    })

    it('updates (clearance downgrade, enablement, backend) and deletes — OWNER only', async () => {
      const patched = await request(app)
        .patch(`/api/computer/profiles/${profileId}`)
        .send({ clearance: 'internal', enabledAssistantIds: ['11111111-1111-4111-8111-111111111111'] })
      expect(patched.status).toBe(200)
      expect(patched.body.profile).toMatchObject({
        clearance: 'internal',
        enabledAssistantIds: ['11111111-1111-4111-8111-111111111111'],
      })

      const stranger = makeApp('intruder')
      expect(
        (await request(stranger).patch(`/api/computer/profiles/${profileId}`).send({ name: 'Mine now' })).status,
      ).toBe(404)
      expect((await request(stranger).delete(`/api/computer/profiles/${profileId}`)).status).toBe(404)

      expect((await request(app).delete(`/api/computer/profiles/${profileId}`)).status).toBe(200)
      expect(await profileStore.get(profileId)).toBeNull()
    })

    it('revokes one site\'s session inside a profile', async () => {
      await vault.put({
        profileId,
        site: 'github.com',
        bundle: { site: 'github.com', cookies: [], capturedAt: new Date().toISOString() },
      })
      const revoked = await request(app).delete(`/api/computer/profiles/${profileId}/sessions/github.com`)
      expect(revoked.status).toBe(200)
      expect(vault.bundles.size).toBe(0)
    })

    it('starts a user-initiated sign-in task ("Sign in to a site", owner only)', async () => {
      const started = await request(app)
        .post(`/api/computer/profiles/${profileId}/login`)
        .send({ url: 'https://www.instagram.com/' })
      expect(started.status).toBe(200)
      expect(started.body.site).toBe('instagram.com')
      const sessionId = started.body.sessionId as string
      expect(sessionId.startsWith('plogin_')).toBe(true)

      // The synthetic-session task is owned by the caller and pre-bound to
      // the profile — the Take-Over live view + capture work on it unchanged.
      const task = await request(app).get(`/api/computer/tasks/${sessionId}`)
      expect(task.status).toBe(200)
      expect(task.body).toMatchObject({ status: 'running', profileId, workspaceId: 'ws-1' })

      const captured = await request(app)
        .post(`/api/computer/tasks/${sessionId}/captured`)
        .send({ site: 'instagram.com' })
      expect(captured.status).toBe(200)
      expect(vault.bundles.get(`${profileId}:instagram.com`)).toBeTruthy()

      // A stranger cannot start a sign-in on someone else's identity.
      const stranger = makeApp('intruder')
      expect(
        (
          await request(stranger)
            .post(`/api/computer/profiles/${profileId}/login`)
            .send({ url: 'https://x.com/' })
        ).status,
      ).toBe(404)

      // Only http(s) URLs can be opened.
      expect(
        (
          await request(app)
            .post(`/api/computer/profiles/${profileId}/login`)
            .send({ url: 'file:///etc/passwd' })
        ).status,
      ).toBe(400)
    })
  })

  it('answers honestly when nothing is configured', async () => {
    const dark = createTestApp(
      '/api/computer',
      computerRoutes({
        orchestrator: null,
        provider: null,
        vault: null,
        profileStore: null,
        getWorkspaceRole: MEMBER_ROLE,
      }),
      { userId: 'user-1' },
    )
    expect((await request(dark).get('/api/computer/tasks/sess-1')).status).toBe(404)
    const profiles = await request(dark).get('/api/computer/profiles?workspaceId=ws-1')
    expect(profiles.status).toBe(200)
    expect(profiles.body).toEqual({ configured: false, profiles: [] })
    expect(
      (await request(dark).post('/api/computer/sessions/sess-1/backend').send({ backend: 'local' })).status,
    ).toBe(501)
  })
})
