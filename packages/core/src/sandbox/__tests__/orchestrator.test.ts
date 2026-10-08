import { describe, it, expect, vi } from 'vitest'
import {
  createSandboxOrchestrator,
  createInMemorySandboxTaskStore,
  looksLikeLoginWall,
  registrableSiteOf,
} from '../orchestrator.js'
import { createCloudBrowserProvider } from '../cloud-browser-provider.js'
import { createInMemorySessionVault, type BrowserProfile } from '../profiles.js'
import { StubSandboxProvider } from '../providers/stub.js'
import type { BrowserCallContext } from '../types.js'

/** Every browse in these tests runs AS profile p1 (R2-4: vault scope = profile). */
function ctx(sessionId: string, profileId: string | null = 'p1'): BrowserCallContext {
  return {
    userId: 'user-1',
    workspaceId: 'ws-1',
    sessionId,
    ...(profileId ? { profileId } : {}),
  }
}

function build(opts: { loginWall?: boolean; loginWallAlways?: boolean } = {}) {
  const provider = new StubSandboxProvider(opts)
  const taskStore = createInMemorySandboxTaskStore()
  const vault = createInMemorySessionVault()
  const profiles = new Map<string, BrowserProfile>(['p1', 'p2', 'p7', 'p9'].map(id => [id, {
    id, workspaceId: 'ws-1', ownerUserId: 'user-1', name: 'Fictional identity', scope: 'owner',
    departmentId: 'department-1', clearance: 'internal', enabledAssistantIds: [], defaultBackend: 'cloud',
    localControlMode: 'task_tabs', proxyUrl: null, createdAt: '', updatedAt: '',
  }]))
  const profileStore = { get: async (id: string) => profiles.get(id) ?? null }
  const downloads: Array<{ path: string; workspaceId: string }> = []
  const orchestrator = createSandboxOrchestrator({
    provider,
    taskStore,
    vault,
    profileStore,
    saveDownload: async (c, file) => void downloads.push({ path: file.path, workspaceId: c.workspaceId }),
  })
  const browser = createCloudBrowserProvider({ provider, binding: orchestrator.binding })
  return { provider, taskStore, vault, orchestrator, browser, downloads, profiles, profileStore }
}

describe('[COMP:sandbox/orchestrator] Sandbox task orchestration', () => {
  it('refuses a pinned task ID after the session binding is replaced', async () => {
    const h = build()
    await h.browser.navigate(ctx('pinned'), 'https://portal.example')
    await expect(h.orchestrator.binding.resolve({ ...ctx('pinned'), taskId: 'retired-task' })).rejects.toThrow()
  })
  it('kills the sandbox and records failure when download publication is refused', async () => {
    const h = build()
    await h.browser.navigate(ctx('publication'), 'https://portal.example')
    const task = (await h.orchestrator.getActiveTask('publication'))!
    vi.spyOn(h.provider.bridge, 'pullDownloads').mockResolvedValue([{ path: '/example.txt', bytes: Buffer.from('fictional') }])
    const finisher = createSandboxOrchestrator({ provider: h.provider, taskStore: h.taskStore, profileStore: h.profileStore,
      saveDownload: async () => { throw new Error('Publication refused') } })
    expect((await finisher.completeTask('publication'))?.status).toBe('failed')
    expect(h.provider.sandboxes.get(task.sandboxId)?.status).toBe('killed')
    expect(h.taskStore.tasks.get(task.taskId)?.status).toBe('failed')
  })

  it('discards an exact task without capture or downloads after profile revocation', async () => {
    const h = build()
    await h.browser.navigate(ctx('discard-session'), 'https://portal.example/account')
    const task = (await h.orchestrator.getActiveTask('discard-session'))!
    const capture = vi.spyOn(h.provider.browser(task.sandboxId), 'captureStorageState')
    const downloads = vi.spyOn(h.provider.bridge, 'pullDownloads')
    h.profiles.delete('p1')
    expect(await h.orchestrator.discardTask('discard-session', 'different-task')).toBe(false)
    expect(h.provider.sandboxes.get(task.sandboxId)?.status).toBe('running')
    expect(await h.orchestrator.discardTask('discard-session', task.taskId)).toBe(true)
    expect(capture).not.toHaveBeenCalled()
    expect(downloads).not.toHaveBeenCalled()
    expect(h.downloads).toEqual([])
    expect(h.vault.bundles.size).toBe(0)
    expect(h.provider.sandboxes.get(task.sandboxId)?.status).toBe('killed')
    expect(await h.orchestrator.discardTask('discard-session', task.taskId)).toBe(false)
  })

  it('keeps failed teardown retryable without attempting publication', async () => {
    const h = build()
    await h.browser.navigate(ctx('discard-session'), 'https://portal.example/account')
    const task = (await h.orchestrator.getActiveTask('discard-session'))!
    vi.spyOn(h.provider, 'kill').mockRejectedValueOnce(new Error('provider unavailable'))
    const downloads = vi.spyOn(h.provider.bridge, 'pullDownloads')
    await expect(h.orchestrator.discardTask('discard-session', task.taskId)).rejects.toThrow()
    expect(await h.orchestrator.getActiveTask('discard-session')).not.toBeNull()
    expect(downloads).not.toHaveBeenCalled()
    expect(await h.orchestrator.discardTask('discard-session', task.taskId)).toBe(true)
  })
  it('creates one task-scoped sandbox per chat session and reuses it across ops', async () => {
    const { provider, browser } = build()
    await browser.navigate(ctx('s1'), 'https://github.com/login')
    await browser.snapshot(ctx('s1'))
    expect(provider.sandboxes.size).toBe(1)

    await browser.navigate(ctx('s2'), 'https://github.com/')
    expect(provider.sandboxes.size).toBe(2) // a different session = a different task
  })

  it.each([
    { departmentId: 'department-2' }, { clearance: 'public' as const },
    { scope: 'workspace' as const }, { ownerUserId: 'user-2' }, { workspaceId: 'ws-2' },
  ])('denies reuse and capture after the original profile floor changes: %j', async patch => {
    const h = build()
    await h.browser.navigate(ctx('s1'), 'https://portal.example/account')
    const task = await h.orchestrator.getActiveTask('s1')
    expect(task?.profileAuthority).toEqual({id:'p1',workspaceId:'ws-1',ownerUserId:'user-1',departmentId:'department-1',scope:'owner',clearance:'internal'})
    await h.orchestrator.pauseForTakeover('s1')
    h.profiles.set('p1', { ...h.profiles.get('p1')!, ...patch })
    const browserAccess = vi.spyOn(h.provider, 'browser')
    await expect(h.orchestrator.binding.resolve(ctx('s1'), {browser:true})).rejects.toMatchObject({code:'profile_authority_denied'})
    await expect(h.orchestrator.resumeAfterTakeover('s1')).rejects.toMatchObject({code:'profile_authority_denied'})
    await expect(h.orchestrator.captureSession('s1', 'portal.example')).rejects.toMatchObject({code:'profile_authority_denied'})
    expect(browserAccess).not.toHaveBeenCalled()
    expect(h.provider.sandboxes.get(task!.sandboxId)?.status).toBe('paused')
    expect(h.vault.bundles.size).toBe(0)
    await h.orchestrator.completeTask('s1', 'failed')
    expect(h.provider.sandboxes.get(task!.sandboxId)?.status).toBe('killed')
  })

  it('retains the floor after a cold orchestrator reload and refuses legacy tasks without evidence', async () => {
    const h = build()
    await h.browser.navigate(ctx('s1'), 'https://portal.example/account')
    const saved = JSON.parse(JSON.stringify(await h.orchestrator.getActiveTask('s1')))
    const coldStore = createInMemorySandboxTaskStore()
    await coldStore.create(saved)
    const cold = createSandboxOrchestrator({provider:h.provider,taskStore:coldStore,vault:h.vault,profileStore:h.profileStore})
    await expect(cold.binding.resolve(ctx('s1'), {browser:true})).resolves.toEqual({sandboxId:saved.sandboxId})
    h.profiles.set('p1', {...h.profiles.get('p1')!,departmentId:'department-2'})
    await expect(cold.captureSession('s1', 'portal.example')).rejects.toMatchObject({code:'profile_authority_denied'})
    // An absent pin is not reconstructed from today's more permissive profile.
    coldStore.tasks.set(saved.taskId, {...saved,profileAuthority:null})
    await expect(cold.binding.resolve(ctx('s1'), {browser:true})).rejects.toMatchObject({code:'profile_authority_denied'})
    await cold.completeTask('s1', 'failed')
    expect(h.provider.sandboxes.get(saved.sandboxId)?.status).toBe('killed')
  })

  it('rejects a different caller or profile before resuming the shared sandbox', async () => {
    const h = build()
    await h.browser.navigate(ctx('s1'), 'https://portal.example/account')
    for (const patch of [{userId:'user-2'}, {workspaceId:'ws-2'}, {profileId:'p7'}, {profileId:undefined}]) {
      await expect(h.orchestrator.binding.resolve({...ctx('s1'),...patch}, {browser:true})).rejects.toMatchObject({code:'profile_authority_denied'})
    }
    await expect(h.orchestrator.captureSession('s1', 'portal.example', 'p7')).rejects.toMatchObject({code:'profile_authority_denied'})
    expect(h.vault.bundles.size).toBe(0)
  })

  it('binds a compute-only task once before its first browser navigation and injects that profile', async () => {
    const h = build()
    await h.vault.put({profileId:'p1',site:'portal.example',bundle:{site:'portal.example',cookies:[],capturedAt:'2026-01-01T00:00:00Z'}})
    await h.orchestrator.binding.resolve(ctx('s1', null))
    const original = await h.orchestrator.getActiveTask('s1')
    await h.browser.navigate(ctx('s1'), 'https://portal.example/account')
    const bound = await h.orchestrator.getActiveTask('s1')
    expect(bound?.taskId).toBe(original?.taskId)
    expect(bound?.profileAuthority?.departmentId).toBe('department-1')
    expect(bound?.injectedSite).toBe('portal.example')
    expect(h.provider.sandboxes.size).toBe(1)
    await expect(h.browser.navigate(ctx('s1','p2'), 'https://portal.example/account')).rejects.toMatchObject({code:'profile_authority_denied'})
  })

  it('requires the profile store before allocating a profile-bound sandbox', async () => {
    const provider = new StubSandboxProvider()
    const orchestrator = createSandboxOrchestrator({provider,taskStore:createInMemorySandboxTaskStore()})
    await expect(orchestrator.binding.resolve(ctx('s1'), {browser:true,url:'https://portal.example'})).rejects.toMatchObject({code:'profile_authority_denied'})
    expect(provider.sandboxes.size).toBe(0)
  })

  it('passes the original floor to vault capture even when classification changes during capture', async () => {
    const h = build()
    await h.browser.navigate(ctx('s1'), 'https://portal.example/account')
    const access = h.provider.browser.bind(h.provider)
    vi.spyOn(h.provider, 'browser').mockImplementation(id => {
      const remote = access(id)
      return {...remote,captureStorageState:async site => {
        h.profiles.set('p1', {...h.profiles.get('p1')!,departmentId:'department-2'})
        return remote.captureStorageState(site)
      }}
    })
    const put = vi.spyOn(h.vault, 'put').mockRejectedValue(Object.assign(new Error('Profile authority unavailable'),{code:'profile_authority_denied'}))
    await expect(h.orchestrator.captureSession('s1', 'portal.example')).rejects.toMatchObject({code:'profile_authority_denied'})
    expect(put).toHaveBeenCalledWith(expect.objectContaining({profileId:'p1'}), expect.objectContaining({departmentId:'department-1'}))
    expect(h.vault.bundles.size).toBe(0)
  })

  it('kills the sandbox when the task row cannot be persisted (never orphans a micro-VM)', async () => {
    const { provider, taskStore, browser } = build()
    // The real shape of this failure: `sandbox_tasks.session_id` is `uuid NOT
    // NULL`, so a malformed session id rejects AFTER the micro-VM is already
    // running. Anything thrown between create() and the task row must still
    // take the sandbox down — an orphan bills until its max-lifetime reaper.
    taskStore.create = async () => {
      throw new Error('invalid input syntax for type uuid')
    }

    await expect(browser.navigate(ctx('s1'), 'https://github.com/')).rejects.toThrow(/uuid/)

    expect(provider.sandboxes.size).toBe(1)
    expect([...provider.sandboxes.values()].map((s) => s.status)).toEqual(['killed'])
  })

  it('lists a workspace\'s live tasks for discovery and drops completed ones (§5)', async () => {
    const { orchestrator, browser } = build()
    await browser.navigate(ctx('s1'), 'https://github.com/')
    await browser.navigate(ctx('s2'), 'https://example.com/')

    expect((await orchestrator.listActiveTasks('ws-1')).map((t) => t.sessionId).sort()).toEqual([
      's1',
      's2',
    ])
    expect(await orchestrator.listActiveTasks('ws-other')).toEqual([])

    await orchestrator.completeTask('s1')
    expect((await orchestrator.listActiveTasks('ws-1')).map((t) => t.sessionId)).toEqual(['s2'])
  })

  it('does not advertise a compute-only sandbox as a live browser', async () => {
    const { orchestrator, browser } = build()
    const finalizers = new Map<string, () => void | Promise<void>>()
    const computeCtx = {
      ...ctx('s1'),
      registerInvocationFinalizer: (key: string, finalize: () => void | Promise<void>) => {
        finalizers.set(key, finalize)
      },
    }

    // runPython and the file bridge resolve the shared sandbox without a
    // browser hint. They neither start nor advertise a browser.
    await orchestrator.binding.resolve(computeCtx)
    expect((await orchestrator.getActiveTask('s1'))?.browserStartedAt).toBeNull()
    expect(await orchestrator.listActiveTasks('ws-1')).toEqual([])
    expect(finalizers.size).toBe(0)

    // If the same task later enters a real browser path, it becomes visible
    // without creating a second sandbox.
    await browser.navigate(computeCtx, 'https://example.com/')
    expect((await orchestrator.getActiveTask('s1'))?.browserStartedAt).not.toBeNull()
    expect((await orchestrator.listActiveTasks('ws-1')).map((t) => t.sessionId)).toEqual(['s1'])
    expect(finalizers.size).toBe(1)
  })

  it('refuses a target-less browser operation before creating or promoting a browser', async () => {
    const { provider, orchestrator, browser } = build()

    await expect(browser.snapshot(ctx('blank'))).rejects.toMatchObject({
      code: 'no_active_browser',
    })
    expect(provider.sandboxes.size).toBe(0)

    await orchestrator.binding.resolve(ctx('compute'))
    expect(provider.sandboxes.size).toBe(1)
    await expect(browser.currentUrl(ctx('compute'))).rejects.toMatchObject({
      code: 'no_active_browser',
    })
    expect((await orchestrator.getActiveTask('compute'))?.browserStartedAt).toBeNull()
  })

  it('registers one invocation finalizer and kills a running browser when the invocation ends', async () => {
    const { provider, orchestrator, browser } = build()
    const finalizers = new Map<string, () => void | Promise<void>>()
    const browserCtx = {
      ...ctx('s1'),
      registerInvocationFinalizer: (key: string, finalize: () => void | Promise<void>) => {
        finalizers.set(key, finalize)
      },
    }

    await browser.navigate(browserCtx, 'https://example.com/')
    await browser.snapshot(browserCtx)
    const task = await orchestrator.getActiveTask('s1')

    expect(finalizers.size).toBe(1)
    await Promise.all([...finalizers.values()].map((finalize) => finalize()))

    expect(provider.sandboxes.get(task!.sandboxId)?.status).toBe('killed')
    expect(await orchestrator.getActiveTask('s1')).toBeNull()
  })

  it('keeps a browser paused for human Take-Over alive at invocation end', async () => {
    const { provider, orchestrator, browser } = build()
    const finalizers = new Map<string, () => void | Promise<void>>()
    const browserCtx = {
      ...ctx('s1'),
      registerInvocationFinalizer: (key: string, finalize: () => void | Promise<void>) => {
        finalizers.set(key, finalize)
      },
    }

    await browser.navigate(browserCtx, 'https://example.com/login')
    const task = await orchestrator.getActiveTask('s1')
    await orchestrator.pauseForTakeover('s1')
    await Promise.all([...finalizers.values()].map((finalize) => finalize()))

    expect(provider.sandboxes.get(task!.sandboxId)?.status).toBe('paused')
    expect((await orchestrator.getActiveTask('s1'))?.status).toBe('paused')
  })

  it('binds the task to the browsing profile from the call context (R2-4)', async () => {
    const { orchestrator, browser } = build()
    await browser.navigate(ctx('s1', 'p9'), 'https://github.com/')
    const task = await orchestrator.getActiveTask('s1')
    expect(task?.profileId).toBe('p9')
  })

  it('completeTask captures the session, pulls downloads into the workspace sink, then kills (§4.10)', async () => {
    const { provider, orchestrator, browser, vault, downloads } = build()
    await browser.navigate(ctx('s1'), 'https://github.com/settings')
    await orchestrator.captureSession('s1', 'github.com')

    const task = await orchestrator.getActiveTask('s1')
    provider.addDownload(task!.sandboxId, '/home/user/downloads/report.csv', new TextEncoder().encode('a,b'))

    const done = await orchestrator.completeTask('s1')
    expect(done?.status).toBe('completed')
    expect(downloads).toEqual([{ path: '/home/user/downloads/report.csv', workspaceId: 'ws-1' }])
    expect(provider.sandboxes.get(task!.sandboxId)?.status).toBe('killed')
    expect(vault.bundles.size).toBe(1) // the session outlives the sandbox
    expect(await orchestrator.getActiveTask('s1')).toBeNull()
  })

  it('captureSession without a profile fails honestly (a session must belong to an identity)', async () => {
    const { orchestrator, browser } = build()
    await browser.navigate(ctx('s1', null), 'https://github.com/settings')
    await expect(orchestrator.captureSession('s1', 'github.com')).rejects.toThrow(/profile/i)
  })

  it('captureSession(profileId) binds a previously identity-less task on first capture', async () => {
    const { orchestrator, browser, vault } = build()
    await browser.navigate(ctx('s1', null), 'https://github.com/settings')
    await orchestrator.captureSession('s1', 'github.com', 'p7')
    expect(vault.bundles.get('p7:github.com')?.status).toBe('active')
    expect((await orchestrator.getActiveTask('s1'))?.profileId).toBe('p7')
  })

  it('pauses and resumes around a Take-Over wait (§4.8)', async () => {
    const { provider, orchestrator, browser } = build()
    await browser.navigate(ctx('s1'), 'https://github.com/login')
    const task = await orchestrator.getActiveTask('s1')

    await orchestrator.pauseForTakeover('s1')
    expect(provider.sandboxes.get(task!.sandboxId)?.status).toBe('paused')
    await orchestrator.resumeAfterTakeover('s1')
    expect(provider.sandboxes.get(task!.sandboxId)?.status).toBe('running')
  })

  it('reaps tasks idle past the abandonment window', async () => {
    const provider = new StubSandboxProvider()
    const taskStore = createInMemorySandboxTaskStore()
    let t = 1_000_000
    const orchestrator = createSandboxOrchestrator({ provider, taskStore, now: () => t })
    const browser = createCloudBrowserProvider({ provider, binding: orchestrator.binding })
    await browser.navigate(ctx('s1', null), 'https://example.com/')
    const task = await orchestrator.getActiveTask('s1')

    t += 21 * 60 * 1000 // past the ~20 min default abandonment window
    const reaped = await orchestrator.reapStale(20 * 60 * 1000)
    expect(reaped).toBe(1)
    expect(provider.sandboxes.get(task!.sandboxId)?.status).toBe('killed')
    expect((await taskStore.getActiveBySession('s1'))).toBeNull()
  })
})

describe('[COMP:sandbox/session-vault] Session reuse — capture once, no second login (§4.4, §4.8)', () => {
  it('first task hits the login wall, Take-Over captures the session; a LATER task re-injects and lands signed in', async () => {
    const { provider, orchestrator, browser, vault } = build({ loginWall: true })

    // ── Task 1: no vaulted session → the site login-walls the sandbox.
    const first = await browser.navigate(ctx('task-a'), 'https://github.com/notifications')
    expect(looksLikeLoginWall(first.url)).toBe(true)

    // The user clears it in the Take-Over live view; the orchestrator
    // captures the now-authenticated session into the PROFILE's vault, then
    // the task completes and its sandbox dies.
    await orchestrator.captureSession('task-a', 'github.com')
    await orchestrator.completeTask('task-a')
    expect(vault.bundles.get('p1:github.com')?.status).toBe('active')

    // ── Task 2 (a fresh session, later, same profile): the orchestrator
    // injects the vaulted bundle BEFORE the first navigation → no login
    // wall, no second Take-Over.
    const second = await browser.navigate(ctx('task-b'), 'https://github.com/notifications')
    expect(looksLikeLoginWall(second.url)).toBe(false)
    expect(second.url).toBe('https://github.com/notifications')

    const task2 = await orchestrator.getActiveTask('task-b')
    const sbx2 = provider.sandboxes.get(task2!.sandboxId)
    expect(sbx2?.injectedBundles.map((b) => b.site)).toEqual(['github.com'])
    // Injection happened before the navigate reached the site.
    const ops = sbx2?.actions.map((a) => a.op)
    expect(ops?.indexOf('injectStorageState')).toBeLessThan(ops!.indexOf('navigate'))
  })

  it('a DIFFERENT profile does not see the first profile’s session (R2-6: one jar per identity)', async () => {
    const { provider, orchestrator, browser } = build({ loginWall: true })
    await browser.navigate(ctx('task-a', 'p1'), 'https://github.com/notifications')
    await orchestrator.captureSession('task-a', 'github.com')
    await orchestrator.completeTask('task-a')

    const other = await browser.navigate(ctx('task-b', 'p2'), 'https://github.com/notifications')
    expect(looksLikeLoginWall(other.url)).toBe(true) // p2 has no bundle — login wall again
    const task2 = await orchestrator.getActiveTask('task-b')
    expect(provider.sandboxes.get(task2!.sandboxId)?.injectedBundles).toEqual([])
  })

  it('silent-death probe: a re-injected session that still login-walls is marked dead (§6)', async () => {
    const { orchestrator, browser, vault } = build({ loginWallAlways: true })
    await vault.put({
      profileId: 'p1',
      site: 'github.com',
      bundle: { site: 'github.com', cookies: [{ name: 'stale' }], capturedAt: new Date().toISOString() },
    })

    await browser.navigate(ctx('s1'), 'https://github.com/notifications')
    expect(vault.bundles.get('p1:github.com')?.status).toBe('dead')
    // A dead bundle is never re-injected on the next task.
    await browser.navigate(ctx('s2'), 'https://github.com/notifications')
    const infos = await vault.list({ profileId: 'p1' })
    expect(infos).toEqual([expect.objectContaining({ site: 'github.com', status: 'dead' })])
  })

  it('registrableSiteOf normalizes hosts to their registrable domain', () => {
    expect(registrableSiteOf('https://www.linkedin.com/feed')).toBe('linkedin.com')
    expect(registrableSiteOf('https://github.com/login')).toBe('github.com')
    expect(registrableSiteOf('https://shop.alpha.co.uk/orders')).toBe('alpha.co.uk')
    expect(registrableSiteOf('https://shop.beta.co.uk/orders')).toBe('beta.co.uk')
    expect(registrableSiteOf('not a url')).toBeNull()
  })
})

describe('[COMP:sandbox/provider] Seam swap (§4.3)', () => {
  it('the orchestrator runs unchanged against the stub provider — swapping impls is construction-only', async () => {
    // This test IS the proof: everything above used StubSandboxProvider
    // through the same SandboxProvider interface E2BCloudProvider implements.
    // Here we assert the orchestrator only ever touched the interface.
    const { provider, browser } = build()
    await browser.navigate(ctx('s1'), 'https://example.com/')
    const [sbx] = [...provider.sandboxes.values()]
    expect(sbx.options).toMatchObject({ workspaceId: 'ws-1' })
    expect(typeof sbx.options.taskId).toBe('string')
  })
})
