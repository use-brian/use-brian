import { describe, it, expect, beforeEach, vi } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'
import { computerRoutes, createInMemoryLocalComputerTaskStore } from '../computer.js'
import {
  BrowserBackendError,
  BrowserProfileAuthoritySchema,
  StubSandboxProvider,
  createCloudBrowserProvider,
  createInMemoryBrowserProfileStore,
  createInMemoryBrowserSkillGrantStore,
  createInMemorySandboxTaskStore,
  createInMemorySessionVault,
  createLocalBrowserProvider,
  createSandboxOrchestrator,
} from '@use-brian/core'
import type {
  DepartmentReadGrant,
  BrowserAuthBroker,
  BrowserCredentialAdminStore,
  BrowserCredentialMetadata,
  BrowserProvider,
} from '@use-brian/core'

const MEMBER_ROLE = async (_userId: string, _workspaceId: string) => 'member'

/**
 * The owner's task whose authority no longer holds is listed only as a
 * discard stub: lifecycle metadata, no profile, no site, nothing live.
 */
function expectOnlyDiscardStubs(tasks: Record<string, unknown>[], sessionIds: string[]) {
  expect(tasks.map((task) => task.sessionId).sort()).toEqual([...sessionIds].sort())
  for (const task of tasks) {
    expect(Object.keys(task).sort()).toEqual(['backend', 'createdAt', 'injectedSite', 'lastActivityAt', 'profileId', 'sessionId', 'status', 'taskId', 'unavailable'])
    expect(task).toMatchObject({ unavailable: true, profileId: null, injectedSite: null })
  }
}

describe('[COMP:routes/computer] Take-Over live view + backend toggle + Profile-Management routes', () => {
  it('requires current membership for the browser destination directory and denies lookup failures', async () => {
    const preview = vi.fn(async () => ({ departments: [{ id: 'dept', name: 'Visible', clearance: 'internal' as const }] }))
    const role = vi.fn(async () => 'member' as string | null)
    const app = createTestApp('/api/computer', computerRoutes({
      orchestrator: null, provider: null, vault: null, profileStore: null, getWorkspaceRole: role,
      previewProfileDestination: preview, setSessionBackend: () => {},
    }), { userId: 'user-1' })
    const get = () => request(app).get('/api/computer/profile-destinations?workspaceId=ws-1')
    const allowed = await get()
    expect(allowed.status).toBe(200)
    expect(allowed.headers['cache-control']).toBe('no-store')
    expect(preview).toHaveBeenCalledWith('user-1', 'ws-1')
    role.mockResolvedValueOnce(null)
    expect((await get()).status).toBe(403)
    expect(preview).toHaveBeenCalledTimes(1)
    preview.mockRejectedValueOnce(new Error('hidden department details'))
    expect((await get()).body).toEqual({ code: 'not_authorized' })
  })

  it('requires and persists admitted department ownership for shared v2 creation', async () => {
    const departmentId = '00000000-0000-4000-8000-000000000123'
    const store = createInMemoryBrowserProfileStore()
    const admit = vi.fn(async () => {})
    const grant: DepartmentReadGrant = { workspaceId: 'ws-1', userId: 'user-1', assistantId: null,
      base: 'public', departments: { [departmentId]: 'confidential' }, contextDepartment: null, binding: null, cap: null }
    const build = (admission = true) => createTestApp('/api/computer', computerRoutes({
      orchestrator: null, provider: null, vault: null, profileStore: store,
      getWorkspaceRole: MEMBER_ROLE, getProfileReadGrant: async () => grant,
      ...(admission ? { admitProfileDestination: admit } : {}), setSessionBackend: () => {},
    }), { userId: 'user-1' })
    const body = { workspaceId: 'ws-1', name: 'Department identity', scope: 'workspace', clearance: 'confidential' }
    expect((await request(build()).post('/api/computer/profiles').send(body)).body.code).toBe('department_required')
    expect((await request(build(false)).post('/api/computer/profiles').send({ ...body, departmentId })).status).toBe(403)
    admit.mockRejectedValueOnce(new Error('unavailable private department'))
    const denied = await request(build()).post('/api/computer/profiles').send({ ...body, departmentId })
    expect(denied.status).toBe(403)
    expect(JSON.stringify(denied.body)).not.toContain('private department')
    expect(await store.list({ workspaceId: 'ws-1' })).toHaveLength(0)
    const allowed = await request(build()).post('/api/computer/profiles').send({ ...body, departmentId })
    expect(allowed.status).toBe(200)
    expect(allowed.body.profile.departmentId).toBe(departmentId)
    expect(admit).toHaveBeenLastCalledWith('user-1', 'ws-1', { departmentId, sensitivity: 'confidential' })
    const create = vi.spyOn(store, 'create').mockRejectedValueOnce(Object.assign(new Error('private persistence detail'), { code: 'profile_authority_denied' }))
    const raced = await request(build()).post('/api/computer/profiles').send({ ...body, departmentId })
    expect(raced.status).toBe(403)
    expect(raced.body.code).toBe('not_authorized')
    expect(JSON.stringify(raced.body)).not.toContain('private persistence detail')
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ ownerUserId: 'user-1', departmentId }), { userId: 'user-1' })
  })

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

  it('passes admitted profiles into credential writes and hides persistence authority errors', async () => {
    const denied=Object.assign(new Error('private credential authority detail'),{code:'profile_authority_denied'})
    const save=vi.spyOn(credentials,'upsert').mockRejectedValueOnce(denied)
    const response=await request(app).post(`/api/computer/profiles/${profileId}/credentials`)
      .send({loginUrl:'https://portal.example/login',username:'fictional@example.com',password:'fictional-secret'})
    expect(response.status).toBe(403)
    expect(response.body.code).toBe('not_authorized')
    expect(JSON.stringify(response.body)).not.toContain('private credential authority detail')
    expect(response.body.credential).toBeUndefined()
    expect(save).toHaveBeenCalledWith(expect.objectContaining({profileId}),expect.objectContaining({id:profileId}))
    const revoke=vi.spyOn(credentials,'revoke').mockRejectedValueOnce(denied)
    const removed=await request(app).delete(`/api/computer/profiles/${profileId}/credentials/fictional-credential`)
    expect(removed.status).toBe(403)
    expect(removed.body.ok).toBeUndefined()
    expect(revoke).toHaveBeenCalledWith({profileId,credentialId:'fictional-credential'},expect.objectContaining({id:profileId}))
  })

  function makeApp(userId: string, getProfileReadGrant?: (userId: string, workspaceId: string) => Promise<DepartmentReadGrant | null>) {
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
        getProfileReadGrant,
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
        return { kind: 'authenticated', credentialId: params.credentialId ?? 'cred-1', credentialVersion: 'fixture-version', site: params.site }
      },
    }
    localProvider = createLocalBrowserProvider({ admit: async () => async () => {},
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

  async function restartCloudTaskWithCurrentProfile() {
    await orchestrator.completeTask('sess-1', 'failed')
    await createCloudBrowserProvider({provider,binding:orchestrator.binding}).navigate(
      {userId:'user-1',workspaceId:'ws-1',sessionId:'sess-1',profileId}, 'https://portal.example/account')
  }

  it.each(['cloud', 'local'] as const)('renews department access for %s live task disclosure and control', async (backend) => {
    await profileStore.update(profileId, { scope: 'workspace', departmentId: 'department-1' })
    if (backend === 'cloud') await restartCloudTaskWithCurrentProfile()
    if (backend === 'local') localTasks.touch({ profileAuthority: BrowserProfileAuthoritySchema.parse(await profileStore.get(profileId)), userId: 'user-1', workspaceId: 'ws-1', sessionId: 'sess-1', profileId })
    let allowed = true
    app = makeApp('user-1', async (): Promise<DepartmentReadGrant> => ({ workspaceId: 'ws-1', userId: 'user-1', assistantId: null,
      base: 'public', departments: allowed ? { 'department-1': 'confidential' } : {},
      contextDepartment: null, binding: null, cap: null }))
    expect((await request(app).get('/api/computer/tasks/sess-1')).status).toBe(200)
    allowed = false
    const providerCalls = localOps.length
    expectOnlyDiscardStubs((await request(app).get('/api/computer/tasks?workspaceId=ws-1')).body.tasks, ['sess-1'])
    for (const suffix of ['', '/frame']) {
      expect((await request(app).get(`/api/computer/tasks/sess-1${suffix}`)).status).toBe(404)
    }
    for (const suffix of ['/resume', '/input', '/stream-session', '/captured', '/complete']) {
      expect((await request(app).post(`/api/computer/tasks/sess-1${suffix}`).send({ site: 'example.com' })).status).toBe(404)
    }
    expect((await request(app).post('/api/computer/sessions/sess-1/backend').send({ backend: 'cloud' })).status).toBe(404)
    expect(localOps.length).toBe(providerCalls)
    expect(backendFlips).toEqual([])
    expect(vault.bundles.size).toBe(0)
    allowed = true
    expect((await request(app).get('/api/computer/tasks/sess-1')).status).toBe(200)
  })

  it('does not expose or control an old cloud task through its newly readable profile department', async () => {
    await profileStore.update(profileId,{scope:'workspace',departmentId:'department-1'})
    await restartCloudTaskWithCurrentProfile()
    let allowedDepartment = 'department-1'
    app = makeApp('user-1', async () => ({workspaceId:'ws-1',userId:'user-1',assistantId:null,
      base:'public',departments:{[allowedDepartment]:'confidential'},contextDepartment:null,binding:null,cap:null}))
    expect((await request(app).get('/api/computer/tasks/sess-1/frame')).status).toBe(200)
    await profileStore.update(profileId,{departmentId:'department-2'})
    allowedDepartment = 'department-2'
    // The current profile is readable, but it cannot relabel an old task's source.
    expect((await request(app).get('/api/computer/profiles?workspaceId=ws-1')).body.profiles.map((p:{id:string})=>p.id)).toContain(profileId)
    const providerAccess = vi.spyOn(provider,'browser')
    expectOnlyDiscardStubs((await request(app).get('/api/computer/tasks?workspaceId=ws-1')).body.tasks, ['sess-1'])
    for (const suffix of ['', '/frame']) expect((await request(app).get(`/api/computer/tasks/sess-1${suffix}`)).status).toBe(404)
    for (const suffix of ['/resume','/input','/stream-session','/captured','/complete']) {
      expect((await request(app).post(`/api/computer/tasks/sess-1${suffix}`).send({site:'portal.example',kind:'key',text:'fictional'})).status).toBe(404)
    }
    expect((await request(app).post('/api/computer/sessions/sess-1/backend').send({backend:'local'})).status).toBe(404)
    expect(providerAccess).not.toHaveBeenCalled()
    expect(backendFlips).toEqual([])
    expect(vault.bundles.size).toBe(0)
  })

  it.each(['frame','stream-session'] as const)('withholds %s when classification changes during the provider operation', async surface => {
    await profileStore.update(profileId,{scope:'workspace',departmentId:'department-1'})
    await restartCloudTaskWithCurrentProfile()
    app = makeApp('user-1', async () => ({workspaceId:'ws-1',userId:'user-1',assistantId:null,
      base:'public',departments:{'department-1':'confidential','department-2':'confidential'},contextDepartment:null,binding:null,cap:null}))
    const remote = provider.browser.bind(provider)
    const operation = vi.fn(async () => {await profileStore.update(profileId,{departmentId:'department-2'})})
    const close = vi.fn(async () => {})
    vi.spyOn(provider,'browser').mockImplementation(id => ({...remote(id),
      takeover:() => ({nextFrame:async()=>{await operation();return {data:'fixture-secret-frame',mimeType:'image/png' as const}},input:async()=>{},close}),
      openTakeoverStream:async()=>{await operation();return {framesUrl:'https://browser.example/fixture-secret',inputUrl:'https://browser.example/fixture-secret-input'}},
    }))
    const response = surface === 'frame'
      ? await request(app).get('/api/computer/tasks/sess-1/frame')
      : await request(app).post('/api/computer/tasks/sess-1/stream-session')
    expect(operation).toHaveBeenCalledTimes(1)
    expect(response.status).toBe(404)
    expect(JSON.stringify(response.body)).not.toContain('fixture-secret')
    if(surface==='frame')expect(close).toHaveBeenCalledTimes(1)
  })

  it.each(['legacy','deleted-profile'] as const)('withholds %s cloud tasks instead of inferring a new source floor', async kind => {
    const task = (await orchestrator.getActiveTask('sess-1'))!
    const unavailable = kind === 'legacy' ? {...task,profileAuthority:null} : {...task,profileId:null}
    vi.spyOn(orchestrator,'getActiveTask').mockResolvedValue(unavailable)
    vi.spyOn(orchestrator,'listActiveTasks').mockResolvedValue([unavailable])
    const providerAccess = vi.spyOn(provider,'browser')
    expectOnlyDiscardStubs((await request(app).get('/api/computer/tasks?workspaceId=ws-1')).body.tasks, ['sess-1'])
    expect((await request(app).get('/api/computer/tasks/sess-1/frame')).status).toBe(404)
    expect(providerAccess).not.toHaveBeenCalled()
  })

  it('keeps live task access after a metadata-only profile rename', async () => {
    await profileStore.update(profileId,{name:'Renamed fictional browser'})
    expect((await request(app).get('/api/computer/tasks/sess-1/frame')).status).toBe(200)
  })

  it('withholds stream capabilities if authority changes during minting', async () => {
    const originalBrowser = provider.browser.bind(provider)
    vi.spyOn(provider, 'browser').mockImplementation(id => ({ ...originalBrowser(id),
      openTakeoverStream: async () => ({ framesUrl: 'https://browser.example/frames', inputUrl: 'https://browser.example/input' }) }))
    await profileStore.update(profileId, { scope: 'workspace', departmentId: 'department-1' })
    await restartCloudTaskWithCurrentProfile()
    let reads = 0
    app = makeApp('user-1', async (): Promise<DepartmentReadGrant> => ({ workspaceId: 'ws-1', userId: 'user-1', assistantId: null,
      base: 'public', departments: ++reads === 1 ? { 'department-1': 'confidential' } : {},
      contextDepartment: null, binding: null, cap: null }))
    const result = await request(app).post('/api/computer/tasks/sess-1/stream-session')
    expect(result.status).toBe(404)
    expect(result.body.framesUrl).toBeUndefined()
  })

  it('withholds a frame when the department grant expires during provider capture', async () => {
    await profileStore.update(profileId, { scope: 'workspace', departmentId: 'department-1' })
    localTasks.touch({ profileAuthority: BrowserProfileAuthoritySchema.parse(await profileStore.get(profileId)), userId: 'user-1', workspaceId: 'ws-1', sessionId: 'sess-1', profileId })
    let allowed = true
    localProvider = { ...localProvider, nextTakeoverFrame: async () => {
      allowed = false
      return { data: 'protected-frame', mimeType: 'image/jpeg' }
    } }
    app = makeApp('user-1', async (): Promise<DepartmentReadGrant> => ({ workspaceId: 'ws-1', userId: 'user-1', assistantId: null,
      base: 'public', departments: allowed ? { 'department-1': 'confidential' } : {},
      contextDepartment: null, binding: null, cap: null }))
    const result = await request(app).get('/api/computer/tasks/sess-1/frame')
    expect(result.status).toBe(404)
    expect(JSON.stringify(result.body)).not.toContain('protected-frame')
  })

  it('cannot capture a bound task into another profile, including a readable shared identity', async () => {
    const other = await profileStore.create({ workspaceId: 'ws-1', ownerUserId: 'user-2', name: 'Shared', scope: 'workspace' })
    expect((await request(app).post('/api/computer/tasks/sess-1/captured')
      .send({ site: 'example.com', profileId: other.id })).status).toBe(404)
    const ownOther = await profileStore.create({ workspaceId: 'ws-1', ownerUserId: 'user-1', name: 'Other identity' })
    expect((await request(app).post('/api/computer/tasks/sess-1/captured')
      .send({ site: 'example.com', profileId: ownOther.id })).status).toBe(404)
    expect(vault.bundles.size).toBe(0)
  })

  it('lists the owner\'s unavailable task as a discard stub, never a teammate\'s', async () => {
    const task = (await orchestrator.getActiveTask('sess-1'))!
    const unavailable = { ...task, profileAuthority: null }
    vi.spyOn(orchestrator, 'getActiveTask').mockResolvedValue(unavailable)
    vi.spyOn(orchestrator, 'listActiveTasks').mockResolvedValue([unavailable])
    expectOnlyDiscardStubs((await request(app).get('/api/computer/tasks?workspaceId=ws-1')).body.tasks, ['sess-1'])
    expect((await request(makeApp('user-2')).get('/api/computer/tasks?workspaceId=ws-1')).body.tasks).toEqual([])
  })

  it('qualifies a human-origin task as live and a legacy agent-origin task without source evidence as a discard stub', async () => {
    const human = (await orchestrator.getActiveTask('sess-1'))!
    expect(human.executionAuthority ?? null).toBeNull()
    const legacyAgent = { ...human, taskId: 'task-legacy', sessionId: 'sess-legacy', executionAuthority: { version: 1 }, sourceAuthority: null }
    vi.spyOn(orchestrator, 'listActiveTasks').mockResolvedValue([human, legacyAgent] as never)
    const assertTaskAuthority = vi.spyOn(orchestrator, 'assertTaskAuthority')
      .mockRejectedValue(Object.assign(new Error('unavailable'), { code: 'profile_authority_denied' }))
    const tasks = (await request(app).get('/api/computer/tasks?workspaceId=ws-1')).body.tasks as Record<string, unknown>[]
    expect(tasks.find((task) => task.sessionId === 'sess-1')).toMatchObject({ backend: 'cloud', status: 'running' })
    expect(tasks.find((task) => task.sessionId === 'sess-1')).not.toHaveProperty('unavailable')
    expectOnlyDiscardStubs(tasks.filter((task) => task.sessionId === 'sess-legacy'), ['sess-legacy'])
    expect(assertTaskAuthority).toHaveBeenCalledOnce()
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

  it('hides a transferred local task and refuses provider operations without rewriting its original department', async () => {
    await profileStore.update(profileId, { scope: 'workspace', departmentId: 'department-1' })
    localTasks.touch({ userId: 'user-1', workspaceId: 'ws-1', sessionId: 'sess-local', profileId,
      profileAuthority: BrowserProfileAuthoritySchema.parse(await profileStore.get(profileId)) })
    await profileStore.update(profileId, { departmentId: 'department-2' })
    app = makeApp('user-1', async (): Promise<DepartmentReadGrant> => ({ workspaceId: 'ws-1', userId: 'user-1', assistantId: null,
      base: 'public', departments: { 'department-2': 'confidential' }, contextDepartment: null, binding: null, cap: null }))
    expect((await request(app).get('/api/computer/profiles?workspaceId=ws-1')).body.profiles).toEqual(expect.arrayContaining([expect.objectContaining({ id: profileId })]))
    for (const suffix of ['', '/frame']) {
      expect((await request(app).get(`/api/computer/tasks/sess-local${suffix}`)).status).toBe(404)
    }
    for (const suffix of ['/input', '/resume', '/complete']) {
      expect((await request(app).post(`/api/computer/tasks/sess-local${suffix}`).send({ kind: 'click', x: 1, y: 1 })).status).toBe(404)
    }
    expectOnlyDiscardStubs((await request(app).get('/api/computer/tasks?workspaceId=ws-1')).body.tasks.filter((task: { sessionId: string }) => task.sessionId === 'sess-local'), ['sess-local'])
    expect(localOps).toEqual([])
    expect(localTasks.getActiveBySession('sess-local')?.profileAuthority?.departmentId).toBe('department-1')
  })

  it('hides an agent-origin local task from human controls after the original source is revoked', async () => {
    let current = true
    localTasks.touch({ userId: 'user-1', workspaceId: 'ws-1', sessionId: 'sess-local', profileId,
      profileAuthority: BrowserProfileAuthoritySchema.parse(await profileStore.get(profileId)),
      authority: { async assertCurrent() { if (!current) throw new Error('private source') },
        async execute(operation) { await this.assertCurrent(); const result = await operation(); await this.assertCurrent(); return result } },
    })
    const before = await request(app).get('/api/computer/tasks/sess-local')
    expect(before.status).toBe(200)
    expect(before.body).not.toHaveProperty('authority')
    expect(before.body).not.toHaveProperty('executionAuthority')
    expect(before.body).not.toHaveProperty('sourceAuthority')
    current = false
    for (const suffix of ['', '/frame']) expect((await request(app).get(`/api/computer/tasks/sess-local${suffix}`)).status).toBe(404)
    for (const suffix of ['/input', '/resume', '/complete']) {
      expect((await request(app).post(`/api/computer/tasks/sess-local${suffix}`).send({ kind: 'click', x: 1, y: 1 })).status).toBe(404)
    }
    expectOnlyDiscardStubs((await request(app).get('/api/computer/tasks?workspaceId=ws-1')).body.tasks.filter((task: { sessionId: string }) => task.sessionId === 'sess-local'), ['sess-local'])
    expect(localOps).toEqual([])
  })

  it('does not expose a legacy local task without original classification evidence', async () => {
    localTasks.touch({ userId: 'user-1', workspaceId: 'ws-1', sessionId: 'sess-local', profileId })
    expect((await request(app).get('/api/computer/tasks/sess-local')).status).toBe(404)
    expect((await request(app).get('/api/computer/tasks/sess-local/frame')).status).toBe(404)
    expect(localOps).toEqual([])
  })

  it('discovers and controls an owned local-browser task through the same Take-Over routes', async () => {
    localTasks.touch({ profileAuthority: BrowserProfileAuthoritySchema.parse(await profileStore.get(profileId)), userId: 'user-1', workspaceId: 'ws-1', sessionId: 'sess-local', profileId }, 'skyscanner.com')

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
    localTasks.touch({ profileAuthority: BrowserProfileAuthoritySchema.parse(await profileStore.get(profileId)), userId: 'user-1', workspaceId: 'ws-1', sessionId: 'sess-local', profileId })
    localProvider = { ...localProvider, stop: async () => { throw new Error('relay unavailable') } }
    app = makeApp('user-1')

    const stopped = await request(app).post('/api/computer/tasks/sess-local/complete')
    expect(stopped.status).toBe(502)
    expect(localTasks.getActiveBySession('sess-local')).not.toBeNull()
  })

  it('retires local tasks from discovery when the extension disconnects', async () => {
    localTasks.touch({ profileAuthority: BrowserProfileAuthoritySchema.parse(await profileStore.get(profileId)), userId: 'user-1', workspaceId: 'ws-1', sessionId: 'sess-local', profileId })
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
    localTasks.touch({ profileAuthority: BrowserProfileAuthoritySchema.parse(await profileStore.get(profileId)), userId: 'user-1', workspaceId: 'ws-1', sessionId: 'sess-local', profileId })
    localStatus = null

    const list = await request(app).get('/api/computer/tasks?workspaceId=ws-1')
    expect(list.body.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: 'sess-local', backend: 'local' }),
    ]))
    expect(localTasks.getActiveBySession('sess-local')).not.toBeNull()
  })

  it('retires local tasks after the relay observes the controlled tab closing', async () => {
    localTasks.touch({ profileAuthority: BrowserProfileAuthoritySchema.parse(await profileStore.get(profileId)), userId: 'user-1', workspaceId: 'ws-1', sessionId: 'sess-local', profileId })
    localStatus = { connected: true, terminalEvent: 'tab_closed' }

    const list = await request(app).get('/api/computer/tasks?workspaceId=ws-1')
    expect(list.body.tasks.some((task: { sessionId: string }) => task.sessionId === 'sess-local')).toBe(false)
    expect(localTasks.getActiveBySession('sess-local')).toBeNull()
  })

  it('keeps the task when an old relay cannot durably queue Stop during disconnect', async () => {
    localTasks.touch({ profileAuthority: BrowserProfileAuthoritySchema.parse(await profileStore.get(profileId)), userId: 'user-1', workspaceId: 'ws-1', sessionId: 'sess-local', profileId })
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
    localTasks.touch({ profileAuthority: BrowserProfileAuthoritySchema.parse(await profileStore.get(profileId)), userId: 'user-1', workspaceId: 'ws-1', sessionId: 'sess-local', profileId })
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
    localTasks.touch({ profileAuthority: BrowserProfileAuthoritySchema.parse(await profileStore.get(profileId)), userId: 'user-1', workspaceId: 'ws-1', sessionId: 'sess-local', profileId })
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
    localTasks.touch({ profileAuthority: BrowserProfileAuthoritySchema.parse(await profileStore.get(profileId)), userId: 'user-1', workspaceId: 'ws-1', sessionId: 'sess-local', profileId })
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
    localTasks.touch({ profileAuthority: BrowserProfileAuthoritySchema.parse(await profileStore.get(profileId)), userId: 'user-1', workspaceId: 'ws-1', sessionId: 'sess-1', profileId })
    const flip = await request(app)
      .post('/api/computer/sessions/sess-1/backend')
      .send({ backend: 'cloud' })
    expect(flip.status).toBe(200)
    expect(localTasks.getActiveBySession('sess-1')).toBeNull()
    expect((await request(app).get('/api/computer/tasks/sess-1')).body.backend).toBe('cloud')
    expect(localOps.at(-1)?.op).toBe('stop')
  })

  it('does not let another user change or retire an owned local task', async () => {
    localTasks.touch({ profileAuthority: BrowserProfileAuthoritySchema.parse(await profileStore.get(profileId)), userId: 'user-1', workspaceId: 'ws-1', sessionId: 'sess-local', profileId })
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

  it('returns non-disclosing authority errors when a task profile changes after route admission', async () => {
    await orchestrator.pauseForTakeover('sess-1')
    const original = (await profileStore.get(profileId))!
    app = makeApp('user-1', async () => {
      await profileStore.update(profileId,{clearance:'public'})
      return null
    })
    for (const suffix of ['/captured','/resume']) {
      await profileStore.update(profileId,{clearance:original.clearance})
      const response = await request(app).post(`/api/computer/tasks/sess-1${suffix}`).send({site:'github.com'})
      expect(response.status).toBe(403)
      expect(response.body).toEqual({error:'Profile authority unavailable.',code:'not_authorized'})
    }
    expect((await orchestrator.getActiveTask('sess-1'))?.status).toBe('paused')
    expect(vault.bundles.size).toBe(0)
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
    it('passes source authority into capture/revoke and withholds success on persistence denial', async () => {
      const denied = Object.assign(new Error('private vault authority detail'), { code: 'profile_authority_denied' })
      const save = vi.spyOn(vault, 'put').mockRejectedValueOnce(denied)
      const captured = await request(app).post(`/api/computer/profiles/${profileId}/capture`).send({ site: 'portal.example' })
      expect(captured.status).toBe(403)
      expect(captured.body).toMatchObject({ code: 'not_authorized' })
      expect(captured.body.capturedAt).toBeUndefined()
      expect(JSON.stringify(captured.body)).not.toContain('private vault authority detail')
      expect(save).toHaveBeenCalledWith(expect.objectContaining({ profileId }), expect.objectContaining({ id: profileId, ownerUserId: 'user-1' }))
      const revoke = vi.spyOn(vault, 'revoke').mockRejectedValueOnce(denied)
      const revoked = await request(app).delete(`/api/computer/profiles/${profileId}/sessions/portal.example`)
      expect(revoked.status).toBe(403)
      expect(revoked.body.ok).toBeUndefined()
      expect(revoke).toHaveBeenCalledWith({ profileId, site: 'portal.example' }, expect.objectContaining({ id: profileId }))
    })

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
      localTasks.touch({ profileAuthority: BrowserProfileAuthoritySchema.parse(await profileStore.get(profileId)), userId: 'user-1', workspaceId: 'ws-1', sessionId: 'sess-local', profileId })
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
          canManage: true,
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

    it('updates clearance, enablement, and per-assistant routing notes, then deletes - OWNER only', async () => {
      const patched = await request(app)
        .patch(`/api/computer/profiles/${profileId}`)
        .send({
          clearance: 'internal',
          enabledAssistantIds: ['11111111-1111-4111-8111-111111111111'],
          assistantRoutingNotes: {
            '11111111-1111-4111-8111-111111111111': 'Use for the company Instagram.',
          },
          localControlMode: 'full_browser',
        })
      expect(patched.status).toBe(200)
      expect(patched.body.profile).toMatchObject({
        clearance: 'internal',
        enabledAssistantIds: ['11111111-1111-4111-8111-111111111111'],
        assistantRoutingNotes: {
          '11111111-1111-4111-8111-111111111111': 'Use for the company Instagram.',
        },
        localControlMode: 'full_browser',
      })

      const stranger = makeApp('intruder')
      const strangerList = await request(stranger).get('/api/computer/profiles?workspaceId=ws-1')
      expect(strangerList.body.profiles).toEqual([])
      expect(
        (await request(stranger).patch(`/api/computer/profiles/${profileId}`).send({ name: 'Mine now' })).status,
      ).toBe(404)
      expect((await request(stranger).delete(`/api/computer/profiles/${profileId}`)).status).toBe(404)

      const invalidNote = await request(app)
        .patch(`/api/computer/profiles/${profileId}`)
        .send({ assistantRoutingNotes: { 'assistant-1': '  not trimmed  ' } })
      expect(invalidNote.status).toBe(400)

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

describe('protected destination task linkage', () => {
  it('exposes only browser-observed exact origin, and denies ordinary completion/backend changes while locked', async () => {
    const tasks = createInMemoryLocalComputerTaskStore()
    const profiles = createInMemoryBrowserProfileStore()
    const profile = await profiles.create({ workspaceId: 'ws-1', ownerUserId: 'user-1', name: 'Protected identity' })
    const ctx = { userId: 'user-1', workspaceId: 'ws-1', sessionId: 'sess-1', profileId: profile.id,
      profileAuthority: BrowserProfileAuthoritySchema.parse(profile) }
    tasks.touch(ctx, 'example.com')
    let blocked = false
    let supported = true
    const app = createTestApp('/api/computer', computerRoutes({
      orchestrator: null, provider: null, vault: null, profileStore: profiles,
      localTasks: tasks, getWorkspaceRole: MEMBER_ROLE, protectedFillEnabled: true,
      protectedBrowserSupported: async () => supported,
      protectedFillBlocked: () => blocked,
    }), { userId: 'user-1' })
    expect((await request(app).get('/api/computer/tasks/sess-1')).body.destinationOrigin).toBeNull()
    tasks.touch(ctx, 'example.com', 'https://example.com:8443')
    expect((await request(app).get('/api/computer/tasks/sess-1')).body.destinationOrigin).toBe('https://example.com:8443')
    supported = false
    expect((await request(app).get('/api/computer/tasks/sess-1')).body.destinationOrigin).toBeUndefined()
    supported = true
    blocked = true
    expect((await request(app).get('/api/computer/tasks/sess-1')).body.destinationOrigin).toBeUndefined()
    expect((await request(app).post('/api/computer/tasks/sess-1/complete')).status).toBe(403)
    expect((await request(app).post('/api/computer/sessions/sess-1/backend').send({ backend: 'cloud' })).status).toBe(403)
  })
})

describe('local protected-task identity lifetime', () => {
  it('assigns a fresh identity after retirement or expiry and refuses silent profile changes', () => {
    let now = 0
    const tasks = createInMemoryLocalComputerTaskStore(() => now)
    const ctx = { userId: 'user', workspaceId: 'workspace', sessionId: 'session', profileId: 'profile' }
    tasks.touch(ctx, 'example.com', 'https://example.com')
    const first = tasks.getActiveBySession('session')!.taskId
    tasks.touch(ctx)
    expect(tasks.getActiveBySession('session')!.taskId).toBe(first)
    tasks.complete('session')
    tasks.touch(ctx, 'example.com', 'https://example.com')
    const second = tasks.getActiveBySession('session')!.taskId
    expect(second).not.toBe(first)
    now += 20 * 60 * 1000
    tasks.touch(ctx, 'example.com', 'https://example.com')
    expect(tasks.getActiveBySession('session')!.taskId).not.toBe(second)
    const third = tasks.getActiveBySession('session')!.taskId
    tasks.touch({ ...ctx, profileId: 'another-profile' })
    expect(tasks.getActiveBySession('session')!.taskId).toBe(third)
    expect(tasks.getActiveBySession('session')!.profileId).toBe('profile')
    tasks.complete('session')
    tasks.touch({ ...ctx, profileId: 'another-profile' })
    expect(tasks.getActiveBySession('session')!.taskId).not.toBe(third)
    expect(tasks.getActiveBySession('session')!.destinationOrigin).toBeNull()
  })
})

describe('[COMP:routes/computer] current profile department authority', () => {
  it('passes admitted identity into grant revocation and refuses persistence authority loss', async () => {
    const store=createInMemoryBrowserProfileStore()
    const profile=await store.create({workspaceId:'workspace-1',ownerUserId:'owner',name:'Grant identity'})
    const grants=createInMemoryBrowserSkillGrantStore()
    const grant=await grants.create({workspaceId:'workspace-1',profileId:profile.id,skillId:'skill-1',grantedBy:'owner'})
    const revoke=vi.spyOn(grants,'revoke').mockRejectedValueOnce(Object.assign(new Error('private grant detail'),{code:'profile_authority_denied'}))
    const app=createTestApp('/api/computer',computerRoutes({orchestrator:null,provider:null,vault:null,
      profileStore:store,grants,getWorkspaceRole:MEMBER_ROLE}),{userId:'owner'})
    const response=await request(app).delete(`/api/computer/profiles/${profile.id}/grants/${grant.id}`)
    expect(response.status).toBe(403)
    expect(response.body.code).toBe('not_authorized')
    expect(JSON.stringify(response.body)).not.toContain('private grant detail')
    expect(revoke).toHaveBeenCalledWith(grant.id,expect.objectContaining({id:profile.id,ownerUserId:'owner'}))
    expect((await grants.list({workspaceId:'workspace-1'}))[0].status).toBe('active')
  })

  it('does not report deletion when persistence refuses a stale authority snapshot', async () => {
    const store = createInMemoryBrowserProfileStore()
    const profile = await store.create({ workspaceId: 'workspace-1', ownerUserId: 'owner', name: 'Protected browser' })
    const remove = store.delete.bind(store)
    vi.spyOn(store, 'delete').mockImplementation(async (id, expected) => {
      await store.update(id, { departmentId: 'new-department' })
      return remove(id, expected)
    })
    const app = createTestApp('/api/computer', computerRoutes({
      orchestrator: null, provider: null, vault: null, profileStore: store, getWorkspaceRole: MEMBER_ROLE,
    }), { userId: 'owner' })
    const response = await request(app).delete(`/api/computer/profiles/${profile.id}`)
    expect(response.status).toBe(409)
    expect(response.body.code).toBe('profile_changed')
    expect(JSON.stringify(response.body)).not.toContain('new-department')
    expect(await store.get(profile.id)).not.toBeNull()
  })

  it('rejects a stale admitted patch if profile authority changes during destination admission', async () => {
    const store = createInMemoryBrowserProfileStore()
    const profile = await store.create({ workspaceId: 'workspace-1', ownerUserId: 'owner', name: 'Protected browser',
      departmentId: 'department-1', scope: 'workspace', clearance: 'internal' })
    const app = createTestApp('/api/computer', computerRoutes({
      orchestrator: null, provider: null, vault: null, profileStore: store, getWorkspaceRole: MEMBER_ROLE,
      getProfileReadGrant: async (): Promise<DepartmentReadGrant> => ({ workspaceId: 'workspace-1', userId: 'owner',
        assistantId: null, base: 'public', departments: { 'department-1': 'confidential' },
        contextDepartment: null, binding: null, cap: null }),
      admitProfileDestination: async () => { await store.update(profile.id, { departmentId: 'department-2' }) },
    }), { userId: 'owner' })
    const response = await request(app).patch(`/api/computer/profiles/${profile.id}`).send({ name: 'Stale edit' })
    expect(response.status).toBe(409)
    expect(response.body.code).toBe('profile_changed')
    expect(JSON.stringify(response.body)).not.toContain('department-2')
    expect(await store.get(profile.id)).toMatchObject({ name: 'Protected browser', departmentId: 'department-2' })
  })

  it('requires destination write admission for protected profile edits and preserves its source floor', async () => {
    const store = createInMemoryBrowserProfileStore()
    const profile = await store.create({ workspaceId: 'workspace-1', ownerUserId: 'owner', name: 'Protected browser',
      departmentId: 'department-1', scope: 'workspace', clearance: 'internal' })
    const admit = vi.fn(async () => {})
    const appFor = (wired = true) => createTestApp('/api/computer', computerRoutes({
      orchestrator: null, provider: null, vault: null, profileStore: store, getWorkspaceRole: MEMBER_ROLE,
      getProfileReadGrant: async (): Promise<DepartmentReadGrant> => ({ workspaceId: 'workspace-1', userId: 'owner',
        assistantId: null, base: 'public', departments: { 'department-1': 'confidential' },
        contextDepartment: null, binding: null, cap: null }),
      ...(wired ? { admitProfileDestination: admit } : {}),
    }), { userId: 'owner' })
    const patch = (body: object, wired = true) => request(appFor(wired)).patch(`/api/computer/profiles/${profile.id}`).send(body)
    expect((await patch({ name: 'Denied' }, false)).status).toBe(403)
    admit.mockRejectedValueOnce(new Error('private authority detail'))
    const denied = await patch({ enabledAssistantIds: ['assistant-1'] })
    expect(denied.status).toBe(403)
    expect(JSON.stringify(denied.body)).not.toContain('private authority detail')
    expect((await patch({ clearance: 'public' })).body.code).toBe('source_scope_required')
    expect((await patch({ departmentId: null, name: 'Discarded field' })).status).toBe(400)
    expect(await store.get(profile.id)).toMatchObject({ name: 'Protected browser', clearance: 'internal', enabledAssistantIds: [] })
    const allowed = await patch({ name: 'Updated browser', clearance: 'confidential' })
    expect(allowed.status).toBe(200)
    expect(allowed.body.profile).toMatchObject({ name: 'Updated browser', clearance: 'confidential', departmentId: 'department-1' })
    expect(admit).toHaveBeenLastCalledWith('owner', 'workspace-1', { departmentId: 'department-1', sensitivity: 'confidential' })
  })

  it('does not turn an unassigned v2 personal profile into an unclassified shared profile', async () => {
    const store = createInMemoryBrowserProfileStore()
    const profile = await store.create({ workspaceId: 'workspace-1', ownerUserId: 'owner', name: 'Personal browser' })
    const app = createTestApp('/api/computer', computerRoutes({
      orchestrator: null, provider: null, vault: null, profileStore: store, getWorkspaceRole: MEMBER_ROLE,
      getProfileReadGrant: async (): Promise<DepartmentReadGrant> => ({ workspaceId: 'workspace-1', userId: 'owner',
        assistantId: null, base: 'confidential', departments: {}, contextDepartment: null, binding: null, cap: null }),
    }), { userId: 'owner' })
    const denied = await request(app).patch(`/api/computer/profiles/${profile.id}`).send({ scope: 'workspace' })
    expect(denied.status).toBe(400)
    expect(denied.body.code).toBe('department_required')
    expect((await store.get(profile.id))?.scope).toBe('owner')
    expect((await request(app).patch(`/api/computer/profiles/${profile.id}`).send({ name: 'Renamed personal browser' })).status).toBe(200)
  })

  it('withholds proxy secrets from department readers while preserving owner management', async () => {
    const store = createInMemoryBrowserProfileStore()
    const proxyUrl = 'http://fictional-user:fictional-secret@proxy.example:8080'
    await store.create({ workspaceId: 'workspace-1', ownerUserId: 'owner', name: 'Shared account',
      departmentId: 'department-1', scope: 'workspace', proxyUrl })
    const appFor = (userId: string) => createTestApp('/api/computer', computerRoutes({
      orchestrator: null, provider: null, vault: null, profileStore: store,
      getWorkspaceRole: MEMBER_ROLE,
      getProfileReadGrant: async (): Promise<DepartmentReadGrant> => ({ workspaceId: 'workspace-1', userId,
        assistantId: null, base: 'public', departments: { 'department-1': 'confidential' },
        contextDepartment: null, binding: null, cap: null }),
    }), { userId })
    const reader = await request(appFor('reader')).get('/api/computer/profiles?workspaceId=workspace-1')
    expect(reader.body.profiles).toEqual([expect.objectContaining({ proxyUrl: null, canManage: false })])
    expect(JSON.stringify(reader.body)).not.toContain('fictional-secret')
    const owner = await request(appFor('owner')).get('/api/computer/profiles?workspaceId=workspace-1')
    expect(owner.body.profiles).toEqual([expect.objectContaining({ proxyUrl, canManage: true })])
  })

  it.each(['revoked', 'reclassified', 'deleted', 'lookup_failed'] as const)(
    'withholds joined metadata when authority becomes %s during its load', async (change) => {
      const store = createInMemoryBrowserProfileStore()
      const profile = await store.create({ workspaceId: 'workspace-1', ownerUserId: 'owner', name: 'Shared account',
        departmentId: 'department-1', scope: 'workspace' })
      let admitted = true
      const vault = createInMemorySessionVault()
      await vault.put({ profileId: profile.id, site: 'private.example',
        bundle: { site: 'private.example', cookies: [], capturedAt: new Date().toISOString() } })
      const originalList = vault.list.bind(vault)
      vi.spyOn(vault, 'list').mockImplementation(async (params) => {
        const result = await originalList(params)
        if (change === 'revoked') admitted = false
        if (change === 'reclassified') await store.update(profile.id, { departmentId: 'department-2' })
        if (change === 'deleted') await store.delete(profile.id)
        if (change === 'lookup_failed') vi.spyOn(store, 'get').mockRejectedValue(new Error('unavailable'))
        return result
      })
      const app = createTestApp('/api/computer', computerRoutes({
        orchestrator: null, provider: null, vault, profileStore: store,
        getWorkspaceRole: MEMBER_ROLE,
        getProfileReadGrant: async (): Promise<DepartmentReadGrant> => ({ workspaceId: 'workspace-1', userId: 'reader',
          assistantId: null, base: 'public', departments: admitted ? { 'department-1': 'confidential' } : {},
          contextDepartment: null, binding: null, cap: null }),
      }), { userId: 'reader' })
      const response = await request(app).get('/api/computer/profiles?workspaceId=workspace-1')
      expect(response.status).toBe(200)
      expect(response.body.profiles).toEqual([])
      expect(JSON.stringify(response.body)).not.toContain('private.example')
    })

  it('withholds metadata and owner credential operations after department revocation', async () => {
    const store = createInMemoryBrowserProfileStore()
    const profile = await store.create({ workspaceId: 'workspace-1', ownerUserId: 'user-1', name: 'Protected account',
      departmentId: 'department-1', scope: 'workspace', clearance: 'confidential' })
    let admitted = true
    let member = true
    const app = createTestApp('/api/computer', computerRoutes({
      orchestrator: null, provider: null, vault: null, profileStore: store,
      getWorkspaceRole: async () => member ? 'owner' : null,
      getProfileReadGrant: async (): Promise<DepartmentReadGrant> => ({ workspaceId: 'workspace-1', userId: 'user-1', assistantId: null,
        base: 'public', departments: admitted ? { 'department-1': 'confidential' } : {},
        contextDepartment: null, binding: null, cap: null }),
    }), { userId: 'user-1' })
    const list = () => request(app).get('/api/computer/profiles?workspaceId=workspace-1')
    expect((await list()).body.profiles.map((p: { id: string }) => p.id)).toEqual([profile.id])
    admitted = false
    expect((await list()).body.profiles).toEqual([])
    expect((await request(app).patch(`/api/computer/profiles/${profile.id}`).send({ name: 'Changed' })).status).toBe(404)
    expect((await request(app).post(`/api/computer/profiles/${profile.id}/credentials`).send({})).status).toBe(404)
    expect((await request(app).delete(`/api/computer/profiles/${profile.id}`)).status).toBe(404)
    expect((await store.get(profile.id))?.name).toBe('Protected account')
    admitted = true
    expect((await list()).body.profiles).toHaveLength(1)
    member = false
    expect((await request(app).delete(`/api/computer/profiles/${profile.id}`)).status).toBe(404)
  })

  it('keeps unassigned recovery owner-only and fails closed on authority lookup errors', async () => {
    const store = createInMemoryBrowserProfileStore()
    const own = await store.create({ workspaceId: 'workspace-1', ownerUserId: 'user-1', name: 'Needs classification', scope: 'workspace' })
    await store.create({ workspaceId: 'workspace-1', ownerUserId: 'user-2', name: 'Other unassigned', scope: 'workspace' })
    await store.create({ workspaceId: 'workspace-1', ownerUserId: 'user-2', name: 'Other private', scope: 'owner' })
    let fail = false
    const app = createTestApp('/api/computer', computerRoutes({
      orchestrator: null, provider: null, vault: null, profileStore: store,
      getWorkspaceRole: MEMBER_ROLE,
      getProfileReadGrant: async () => {
        if (fail) throw new Error('lookup unavailable')
        return { workspaceId: 'workspace-1', userId: 'user-1', assistantId: null,
          base: 'confidential', departments: {}, contextDepartment: null, binding: null, cap: null }
      },
    }), { userId: 'user-1' })
    expect((await request(app).get('/api/computer/profiles?workspaceId=workspace-1')).body.profiles.map((p: { id: string }) => p.id)).toEqual([own.id])
    fail = true
    expect((await request(app).get('/api/computer/profiles?workspaceId=workspace-1')).body.profiles).toEqual([])
    expect((await request(app).patch(`/api/computer/profiles/${own.id}`).send({ name: 'Changed' })).status).toBe(404)
  })
})


describe('[COMP:routes/computer] audited profile department command',()=>{
 it('requires explicit confirmation and forwards the authenticated owner snapshot',async()=>{
  const profiles=createInMemoryBrowserProfileStore()
  const profile=await profiles.create({workspaceId:'ws-1',ownerUserId:'user-1',name:'Recovery fixture'})
  const classifyDepartment=vi.fn(async()=>({...profile,departmentId:'00000000-0000-4000-8000-000000000001'}))
  const app=createTestApp('/api/computer',computerRoutes({orchestrator:null,provider:null,vault:null,profileStore:{...profiles,classifyDepartment},getWorkspaceRole:MEMBER_ROLE}),{userId:'user-1'})
  const body={departmentId:'00000000-0000-4000-8000-000000000001',expectedDepartmentId:null,reason:'Assign fictional operations',confirmed:true}
  await request(app).post(`/api/computer/profiles/${profile.id}/department`).send({...body,confirmed:false}).expect(400)
  await request(app).post(`/api/computer/profiles/${profile.id}/department`).send({...body,expectedDepartmentId:undefined}).expect(400)
  const stale=await request(app).post(`/api/computer/profiles/${profile.id}/department`).send({...body,expectedDepartmentId:body.departmentId}).expect(409)
  expect(stale.body).toEqual({error:'Profile changed. Refresh and retry.',code:'profile_changed'})
  expect(classifyDepartment).not.toHaveBeenCalled()
  await request(app).post(`/api/computer/profiles/${profile.id}/department`).send(body).expect(200)
  const {expectedDepartmentId: _reviewedDepartment,...command}=body
  expect(classifyDepartment).toHaveBeenCalledWith(profile.id,{...command,userId:'user-1',expected:profile})
  classifyDepartment.mockRejectedValueOnce(Object.assign(new Error('private source'),{code:'profile_authority_denied'}))
  const denied=await request(app).post(`/api/computer/profiles/${profile.id}/department`).send(body).expect(403)
  expect(denied.body.error).toBe('Profile classification unavailable')
 })
})
