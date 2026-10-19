/** Native canonical transaction composition, not a substitute CRM/task store. */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import { boundScopeSources, type ApplicationModuleDefinition, type TaskRecord, type TaskUpdateFields } from '@use-brian/core'
import { ApplicationPlatformError } from '@use-brian/shared'
import { applyRLSGucs, getAppPool, getPool } from '../../db/client.js'
import { bindTaskClosedHook, createTask, getTaskById, resolveTaskById, updateTask } from '../../db/tasks.js'
import { createCompany, updateCompany } from '../../db/crm.js'
import { findAssistantById } from '../../db/users.js'
import { resolveExecutionContextSystem } from '../../context-scope/execution-context.js'
import { ApplicationPlatformService } from '../service.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

describe('[COMP:api/application-records] canonical native operation composition', () => {
  const owner = getPool(), workspaceId = randomUUID(), userId = randomUUID(), readerId = randomUUID(), assistantId = randomUUID()
  const access = { workspaceId, userId, assistantId, assistantKind: 'primary' as const }
  beforeAll(async () => {
    for (const id of [userId,readerId]) await owner.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
    await owner.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Fictional native operations',$2,false)", [workspaceId,userId])
    await owner.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')", [workspaceId,userId])
    await owner.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'member','confidential')", [workspaceId,readerId])
    await owner.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Fictional native operator',$2,$3,'primary','confidential')", [assistantId,userId,workspaceId])
  })
  afterAll(async () => {
    bindTaskClosedHook(null)
    await owner.query('DELETE FROM workspaces WHERE id=$1', [workspaceId])
    await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[userId,readerId]])
    await getAppPool().end(); await owner.end()
  })
  const version = (task: TaskRecord) => boundScopeSources(task)[0].version!
  const task = (title = `Fictional operation ${randomUUID()}`, parentId?: string) => createTask(userId, { workspaceId, title, parentId, access })
  async function client() {
    const connection = await getAppPool().connect()
    await connection.query('BEGIN'); await applyRLSGucs(connection,userId)
    expect((await connection.query(`SELECT r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE') AS bypass
      FROM pg_roles r JOIN pg_class c ON c.oid='public.tasks'::regclass WHERE r.rolname=current_user`)).rows[0].bypass).toBe(false)
    return connection
  }
  async function execution() {
    return (await resolveExecutionContextSystem({ userId, workspaceId, assistant: (await findAssistantById(assistantId))!, memberMode: 'member',
      identity: { kind: 'attended', principal: { kind: 'workspace_member', userId, authenticationKind: 'native_session' } },
      ownership: { kind: 'workspace', workspaceId }, lifecycle: { sessionId: randomUUID(), sessionPersisted: false,
        channelId: 'native-operation-fixture', channelType: 'test', abortSignal: new AbortController().signal } })).executionContext
  }
  it('Q05 rolls back task supersession, child and Goal links without early lifecycle effects', async () => {
    const parent = await task(), child = await task('Fictional linked child',parent.id)
    const goal = (await owner.query(`INSERT INTO goals(workspace_id,host_type,host_id,outcome,done_when,means,status,created_by_user_id,confirmed_at)
      VALUES($1,'task',$2,'Fictional linked outcome','{"kind":"subtasks"}','{}','active',$3,now()) RETURNING id`, [workspaceId,parent.id,userId])).rows[0].id
    const connection = await client(), effects: Array<() => void> = [], closed: string[] = []
    bindTaskClosedHook(value => closed.push(value.id))
    try {
      const updated = await updateTask(userId,parent.id,{ title: 'Fictional uncommitted successor',status: 'done' },undefined,{ access,expectedVersion: version(parent) },
        { client: connection,afterCommit: (effect: () => void) => effects.push(effect) })
      expect(updated).not.toBeNull(); expect(updated!.id).not.toBe(parent.id)
      expect(version(updated!)).toBe(String(BigInt(version(parent))+1n))
      expect((await connection.query('SELECT parent_id FROM tasks WHERE id=$1',[child.id])).rows[0].parent_id).toBe(updated!.id)
      expect((await connection.query('SELECT host_id FROM goals WHERE id=$1',[goal])).rows[0].host_id).toBe(updated!.id)
      expect(closed).toEqual([]); expect(effects).toHaveLength(1)
      await connection.query('ROLLBACK')
      expect((await owner.query('SELECT valid_to,superseded_by FROM tasks WHERE id=$1',[parent.id])).rows[0]).toEqual({ valid_to: null,superseded_by: null })
      expect((await owner.query('SELECT parent_id FROM tasks WHERE id=$1',[child.id])).rows[0].parent_id).toBe(parent.id)
      expect((await owner.query('SELECT host_id FROM goals WHERE id=$1',[goal])).rows[0].host_id).toBe(parent.id)
      expect((await owner.query('SELECT id FROM tasks WHERE id=$1',[updated!.id])).rows).toEqual([])
      expect(closed).toEqual([])
    } finally { await connection.query('ROLLBACK'); connection.release(); bindTaskClosedHook(null) }
  })
  it('Q05 composes the canonical entity-backed company and task writers in one commit', async () => {
    const company = await createCompany(userId,{ workspaceId,name: `Fictional company ${randomUUID()}`,access,mergeByName: false }), before = await task()
    const connection = await client(), effects: Array<() => void> = []
    try {
      const changedCompany = await updateCompany(userId,company.id,{ name: 'Fictional revised company' },access,connection)
      const changedTask = await updateTask(userId,before.id,{ title: 'Fictional revised work' },undefined,{ access,expectedVersion: version(before) },
        { client: connection,afterCommit: (effect: () => void) => effects.push(effect) })
      expect(changedCompany?.id).toBe(company.id)
      expect((await owner.query('SELECT display_name FROM entities WHERE id=$1',[company.id])).rows[0].display_name).toBe(company.name)
      expect((await owner.query('SELECT valid_to FROM tasks WHERE id=$1',[before.id])).rows[0].valid_to).toBeNull()
      await connection.query('COMMIT'); for (const effect of effects) effect()
      expect((await owner.query('SELECT display_name FROM entities WHERE id=$1',[company.id])).rows[0].display_name).toBe('Fictional revised company')
      expect((await getTaskById(access,changedTask!.id))?.title).toBe('Fictional revised work')
      expect(version(changedTask!)).toBe(String(BigInt(version(before))+1n))
    } finally { await connection.query('ROLLBACK'); connection.release() }
  })
  it('Q05 lets exactly one canonical CAS writer win and refuses a stale predecessor precondition', async () => {
    const before = await task()
    const results = await Promise.allSettled(['Fictional first edit','Fictional second edit'].map(title =>
      updateTask(userId,before.id,{ title },undefined,{ access,expectedVersion: version(before) })))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const refused = results.find(result => result.status === 'rejected')
    expect(refused?.status === 'rejected' && refused.reason.code).toBe('record_version_conflict')
    expect((await owner.query('SELECT id FROM tasks WHERE workspace_id=$1 AND valid_to IS NULL AND title=ANY($2::text[])',[workspaceId,['Fictional first edit','Fictional second edit']])).rows).toHaveLength(1)
  })
  it.each([{ unknown: 'not a field' },{ title: '' },{ status: 'invented' },{ due: 'not a Date' }])('Q04 refuses invalid native patch %j at the canonical writer', async fields => {
    const before = await task()
    await expect(updateTask(userId,before.id,fields as TaskUpdateFields,undefined,{ access })).rejects.toMatchObject({ code: 'invalid_value' })
    expect((await owner.query('SELECT valid_to,superseded_by FROM tasks WHERE id=$1',[before.id])).rows[0]).toEqual({ valid_to: null,superseded_by: null })
  })
  it('Q06 commits a registered multi-task command and its receipt/audit/outbox exactly once, with complete rollback on refusal', async () => {
    const first = await task(), second = await task(), input = z.object({ ids: z.array(z.string().uuid()).length(2),versions: z.array(z.string()).length(2),title: z.string().min(1) }).strict()
    const module: ApplicationModuleDefinition<PoolClient> = { key: 'native_operation_fixture',defaultState: 'enabled',application: {
      version: '1',dependencies: [],resources: [],queries: [],commands: ['rename_pair'],events: ['native_operation_fixture.changed'],policyCapabilities: [],backgroundHandlers: [],uiContributions: [] },queries: {},commands: {
      rename_pair: { input,eventKey: 'native_operation_fixture.changed',authorize: async (context,raw) => {
        for (const id of input.parse(raw).ids) if (!await resolveTaskById(context.execution.security.access,id,context.transaction)) throw new ApplicationPlatformError('access_unavailable','The task is unavailable.')
      },execute: async (context,raw) => {
        const value = input.parse(raw),refs = []
        for (const [index,id] of value.ids.entries()) {
          const updated = await updateTask(userId,id,{ title: value.title },undefined,{ access: context.execution.security.access,expectedVersion: value.versions[index] },
            { client: context.transaction,afterCommit: context.afterCommit })
          if (!updated) throw new ApplicationPlatformError('access_unavailable','The task is unavailable.')
          refs.push({ workspaceId,origin: { kind: 'native' as const,moduleKey: 'native' },typeKey: 'task',id: updated.id,version: version(updated) })
        }
        return refs
      },authorizeResult: async (context,refs) => {
        for (const ref of refs) if (!await getTaskById(context.execution.security.access,ref.id,context.transaction)) throw new ApplicationPlatformError('access_unavailable','The task is unavailable.')
      } },
    } }
    const service = new ApplicationPlatformService([module]), identity = await execution(), key = randomUUID()
    const failed = { idempotencyKey: key,input: { ids: [first.id,second.id],versions: [version(first),'999'],title: 'Fictional rolled back pair' } }
    await expect(service.command(identity,module.key,'rename_pair',failed)).rejects.toMatchObject({ code: 'record_version_conflict' })
    expect((await owner.query('SELECT id FROM tasks WHERE id=ANY($1::uuid[]) AND valid_to IS NULL',[[first.id,second.id]])).rows).toHaveLength(2)
    expect((await owner.query('SELECT id FROM application_operation_receipts WHERE idempotency_key=$1',[key])).rows).toEqual([])
    const command = { idempotencyKey: randomUUID(),input: { ids: [first.id,second.id],versions: [version(first),version(second)],title: 'Fictional committed pair' } }
    const committed = await service.command(identity,module.key,'rename_pair',command), replay = await service.command(identity,module.key,'rename_pair',command)
    expect(replay.id).toBe(committed.id); expect(committed.resources).toHaveLength(2)
    expect((await owner.query('SELECT count(*)::int AS count FROM application_command_audit WHERE receipt_id=$1',[committed.id])).rows[0].count).toBe(1)
    expect((await owner.query('SELECT count(*)::int AS count FROM application_committed_events WHERE receipt_id=$1',[committed.id])).rows[0].count).toBe(1)
    expect((await owner.query('SELECT resources::text FROM application_operation_receipts WHERE id=$1',[committed.id])).rows[0].resources).not.toContain('Fictional committed pair')
    // Replay is governed by current native visibility; another actual member
    // retains access to the same source after this caller loses its audience.
    await owner.query('UPDATE tasks SET user_id=$2 WHERE id=$1',[committed.resources[0].id,readerId])
    await expect(service.command(identity,module.key,'rename_pair',command)).rejects.toMatchObject({ code: 'access_unavailable' })
    expect(await getTaskById({ ...access,userId: readerId },committed.resources[0].id)).not.toBeNull()
    expect((await owner.query('SELECT count(*)::int AS count FROM application_command_audit WHERE receipt_id=$1',[committed.id])).rows[0].count).toBe(1)
  })
})
