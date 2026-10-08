import { describe, it, expect, vi } from 'vitest'
import request from 'supertest'
import { createTestApp } from '../../routes/__tests__/helpers.js'
import { computerRoutes, createInMemoryLocalComputerTaskStore } from '../../routes/computer.js'
import { createBrowserTaskDiscard } from '../task-discard.js'
import type { RelayCommandTransport } from '@use-brian/core'
import { createSandboxOrchestrator, createInMemorySandboxTaskStore, StubSandboxProvider } from '@use-brian/core'

const actor = { userId: 'user-1', workspaceId: 'ws-1', sessionId: 'session-1' }
function fixture() {
  const tasks = createInMemoryLocalComputerTaskStore()
  tasks.touch({ ...actor, profileId: 'profile-1' })
  const send = vi.fn<RelayCommandTransport['send']>(async () => ({ ok: true, data: { stopped: true } }))
  const role = vi.fn(async () => 'member' as string | null)
  const discard = createBrowserTaskDiscard({ localTasks: tasks, transport: { send }, orchestrator: null, getWorkspaceRole: role })
  return { tasks, send, role, discard }
}

describe('[COMP:sandbox/task-discard] owner-scoped safety teardown', () => {
  it('discards both owned backends and leaves uncertain local teardown retryable', async () => {
    const h = fixture()
    const provider = new StubSandboxProvider()
    const orchestrator = createSandboxOrchestrator({ provider, taskStore: createInMemorySandboxTaskStore() })
    const binding = await orchestrator.binding.resolve(actor, { browser: false })
    const complete = vi.spyOn(orchestrator, 'completeTask')
    const discard = createBrowserTaskDiscard({ localTasks: h.tasks, transport: { send: h.send }, orchestrator, getWorkspaceRole: h.role })
    h.send.mockRejectedValueOnce(new Error('uncertain'))
    await expect(discard(actor)).rejects.toThrow('could not be confirmed')
    expect(provider.sandboxes.get(binding.sandboxId)?.status).toBe('killed')
    expect(h.tasks.getActiveBySession(actor.sessionId)).not.toBeNull()
    expect(complete).not.toHaveBeenCalled()
    expect(await discard(actor)).toBe('discarded')
  })
  it('stops an owned bound task without profile or source READ and removes only that task', async () => {
    const h = fixture(); const task = h.tasks.getActiveBySession(actor.sessionId)!
    task.authority = { assertCurrent: async () => { throw new Error('revoked') }, execute: async () => { throw new Error('revoked') } }
    expect(await h.discard(actor)).toBe('discarded')
    expect(h.send).toHaveBeenCalledWith({ userId: actor.userId, browserProfileId: 'profile-1', taskId: task.taskId, op: 'stop', args: {} })
    expect(h.tasks.getActiveBySession(actor.sessionId)).toBeNull()
    expect(await h.discard(actor)).toBe('not_active')
    expect(h.send).toHaveBeenCalledOnce()
  })

  it.each([{ userId: 'other-user' }, { workspaceId: 'other-workspace' }, { sessionId: 'unknown-session' }])('conceals tasks outside the actor scope: %j', async patch => {
    const h = fixture()
    expect(await h.discard({ ...actor, ...patch })).toBe('not_active')
    expect(h.send).not.toHaveBeenCalled()
  })

  it('refuses nonmembers and membership loss before dispatch', async () => {
    const h = fixture()
    h.role.mockResolvedValueOnce(null)
    expect(await h.discard(actor)).toBe('not_active')
    h.role.mockResolvedValueOnce('member').mockResolvedValueOnce(null)
    await expect(h.discard(actor)).rejects.toThrow('could not be confirmed')
    expect(h.send).not.toHaveBeenCalled()
    expect(h.tasks.getActiveBySession(actor.sessionId)).not.toBeNull()
  })

  it('keeps a replacement task installed while the exact old Stop is in flight', async () => {
    const h = fixture(); const old = h.tasks.getActiveBySession(actor.sessionId)!
    h.send.mockImplementationOnce(async () => {
      h.tasks.complete(actor.sessionId, old.taskId)
      h.tasks.touch({ ...actor, profileId: 'profile-1' })
      return { ok: true, data: { stopped: true } }
    })
    expect(await h.discard(actor)).toBe('discarded')
    expect(h.tasks.getActiveBySession(actor.sessionId)?.taskId).not.toBe(old.taskId)
    expect(h.send.mock.calls[0]?.[0]).toMatchObject({ taskId: old.taskId })
  })

  it('retains the task on uncertain relay failure and suppresses raw errors', async () => {
    const h = fixture()
    h.send.mockRejectedValueOnce(new Error('SECRET_SENTINEL'))
    await expect(h.discard(actor)).rejects.toThrow('Browser discard could not be confirmed.')
    expect(h.tasks.getActiveBySession(actor.sessionId)).not.toBeNull()
    expect(await h.discard(actor)).toBe('discarded')
  })

  it('exposes only the trusted actor route, including while observation is locked', async () => {
    const h = fixture()
    const app = createTestApp('/api/computer', computerRoutes({ orchestrator: null, provider: null, vault: null,
      profileStore: null, getWorkspaceRole: h.role, protectedFillBlocked: () => true, discardTask: h.discard }), { userId: actor.userId })
    const url = `/api/computer/tasks/${actor.sessionId}/discard`
    expect((await request(app).post(url).send({ workspaceId: actor.workspaceId, userId: 'other-user' })).status).toBe(400)
    h.send.mockRejectedValueOnce(new Error('SECRET_SENTINEL'))
    const failed = await request(app).post(url).send({ workspaceId: actor.workspaceId })
    expect(failed.status).toBe(502)
    expect(JSON.stringify(failed.body)).not.toContain('SECRET_SENTINEL')
    expect((await request(app).post(url).send({ workspaceId: actor.workspaceId })).body).toEqual({ ok: true, status: 'discarded' })
  })
})
