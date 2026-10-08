import { describe, expect, it } from 'vitest'
import { createInMemorySandboxTaskStore, type SandboxTaskRecord } from '../orchestrator.js'
import { browserInputScope } from '../input-scope.js'
import { assertBrowserTaskPublication } from '../task-publication.js'
const task = (): SandboxTaskRecord => ({ taskId: 'task', sessionId: 'session', workspaceId: 'workspace', userId: 'owner',
  sandboxId: 'sandbox', status: 'running', profileId: null, injectedSite: null, browserStartedAt: 1,
  authorizedBudgetUsd: 1, createdAt: 1, lastActivityAt: 1, inputScope: browserInputScope({}, 'workspace') })
describe('[COMP:sandbox/task-publication] in-memory task publication guard', () => {
  it('prevents changed history, replacement and retirement until persistence finishes, then permits retry', async () => {
    const store = createInMemorySandboxTaskStore(), original = task()
    await store.create(original)
    await store.withPublication(original, async () => {
      await expect(store.noteInputScope(original.taskId, browserInputScope({ compartments: ['private'] }, original.workspaceId)))
        .rejects.toMatchObject({ code: 'browser_publication_busy', retrySafe: true })
      await expect(store.create({ ...original, taskId: 'replacement' })).rejects.toMatchObject({ code: 'browser_publication_busy' })
      await expect(store.update(original.taskId, { status: 'completed' })).rejects.toMatchObject({ code: 'browser_publication_busy' })
      expect((await store.getActiveBySession(original.sessionId))?.inputScope?.compartments).toEqual([])
    })
    await store.noteInputScope(original.taskId, browserInputScope({ compartments: ['private'] }, original.workspaceId))
    expect((await store.getActiveBySession(original.sessionId))?.inputScope?.compartments).toEqual(['private'])
    await expect(store.withPublication(original, async () => {})).rejects.toMatchObject({ code: 'profile_authority_denied' })
  })
  it('releases the guard after refusal and handles semantic property ordering', async () => {
    const store = createInMemorySandboxTaskStore(), original = task()
    await store.create(original)
    await expect(store.update(original.taskId, { sessionId: 'replacement' })).rejects.toMatchObject({ code: 'profile_authority_denied' })
    await expect(store.withPublication(original, async () => { throw new Error('Storage failed') })).rejects.toThrow('Storage failed')
    await expect(store.update(original.taskId, { status: 'completed' })).resolves.toBeUndefined()
    expect(() => assertBrowserTaskPublication(original, { ...original, inputScope: { sources: [], projectIds: [], compartments: [], sensitivity: 'public' } })).not.toThrow()
  })
})
