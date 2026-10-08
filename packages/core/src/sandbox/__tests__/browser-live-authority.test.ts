import { createComputerTools } from '../tools.js'
import { createExecutionContext, executionToolContext } from '../../security/execution-context.js'
import { describe, expect, it, vi } from 'vitest'
import { createLocalBrowserProvider } from '../local-browser-provider.js'
import { createCloudBrowserProvider } from '../cloud-browser-provider.js'
import { createSandboxOrchestrator, createInMemorySandboxTaskStore } from '../orchestrator.js'
import { createInMemorySessionVault, type BrowserProfile } from '../profiles.js'
import { StubSandboxProvider } from '../providers/stub.js'
import type { CurrentAuthorityBoundary } from '../../tools/types.js'

function lease() {
  let allowed = true
  const authority: CurrentAuthorityBoundary = {
    async assertCurrent() { if (!allowed) throw Object.assign(new Error('Access changed'), { reason: 'authority_changed' }) },
    async execute(operation) {
      await authority.assertCurrent()
      const result = await operation()
      await authority.assertCurrent()
      return result
    },
  }
  return { authority, revoke: () => { allowed = false } }
}
const ctx = { userId: 'user', workspaceId: 'workspace', sessionId: 'session', profileId: 'profile' }

describe('[COMP:sandbox/local-browser] live source authority across browser backends', () => {
  it.each([[false, 'browserNavigate'], [true, 'browserNavigate'], [true, 'browserReadPage']] as const)('forwards the tool source boundary into provider dispatch (validated execution: %s, tool: %s)', async (validated, toolName) => {
    const source = lease(), provider = new StubSandboxProvider()
    const { sandboxId } = await provider.create({ workspaceId: ctx.workspaceId, taskId: 'task' })
    const cloud = createCloudBrowserProvider({ provider, binding: { resolve: async () => ({ sandboxId }) } })
    const tools = createComputerTools({ cloudAvailable: () => true, cloud, local: createLocalBrowserProvider({ transport: null }) })
    const execution = createExecutionContext({
      identity: { kind: 'attended', principal: { kind: 'workspace_member', userId: ctx.userId } },
      ownership: { kind: 'workspace', workspaceId: ctx.workspaceId },
      access: { ...ctx, assistantId: 'assistant', assistantKind: 'standard', clearance: 'internal',
        compartments: null, mutationCompartments: null, projectIds: null, visibilityAssistantIds: ['assistant'] },
      writeDefaults: { compartments: [], projectIds: [] }, authority: source.authority,
      lifecycle: { sessionId: ctx.sessionId, channelType: 'web', channelId: 'fixture', abortSignal: new AbortController().signal },
    })
    const projected = executionToolContext(execution, { appId: 'fixture' })
    const { executionContext: _execution, ...legacy } = projected
    source.revoke()
    const result = await tools[toolName].execute({ url: 'https://example.com' }, validated ? projected : legacy)
    expect(result.isError).toBe(true)
    expect(provider.sandboxes.get(sandboxId)?.actions.some(action => action.op === 'navigate')).toBe(false)
  })

  it('refuses local dispatch when source authority expires while profile admission waits', async () => {
    const source = lease(), send = vi.fn(), onDestination = vi.fn()
    const local = createLocalBrowserProvider({ transport: { send }, onDestination,
      admit: async () => { source.revoke(); return async () => {} } })
    await expect(local.navigate({ ...ctx, authority: source.authority }, 'https://example.com')).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(send).not.toHaveBeenCalled()
    expect(onDestination).not.toHaveBeenCalled()
  })
  it('withholds local results and destination observations after source revocation', async () => {
    const source = lease(), onDestination = vi.fn()
    const local = createLocalBrowserProvider({ admit: async () => async () => {}, onDestination,
      transport: { send: async () => { source.revoke(); return { ok: true, data: { url: 'https://private.example', title: 'Private', nodes: [] } } } } })
    await expect(local.snapshot({ ...ctx, authority: source.authority })).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(onDestination).not.toHaveBeenCalled()
  })
  it('retains the live boundary on protected reference fills without serializing it', async () => {
    const source = lease(), send = vi.fn(async () => ({ ok: true as const, data: { status: 'filled', filledCount: 1, requiresHumanCompletion: true } }))
    const local = createLocalBrowserProvider({ admit: async () => async () => {}, transport: { send } })
    const scope = { ...ctx, taskId: 'task', browserProfileId: ctx.profileId, destinationOrigin: 'https://example.com' }
    await local.fillReference!(scope, [{ referenceId: 'opaque-reference', ref: '@e1' }], source.authority)
    expect(JSON.stringify(send.mock.calls)).not.toContain('authority')
    source.revoke()
    await expect(local.fillReference!(scope, [{ referenceId: 'opaque-reference', ref: '@e1' }], source.authority)).rejects.toMatchObject({ code: 'protected_fill_denied' })
    expect(send).toHaveBeenCalledOnce()
  })
  it('refuses a cloud action after connect loses source authority', async () => {
    const source = lease(), provider = new StubSandboxProvider()
    const { sandboxId } = await provider.create({ workspaceId: ctx.workspaceId, taskId: 'task' })
    const connect = provider.connect.bind(provider)
    vi.spyOn(provider, 'connect').mockImplementation(async id => { const handle = await connect(id); source.revoke(); return handle })
    const cloud = createCloudBrowserProvider({ provider, binding: { resolve: async () => ({ sandboxId }) } })
    await expect(cloud.click({ ...ctx, authority: source.authority }, '@e1')).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(provider.sandboxes.get(sandboxId)?.actions.some(action => action.op === 'click')).toBe(false)
  })
  it.each(['snapshot', 'navigate'] as const)('withholds cloud %s results and blocks follow-up recovery after revocation', async op => {
    const source = lease(), provider = new StubSandboxProvider()
    const { sandboxId } = await provider.create({ workspaceId: ctx.workspaceId, taskId: 'task' })
    const base = provider.browser.bind(provider)
    vi.spyOn(provider, 'browser').mockImplementation(id => {
      const browser = base(id)
      return { ...browser,
        snapshot: async () => { const result = await browser.snapshot(); source.revoke(); return result },
        navigate: async url => { const result = await browser.navigate(url); source.revoke(); return result },
      }
    })
    const recoverLogin = vi.fn(async () => ({ retry: true })), onNavigated = vi.fn()
    const cloud = createCloudBrowserProvider({ provider, binding: { resolve: async () => ({ sandboxId }), recoverLogin, onNavigated } })
    const call = op === 'snapshot' ? cloud.snapshot({ ...ctx, authority: source.authority })
      : cloud.navigate({ ...ctx, authority: source.authority }, 'https://example.com/login')
    await expect(call).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(recoverLogin).not.toHaveBeenCalled()
    expect(onNavigated).not.toHaveBeenCalled()
  })
  it.each(['finalizer', 'budget', 'explicit'] as const)('kills a revoked live task during %s cleanup without capture or download publication', async cleanup => {
    const source = lease(), provider = new StubSandboxProvider(), vault = createInMemorySessionVault()
    const profile: BrowserProfile = { id: ctx.profileId, workspaceId: ctx.workspaceId, ownerUserId: ctx.userId,
      name: 'Fictional live identity', scope: 'owner', clearance: 'internal', departmentId: 'research',
      enabledAssistantIds: [], defaultBackend: 'cloud', localControlMode: 'task_tabs', proxyUrl: null, createdAt: '', updatedAt: '' }
    await vault.put({ profileId: ctx.profileId, site: 'example.com', bundle: { site: 'example.com', cookies: [{ name: 'sid', value: 'fixture' }], capturedAt: new Date().toISOString() } })
    const saveDownload = vi.fn(), finals: Array<() => void | Promise<void>> = []
    const orchestrator = createSandboxOrchestrator({ provider, taskStore: createInMemorySandboxTaskStore(), vault,
      profileStore: { get: async () => profile }, saveDownload,
      meter: cleanup === 'budget' ? {
        meteringActive: () => true,
        recordSandboxSeconds: async () => { source.revoke(); return { costUsd: 1, capExceeded: true } },
        recordProxyGb: async () => ({ costUsd: 0, capExceeded: false }),
        recordTokens: async () => ({ costUsd: 0, capExceeded: false }),
      } : null })
    const cloud = createCloudBrowserProvider({ provider, binding: orchestrator.binding })
    await cloud.navigate({ ...ctx, authority: source.authority, registerInvocationFinalizer: (_key, finish) => { finals.push(finish) } }, 'https://example.com/account')
    const task = await orchestrator.getActiveTask(ctx.sessionId)
    const put = vi.spyOn(vault, 'put'), pull = vi.spyOn(provider.bridge, 'pullDownloads')
    if (cleanup === 'explicit') {
      source.revoke()
      await orchestrator.completeTask(ctx.sessionId, 'completed', source.authority)
    } else if (cleanup === 'finalizer') {
      source.revoke()
      await finals[0]()
    } else {
      await expect(cloud.snapshot({ ...ctx, authority: source.authority })).rejects.toThrow('authorized budget')
    }
    expect(put).not.toHaveBeenCalled()
    expect(pull).not.toHaveBeenCalled()
    expect(saveDownload).not.toHaveBeenCalled()
    expect(provider.sandboxes.get(task!.sandboxId)?.status).toBe('killed')
  })
  it('retains the original acting floor across cold restoration and denies capture, resume and results after revocation', async () => {
    const source = lease(), provider = new StubSandboxProvider(), tasks = createInMemorySandboxTaskStore()
    const frozen = { version: 1 as const, assistantId: 'assistant', ceiling: {
      userId: ctx.userId, workspaceId: ctx.workspaceId, clearance: 'internal' as const,
      compartments: null, mutationCompartments: null, projectIds: null, visibilityAssistantIds: ['assistant'],
    } }
    const orchestrator = createSandboxOrchestrator({ provider, taskStore: tasks, resolveExecutionAuthority: async () => source.authority })
    const cloud = createCloudBrowserProvider({ provider, binding: orchestrator.binding })
    const identityless = { ...ctx, profileId: undefined }
    await cloud.navigate({ ...identityless, executionAuthority: frozen }, 'https://example.com')
    const original = await orchestrator.getActiveTask(ctx.sessionId)
    expect(original?.executionAuthority).toEqual(frozen)
    const restored = createInMemorySandboxTaskStore()
    await restored.create(JSON.parse(JSON.stringify(original)))
    const pull = vi.spyOn(provider.bridge, 'pullDownloads'), saveDownload = vi.fn()
    const cold = createSandboxOrchestrator({ provider, taskStore: restored, saveDownload, resolveExecutionAuthority: async () => source.authority })
    source.revoke()
    await expect(createCloudBrowserProvider({ provider, binding: cold.binding }).snapshot(identityless))
      .rejects.toMatchObject({ reason: 'authority_changed' })
    await restored.update(original!.taskId, { status: 'paused' })
    await expect(cold.resumeAfterTakeover(ctx.sessionId)).rejects.toMatchObject({ reason: 'authority_changed' })
    await expect(cold.assertTaskAuthority(original!)).rejects.toMatchObject({ reason: 'authority_changed' })
    await cold.completeTask(ctx.sessionId)
    expect(pull).not.toHaveBeenCalled()
    expect(saveDownload).not.toHaveBeenCalled()
    expect(provider.sandboxes.get(original!.sandboxId)?.status).toBe('killed')
  })

  it.each(['before', 'during'])('renews original profile eligibility after assistant removal %s a cloud operation', async when => {
    const source = lease(), provider = new StubSandboxProvider(), tasks = createInMemorySandboxTaskStore()
    let enabled = true
    const profile: BrowserProfile = { id: ctx.profileId, workspaceId: ctx.workspaceId, ownerUserId: ctx.userId,
      name: 'Fictional enabled identity', scope: 'owner', clearance: 'internal', departmentId: null,
      enabledAssistantIds: ['assistant'], defaultBackend: 'cloud', localControlMode: 'task_tabs', proxyUrl: null, createdAt: '', updatedAt: '' }
    const frozen = { version: 1 as const, assistantId: 'assistant', ceiling: {
      userId: ctx.userId, workspaceId: ctx.workspaceId, clearance: 'internal' as const,
      compartments: null, mutationCompartments: null, projectIds: null, visibilityAssistantIds: ['assistant'],
    } }
    const orchestrator = createSandboxOrchestrator({ provider, taskStore: tasks,
      profileStore: { get: async () => ({ ...profile, enabledAssistantIds: enabled ? ['assistant'] : [] }) },
      resolveExecutionAuthority: async () => source.authority })
    const cloud = createCloudBrowserProvider({ provider, binding: orchestrator.binding })
    await cloud.navigate({ ...ctx, executionAuthority: frozen }, 'https://portal.example')
    const task = (await orchestrator.getActiveTask(ctx.sessionId))!
    const control = provider.browser(task.sandboxId)
    const snapshot = vi.spyOn(control, 'snapshot')
    vi.spyOn(provider, 'browser').mockReturnValue(control)
    if (when === 'before') enabled = false
    else snapshot.mockImplementationOnce(async () => { enabled = false; return { url: 'https://portal.example', title: 'Withheld', nodes: [] } })
    await expect(cloud.snapshot(ctx)).rejects.toMatchObject({ code: 'profile_authority_denied' })
    expect(snapshot).toHaveBeenCalledTimes(when === 'before' ? 0 : 1)
    await expect(orchestrator.assertTaskAuthority(task)).rejects.toMatchObject({ code: 'profile_authority_denied' })
    await expect(orchestrator.captureSession(ctx.sessionId, 'portal.example')).rejects.toMatchObject({ code: 'profile_authority_denied' })
    const pull = vi.spyOn(provider.bridge, 'pullDownloads')
    await orchestrator.completeTask(ctx.sessionId)
    expect(pull).not.toHaveBeenCalled()
    expect(provider.sandboxes.get(task.sandboxId)?.status).toBe('killed')
  })

  it('adds profile eligibility to the returned authority when compute first binds a browser identity', async () => {
    const source = lease(), provider = new StubSandboxProvider(), tasks = createInMemorySandboxTaskStore()
    const profile: BrowserProfile = { id: ctx.profileId, workspaceId: ctx.workspaceId, ownerUserId: ctx.userId,
      name: 'Fictional compute identity', scope: 'owner', clearance: 'internal', departmentId: null,
      enabledAssistantIds: ['assistant'], defaultBackend: 'cloud', localControlMode: 'task_tabs', proxyUrl: null, createdAt: '', updatedAt: '' }
    const executionAuthority = { version: 1 as const, assistantId: 'assistant', ceiling: {
      userId: ctx.userId, workspaceId: ctx.workspaceId, clearance: 'internal' as const,
      compartments: null, mutationCompartments: null, projectIds: null, visibilityAssistantIds: ['assistant'],
    } }
    const orchestrator = createSandboxOrchestrator({ provider, taskStore: tasks, profileStore: { get: async () => profile },
      resolveExecutionAuthority: async () => source.authority })
    await orchestrator.binding.resolve({ ...ctx, profileId: undefined, executionAuthority })
    const bound = await orchestrator.binding.resolve({ ...ctx, executionAuthority }, { browser: true, url: 'https://portal.example' })
    expect((await orchestrator.getActiveTask(ctx.sessionId))?.profileId).toBe(ctx.profileId)
    profile.enabledAssistantIds = []
    const effect = vi.fn()
    await expect(bound.authority!.execute(effect)).rejects.toMatchObject({ code: 'profile_authority_denied' })
    expect(effect).not.toHaveBeenCalled()
    const second = { ...ctx, sessionId: 'second-compute', executionAuthority }
    await orchestrator.binding.resolve({ ...second, profileId: undefined })
    await expect(orchestrator.binding.resolve(second, { browser: true, url: 'https://portal.example' })).rejects.toMatchObject({ code: 'profile_authority_denied' })
    expect((await orchestrator.getActiveTask(second.sessionId))?.profileId).toBeNull()
  })

})
