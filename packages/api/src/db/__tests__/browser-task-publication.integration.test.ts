import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { browserInputScope, browserTaskPublicationSnapshot, type SandboxTaskRecord } from '@use-brian/core'
import { applyRLSGucs, getAppPool, getPool, query, rollbackAndRelease } from '../client.js'
import { createSandboxTaskStore } from '../sandbox-task-store.js'
import { createWorkspaceFile } from '../workspace-files.js'
import { withFileTransactionAdmission } from '../../workspace-access/file-transaction-admission.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
afterAll(async () => { await getAppPool().end(); await getPool().end() })
async function fixture() {
  const userId = randomUUID(), workspaceId = randomUUID(), sessionId = randomUUID(), taskId = randomUUID()
  await query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'test',$1::text)", [userId])
  await query("INSERT INTO workspaces(id,name,purpose,owner_user_id) VALUES($1,'Fictional publication lock','test',$2)", [workspaceId, userId])
  await query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')", [workspaceId, userId])
  const store = createSandboxTaskStore(), record: SandboxTaskRecord = { taskId, sandboxId: 'fictional-sandbox', userId, workspaceId, sessionId,
    status: 'running', profileId: null, injectedSite: null, browserStartedAt: Date.now(), authorizedBudgetUsd: 1,
    createdAt: Date.now(), lastActivityAt: Date.now(), inputScope: browserInputScope({}, workspaceId) }
  await store.create(record)
  return { record, store, expected: browserTaskPublicationSnapshot(record) }
}
async function waitForLock(pid: number) {
  const end = Date.now() + 3000
  while (Date.now() < end) {
    if ((await query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.wait_event_type === 'Lock') return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Competing task mutation did not wait for publication')
}
describe('[COMP:sandbox/task-publication] atomic PostgreSQL task history', () => {
  it.each([false,true])('renews host authority after file insertion before commit (deny=%s)',async deny=>{
    const f=await fixture(),id=randomUUID(),events:string[]=[]
    const input={id,workspaceId:f.record.workspaceId,path:`/${id}.txt`,parentPath:'/',name:'Fixture.txt',
      mime:'text/plain',sizeBytes:4,storageUri:`fixture://${id}`,createdByUserId:f.record.userId,sensitivity:'public' as const}
    const publish=()=>withFileTransactionAdmission(async(client,actor)=>{
      expect(actor).toBe(f.record.userId)
      expect((await client.query('SELECT id FROM workspace_files WHERE id=$1',[id])).rows).toEqual([])
      events.push('admit')
      return async()=>{
        expect((await client.query('SELECT id FROM workspace_files WHERE id=$1',[id])).rows).toEqual([{id}])
        expect((await query('SELECT id FROM workspace_files WHERE id=$1',[id])).rows).toEqual([])
        events.push('renew')
        if(deny)throw new Error('fixture_authority_expired')
      }
    },()=>createWorkspaceFile(f.record.userId,input))
    if(deny)await expect(publish()).rejects.toThrow('fixture_authority_expired')
    else expect(await publish()).toMatchObject({id})
    expect(events).toEqual(['admit','renew'])
    expect((await query('SELECT id FROM workspace_files WHERE id=$1',[id])).rows).toEqual(deny?[]:[{id}])
    // An expired call's guard must not leak into later independent publications.
    if(deny)expect(await createWorkspaceFile(f.record.userId,input)).toMatchObject({id})
  })
  it.each(['input', 'replacement', 'retirement', 'deletion'])('holds %s until the publication transaction commits', async change => {
    const f = await fixture(), writer = await getAppPool().connect(), other = await getPool().connect()
    let pending: Promise<unknown> | undefined
    try {
      await writer.query('BEGIN'); await applyRLSGucs(writer, f.record.userId)
      await writer.query('SELECT admit_browser_task_publication($1,$2,$3,$4::jsonb)',
        [f.record.workspaceId, f.record.sessionId, f.record.taskId, JSON.stringify(f.expected)])
      const pid = (await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      const command = change === 'input' ? ["UPDATE sandbox_tasks SET input_scope=$2::jsonb WHERE task_id=$1", [f.record.taskId, browserInputScope({ compartments: ['later-protected-input'] }, f.record.workspaceId)]]
        : change === 'retirement' ? ["UPDATE sandbox_tasks SET status='completed' WHERE task_id=$1", [f.record.taskId]]
        : change === 'deletion' ? ["DELETE FROM sandbox_tasks WHERE task_id=$1", [f.record.taskId]]
        : ["INSERT INTO sandbox_tasks(task_id,sandbox_id,user_id,workspace_id,session_id,status,input_scope) VALUES($1,'replacement',$2,$3,$4,'running',$5)",
          [randomUUID(), f.record.userId, f.record.workspaceId, f.record.sessionId, f.record.inputScope]]
      let finished = false
      pending = other.query(command[0] as string, command[1] as unknown[]).then(() => { finished = true })
      await waitForLock(pid)
      expect(finished).toBe(false)
      expect((await f.store.getActiveBySession(f.record.sessionId))?.taskId).toBe(f.record.taskId)
      await writer.query('COMMIT')
      await pending
      expect(finished).toBe(true)
      await writer.query('BEGIN'); await applyRLSGucs(writer, f.record.userId)
      await expect(writer.query('SELECT admit_browser_task_publication($1,$2,$3,$4::jsonb)',
        [f.record.workspaceId, f.record.sessionId, f.record.taskId, JSON.stringify(f.expected)])).rejects.toMatchObject({ code: '42501' })
    } finally {
      await rollbackAndRelease(writer)
      await pending?.catch(() => {})
      await rollbackAndRelease(other)
    }
  })
  it('rejects a forged actor and releases a refused transaction for a later store mutation', async () => {
    const f = await fixture(), client = await getAppPool().connect()
    try {
      await client.query('BEGIN'); await applyRLSGucs(client, randomUUID())
      await expect(client.query('SELECT admit_browser_task_publication($1,$2,$3,$4::jsonb)',
        [f.record.workspaceId, f.record.sessionId, f.record.taskId, JSON.stringify(f.expected)])).rejects.toMatchObject({ code: '42501' })
    } finally { await rollbackAndRelease(client) }
    await f.store.noteInputScope(f.record.taskId, browserInputScope({ compartments: ['after-refusal'] }, f.record.workspaceId))
    expect((await f.store.getActiveBySession(f.record.sessionId))?.inputScope?.compartments).toEqual(['after-refusal'])
  })
})
