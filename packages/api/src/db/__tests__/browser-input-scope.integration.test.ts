import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { getPool, getAppPool, query } from '../client.js'
import { createSandboxTaskStore } from '../sandbox-task-store.js'
import { browserInputScope, type SandboxTaskRecord } from '@use-brian/core'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
afterAll(async () => { await getAppPool().end(); await getPool().end() })

describe('[COMP:sandbox/input-scope] durable input history', () => {
  it('merges concurrent API writers without losing protection and survives a cold store', async () => {
    const userId = randomUUID(), workspaceId = randomUUID(), sessionId = randomUUID(), taskId = randomUUID()
    await query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'test',$1::text)", [userId])
    await query("INSERT INTO workspaces(id,name,purpose,owner_user_id) VALUES($1,'Fictional task evidence','test',$2)", [workspaceId, userId])
    await query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'member','confidential')", [workspaceId, userId])
    const store = createSandboxTaskStore()
    const record: SandboxTaskRecord = { taskId, sandboxId: 'fictional-sandbox', userId, workspaceId, sessionId,
      status: 'running', profileId: null, injectedSite: null, browserStartedAt: Date.now(), authorizedBudgetUsd: 2,
      createdAt: Date.now(), lastActivityAt: Date.now(), inputScope: browserInputScope({}, workspaceId) }
    await store.create(record)
    const source = { resourceKind: 'workspace_file', resourceId: randomUUID(), version: '1', workspaceId, userId, assistantId: null,
      sensitivity: 'confidential' as const, compartments: ['team:fictional-a'], projectIds: [] }
    await Promise.all([
      store.noteInputScope(taskId, browserInputScope({ sources: [source] }, workspaceId)),
      createSandboxTaskStore().noteInputScope(taskId, browserInputScope({ compartments: ['team:fictional-b'] }, workspaceId)),
    ])
    const restored = (await createSandboxTaskStore().getActiveBySession(sessionId))!
    expect(restored.inputScope).toMatchObject({ sensitivity: 'confidential', compartments: ['team:fictional-a', 'team:fictional-b'], sources: [source] })
    await expect(store.noteInputScope(taskId, browserInputScope({ sources: [{ ...source, version: '2' }] }, workspaceId))).rejects.toMatchObject({ code: 'profile_authority_denied' })
    expect((await store.getActiveBySession(sessionId))?.inputScope).toEqual(restored.inputScope)
    await expect(store.update(taskId, { inputScope: browserInputScope({}, workspaceId) })).rejects.toThrow()
    const unknown = { ...record, taskId: randomUUID(), sessionId: randomUUID(), inputScope: null }
    await store.create(unknown)
    expect(await store.noteInputScope(unknown.taskId, browserInputScope({ compartments: ['team:fictional-b'] }, workspaceId))).toBeNull()
    await store.update(taskId, { status: 'failed' })
    await expect(store.noteInputScope(taskId, browserInputScope({}, workspaceId))).rejects.toThrow()
  })
})
