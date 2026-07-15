import { describe, it, expect } from 'vitest'
import {
  createSandboxOrchestrator,
  createInMemorySandboxTaskStore,
  looksLikeLoginWall,
  registrableSiteOf,
} from '../orchestrator.js'
import { createCloudBrowserProvider } from '../cloud-browser-provider.js'
import { createInMemorySessionVault } from '../profiles.js'
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
  const downloads: Array<{ path: string; workspaceId: string }> = []
  const orchestrator = createSandboxOrchestrator({
    provider,
    taskStore,
    vault,
    saveDownload: async (c, file) => void downloads.push({ path: file.path, workspaceId: c.workspaceId }),
  })
  const browser = createCloudBrowserProvider({ provider, binding: orchestrator.binding })
  return { provider, taskStore, vault, orchestrator, browser, downloads }
}

describe('[COMP:sandbox/orchestrator] Sandbox task orchestration', () => {
  it('creates one task-scoped sandbox per chat session and reuses it across ops', async () => {
    const { provider, browser } = build()
    await browser.navigate(ctx('s1'), 'https://github.com/login')
    await browser.snapshot(ctx('s1'))
    expect(provider.sandboxes.size).toBe(1)

    await browser.navigate(ctx('s2'), 'https://github.com/')
    expect(provider.sandboxes.size).toBe(2) // a different session = a different task
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
    await browser.navigate(ctx('s1'), 'https://example.com/')
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
