import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'
import { computerRoutes, createInMemoryLocalComputerTaskStore } from '../computer.js'
import {
  BrowserBackendError,
  StubSandboxProvider,
  createCloudBrowserProvider,
  createInMemoryBrowserProfileStore,
  createInMemorySandboxTaskStore,
  createInMemorySessionVault,
  createLocalBrowserProvider,
  createSandboxOrchestrator,
} from '@use-brian/core'
import type {
  BrowserAuthBroker,
  BrowserCredentialAdminStore,
  BrowserCredentialMetadata,
  BrowserProvider,
} from '@use-brian/core'

const MEMBER_ROLE = async (_userId: string, _workspaceId: string) => 'member'

describe('[COMP:routes/computer] Take-Over live view + backend toggle + Profile-Management routes', () => {
  let provider: StubSandboxProvider
  let orchestrator: ReturnType<typeof createSandboxOrchestrator>
  let vault: ReturnType<typeof createInMemorySessionVault>
  let profileStore: ReturnType<typeof createInMemoryBrowserProfileStore>
  let profileId: string
  let backendFlips: Array<{ sessionId: string; backend: string | null }>
  let localProvider: BrowserProvider
  let localTasks: ReturnType<typeof createInMemoryLocalComputerTaskStore>
  let localOps: Array<{ op: string; args?: Record<string, unknown> }>
  let localStatus: { connected: boolean; terminalEvent: 'stopped' | 'tab_closed' | null } | null
  let credentials: BrowserCredentialAdminStore
  let credentialRows: Map<string, BrowserCredentialMetadata>
  let savedSecret: { username: string; password: string } | null
  let authBroker: BrowserAuthBroker
  let app: ReturnType<typeof createTestApp>

  function makeApp(userId: string) {
    return createTestApp(
      '/api/computer',
      computerRoutes({
        orchestrator,
        provider,
        localProvider,
        localTasks,
        localStatus: async () => localStatus,
        vault,
        profileStore,
        credentials,
        authBroker,
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
    localOps = []
    localStatus = { connected: true, terminalEvent: null }
    localTasks = createInMemoryLocalComputerTaskStore()
    credentialRows = new Map()
    savedSecret = null
    credentials = {
      async list({ profileId: requestedProfileId }) {
        return [...credentialRows.values()].filter((row) => row.profileId === requestedProfileId)
      },
      async upsert(params) {
        savedSecret = params.secret
        const now = '2026-08-10T00:00:00.000Z'
        const row: BrowserCredentialMetadata = {
          id: 'cred-1',
          workspaceId: params.workspaceId,
          profileId: params.profileId,
          site: params.site,
          loginUrl: params.loginUrl,
          accountLabel: params.accountLabel ?? null,
          status: 'active',
          lastUsedAt: null,
          lastFailureCode: null,
          createdAt: now,
          updatedAt: now,
        }
        credentialRows.set(row.id, row)
        return row
      },
      async revoke({ profileId: requestedProfileId, credentialId }) {
        const row = credentialRows.get(credentialId)
        if (!row || row.profileId !== requestedProfileId) return false
        credentialRows.delete(credentialId)
        return true
      },
    }
    authBroker = {
      async authenticate(params) {
        return { kind: 'authenticated', credentialId: params.credentialId ?? 'cred-1', site: params.site }
      },
    }
    localProvider = createLocalBrowserProvider({
      transport: {
        async send({ op, args }) {
          localOps.push({ op, args })
          if (op === 'captureFrame') {
            return { ok: true, data: { data: 'local-jpeg', mimeType: 'image/jpeg' } }
          }
          if (op === 'captureState') {
            return {
              ok: true,
              data: {
                site: (args?.site as string | undefined) ?? 'example.com',
                cookies: [{ name: 'sid', value: 'local-cookie' }],
                capturedAt: '2026-08-04T00:00:00.000Z',
              },
            }
          }
          return { ok: true, data: { url: 'https://example.com/', title: 'Example' } }
        },
      },
    })
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
    expect(mine.body.tasks[0]).toMatchObject({ sessionId: 'sess-1', status: 'running', backend: 'cloud' })

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

    // Take-over toolbar navigation (§5): reload + an http(s) goto are accepted.
    const reload = await request(app)
      .post('/api/computer/tasks/sess-1/input')
      .send({ kind: 'navigate', action: 'reload' })
    expect(reload.status).toBe(200)
    const goto = await request(app)
      .post('/api/computer/tasks/sess-1/input')
      .send({ kind: 'navigate', action: 'goto', url: 'https://example.com' })
    expect(goto.status).toBe(200)

    // A goto without an http(s) url is rejected before it reaches the seam.
    const badScheme = await request(app)
      .post('/api/computer/tasks/sess-1/input')
      .send({ kind: 'navigate', action: 'goto', url: 'file:///etc/passwd' })
    expect(badScheme.status).toBe(400)
    const noUrl = await request(app)
      .post('/api/computer/tasks/sess-1/input')
      .send({ kind: 'navigate', action: 'goto' })
    expect(noUrl.status).toBe(400)

    const task = await orchestrator.getActiveTask('sess-1')
    const ops = provider.sandboxes.get(task!.sandboxId)?.actions.map((a) => a.op)
    expect(ops).toContain('takeoverInput')
  })

  it('discovers and controls an owned local-browser task through the same Take-Over routes', async () => {
    localTasks.touch({ userId: 'user-1', workspaceId: 'ws-1', sessionId: 'sess-local', profileId }, 'skyscanner.com')

    const list = await request(app).get('/api/computer/tasks?workspaceId=ws-1')
    expect(list.body.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: 'sess-local', backend: 'local', injectedSite: 'skyscanner.com' }),
    ]))
    const detail = await request(app).get('/api/computer/tasks/sess-local')
    expect(detail.body).toMatchObject({ backend: 'local', workspaceId: 'ws-1' })

    const frame = await request(app).get('/api/computer/tasks/sess-local/frame')
    expect(frame.body).toEqual({ data: 'local-jpeg', mimeType: 'image/jpeg' })
    const input = await request(app)
      .post('/api/computer/tasks/sess-local/input')
      .send({ kind: 'click', x: 100, y: 50, frameW: 200, frameH: 100 })
    expect(input.status).toBe(200)
    expect(localOps.at(-1)).toEqual({
      op: 'takeoverInput',
      args: { event: { kind: 'click', x: 100, y: 50, frameW: 200, frameH: 100 } },
    })
    const pointerDown = await request(app)
      .post('/api/computer/tasks/sess-local/input')
      .send({ kind: 'pointer', action: 'down', x: 100, y: 50, frameW: 200, frameH: 100 })
    const pointerMove = await request(app)
      .post('/api/computer/tasks/sess-local/input')
      .send({ kind: 'pointer', action: 'move', x: 120, y: 60, frameW: 200, frameH: 100 })
    const pointerUp = await request(app)
      .post('/api/computer/tasks/sess-local/input')
      .send({ kind: 'pointer', action: 'up', x: 120, y: 60, frameW: 200, frameH: 100 })
    expect([pointerDown.status, pointerUp.status, pointerMove.status]).toEqual([200, 200, 200])
    expect(localOps.slice(-3).map((entry) => entry.args)).toEqual([
      { event: { kind: 'pointer', action: 'down', x: 100, y: 50, frameW: 200, frameH: 100 } },
      { event: { kind: 'pointer', action: 'move', x: 120, y: 60, frameW: 200, frameH: 100 } },
      { event: { kind: 'pointer', action: 'up', x: 120, y: 60, frameW: 200, frameH: 100 } },
    ])
    expect((await request(app).post('/api/computer/tasks/sess-local/stream-session')).status).toBe(501)
    expect((await request(app).post('/api/computer/tasks/sess-local/captured').send({ site: 'skyscanner.com' })).body.code)
      .toBe('local_session')

    expect((await request(app).post('/api/computer/tasks/sess-local/complete')).status).toBe(200)
    expect(localOps.at(-1)?.op).toBe('stop')
    expect((await request(app).get('/api/computer/tasks/sess-local')).status).toBe(404)
  })

  it('keeps one ephemeral local task per profile, allows different profiles in parallel, and expires abandoned bindings', () => {
    let now = 1_000
    const tasks = createInMemoryLocalComputerTaskStore(() => now)
    tasks.touch({ userId: 'user-1', workspaceId: 'ws-1', sessionId: 'first', profileId: 'profile-a' }, 'one.test')
    tasks.touch({ userId: 'user-1', workspaceId: 'ws-1', sessionId: 'second', profileId: 'profile-b' }, 'two.test')
    expect(tasks.getActiveBySession('first')?.profileId).toBe('profile-a')
    expect(tasks.getActiveBySession('second')?.profileId).toBe('profile-b')

    tasks.touch({ userId: 'user-1', workspaceId: 'ws-1', sessionId: 'third', profileId: 'profile-a' }, 'three.test')
    expect(tasks.getActiveBySession('first')).toBeNull()
    expect(tasks.getActiveBySession('second')?.injectedSite).toBe('two.test')
    expect(tasks.getActiveBySession('third')?.injectedSite).toBe('three.test')

    now += 20 * 60 * 1000
    expect(tasks.getActiveBySession('second')).toBeNull()
    expect(tasks.getActiveBySession('third')).toBeNull()
  })

  it('keeps a local task discoverable when Stop cannot reach the extension', async () => {
    localTasks.touch({ userId: 'user-1', workspaceId: 'ws-1', sessionId: 'sess-local', profileId })
    localProvider = { ...localProvider, stop: async () => { throw new Error('relay unavailable') } }
    app = makeApp('user-1')

    const stopped = await request(app).post('/api/computer/tasks/sess-local/complete')
    expect(stopped.status).toBe(502)
    expect(localTasks.getActiveBySession('sess-local')).not.toBeNull()
  })

  it('retires local tasks from discovery when the extension disconnects', async () => {
    localTasks.touch({ userId: 'user-1', workspaceId: 'ws-1', sessionId: 'sess-local', profileId })
    localStatus = { connected: false, terminalEvent: null }

    const list = await request(app).get('/api/computer/tasks?workspaceId=ws-1')
    expect(list.status).toBe(200)
    expect(list.body.tasks.some((task: { sessionId: string }) => task.sessionId === 'sess-local')).toBe(false)
    expect(localTasks.getActiveBySession('sess-local')).not.toBeNull()
    const disconnected = await request(app).get('/api/computer/tasks/sess-local')
    expect(disconnected.body.connectionState).toBe('disconnected')
    localStatus = { connected: true, terminalEvent: null }
    const reconnected = await request(app).get('/api/computer/tasks?workspaceId=ws-1')
    expect(reconnected.body.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: 'sess-local', backend: 'local' }),
    ]))
    expect((await request(app).post('/api/computer/tasks/sess-local/complete')).status).toBe(200)
    expect(localTasks.getActiveBySession('sess-local')).toBeNull()
  })

  it('keeps local tasks when relay liveness is temporarily unavailable', async () => {
    localTasks.touch({ userId: 'user-1', workspaceId: 'ws-1', sessionId: 'sess-local', profileId })
    localStatus = null

    const list = await request(app).get('/api/computer/tasks?workspaceId=ws-1')
    expect(list.body.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: 'sess-local', backend: 'local' }),
    ]))
    expect(localTasks.getActiveBySession('sess-local')).not.toBeNull()
  })

  it('retires local tasks after the relay observes the controlled tab closing', async () => {
    localTasks.touch({ userId: 'user-1', workspaceId: 'ws-1', sessionId: 'sess-local', profileId })
    localStatus = { connected: true, terminalEvent: 'tab_closed' }

    const list = await request(app).get('/api/computer/tasks?workspaceId=ws-1')
    expect(list.body.tasks.some((task: { sessionId: string }) => task.sessionId === 'sess-local')).toBe(false)
    expect(localTasks.getActiveBySession('sess-local')).toBeNull()
  })

  it('keeps the task when an old relay cannot durably queue Stop during disconnect', async () => {
    localTasks.touch({ userId: 'user-1', workspaceId: 'ws-1', sessionId: 'sess-local', profileId })
    localProvider = {
      ...localProvider,
      stop: async () => { throw new BrowserBackendError('extension disconnected', 'no_extension') },
    }
    app = makeApp('user-1')

    const stopped = await request(app).post('/api/computer/tasks/sess-local/complete')
    expect(stopped.status).toBe(502)
    expect(localTasks.getActiveBySession('sess-local')).not.toBeNull()
  })

  it('retires a local task when frame polling reports that its tab closed', async () => {
    localTasks.touch({ userId: 'user-1', workspaceId: 'ws-1', sessionId: 'sess-local', profileId })
    localProvider = {
      ...localProvider,
      nextTakeoverFrame: async () => { throw new BrowserBackendError('tab closed', 'tab_closed') },
    }
    app = makeApp('user-1')

    const frame = await request(app).get('/api/computer/tasks/sess-local/frame')
    expect(frame.status).toBe(502)
    expect(localTasks.getActiveBySession('sess-local')).toBeNull()
  })

  it('keeps a local task retryable after a command timeout', async () => {
    localTasks.touch({ userId: 'user-1', workspaceId: 'ws-1', sessionId: 'sess-local', profileId })
    localProvider = {
      ...localProvider,
      nextTakeoverFrame: async () => { throw new BrowserBackendError('relay timeout', 'timeout') },
    }
    app = makeApp('user-1')

    const frame = await request(app).get('/api/computer/tasks/sess-local/frame')
    expect(frame.status).toBe(502)
    expect(localTasks.getActiveBySession('sess-local')).not.toBeNull()
  })

  it('keeps a local task retryable while the Firefox companion restarts', async () => {
    localTasks.touch({ userId: 'user-1', workspaceId: 'ws-1', sessionId: 'sess-local', profileId })
    localProvider = {
      ...localProvider,
      nextTakeoverFrame: async () => {
        throw new BrowserBackendError('restart Firefox from the desktop app', 'firefox_restart_required')
      },
    }
    app = makeApp('user-1')

    expect((await request(app).get('/api/computer/tasks/sess-local/frame')).status).toBe(502)
    expect(localTasks.getActiveBySession('sess-local')).not.toBeNull()
  })

  it('releases a stale local binding when the session switches to cloud', async () => {
    localTasks.touch({ userId: 'user-1', workspaceId: 'ws-1', sessionId: 'sess-1', profileId })
    const flip = await request(app)
      .post('/api/computer/sessions/sess-1/backend')
      .send({ backend: 'cloud' })
    expect(flip.status).toBe(200)
    expect(localTasks.getActiveBySession('sess-1')).toBeNull()
    expect((await request(app).get('/api/computer/tasks/sess-1')).body.backend).toBe('cloud')
    expect(localOps.at(-1)?.op).toBe('stop')
  })

  it('does not let another user change or retire an owned local task', async () => {
    localTasks.touch({ userId: 'user-1', workspaceId: 'ws-1', sessionId: 'sess-local', profileId })
    const stranger = makeApp('user-2')
    const flip = await request(stranger)
      .post('/api/computer/sessions/sess-local/backend')
      .send({ backend: 'cloud' })
    expect(flip.status).toBe(404)
    expect(localTasks.getActiveBySession('sess-local')?.userId).toBe('user-1')
    expect(backendFlips).toEqual([])
  })

  it('mints the live-stream session for the owner; 501 when the backend cannot stream (§5 fallback)', async () => {
    // Stub without takeoverStream scripted = a backend without streaming.
    const unsupported = await request(app).post('/api/computer/tasks/sess-1/stream-session')
    expect(unsupported.status).toBe(501)

    // Script the stream endpoints and re-mint: capability URLs pass through.
    provider = new StubSandboxProvider({
      takeoverStream: {
        framesUrl: 'https://49223-sbx.e2b.test/frames?token=tok',
        inputUrl: 'https://49223-sbx.e2b.test/input?token=tok',
      },
    })
    orchestrator = createSandboxOrchestrator({
      provider,
      taskStore: createInMemorySandboxTaskStore(),
      vault,
      profileStore,
    })
    const browser = createCloudBrowserProvider({ provider, binding: orchestrator.binding })
    await browser.navigate(
      { userId: 'user-1', workspaceId: 'ws-1', sessionId: 'sess-stream', profileId },
      'https://github.com/notifications',
    )
    app = makeApp('user-1')
    const res = await request(app).post('/api/computer/tasks/sess-stream/stream-session')
    expect(res.status).toBe(200)
    expect(res.body.framesUrl).toContain('/frames?token=')
    expect(res.body.inputUrl).toContain('/input?token=')

    // Ownership-gated like every other takeover route.
    const stranger = makeApp('user-2')
    const denied = await request(stranger).post('/api/computer/tasks/sess-stream/stream-session')
    expect(denied.status).toBe(404)
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

  describe('[COMP:sandbox/session-capture] "Save this login from my browser" (D5, browser-session-portability.md)', () => {
    it('captures through the local provider with no task at all, and echoes site + capturedAt', async () => {
      const res = await request(app)
        .post(`/api/computer/profiles/${profileId}/capture`)
        .send({ site: 'skyscanner.com' })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true, site: 'skyscanner.com', capturedAt: '2026-08-04T00:00:00.000Z' })
      expect(vault.bundles.get(`${profileId}:skyscanner.com`)).toBeTruthy()
      // No task of any kind was created for this capture — it went straight
      // through the local provider, never through the SandboxProvider or
      // the local task store.
      expect(localTasks.listActiveByWorkspace('ws-1')).toEqual([])
      expect(localOps.find((o) => o.op === 'captureState')).toEqual({
        op: 'captureState',
        args: { site: 'skyscanner.com' },
      })
    })

    it('leaves the existing "I signed in" cloud capture unchanged', async () => {
      const res = await request(app)
        .post('/api/computer/tasks/sess-1/captured')
        .send({ site: 'github.com' })
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(vault.bundles.get(`${profileId}:github.com`)).toBeTruthy()

      // A task whose backend is local still refuses on the task-scoped route
      // (unchanged) — the new profile-scoped route above is the only path
      // for a My Browser capture.
      localTasks.touch({ userId: 'user-1', workspaceId: 'ws-1', sessionId: 'sess-local', profileId })
      const refused = await request(app)
        .post('/api/computer/tasks/sess-local/captured')
        .send({ site: 'skyscanner.com' })
      expect(refused.body.code).toBe('local_session')
    })

    it('is owner-only, like every other route that writes an identity into a profile', async () => {
      const stranger = makeApp('intruder')
      const res = await request(stranger)
        .post(`/api/computer/profiles/${profileId}/capture`)
        .send({ site: 'skyscanner.com' })
      expect(res.status).toBe(404)
      expect(vault.bundles.size).toBe(0)
    })

    it('rejects a missing site before touching the provider', async () => {
      const res = await request(app).post(`/api/computer/profiles/${profileId}/capture`).send({})
      expect(res.status).toBe(400)
      expect(localOps).toEqual([])
    })

    it('answers a typed refusal, not a 500, when the local provider cannot capture', async () => {
      localProvider = { ...localProvider, captureState: undefined }
      app = makeApp('user-1')

      const res = await request(app)
        .post(`/api/computer/profiles/${profileId}/capture`)
        .send({ site: 'skyscanner.com' })
      expect(res.status).toBe(501)
      expect(res.body.code).toBe('capture_unsupported')
      expect(vault.bundles.size).toBe(0)
    })

    it('answers a typed refusal when the vault is not configured', async () => {
      const noVault = createTestApp(
        '/api/computer',
        computerRoutes({
          orchestrator,
          provider,
          localProvider,
          localTasks,
          vault: null,
          profileStore,
          getWorkspaceRole: MEMBER_ROLE,
        }),
        { userId: 'user-1' },
      )
      const res = await request(noVault)
        .post(`/api/computer/profiles/${profileId}/capture`)
        .send({ site: 'skyscanner.com' })
      expect(res.status).toBe(501)
      expect(res.body.code).toBe('capture_unsupported')
    })

    it('maps each BrowserBackendError code to its own status and message, not one flattened failure', async () => {
      const cases: Array<{ code: ConstructorParameters<typeof BrowserBackendError>[1]; status: number }> = [
        { code: 'no_extension', status: 409 },
        { code: 'no_eligible_tab', status: 409 },
        { code: 'site_mismatch', status: 409 },
        { code: 'detached', status: 409 },
        { code: 'not_configured', status: 501 },
        { code: 'timeout', status: 502 },
      ]
      for (const { code, status } of cases) {
        localProvider = {
          ...localProvider,
          captureState: async () => {
            throw new BrowserBackendError(`refused: ${code}`, code)
          },
        }
        app = makeApp('user-1')
        const res = await request(app)
          .post(`/api/computer/profiles/${profileId}/capture`)
          .send({ site: 'skyscanner.com' })
        expect(res.status).toBe(status)
        expect(res.body.error).toBe(`refused: ${code}`)
      }
    })
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
      expect(list.body.credentialAuthConfigured).toBe(true)
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
        localControlMode: 'task_tabs',
      })
    })

    it('round-trips proxyUrl on create and on PATCH (D7)', async () => {
      const created = await request(app)
        .post('/api/computer/profiles')
        .send({ workspaceId: 'ws-1', name: 'Proxied', proxyUrl: 'http://proxy.example:8080' })
      expect(created.status).toBe(200)
      expect(created.body.profile.proxyUrl).toBe('http://proxy.example:8080')

      const patched = await request(app)
        .patch(`/api/computer/profiles/${created.body.profile.id}`)
        .send({ proxyUrl: 'http://other-proxy.example:9090' })
      expect(patched.status).toBe(200)
      expect(patched.body.profile.proxyUrl).toBe('http://other-proxy.example:9090')

      const cleared = await request(app)
        .patch(`/api/computer/profiles/${created.body.profile.id}`)
        .send({ proxyUrl: null })
      expect(cleared.status).toBe(200)
      expect(cleared.body.profile.proxyUrl).toBeNull()
    })

    it('updates (clearance downgrade, enablement, backend) and deletes — OWNER only', async () => {
      const patched = await request(app)
        .patch(`/api/computer/profiles/${profileId}`)
        .send({
          clearance: 'internal',
          enabledAssistantIds: ['11111111-1111-4111-8111-111111111111'],
          localControlMode: 'full_browser',
        })
      expect(patched.status).toBe(200)
      expect(patched.body.profile).toMatchObject({
        clearance: 'internal',
        enabledAssistantIds: ['11111111-1111-4111-8111-111111111111'],
        localControlMode: 'full_browser',
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

    it('stores browser credentials through owner-only write-only routes and tests via the broker', async () => {
      const saved = await request(app)
        .post(`/api/computer/profiles/${profileId}/credentials`)
        .send({
          loginUrl: 'https://accounts.example.com/login',
          accountLabel: 'Primary account',
          username: 'member@example.com',
          password: 'secret-password',
        })
      expect(saved.status).toBe(200)
      expect(saved.body.credential).toMatchObject({
        id: 'cred-1',
        site: 'example.com',
        accountLabel: 'Primary account',
      })
      expect(saved.body).not.toHaveProperty('username')
      expect(saved.body).not.toHaveProperty('password')
      expect(savedSecret).toEqual({ username: 'member@example.com', password: 'secret-password' })

      const list = await request(app).get('/api/computer/profiles?workspaceId=ws-1')
      expect(list.body.profiles[0].credentials).toEqual([
        expect.objectContaining({ id: 'cred-1', site: 'example.com' }),
      ])
      expect(JSON.stringify(list.body)).not.toContain('secret-password')
      expect(JSON.stringify(list.body)).not.toContain('member@example.com')

      const tested = await request(app).post(
        `/api/computer/profiles/${profileId}/credentials/cred-1/test`,
      )
      expect(tested.status).toBe(200)
      expect(tested.body).toEqual({ ok: true, status: 'authenticated', site: 'example.com' })

      const stranger = makeApp('intruder')
      expect(
        (
          await request(stranger)
            .post(`/api/computer/profiles/${profileId}/credentials`)
            .send({
              loginUrl: 'https://accounts.example.com/login',
              username: 'x',
              password: 'y',
            })
        ).status,
      ).toBe(404)
      expect(
        (
          await request(app)
            .post(`/api/computer/profiles/${profileId}/credentials`)
            .send({ loginUrl: 'http://example.com/login', username: 'x', password: 'y' })
        ).status,
      ).toBe(400)

      const revoked = await request(app).delete(
        `/api/computer/profiles/${profileId}/credentials/cred-1`,
      )
      expect(revoked.status).toBe(200)
      expect(credentialRows.size).toBe(0)
    })

    it('starts a user-initiated sign-in task ("Sign in to a site", owner only)', async () => {
      const started = await request(app)
        .post(`/api/computer/profiles/${profileId}/login`)
        .send({ url: 'https://www.instagram.com/' })
      expect(started.status).toBe(200)
      expect(started.body.site).toBe('instagram.com')
      const sessionId = started.body.sessionId as string
      // A BARE uuid — `sandbox_tasks.session_id` is `uuid NOT NULL` (closed
      // migration 315), so a decorated id (the old synthetic `plogin_<uuid>`)
      // makes the task insert throw `invalid input syntax for type uuid` and
      // the route 502s. The in-memory task store accepts any string, so this
      // shape assertion is the only place the DB contract is enforced in test.
      expect(sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      )

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
    expect(profiles.body).toEqual({ configured: false, credentialAuthConfigured: false, profiles: [] })
    expect(
      (await request(dark).post('/api/computer/sessions/sess-1/backend').send({ backend: 'local' })).status,
    ).toBe(501)
  })
})
