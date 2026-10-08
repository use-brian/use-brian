import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserProfileAuthoritySchema, createInMemoryBrowserProfileStore, createLocalBrowserProvider, type AuthoringAuthority, type CurrentAuthorityBoundary, type DepartmentReadGrant } from '@use-brian/core'
import { createInMemoryLocalComputerTaskStore } from '../../routes/computer.js'
import { createLocalTaskAdmission } from '../local-task-authority.js'
import { browserInputScope } from '@use-brian/core'
import type { RelayCommandTransport } from '@use-brian/core'

describe('[COMP:sandbox/local-task-authority] local browser source and result authority', () => {
  const ctx = { userId: 'owner', workspaceId: 'workspace', sessionId: 'session', profileId: '' }
  let profiles: ReturnType<typeof createInMemoryBrowserProfileStore>
  let tasks: ReturnType<typeof createInMemoryLocalComputerTaskStore>
  let allowed: boolean
  let member: boolean
  let now: number
  let admit: ReturnType<typeof createLocalTaskAdmission>
  beforeEach(async () => {
    profiles = createInMemoryBrowserProfileStore()
    now = 0
    tasks = createInMemoryLocalComputerTaskStore(() => now)
    allowed = true
    member = true
    const profile = await profiles.create({ workspaceId: ctx.workspaceId, ownerUserId: ctx.userId,
      name: 'Fictional local browser', departmentId: 'research', scope: 'workspace', clearance: 'internal' })
    ctx.profileId = profile.id
    admit = createLocalTaskAdmission({ profiles, tasks, resolveHumanRead: async (userId, workspaceId): Promise<DepartmentReadGrant> => {
      if (!member) throw new Error('private database diagnostic')
      return { workspaceId, userId, assistantId: null, base: 'confidential',
        departments: allowed ? { research: 'confidential', operations: 'confidential' } : {},
        contextDepartment: null, binding: null, cap: null }
    } })
  })
  it('creates a minimal original floor and permits renewed operations without copying secrets', async () => {
    await (await admit(ctx, 'navigate'))()
    const task = tasks.getActiveBySession(ctx.sessionId)!
    expect((await admit(ctx, 'snapshot')).taskId).toBe(task.taskId)
    const send = vi.fn(async () => ({ ok: true as const, data: { url: 'https://portal.example', title: 'Fictional page', nodes: [] } }))
    await createLocalBrowserProvider({ transport: { send }, admit }).snapshot(ctx)
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ taskId: task.taskId, browserProfileId: ctx.profileId }))
    expect(task.profileAuthority).toEqual({ id: ctx.profileId, workspaceId: ctx.workspaceId, ownerUserId: ctx.userId,
      departmentId: 'research', scope: 'workspace', clearance: 'internal' })
    await (await admit({ ...ctx, taskId: task.taskId }, 'snapshot'))()
    await profiles.update(ctx.profileId, { name: 'Renamed' })
    await (await admit(ctx, 'click'))()
  })
  it('guards local publication before a competing input can reach the relay and permits a later retry', async () => {
    await admit({ ...ctx, inputScope: browserInputScope({}, ctx.workspaceId) }, 'navigate')
    const original = tasks.getActiveBySession(ctx.sessionId)!
    const send = vi.fn<RelayCommandTransport['send']>(async () => ({ ok: true, data: { url: 'https://portal.example', title: 'Page', nodes: [] } }))
    const provider = createLocalBrowserProvider({ transport: { send }, admit })
    const next = { ...ctx, inputScope: browserInputScope({ compartments: ['operations'] }, ctx.workspaceId) }
    await tasks.withPublication(original, async () => {
      await expect(provider.snapshot(next)).rejects.toMatchObject({ code: 'browser_publication_busy' })
      expect(send).not.toHaveBeenCalled()
      expect(() => tasks.complete(ctx.sessionId)).toThrow(/being saved/)
      expect(() => tasks.touch({ ...ctx, sessionId: 'replacement' })).toThrow(/being saved/)
    })
    await provider.snapshot(next)
    expect(send).toHaveBeenCalledTimes(1)
    expect(tasks.getActiveBySession(ctx.sessionId)?.inputScope?.compartments).toContain('operations')
  })
  it('retains input requirements across calls without sending them to the relay', async () => {
    const first = browserInputScope({ sensitivity: 'confidential', compartments: ['research'] }, ctx.workspaceId)
    await admit({ ...ctx, inputScope: first }, 'navigate')
    const send = vi.fn<RelayCommandTransport['send']>(async () => ({ ok: true, data: { url: 'https://portal.example', title: 'Page', nodes: [] } }))
    await createLocalBrowserProvider({ transport: { send }, admit }).snapshot({ ...ctx, inputScope: browserInputScope({ compartments: ['operations'] }, ctx.workspaceId) })
    expect(tasks.getActiveBySession(ctx.sessionId)?.inputScope).toMatchObject({ sensitivity: 'confidential', compartments: ['operations', 'research'] })
    expect(send.mock.calls[0]?.[0]).not.toHaveProperty('inputScope')
    first.compartments.push('mutated')
    expect(tasks.getActiveBySession(ctx.sessionId)?.inputScope?.compartments).not.toContain('mutated')
  })
  it('rejects changed input versions before relay dispatch and cannot add evidence to a replacement', async () => {
    const source = { workspaceId: ctx.workspaceId, userId: ctx.userId, assistantId: null,
      resourceKind: 'workspace_file', resourceId: 'file', version: '1', sensitivity: 'internal' as const, compartments: ['research'], projectIds: [] }
    await admit({ ...ctx, inputScope: browserInputScope({ sources: [source] }, ctx.workspaceId) }, 'navigate')
    const old = tasks.getActiveBySession(ctx.sessionId)!
    const send = vi.fn<RelayCommandTransport['send']>()
    const provider = createLocalBrowserProvider({ transport: { send }, admit })
    await expect(provider.snapshot({ ...ctx, inputScope: browserInputScope({ sources: [{ ...source, version: '2' }] }, ctx.workspaceId) }))
      .rejects.toMatchObject({ code: 'profile_authority_denied' })
    expect(send).not.toHaveBeenCalled()
    tasks.complete(ctx.sessionId)
    await admit(ctx, 'navigate')
    expect(() => tasks.noteInputScope(ctx.sessionId, old.taskId, browserInputScope({}, ctx.workspaceId))).toThrow()
    expect(tasks.getActiveBySession(ctx.sessionId)?.inputScope).toBeNull()
  })
  it.each(['department', 'scope', 'clearance', 'deleted'])('refuses stale %s before dispatch even when the new classification is readable', async (change) => {
    await admit(ctx, 'navigate')
    if (change === 'department') await profiles.update(ctx.profileId, { departmentId: 'operations' })
    if (change === 'scope') await profiles.update(ctx.profileId, { scope: 'owner' })
    if (change === 'clearance') await profiles.update(ctx.profileId, { clearance: 'public' })
    if (change === 'deleted') await profiles.delete(ctx.profileId)
    const send = vi.fn()
    const provider = createLocalBrowserProvider({ transport: { send }, admit })
    await expect(provider.snapshot(ctx)).rejects.toMatchObject({ code: 'profile_authority_denied' })
    expect(send).not.toHaveBeenCalled()
  })
  it.each(['transfer', 'revoke', 'membership', 'replacement', 'expiry'])('withholds a successful relay result after %s', async (change) => {
    await admit(ctx, 'navigate')
    const send = vi.fn(async () => {
      if (change === 'transfer') await profiles.update(ctx.profileId, { departmentId: 'operations' })
      if (change === 'revoke') allowed = false
      if (change === 'membership') member = false
      if (change === 'replacement') { tasks.complete(ctx.sessionId); await admit(ctx, 'navigate') }
      if (change === 'expiry') now += 20 * 60 * 1000
      return { ok: true as const, data: { url: 'https://private.example', title: 'Private', nodes: [] } }
    })
    const onDestination = vi.fn()
    const provider = createLocalBrowserProvider({ transport: { send }, admit, onDestination })
    await expect(provider.snapshot(ctx)).rejects.toMatchObject({ code: 'profile_authority_denied', message: 'Profile authority unavailable' })
    expect(send).toHaveBeenCalledOnce()
    expect(onDestination).not.toHaveBeenCalled()
  })
  it('preserves missing legacy evidence and rejects attempts to replace the first floor', async () => {
    tasks.touch(ctx)
    const pin = BrowserProfileAuthoritySchema.parse(await profiles.get(ctx.profileId))
    tasks.touch({ ...ctx, profileAuthority: pin })
    expect(tasks.getActiveBySession(ctx.sessionId)?.profileAuthority).toBeNull()
    await expect(admit(ctx, 'navigate')).rejects.toMatchObject({ code: 'profile_authority_denied' })
    tasks.complete(ctx.sessionId)
    await admit(ctx, 'navigate')
    await profiles.update(ctx.profileId, { departmentId: 'operations' })
    tasks.touch({ ...ctx, profileAuthority: BrowserProfileAuthoritySchema.parse(await profiles.get(ctx.profileId)) })
    expect(tasks.getActiveBySession(ctx.sessionId)?.profileAuthority?.departmentId).toBe('research')
    await expect(admit(ctx, 'navigate')).rejects.toMatchObject({ code: 'profile_authority_denied' })
    tasks.complete(ctx.sessionId)
    await (await admit(ctx, 'navigate'))()
    expect(tasks.getActiveBySession(ctx.sessionId)?.profileAuthority?.departmentId).toBe('operations')
  })
  it.each([{ userId: 'stranger' }, { workspaceId: 'another' }, { profileId: 'missing' }, { taskId: 'stale-handle' }])('refuses a mismatched actor or task handle: %j', async (changed) => {
    await admit(ctx, 'navigate')
    const original = tasks.getActiveBySession(ctx.sessionId)
    await expect(admit({ ...ctx, ...changed }, 'navigate')).rejects.toMatchObject({ code: 'profile_authority_denied' })
    tasks.touch({ ...ctx, ...changed })
    expect(tasks.getActiveBySession(ctx.sessionId)?.taskId).toBe(original?.taskId)
  })
  it('requires a task for ordinary operations and allows owner capture without advertising a task', async () => {
    await expect(admit(ctx, 'snapshot')).rejects.toMatchObject({ code: 'profile_authority_denied' })
    await expect(admit({ ...ctx, userId: 'reader' }, 'captureState')).rejects.toMatchObject({ code: 'profile_authority_denied' })
    const renew = await admit(ctx, 'captureState')
    expect(tasks.getActiveBySession(ctx.sessionId)).toBeNull()
    await renew()
    await profiles.update(ctx.profileId, { departmentId: 'operations' })
    await expect(renew()).rejects.toMatchObject({ code: 'profile_authority_denied' })
  })
  it('does not use owner recovery visibility to operate an unassigned shared v2 profile', async () => {
    await profiles.update(ctx.profileId, { departmentId: null })
    await expect(admit(ctx, 'navigate')).rejects.toMatchObject({ code: 'profile_authority_denied' })
    expect(tasks.getActiveBySession(ctx.sessionId)).toBeNull()
  })

  it('refuses a transfer while membership lookup is awaited, before dispatch', async () => {
    const racing = createLocalTaskAdmission({ profiles, tasks, resolveHumanRead: async () => {
      await profiles.update(ctx.profileId, { departmentId: 'operations' })
      return { workspaceId: ctx.workspaceId, userId: ctx.userId, assistantId: null, base: 'confidential',
        departments: { research: 'confidential', operations: 'confidential' }, contextDepartment: null, binding: null, cap: null }
    } })
    await expect(racing(ctx, 'navigate')).rejects.toMatchObject({ code: 'profile_authority_denied' })
    expect(tasks.getActiveBySession(ctx.sessionId)).toBeNull()
  })

  it('denies missing profile-store wiring and membership failures with no raw diagnostics', async () => {
    const missing = createLocalTaskAdmission({ profiles: null, tasks, resolveHumanRead: async () => null })
    await expect(missing(ctx, 'navigate')).rejects.toMatchObject({ code: 'profile_authority_denied' })
    member = false
    await expect(admit(ctx, 'navigate')).rejects.toMatchObject({ message: 'Profile authority unavailable' })
    expect(tasks.getActiveBySession(ctx.sessionId)).toBeNull()
  })
  it.each(['before', 'during'])('retains the original live source for human relay operations after revocation %s dispatch', async when => {
    let sourceAllowed = true
    const authority: CurrentAuthorityBoundary = {
      async assertCurrent() { if (!sourceAllowed) throw new Error('private revoked source') },
      async execute(operation) { await this.assertCurrent(); const result = await operation(); await this.assertCurrent(); return result },
    }
    await admit({ ...ctx, authority }, 'navigate')
    // Human controls omit the invoking assistant's boundary. Activity must not erase it.
    tasks.touch(ctx)
    expect(tasks.getActiveBySession(ctx.sessionId)?.authority).toBe(authority)
    if (when === 'before') sourceAllowed = false
    const send = vi.fn(async () => { sourceAllowed = false; return { ok: true as const, data: { url: 'https://portal.example', nodes: [] } } })
    const onDestination = vi.fn()
    const provider = createLocalBrowserProvider({ transport: { send }, admit, onDestination })
    await expect(provider.snapshot(ctx)).rejects.toMatchObject({ code: 'profile_authority_denied' })
    expect(send).toHaveBeenCalledTimes(when === 'before' ? 0 : 1)
    expect(onDestination).not.toHaveBeenCalled()
  })

  it('pins the execution and source once and composes the original source resolver with human controls', async () => {
    const frozen: AuthoringAuthority = { version: 1, assistantId: 'assistant', ceiling: {
      workspaceId: ctx.workspaceId, userId: ctx.userId, clearance: 'internal', compartments: null,
      mutationCompartments: null, projectIds: null, visibilityAssistantIds: ['assistant'],
      departmentRead: { workspaceId: ctx.workspaceId, userId: ctx.userId, assistantId: 'assistant', base: 'internal',
        departments: { research: 'internal' }, contextDepartment: null, binding: null, cap: null },
    } }
    let sourceAllowed = true
    const authority: CurrentAuthorityBoundary = {
      snapshotSource: () => ({ version: 1, kind: 'invocation', invocationId: '11111111-1111-4111-8111-111111111111' }),
      async assertCurrent() { if (!sourceAllowed) throw new Error('source lost') },
      async execute(operation) { await this.assertCurrent(); const result = await operation(); await this.assertCurrent(); return result },
    }
    const resolveExecutionAuthority = vi.fn(async () => authority)
    const checked = createLocalTaskAdmission({ profiles, tasks, resolveHumanRead: async () => ({
      workspaceId: ctx.workspaceId, userId: ctx.userId, assistantId: null, base: 'internal',
      departments: { research: 'internal' }, contextDepartment: null, binding: null, cap: null,
    }), resolveExecutionAuthority })
    const sourceAuthority = authority.snapshotSource!()
    const agent = { ...ctx, executionAuthority: frozen, sourceAuthority, authority }
    await profiles.update(ctx.profileId, { enabledAssistantIds: ['assistant'] })
    await checked(agent, 'navigate')
    const original = tasks.getActiveBySession(ctx.sessionId)!
    expect(resolveExecutionAuthority).toHaveBeenCalledWith({ userId: ctx.userId, workspaceId: ctx.workspaceId,
      executionAuthority: frozen, sourceAuthority }, authority)
    expect(original.executionAuthority).toEqual(frozen)
    expect(original.executionAuthority).not.toBe(frozen)
    tasks.touch({ ...agent, executionAuthority: { ...frozen, assistantId: 'replacement' } })
    expect(tasks.getActiveBySession(ctx.sessionId)?.executionAuthority).toEqual(frozen)
    expect(tasks.getActiveBySession(ctx.sessionId)?.authority).toBe(original.authority)
    await (await checked(ctx, 'snapshot'))()
    await expect(checked({ ...agent, executionAuthority: { ...frozen, assistantId: 'replacement' } }, 'snapshot')).rejects.toMatchObject({ code: 'profile_authority_denied' })
    await expect(checked({ ...agent, executionAuthority: { ...frozen, ceiling: { ...frozen.ceiling, clearance: 'public' } } }, 'snapshot')).rejects.toMatchObject({ code: 'profile_authority_denied' })
    await profiles.update(ctx.profileId, { clearance: 'public' })
    await expect(original.authority!.assertCurrent()).rejects.toMatchObject({ code: 'profile_authority_denied' })
    await profiles.update(ctx.profileId, { clearance: 'internal' })
    await profiles.update(ctx.profileId, { enabledAssistantIds: [] })
    await expect(checked(ctx, 'snapshot')).rejects.toMatchObject({ code: 'profile_authority_denied' })
    const effect = vi.fn()
    await expect(original.authority!.execute(effect)).rejects.toMatchObject({ code: 'profile_authority_denied' })
    expect(effect).not.toHaveBeenCalled()
    await profiles.update(ctx.profileId, { enabledAssistantIds: ['assistant'] })
    await expect(original.authority!.execute(async () => {
      await profiles.update(ctx.profileId, { enabledAssistantIds: [] })
      return 'withheld browser result'
    })).rejects.toMatchObject({ code: 'profile_authority_denied' })
    await profiles.update(ctx.profileId, { enabledAssistantIds: ['assistant'] })
    sourceAllowed = false
    await expect(checked(ctx, 'snapshot')).rejects.toMatchObject({ code: 'profile_authority_denied' })
    expect(resolveExecutionAuthority).toHaveBeenCalledOnce()
    tasks.complete(ctx.sessionId)
    sourceAllowed = true
    resolveExecutionAuthority.mockImplementationOnce(async () => {
      tasks.touch({ ...ctx, profileAuthority: BrowserProfileAuthoritySchema.parse(await profiles.get(ctx.profileId)) })
      return authority
    })
    await expect(checked(agent, 'navigate')).rejects.toMatchObject({ code: 'profile_authority_denied' })
    expect(tasks.getActiveBySession(ctx.sessionId)?.executionAuthority).toBeNull()
  })

  it('does not attach fresh agent authority to a task already started without it', async () => {
    await admit(ctx, 'navigate')
    const executionAuthority: AuthoringAuthority = { version: 1, assistantId: 'assistant', ceiling: {
      workspaceId: ctx.workspaceId, userId: ctx.userId, clearance: 'internal', compartments: null,
      mutationCompartments: null, projectIds: null, visibilityAssistantIds: null,
    } }
    await expect(admit({ ...ctx, executionAuthority }, 'navigate')).rejects.toMatchObject({ code: 'profile_authority_denied' })
    expect(tasks.getActiveBySession(ctx.sessionId)?.executionAuthority).toBeNull()
  })

})
