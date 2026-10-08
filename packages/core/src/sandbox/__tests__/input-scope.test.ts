import { describe, it, expect } from 'vitest'
import { browserInputScope, mergeBrowserInputScope, parseBrowserInputScope } from '../input-scope.js'
import { createInMemorySandboxTaskStore, createSandboxOrchestrator } from '../orchestrator.js'
import { StubSandboxProvider } from '../providers/stub.js'

const source = { workspaceId: 'workspace', userId: 'user', assistantId: null, resourceKind: 'workspace_file', resourceId: 'file',
  version: '1', sensitivity: 'confidential' as const, compartments: ['department-a'], projectIds: ['project-a'] }
const input = () => browserInputScope({ sources: [source] }, 'workspace')

describe('[COMP:sandbox/input-scope] retained task input protection', () => {
  it('copies evidence and retains the maximum labels when later input is narrower', () => {
    const initial = input()
    const result = mergeBrowserInputScope(initial, browserInputScope({ compartments: ['department-b'] }, 'workspace'), 'workspace')!
    expect(result).toMatchObject({ sensitivity: 'confidential', compartments: ['department-a', 'department-b'], projectIds: ['project-a'], sources: [source] })
    initial.sources[0]!.compartments.push('later-mutation')
    expect(result.sources[0]!.compartments).toEqual(['department-a'])
    expect(mergeBrowserInputScope(result, browserInputScope({}, 'workspace'), 'workspace')).toEqual(result)
  })

  it('rejects foreign inputs, malformed stored evidence and conflicting source versions', () => {
    expect(() => browserInputScope({ sources: [{ ...source, workspaceId: 'other' }] }, 'workspace')).toThrow()
    expect(() => parseBrowserInputScope({ sources: [] }, 'workspace')).toThrow()
    expect(() => mergeBrowserInputScope(input(), browserInputScope({ sources: [{ ...source, version: '2' }] }, 'workspace'), 'workspace')).toThrow()
    expect(mergeBrowserInputScope(null, input(), 'workspace')).toBeNull()
  })

  it('persists new evidence before another provider effect and passes retained evidence to automatic publication', async () => {
    const provider = new StubSandboxProvider(), taskStore = createInMemorySandboxTaskStore()
    provider.bridge.pullDownloads = async () => [{ path: '/download.txt', bytes: Buffer.from('fixture') }]
    let published: Parameters<NonNullable<Parameters<typeof createSandboxOrchestrator>[0]['saveDownload']>>[0] | undefined
    const orchestrator = createSandboxOrchestrator({ provider, taskStore, saveDownload: async ctx => { published = ctx } })
    const ctx = { userId: 'user', workspaceId: 'workspace', sessionId: 'session', inputScope: input() }
    await orchestrator.binding.resolve(ctx, { browser: true, url: 'https://portal.example/report' })
    await orchestrator.binding.resolve({ ...ctx, inputScope: browserInputScope({ compartments: ['department-b'] }, 'workspace') }, { browser: true })
    const before = await orchestrator.getActiveTask('session')
    expect(before?.inputScope?.compartments).toEqual(['department-a', 'department-b'])
    await expect(orchestrator.binding.resolve({ ...ctx, inputScope: browserInputScope({ sources: [{ ...source, version: '2' }] }, 'workspace') }, { browser: true }))
      .rejects.toMatchObject({ code: 'profile_authority_denied' })
    expect((await orchestrator.getActiveTask('session'))?.inputScope).toEqual(before?.inputScope)
    await orchestrator.completeTask('session')
    expect(published?.task.inputScope).toEqual(before?.inputScope)
    expect(published?.task.taskId).toBe(before?.taskId)
    expect(published?.task).not.toBe(before)
  })

  it('does not upgrade unknown history or allow a generic task patch to replace it', async () => {
    const taskStore = createInMemorySandboxTaskStore()
    const orchestrator = createSandboxOrchestrator({ provider: new StubSandboxProvider(), taskStore })
    await orchestrator.binding.resolve({ userId: 'user', workspaceId: 'workspace', sessionId: 'session' })
    const task = (await orchestrator.getActiveTask('session'))!
    expect(await taskStore.noteInputScope(task.taskId, input())).toBeNull()
    await expect(taskStore.update(task.taskId, { inputScope: input() })).rejects.toThrow()
  })
})
