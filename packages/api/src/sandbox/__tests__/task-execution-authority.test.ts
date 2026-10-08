import { describe, expect, it, vi } from 'vitest'
import type { AuthoringAuthority, SandboxTaskRecord } from '@use-brian/core'
import { createAuthorityLease } from '../../context-scope/authority-lease.js'
import { resolveBrowserTaskExecutionAuthority } from '../task-execution-authority.js'

const state = vi.hoisted(() => ({ assistant: { id: 'assistant', workspaceId: 'workspace' } as unknown, current: null as unknown, session: null as Record<string, unknown> | null, denied: false }))
vi.mock('../../db/sessions.js', () => ({ findSessionAuthorityById: async () => state.session }))
vi.mock('../../db/client.js', () => ({ query: async () => ({ rows: state.session ? [state.session] : [] }) }))
vi.mock('../../session-read-authority.js', () => ({ gateSessionRead: async () => state.denied ? { status: 403, error: 'private source' } : null }))
vi.mock('../../db/users.js', () => ({ findAssistantById: async () => state.assistant }))
vi.mock('../../context-scope/resolve-turn-scope.js', () => ({ resolveLiveAccessCeilingSystem: async () => state.current }))

const frozen: AuthoringAuthority = { version: 1, assistantId: 'assistant', ceiling: {
  workspaceId: 'workspace', userId: 'member', clearance: 'internal', compartments: null,
  mutationCompartments: null, projectIds: null, visibilityAssistantIds: ['assistant'],
  departmentRead: { workspaceId: 'workspace', userId: 'member', assistantId: 'assistant', base: 'internal',
    departments: { research: 'internal' }, contextDepartment: null, binding: null, cap: null },
} }
const task = { userId: 'member', workspaceId: 'workspace', executionAuthority: frozen } as SandboxTaskRecord

async function resolveLiveTask() {
  const caller=createAuthorityLease(frozen.ceiling,async()=>state.current as typeof frozen.ceiling)
  return resolveBrowserTaskExecutionAuthority(JSON.parse(JSON.stringify({...task,sourceAuthority:caller.snapshotSource!()})),caller)
}

describe('[COMP:sandbox/task-execution-authority] persisted acting-assistant ceiling', () => {
  it('renews current department edges and never revives an invalidated cold lease', async () => {
    state.assistant = { id: 'assistant', workspaceId: 'workspace' }
    state.current = structuredClone(frozen.ceiling)
    const authority = await resolveLiveTask()
    await expect(authority.execute(async () => 'allowed')).resolves.toBe('allowed')
    state.current = { ...frozen.ceiling, departmentRead: { ...frozen.ceiling.departmentRead, departments: {} } }
    const effect = vi.fn()
    await expect(authority.execute(effect)).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(effect).not.toHaveBeenCalled()
    state.current = structuredClone(frozen.ceiling)
    await expect(authority.assertCurrent()).rejects.toMatchObject({ reason: 'authority_changed' })
  })
  it.each([null, { id: 'assistant', workspaceId: 'elsewhere' }])('refuses missing or moved original assistant', async assistant => {
    state.assistant = assistant
    state.current = structuredClone(frozen.ceiling)
    const authority = await resolveLiveTask()
    await expect(authority.assertCurrent()).rejects.toMatchObject({ reason: 'authority_changed' })
  })
  it.each([null, {}, { ...frozen, ceiling: { ...frozen.ceiling, userId: 'another-member' } }])('refuses absent, malformed or foreign actor evidence', async evidence => {
    await expect(resolveBrowserTaskExecutionAuthority({ ...task, executionAuthority: evidence } as SandboxTaskRecord))
      .rejects.toMatchObject({ code: 'profile_authority_denied' })
  })
  it('withholds a completed provider result when the original grant expires in flight', async () => {
    state.assistant = { id: 'assistant', workspaceId: 'workspace' }
    state.current = structuredClone(frozen.ceiling)
    const authority = await resolveLiveTask()
    await expect(authority.execute(async () => { state.current = null; return 'private frame' }))
      .rejects.toMatchObject({ reason: 'authority_changed', operationMayHaveExecuted: true })
  })
  it('refuses missing historical source evidence even with a current acting ceiling',async()=>{
    state.assistant={id:'assistant',workspaceId:'workspace'}
    state.current=structuredClone(frozen.ceiling)
    await expect(resolveBrowserTaskExecutionAuthority(task)).rejects.toMatchObject({code:'profile_authority_denied'})
    const caller=createAuthorityLease(frozen.ceiling,async()=>frozen.ceiling)
    await expect(resolveBrowserTaskExecutionAuthority(task,caller)).rejects.toMatchObject({code:'profile_authority_denied'})
  })
  it('requires the same live invocation when the source cannot be reconstructed', async () => {
    state.assistant = { id: 'assistant', workspaceId: 'workspace' }
    state.current = structuredClone(frozen.ceiling)
    const original = createAuthorityLease(frozen.ceiling, async () => state.current as typeof frozen.ceiling)
    const held = { ...task, sourceAuthority: original.snapshotSource!() }
    await expect((await resolveBrowserTaskExecutionAuthority(held, original)).execute(async () => 'live')).resolves.toBe('live')
    await expect((await resolveBrowserTaskExecutionAuthority(held)).assertCurrent()).rejects.toMatchObject({ reason: 'authority_changed' })
    const replacement = createAuthorityLease(frozen.ceiling, async () => frozen.ceiling)
    await expect((await resolveBrowserTaskExecutionAuthority(held, replacement)).assertCurrent()).rejects.toMatchObject({ reason: 'authority_changed' })
  })
  it('accepts a delegated sub-agent invocation and stops when the delegating leases stop holding', async () => {
    state.assistant = { id: 'assistant', workspaceId: 'workspace' }
    state.current = structuredClone(frozen.ceiling)
    // The inter-assistant callee's ambient boundary: it renews through the
    // delegating leases and names its own invocation as the task source.
    let delegating = true
    const delegated = {
      assertCurrent: async () => { if (!delegating) throw Object.assign(new Error('changed'), { reason: 'authority_changed' }) },
      execute: async <T,>(operation: () => Promise<T>) => operation(),
      snapshotSource: () => ({ version: 1 as const, kind: 'invocation' as const, invocationId: '22222222-2222-4222-8222-222222222222' }),
    }
    const held = JSON.parse(JSON.stringify({ ...task, sourceAuthority: delegated.snapshotSource() }))
    const authority = await resolveBrowserTaskExecutionAuthority(held, delegated)
    await expect(authority.execute(async () => 'delegated')).resolves.toBe('delegated')
    delegating = false
    await expect(authority.assertCurrent()).rejects.toMatchObject({ reason: 'authority_changed' })
  })
  it.each(['deleted', 'rebound', 'lock', 'read', 'audience', 'held'])('refuses a cold session whose source is %s', async changed => {
    state.assistant = { id: 'assistant', workspaceId: 'workspace' }
    state.current = structuredClone(frozen.ceiling)
    state.denied = false
    state.session = { id: 'session', assistantId: 'assistant', userId: 'member', contextGroupId: null,
      visibility: 'owner', mode: null, effectiveClearance: null, contextCompartments: [], contextBindingOrigin: 'explicit',
      contextProjectId: null, contextLockedAt: new Date('2026-10-07T00:00:00Z') }
    const held: SandboxTaskRecord = { ...task, sourceAuthority: {
      version: 1, kind: 'session', visibility: 'owner', mode: null, effectiveClearance: null, contextCompartments: [], invocationId: '10000000-0000-4000-8000-000000000001',
      id: 'session', assistantId: 'assistant', userId: 'member', executingAssistantId: 'assistant',
      authorityUserId: 'member', workspaceId: 'workspace', contextGroupId: null, contextProjectId: null,
      contextLockedAt: '2026-10-07T00:00:00.000Z', memberMode: 'member', ignoreSessionBinding: false, systemRead: false,
    } }
    const authority = await resolveBrowserTaskExecutionAuthority(JSON.parse(JSON.stringify(held)))
    await expect(authority.assertCurrent()).resolves.toBeUndefined()
    if (changed === 'deleted') state.session = null
    else if (changed === 'rebound') state.session.assistantId = 'replacement'
    else if (changed === 'lock') state.session.contextLockedAt = new Date('2026-10-08T00:00:00Z')
    else if (changed === 'audience') state.session.visibility = 'workspace'
    else if (changed === 'held') state.session.contextBindingOrigin = 'held'
    else state.denied = true
    const effect = vi.fn()
    await expect(authority.execute(effect)).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(effect).not.toHaveBeenCalled()
  })

})
