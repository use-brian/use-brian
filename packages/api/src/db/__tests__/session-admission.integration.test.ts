import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { getPool, getAppPool, applyRLSGucs } from '../client.js'
import { createWorkspaceChatSession, findOrCreateSession } from '../sessions.js'
import { runWithAgentAccess } from '../agent-access-context.js'
import { admitSessionCreate } from '../../workspace-access/session-create-admission.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
async function fixture(mode: 'simple' | 'departments' = 'simple') {
  const w = randomUUID(), owner = randomUUID(), member = randomUUID(), assistant = randomUUID()
  for (const id of [owner, member]) await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Session admission',$2)", [w, owner])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [w, owner])
  async function team() {
    const id = randomUUID(), key = `team:${id}`
    await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1,$2,'Department',$3,'team',$1::uuid::text,$4)", [id, w, owner, key])
    await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,created_by,managed_by,managed_ref_id) VALUES($1,$2,'Department',$3,'team',$4)", [w, key, owner, id])
    await pool.query('INSERT INTO workspace_group_compartment_grants(group_id,compartment_key,granted_by_user_id) VALUES($1,$2,$3)', [id, key, owner])
    return { id, key }
  }
  const common = await team(), other = await team()
  await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance,team_scope_mode) VALUES($1,'Session assistant',$2,$3,'standard','internal','all')", [assistant, owner, w])
  await pool.query("UPDATE workspace_access_policies SET access_mode=$2,setup_state='ready',default_department_id=$3 WHERE workspace_id=$1", [w, mode, common.id])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,team_scope_mode) VALUES($1,$2,'member','assigned')", [w, member])
  if (mode === 'departments') await pool.query('INSERT INTO workspace_group_members(group_id,user_id) VALUES($1,$2)', [common.id, member])
  const create = (patch: Partial<Parameters<typeof createWorkspaceChatSession>[0]> = {}) => createWorkspaceChatSession({
    assistantId: assistant, starterUserId: member, workspaceId: w, effectiveClearance: 'public', authenticatedHuman: true, ...patch,
  })
  const revision = async () => (await pool.query('SELECT revision::text FROM workspace_access_policies WHERE workspace_id=$1', [w])).rows[0].revision as string
  const project = randomUUID()
  await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,$1::uuid::text,$1::uuid::text,$3)", [project, w, owner])
  return { w, owner, member, assistant, common, other, create, revision, project }
}

// Deliberately fabricate BOTH sides under the non-bypass application role.
// Matching receipt/row labels (and permissive execution GUCs) are not grants.
async function pairedSharedInsert(f: Awaited<ReturnType<typeof fixture>>, patch: {
  team?: string | null; compartments?: string[]; project?: string | null;
  sensitivity?: string; actor?: string
} = {}) {
  const client = await getAppPool().connect(), channelId = randomUUID()
  const actor = patch.actor ?? f.member, groupId = patch.team === undefined ? f.common.id : patch.team
  const compartments = patch.compartments ?? (groupId === null ? [] : [f.common.key])
  const projectId = patch.project ?? null, sensitivity = patch.sensitivity ?? 'internal'
  const revision = await f.revision()
  try {
    await client.query('BEGIN'); await applyRLSGucs(client, actor)
    await client.query("SELECT set_config('app.agent_compartments','null',true),set_config('app.agent_project_ids','null',true),set_config('app.agent_clearance','confidential',true)")
    await client.query("SELECT set_config('app.session_creation_admission',$1,true)", [JSON.stringify({
      protocol:'1',provenance:'authenticated_chat_root',workspaceId:f.w,policyRevision:revision,actor,
      userId:actor,assistantId:f.assistant,channelType:'web',channelId,appId:'Use Brian',appOrigin:'chat',
      visibility:'workspace',mode:null,sensitivity,groupId,projectId,compartments,
    })])
    const row = (await client.query(`INSERT INTO sessions(assistant_id,user_id,workspace_id,channel_type,channel_id,app_id,app_origin,
      visibility,effective_clearance,context_group_id,context_project_id,context_compartments)
      VALUES($1,$2,$3,'web',$4,'Use Brian','chat','workspace',$5,$6,$7,$8)
      RETURNING id,visibility,effective_clearance,context_group_id,context_project_id,context_compartments`,
    [f.assistant,actor,f.w,channelId,sensitivity,groupId,projectId,compartments])).rows[0]
    await client.query('COMMIT'); return row
  } finally { await client.query('ROLLBACK'); client.release() }
}

describe('ordinary shared session admission (real PostgreSQL)', () => {
  afterAll(async () => { await getAppPool().end(); await pool.end() })
  it('app-role paired forgeries cannot choose unauthorized same-workspace Team/Project or bypass assistant caps', async () => {
    const f = await fixture('departments')
    const role = (await getAppPool().query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]
    expect(role).toEqual({rolsuper:false,rolbypassrls:false})
    await expect(pairedSharedInsert(f,{project:f.project})).rejects.toMatchObject({code:'42501',message:'workspace_creation_scope_unavailable'})
    await expect(pairedSharedInsert(f,{team:f.other.id,compartments:[f.other.key]})).rejects.toMatchObject({code:'42501'})
    expect(await pairedSharedInsert(f,{team:null})).toMatchObject({visibility:'workspace',context_group_id:null,context_compartments:[]})
    expect(await f.create({contextGroupId:f.common.id})).toMatchObject({visibility:'workspace',contextGroupId:f.common.id,effectiveClearance:'internal'})
    await pool.query('INSERT INTO workspace_project_members(project_id,user_id) VALUES($1,$2)',[f.project,f.member])
    await pool.query("UPDATE assistants SET project_scope_mode='assigned',team_scope_mode='assigned' WHERE id=$1",[f.assistant])
    await expect(pairedSharedInsert(f,{project:f.project})).rejects.toMatchObject({code:'42501'})
    await pool.query('INSERT INTO workspace_group_assistants(group_id,assistant_id) VALUES($1,$2)',[f.common.id,f.assistant])
    await expect(pairedSharedInsert(f,{project:f.project})).rejects.toMatchObject({code:'42501'})
    await pool.query('INSERT INTO assistant_project_grants(project_id,assistant_id) VALUES($1,$2)',[f.project,f.assistant])
    expect(await pairedSharedInsert(f,{project:f.project})).toMatchObject({context_project_id:f.project,visibility:'workspace'})
    expect(await f.create({contextGroupId:f.common.id,contextProjectId:f.project})).toMatchObject({contextProjectId:f.project,contextGroupId:f.common.id})
    await pool.query("UPDATE assistants SET compartments='{}' WHERE id=$1",[f.assistant])
    await expect(pairedSharedInsert(f)).rejects.toMatchObject({code:'42501'})
    await pool.query('UPDATE assistants SET compartments=NULL WHERE id=$1',[f.assistant])
    await pool.query("UPDATE workspace_members SET compartments='{}' WHERE workspace_id=$1 AND user_id=$2",[f.w,f.member])
    await expect(pairedSharedInsert(f)).rejects.toMatchObject({code:'42501'})
    await pool.query('UPDATE workspace_members SET compartments=NULL WHERE workspace_id=$1 AND user_id=$2',[f.w,f.member])
    await pool.query("UPDATE workspace_projects SET status='archived' WHERE id=$1",[f.project])
    await expect(pairedSharedInsert(f,{project:f.project})).rejects.toMatchObject({code:'42501'})
    await pool.query('UPDATE workspace_access_policies SET default_department_id=NULL WHERE workspace_id=$1',[f.w])
    await pool.query("UPDATE workspace_groups SET status='archived' WHERE id=$1",[f.common.id])
    await expect(pairedSharedInsert(f)).rejects.toMatchObject({code:'42501'})
  })
  it('app-role paired receipts cannot bypass Simple placement, current sensitivity, or nonready policy', async () => {
    const f = await fixture()
    expect(await f.create()).toMatchObject({visibility:'workspace',contextGroupId:f.common.id,effectiveClearance:'internal'})
    expect(await pairedSharedInsert(f)).toMatchObject({context_group_id:f.common.id})
    // Owner has authority over both Teams; Simple still only permits its default.
    await expect(pairedSharedInsert(f,{actor:f.owner,team:f.other.id,compartments:[f.other.key]})).rejects.toMatchObject({code:'42501'})
    await expect(pairedSharedInsert(f,{team:null})).rejects.toMatchObject({code:'42501'})
    for (const sensitivity of ['public','confidential']) await expect(pairedSharedInsert(f,{sensitivity})).rejects.toMatchObject({code:'42501'})
    await pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2",[f.w,f.member])
    await expect(pairedSharedInsert(f)).rejects.toMatchObject({code:'42501'})
    await pool.query("UPDATE workspace_access_policies SET setup_state='legacy' WHERE workspace_id=$1",[f.w])
    await expect(pairedSharedInsert(f)).rejects.toMatchObject({code:'42501',message:'workspace_creation_policy_not_ready'})
    // Legacy writers without an admission claim keep historical compatibility.
    expect(await f.create({authenticatedHuman:undefined})).toMatchObject({visibility:'workspace'})
  })
  it('SQL blocks old shared writers, forged conflict resumes, and draft roots; private rows stay private', async () => {
    const f = await fixture()
    const old = await f.create()
    const sql = `INSERT INTO sessions(assistant_id,user_id,workspace_id,channel_type,channel_id,app_origin,visibility,mode)
      VALUES($1,$2,$3,'web',$4,'chat',$5,$6)
      ON CONFLICT(assistant_id,user_id,channel_type,channel_id,app_id) DO UPDATE SET last_active_at=now()`
    for (const [channel, visibility, mode] of [[randomUUID(), 'workspace', null], [old.channelId, 'workspace', null], [randomUUID(), 'owner', 'draft']]) {
      await expect(pool.query(sql, [f.assistant, f.member, f.w, channel, visibility, mode])).rejects.toMatchObject({ code: '42501' })
    }
    await expect(pool.query(sql, [f.assistant, f.member, f.w, randomUUID(), 'owner', null])).rejects.toMatchObject({ code: '42501' })
    const foreign = await fixture()
    await pool.query("UPDATE workspace_access_policies SET setup_state='legacy' WHERE workspace_id=$1", [foreign.w])
    await expect(pool.query(sql, [foreign.assistant, f.member, f.w, randomUUID(), 'workspace', null])).rejects.toMatchObject({ code: '42501' })
    await expect(pool.query(sql, [f.assistant, f.member, foreign.w, randomUUID(), 'workspace', null])).rejects.toMatchObject({ code: '42501' })
  })
  it('SQL consumes an exact current chat receipt once and rejects altered partitions, actor, policy and envelope', async () => {
    const f = await fixture(), client = await pool.connect()
    const input: Parameters<typeof admitSessionCreate>[1] = { assistantId: f.assistant, userId: f.member, workspaceId: f.w,
      channelType: 'web', channelId: randomUUID(), appOrigin: 'chat' }
    const sql = `INSERT INTO sessions(assistant_id,user_id,workspace_id,channel_type,channel_id,app_id,app_origin,
      visibility,effective_clearance,context_group_id,context_project_id,context_compartments)
      VALUES($1,$2,$3,$4,$5,$6,$7,'workspace',$8,$9,$10,$11) RETURNING id`
    try {
      await client.query('BEGIN')
      await applyRLSGucs(client, f.member)
      const admitted = await admitSessionCreate(client, input, true)
      const values = [f.assistant, f.member, f.w, 'web', input.channelId, 'Use Brian', 'chat',
        admitted.effectiveClearance, admitted.contextGroupId, admitted.contextProjectId, admitted.contextCompartments]
      for (const [index, value] of [[0, (await fixture()).assistant], [1, f.owner], [4, randomUUID()], [5, 'other'],
        [6, 'workflow'], [7, 'public']] as const) {
        await client.query('SAVEPOINT mismatch')
        const changed = [...values]; changed[index] = value
        await expect(client.query(sql, changed)).rejects.toMatchObject({ code: '42501' })
        await client.query('ROLLBACK TO SAVEPOINT mismatch')
      }
      await client.query('SAVEPOINT stale')
      await client.query('UPDATE workspace_access_policies SET revision=revision+1 WHERE workspace_id=$1', [f.w])
      await expect(client.query(sql, values)).rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK TO SAVEPOINT stale')
      expect((await client.query(sql, values)).rows).toHaveLength(1)
      await client.query('SAVEPOINT consumed')
      await expect(client.query(sql, values)).rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK TO SAVEPOINT consumed')
      await client.query('COMMIT')
    } finally { await client.query('ROLLBACK'); client.release() }
  })
  it('Simple omission uses common, explicit null conflicts, and scope persists with canonical sensitivity', async () => {
    const f = await fixture()
    expect(await f.create()).toMatchObject({ contextGroupId: f.common.id, contextCompartments: [f.common.key], effectiveClearance: 'internal' })
    await expect(f.create({ contextGroupId: null })).rejects.toMatchObject({ code: 'access_mode_destination_conflict', status: 409 })
    await expect(f.create({ contextGroupId: f.other.id, starterUserId: f.owner })).rejects.toMatchObject({ code: 'access_mode_destination_conflict' })
    const stale = await f.revision()
    await pool.query("UPDATE assistants SET clearance='confidential' WHERE id=$1", [f.assistant])
    await expect(f.create({ expectedPolicyRevision: stale })).rejects.toMatchObject({ code: 'access_policy_conflict' })
    await expect(f.create()).rejects.toMatchObject({ code: 'context_not_available' })
  })
  it('Departments requires selection or an authorized bound assistant default, never unions memberships', async () => {
    const f = await fixture('departments')
    await expect(f.create()).rejects.toMatchObject({ code: 'context_selection_required' })
    expect(await f.create({ contextGroupId: f.common.id })).toMatchObject({ contextCompartments: [f.common.key] })
    expect(await f.create({ contextGroupId: null })).toMatchObject({ contextGroupId: null, contextCompartments: [] })
    await pool.query('UPDATE assistants SET default_workspace_group_id=$2 WHERE id=$1', [f.assistant, f.common.id])
    expect(await f.create()).toMatchObject({ contextGroupId: f.common.id })
    await pool.query('UPDATE assistants SET default_workspace_group_id=$2 WHERE id=$1', [f.assistant, f.other.id])
    await expect(f.create()).rejects.toMatchObject({ code: 'context_not_available' })
  })
  it('rejects foreign, archived, missing membership, assistant audience and direct caps', async () => {
    const f = await fixture('departments'), foreign = await fixture()
    await expect(f.create({ contextGroupId: '' })).rejects.toMatchObject({ code: 'context_not_available' })
    await expect(f.create({ contextGroupId: foreign.common.id, starterUserId: f.owner })).rejects.toMatchObject({ code: 'context_not_available' })
    await pool.query("UPDATE workspace_groups SET status='archived' WHERE id=$1", [f.other.id])
    await expect(f.create({ contextGroupId: f.other.id, starterUserId: f.owner })).rejects.toMatchObject({ code: 'context_not_available' })
    await pool.query("UPDATE assistants SET team_scope_mode='assigned' WHERE id=$1", [f.assistant])
    await expect(f.create({ contextGroupId: f.common.id })).rejects.toMatchObject({ code: 'context_not_available' })
    await pool.query("UPDATE assistants SET team_scope_mode='all' WHERE id=$1", [f.assistant])
    await pool.query("UPDATE workspace_members SET compartments='{}' WHERE workspace_id=$1 AND user_id=$2", [f.w, f.member])
    await expect(f.create({ contextGroupId: f.common.id })).rejects.toMatchObject({ code: 'context_not_available' })
    await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.w, f.member])
    await expect(f.create({ contextGroupId: f.common.id })).rejects.toMatchObject({ code: 'context_not_available' })
  })
  it('preserves Project floors and intersects assistant and executing ceilings', async () => {
    const f = await fixture()
    await pool.query('UPDATE assistants SET default_project_id=$2 WHERE id=$1', [f.assistant, f.project])
    await expect(f.create()).rejects.toMatchObject({ code: 'context_not_available' })
    await pool.query('INSERT INTO workspace_project_members(project_id,user_id) VALUES($1,$2)', [f.project, f.member])
    expect(await f.create()).toMatchObject({ contextProjectId: f.project, contextGroupId: f.common.id })
    await expect(runWithAgentAccess({ workspaceId: f.w, userId: f.member, clearance: 'internal', compartments: [], mutationCompartments: [], projectIds: null }, () => f.create())).rejects.toMatchObject({ code: 'context_not_available' })
    await pool.query("UPDATE assistants SET project_scope_mode='assigned',default_project_id=NULL WHERE id=$1", [f.assistant])
    await expect(f.create({ contextProjectId: f.project })).rejects.toMatchObject({ code: 'context_not_available' })
  })
  it('leaves personal and historical explicit-null sessions unchanged and blocks unverified shared creation', async () => {
    const f = await fixture()
    const identity = { assistantId: f.assistant, userId: f.member, channelType: 'web', channelId: randomUUID(), appOrigin: 'chat' }
    await pool.query("UPDATE workspace_access_policies SET setup_state='legacy' WHERE workspace_id=$1", [f.w])
    const personal = await findOrCreateSession(identity)
    await pool.query("UPDATE workspace_access_policies SET setup_state='ready' WHERE workspace_id=$1", [f.w])
    expect(personal).toMatchObject({ visibility: 'owner', contextGroupId: null })
    for (const starterUserId of [f.member, f.owner]) {
      await expect(f.create({ authenticatedHuman: undefined, starterUserId })).rejects.toMatchObject({ code: 'session_admission_unsupported' })
    }
    await expect(findOrCreateSession({ ...identity, channelType: 'doc_thread', visibility: 'workspace', workspaceId: f.w })).rejects.toMatchObject({ code: 'session_admission_unsupported' })
    await pool.query("UPDATE workspace_access_policies SET setup_state='legacy' WHERE workspace_id=$1", [f.w])
    const sharedIdentity = { ...identity, channelId: randomUUID(), visibility: 'workspace' as const, workspaceId: f.w, contextGroupId: null }
    const old = await findOrCreateSession(sharedIdentity)
    await pool.query("UPDATE workspace_access_policies SET setup_state='ready' WHERE workspace_id=$1", [f.w])
    await pool.query('UPDATE assistants SET default_workspace_group_id=$2 WHERE id=$1', [f.assistant, f.common.id])
    expect(await findOrCreateSession({ ...sharedIdentity, contextGroupId: f.common.id, expectedPolicyRevision: 'stale-resume' })).toMatchObject({ id: old.id, contextGroupId: null, contextCompartments: [] })
    expect(await findOrCreateSession(identity)).toMatchObject({ id: personal.id, contextGroupId: null })
    for (const channelType of ['telegram', 'public_api']) {
      expect(await findOrCreateSession({ ...identity, channelType, contextGroupId: null })).toMatchObject({ contextGroupId: null, visibility: 'owner' })
    }
  })
  it('does not borrow a foreign legacy assistant policy for a ready output workspace', async () => {
    const target = await fixture(), foreign = await fixture()
    await pool.query("UPDATE workspace_access_policies SET setup_state='legacy' WHERE workspace_id=$1", [foreign.w])
    // Transfers now fail before CHECK constraints are evaluated. The original
    // workspace-required invariant remains, rather than manufacturing a null fixture.
    await expect(pool.query('UPDATE assistants SET workspace_id=NULL WHERE id=$1', [foreign.assistant]))
      .rejects.toThrow('assistant_transfer_admission_required')
    expect((await pool.query("SELECT convalidated FROM pg_constraint WHERE conrelid='assistants'::regclass AND conname='assistants_workspace_required'")).rows).toEqual([{ convalidated: true }])
    const identity = { assistantId: foreign.assistant, userId: target.member, channelType: 'doc_thread', channelId: randomUUID(), visibility: 'workspace' as const, workspaceId: target.w }
    await expect(findOrCreateSession(identity)).rejects.toMatchObject({ code: 'context_not_available' })
    expect((await pool.query('SELECT id FROM sessions WHERE workspace_id=$1', [target.w])).rows).toHaveLength(0)
    // The historical cross-workspace comment-thread behavior is unchanged
    // when neither workspace participates in ready-mode admission.
    await pool.query("UPDATE workspace_access_policies SET setup_state='legacy' WHERE workspace_id=$1", [target.w])
    const historical = await findOrCreateSession(identity)
    await pool.query("UPDATE workspace_access_policies SET setup_state='ready' WHERE workspace_id=$1", [target.w])
    expect(await findOrCreateSession(identity)).toMatchObject({ id: historical.id, contextGroupId: null })
  })
  it('locks a resumed identity so deletion cannot turn compatibility replay into a new INSERT', async () => {
    const f = await fixture()
    await pool.query("UPDATE workspace_access_policies SET setup_state='legacy' WHERE workspace_id=$1", [f.w])
    const identity = { assistantId: f.assistant, userId: f.member, channelType: 'web', channelId: randomUUID(), visibility: 'workspace' as const, workspaceId: f.w, contextGroupId: null }
    const historical = await findOrCreateSession(identity)
    await pool.query("UPDATE workspace_access_policies SET setup_state='ready' WHERE workspace_id=$1", [f.w])
    const writer = await pool.connect(), remover = await pool.connect()
    try {
      await writer.query('BEGIN')
      expect(await admitSessionCreate(writer, identity, false)).toMatchObject({ contextGroupId: null })
      await remover.query('BEGIN')
      await remover.query("SET LOCAL lock_timeout='100ms'")
      await expect(remover.query('DELETE FROM sessions WHERE id=$1', [historical.id])).rejects.toMatchObject({ code: '55P03' })
    } finally {
      await remover.query('ROLLBACK'); remover.release()
      await writer.query('ROLLBACK'); writer.release()
    }
  })
  it('waits for workspace metadata changes then rejects a stale revision without inserting', async () => {
    const f = await fixture(), revision = await f.revision(), client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [f.w])
      await client.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2", [f.w, f.member])
      const pending = f.create({ expectedPolicyRevision: revision })
      const assertion = expect(pending).rejects.toMatchObject({ code: 'access_policy_conflict' })
      let waiting = false
      for (let i = 0; i < 100 && !waiting; i++) {
        waiting = (await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query='SELECT id FROM workspaces WHERE id=$1 FOR UPDATE'")).rows.length > 0
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(waiting).toBe(true)
      await client.query('COMMIT')
      await assertion
      expect((await pool.query('SELECT id FROM sessions WHERE assistant_id=$1', [f.assistant])).rows).toHaveLength(0)
    } finally { await client.query('ROLLBACK'); client.release() }
  })
  it('blocks an unadmitted transfer while session admission waits, preserving the original workspace', async () => {
    const f = await fixture(), destination = await fixture(), client = await pool.connect()
    // SQL640 prohibits this formerly possible transfer. Do not disable that
    // barrier merely to manufacture a committed pointer change for a fixture.
    await pool.query("UPDATE workspace_access_policies SET setup_state='legacy' WHERE workspace_id=$1", [f.w])
    let pending: Promise<unknown> | undefined
    try {
      await client.query('BEGIN')
      await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [f.w])
      pending = f.create().then(session => ({ session }), error => ({ error }))
      let waiting = false
      for (let i = 0; i < 100 && !waiting; i++) {
        waiting = (await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query='SELECT id FROM workspaces WHERE id=$1 FOR UPDATE'")).rows.length > 0
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(waiting).toBe(true)
      await client.query('SAVEPOINT transfer_attempt')
      await expect(client.query('UPDATE assistants SET workspace_id=$2 WHERE id=$1', [f.assistant, destination.w]))
        .rejects.toThrow('assistant_transfer_admission_required')
      await client.query('ROLLBACK TO SAVEPOINT transfer_attempt')
      await client.query('COMMIT')
      expect(await pending).toMatchObject({ session: { assistantId: f.assistant } })
      expect((await pool.query('SELECT workspace_id FROM sessions WHERE assistant_id=$1', [f.assistant])).rows).toEqual([{ workspace_id: f.w }])
      expect((await pool.query('SELECT id FROM sessions WHERE workspace_id=$1', [destination.w])).rows).toEqual([])
    } finally { await client.query('ROLLBACK'); client.release(); await pending }
  })

})
