import { previewAssistantTransfer } from '../assistant-transfer-admission.js'
import { createDbCompartmentStore } from '../compartment-store.js'
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getPool, getAppPool } from '../client.js'
import { createWorkspaceStore } from '../workspace-store.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool(), store = createWorkspaceStore()
let db: PoolClient, actor: string, outsider: string, source: string, destination: string, assistant: string, department: string
const q = (sql: string, values: unknown[] = []) => db.query(sql, values)
const adopt = (who = actor, selected?: string) => store.adoptAssistant(who, destination, assistant, selected)
describe('bounded assistant transfer admission', () => {
  beforeAll(async () => { db = await pool.connect() })
  beforeEach(async () => {
    ;[actor, outsider, source, destination, assistant, department] = Array.from({ length: 6 }, () => randomUUID())
    for (const id of [actor, outsider]) await q('INSERT INTO users(id,auth_provider_id) VALUES($1,$1::uuid::text)', [id])
    for (const id of [source, destination]) {
      await q("INSERT INTO workspaces(id,name,owner_user_id,is_personal) VALUES($1,'Transfer',$2,$3)", [id, actor, id === source])
      await q("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [id, actor])
    }
    await q("INSERT INTO assistants(id,name,workspace_id,owner_user_id,kind) VALUES($1,'Empty',$2,$3,'standard')", [assistant, source, actor])
    await q("INSERT INTO assistant_members(assistant_id,user_id,role) VALUES($1,$2,'owner') ON CONFLICT DO NOTHING", [assistant, actor])
    await q("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1,$2,'Default',$3,'team',$1::uuid::text,$4)", [department, destination, actor, `team:${department}`])
    await q("INSERT INTO workspace_compartments(workspace_id,key,label,created_by,managed_by,managed_ref_id) VALUES($1,$2,'Default',$3,'team',$4)", [destination, `team:${department}`, actor, department])
    await q('INSERT INTO workspace_group_compartment_grants(group_id,compartment_key) VALUES($1,$2)', [department, `team:${department}`])
    await q("UPDATE workspace_access_policies SET access_mode='simple',setup_state='ready',default_department_id=$2 WHERE workspace_id=$1", [destination, department])
  })
  afterEach(async () => {
    await q('DELETE FROM turn_events WHERE assistant_id=$1', [assistant])
    await q('DELETE FROM workspaces WHERE id=ANY($1::uuid[])', [[source, destination]])
    await q('DELETE FROM users WHERE id=ANY($1::uuid[])', [[actor, outsider]])
  })
  afterAll(async () => { db.release(); await pool.end(); await getAppPool().end() })
  it('temporarily denies empty shells until non-FK writers have certified serialization', async () => {
    await expect(adopt()).rejects.toMatchObject({ code: 'assistant_transfer_certification_required' })
    expect((await q('SELECT workspace_id,owner_user_id,default_workspace_group_id FROM assistants WHERE id=$1', [assistant])).rows)
      .toEqual([{ workspace_id: source, owner_user_id: actor, default_workspace_group_id: null }])
    expect((await q('SELECT group_id FROM workspace_group_assistants WHERE assistant_id=$1', [assistant])).rows).toEqual([])
    expect((await q('SELECT user_id FROM assistant_members WHERE assistant_id=$1', [assistant])).rows).toEqual([{ user_id: actor }])
  })
  it('denies nonmembers and nonowners without changing the private boundary', async () => {
    expect(await adopt(outsider)).toBe(false)
    await q('DELETE FROM assistant_members WHERE assistant_id=$1', [assistant])
    expect(await adopt()).toBe(false)
    expect((await q('SELECT workspace_id,owner_user_id FROM assistants WHERE id=$1', [assistant])).rows).toEqual([{ workspace_id: source, owner_user_id: actor }])
  })
  it('Departments requires an explicit department or saved default', async () => {
    await q("UPDATE workspace_access_policies SET access_mode='departments',default_department_id=NULL WHERE workspace_id=$1", [destination])
    await expect(adopt()).rejects.toMatchObject({ code: 'context_selection_required' })
    await expect(adopt(actor, department)).rejects.toMatchObject({ code: 'assistant_transfer_certification_required' })
  })
  it('does not borrow legacy destination policy from a ready source', async () => {
    await q("UPDATE workspace_access_policies SET access_mode='departments',setup_state='legacy',default_department_id=NULL WHERE workspace_id=$1", [destination])
    await q("INSERT INTO workspace_access_policies(workspace_id,setup_state) VALUES($1,'ready') ON CONFLICT(workspace_id) DO UPDATE SET setup_state='ready'", [source])
    await expect(adopt()).rejects.toMatchObject({ code: 'access_mode_setup_required' })
    await q("UPDATE workspace_access_policies SET setup_state='legacy' WHERE workspace_id=$1", [source])
    // Both legacy: the pre-mode transfer applies unchanged (see the legacy test below).
    expect(await adopt()).toBe(true)
  })
  it('legacy-to-legacy adopt and remove behave exactly as before the access-mode branch', async () => {
    await q("UPDATE workspace_access_policies SET access_mode='departments',setup_state='legacy',default_department_id=NULL WHERE workspace_id=$1", [destination])
    // Legacy moves never required an empty shell.
    await q("UPDATE assistants SET system_prompt='Kept instructions' WHERE id=$1", [assistant])
    const preview = await previewAssistantTransfer(actor, destination, assistant, 'adopt')
    expect(preview).toMatchObject({ setupState: 'legacy', canTransfer: true, reason: null })
    expect(await adopt()).toBe(true)
    expect((await q('SELECT workspace_id,owner_user_id,system_prompt FROM assistants WHERE id=$1', [assistant])).rows)
      .toEqual([{ workspace_id: destination, owner_user_id: null, system_prompt: 'Kept instructions' }])
    expect((await q('SELECT user_id FROM assistant_members WHERE assistant_id=$1', [assistant])).rows).toEqual([])
    expect(await store.removeAssistant(actor, destination, assistant)).toBe(true)
    expect((await q('SELECT workspace_id,owner_user_id FROM assistants WHERE id=$1', [assistant])).rows)
      .toEqual([{ workspace_id: source, owner_user_id: actor }])
    expect((await q('SELECT user_id,role FROM assistant_members WHERE assistant_id=$1', [assistant])).rows).toEqual([{ user_id: actor, role: 'owner' }])
    // A raw write without the canonical receipt is still refused, legacy or not.
    await expect(q('UPDATE assistants SET workspace_id=$2 WHERE id=$1', [assistant, destination])).rejects.toThrow('assistant_transfer_admission_required')
  })
  it('blocks raw mixed-version workspace updates', async () => {
    await expect(q('UPDATE assistants SET workspace_id=$2 WHERE id=$1', [assistant, destination])).rejects.toThrow('assistant_transfer_admission_required')
  })
  it('rechecks mode after waiting for the workspace lock', async () => {
    await q('BEGIN')
    await q('SELECT id FROM workspaces WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[source, destination]])
    const pid = (await q('SELECT pg_backend_pid() pid')).rows[0].pid
    const result = adopt().catch(e => e)
    try {
      await expect.poll(async () => {
        await q('SELECT pg_stat_clear_snapshot()')
        return (await q('SELECT count(*)::int n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid])).rows[0].n
      }).toBe(1)
      await q("UPDATE workspace_access_policies SET access_mode='departments',default_department_id=NULL WHERE workspace_id=$1", [destination])
      await q('COMMIT')
      expect(await result).toMatchObject({ code: 'context_selection_required' })
    } finally { await q('ROLLBACK'); await result }
  })
  it.each([
    ["charter", { instructions: 'Private customer notes' }],
    ["system_prompt", 'Private instructions'], ["bio", 'Private biography'],
    ["compartments", ['source:private']], ["compartments", []],
    ["default_compartments", ['source:private']],
  ])('rejects assistant-local content or caps: %s', async (column, value) => {
    await q(`UPDATE assistants SET ${column}=$2 WHERE id=$1`, [assistant, value])
    await expect(adopt()).rejects.toMatchObject({ code: 'assistant_transfer_review_required' })
    expect((await q(`SELECT ${column} AS value,workspace_id FROM assistants WHERE id=$1`, [assistant])).rows)
      .toEqual([{ value, workspace_id: source }])
  })
  it('does not certify snapshot emptiness while a non-FK history insert is uncommitted', async () => {
    await q('BEGIN')
    try {
      await q(`INSERT INTO turn_events(workspace_id,assistant_id,assistant_message_id,step_ordinal,actor,kind)
        VALUES($1,$2,$2::uuid::text,0,'assistant_turn','mutation')`, [source, assistant])
      await expect(adopt()).rejects.toMatchObject({ code: 'assistant_transfer_certification_required' })
      await q('COMMIT')
      expect((await q('SELECT workspace_id FROM assistants WHERE id=$1', [assistant])).rows).toEqual([{ workspace_id: source }])
      expect((await q('SELECT workspace_id FROM turn_events WHERE assistant_id=$1', [assistant])).rows).toEqual([{ workspace_id: source }])
    } finally { await q('ROLLBACK') }
  })
  it('returns current destination preview and rejects stale revision before admission', async () => {
    const preview = await previewAssistantTransfer(actor, destination, assistant, 'adopt')
    expect(preview).toMatchObject({ destinationWorkspaceId: destination, defaultDepartmentId: department,
      canTransfer: false, reason: 'assistant_transfer_certification_required' })
    if (typeof preview === 'boolean') throw new Error('expected preview')
    await q("UPDATE workspace_access_policies SET revision=revision+1 WHERE workspace_id=$1", [destination])
    await expect(store.adoptAssistant(actor, destination, assistant, department, preview.policyRevision))
      .rejects.toMatchObject({ code: 'access_policy_conflict' })
  })
  it('old row-first assistant updates fail NOWAIT instead of waiting backwards', async () => {
    await q('BEGIN')
    try {
      await q('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [source])
      await expect(pool.query('UPDATE assistants SET compartments=$2 WHERE id=$1', [assistant, []]))
        .rejects.toMatchObject({ code: '55P03' })
      await q('SELECT id FROM assistants WHERE id=$1 FOR UPDATE NOWAIT', [assistant])
    } finally { await q('ROLLBACK') }
  })
  it('canonical compartment setter waits on workspace before locking assistant', async () => {
    await q('BEGIN')
    await q('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [source])
    const pid = (await q('SELECT pg_backend_pid() pid')).rows[0].pid
    const result = createDbCompartmentStore().setAssistantGrant(actor, assistant, [], []).catch(e => e)
    try {
      await expect.poll(async () => {
        await q('SELECT pg_stat_clear_snapshot()')
        return (await q('SELECT count(*)::int n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid])).rows[0].n
      }).toBe(1)
      await q('SELECT id FROM assistants WHERE id=$1 FOR UPDATE NOWAIT', [assistant])
      await q('COMMIT')
      expect(await result).toBe(true)
    } finally { await q('ROLLBACK'); await result }
  })

  it('a shaped transfer receipt cannot reopen uncertified transfers', async () => {
    await q('BEGIN')
    try {
      await q("SELECT set_config('app.current_user_id',$1,true),set_config('app.assistant_transfer',$2,true)",
        [actor, JSON.stringify({ assistantId: assistant, source, destination, userId: actor })])
      await expect(q('UPDATE assistants SET workspace_id=$2 WHERE id=$1', [assistant, destination]))
        .rejects.toThrow('assistant_transfer_certification_required')
    } finally { await q('ROLLBACK') }
  })
  it('removal previews the owner personal destination without reusing the source revision', async () => {
    const shared = randomUUID()
    await q("INSERT INTO assistants(id,name,workspace_id,kind) VALUES($1,'Shared',$2,'standard')", [shared, destination])
    const preview = await previewAssistantTransfer(actor, destination, shared, 'remove')
    expect(preview).toMatchObject({ destinationWorkspaceId: source, setupState: 'legacy', canTransfer: false })
    await expect(store.removeAssistant(actor, destination, shared, department)).rejects.toMatchObject({ code: 'access_mode_setup_required' })
    expect((await q('SELECT workspace_id,owner_user_id FROM assistants WHERE id=$1', [shared])).rows)
      .toEqual([{ workspace_id: destination, owner_user_id: null }])
  })

  it('compartment setter preserves caps when the live actor is not an administrator', async () => {
    expect(await createDbCompartmentStore().setAssistantGrant(outsider, assistant, [], [])).toBe(false)
    expect((await q('SELECT compartments,default_compartments FROM assistants WHERE id=$1', [assistant])).rows)
      .toEqual([{ compartments: null, default_compartments: [] }])
  })

})
