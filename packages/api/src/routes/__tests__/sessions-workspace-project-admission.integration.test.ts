/** Production HTTP + real scope/admission/SQL, only in the parent's owned
 * migration-replayed fixture. No helper/proof/authority mocks. HTTP uses the
 * existing canonical shared-session metadata writer; direct app_user INSERTs
 * must remain RLS-denied even with an otherwise valid creation receipt.
 */
import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterAll, describe, expect, it } from 'vitest'
import { requireAuth } from '../../auth/middleware.js'
import { createTokens } from '../../auth/jwt.js'
import { authSessionStore } from '../../db/auth-session-store.js'
import { getPool, getAppPool, applyRLSGucs, queryWithRLS, runWithAgentAccess } from '../../db/client.js'
import { findAssistantById } from '../../db/users.js'
import { resolveTurnScopeSystem } from '../../context-scope/resolve-turn-scope.js'
import { createDeliveryAudienceAuthorizer } from '../../context-scope/delivery-authority.js'
import { createAttendedDeliveryAudienceAuthorizer } from '../../context-scope/attended-audience.js'
import { resolveExecutionContextSystem } from '../../context-scope/execution-context.js'
import { readJointSessionQueryFrame } from '../../db/session-context-revisions.js'
import { ContextScopeAccumulator } from '@use-brian/core'
import { nativeSessionQueryCaptureSources } from '../../application-platform/native-session-query-evidence.js'
import { createConnectorRuntimeAuthority } from '../../application-platform/connector-runtime-authority.js'
import { admitSessionCreate } from '../../workspace-access/session-create-admission.js'
import { sessionRoutes } from '../sessions.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool(), secret = 'project-room-admission-test-secret'
const app = express(); app.use(express.json()); app.use('/api/sessions', requireAuth(secret), sessionRoutes())
afterAll(async () => { await getAppPool().end(); await pool.end() })
async function fixture(mode = 'departments') {
  const workspaceId = randomUUID(), owner = randomUUID(), userId = randomUUID(), outsider = randomUUID(), assistantId = randomUUID(), projectId = randomUUID()
  for (const id of [owner, userId, outsider]) await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2,project_shared_spaces) VALUES($1,'Project room admission',$2,true,true)", [workspaceId, owner])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','internal'),($1,$3,'member','internal'),($1,$4,'member','internal')", [workspaceId, owner, userId, outsider])
  await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance,team_scope_mode,project_scope_mode) VALUES($1,'Project Brian',$2,$3,'primary','internal','all','all')", [assistantId, owner, workspaceId])
  await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Project','project',$3)", [projectId, workspaceId, owner])
  await pool.query("INSERT INTO project_shared_scopes(project_id,workspace_id,origin,created_by) VALUES($1,$2,'created',$3)", [projectId, workspaceId, owner])
  await pool.query('INSERT INTO project_shared_owners(workspace_id,project_id,user_id) VALUES($1,$2,$3)', [workspaceId, projectId, owner])
  await pool.query("INSERT INTO project_shared_members(workspace_id,project_id,principal_kind,user_id,origin) VALUES($1,$2,'user',$3,'invited')", [workspaceId, projectId, userId])
  await pool.query("INSERT INTO project_shared_members(workspace_id,project_id,principal_kind,assistant_id,origin) VALUES($1,$2,'assistant',$3,'invited')", [workspaceId, projectId, assistantId])
  const defaultDepartment = mode === 'simple' ? randomUUID() : null
  if (defaultDepartment) await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1,$2,'Default department',$3,'team',$1::uuid::text,'team:'||$1::uuid::text)", [defaultDepartment,workspaceId,owner])
  await pool.query("UPDATE workspace_access_policies SET setup_state='ready',access_mode=$2,default_department_id=$3 WHERE workspace_id=$1", [workspaceId, mode, defaultDepartment])
  const auth = (await authSessionStore.create(userId, { deviceLabel: 'test', userAgent: null, ipAddress: null }))!
  const token = createTokens(userId, secret, auth).accessToken
  const body = { workspaceId, assistantId, contextGroupId: null, contextProjectId: projectId }
  const post = (patch = {}) => request(app).post('/api/sessions/workspace').set('Authorization', `Bearer ${token}`).send({ ...body, ...patch })
  return { workspaceId, owner, userId, outsider, assistantId, projectId, post, auth }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
async function appInsert(f: Fixture, mutateReceipt: Record<string, unknown> = {}, pairedRow: { group?: string; sensitivity?: string; actor?: string } = {}, afterAdmission?: () => Promise<unknown>) {
  const client = await getAppPool().connect(), channelId = randomUUID()
  const actor = pairedRow.actor ?? f.userId
  try {
    await client.query('BEGIN'); await applyRLSGucs(client, actor)
    const role = (await client.query(`SELECT r.rolsuper,r.rolbypassrls,pg_has_role(r.oid,c.relowner,'USAGE') AS owner FROM pg_roles r CROSS JOIN pg_class c WHERE r.rolname=current_user AND c.oid='sessions'::regclass`)).rows[0]
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false, owner: false })
    const input: Parameters<typeof admitSessionCreate>[1] = { workspaceId: f.workspaceId, assistantId: f.assistantId, userId: actor, channelType: 'web', channelId, appOrigin: 'chat', contextGroupId: null, contextProjectId: f.projectId }
    const admitted = await admitSessionCreate(client, input, true)
    const receipt = JSON.parse((await client.query("SELECT current_setting('app.session_creation_admission',true) AS receipt")).rows[0].receipt)
    expect(receipt).toMatchObject({ provenance: 'authenticated_chat_root', projectId: f.projectId, compartments: [`project:${f.projectId}`] })
    await client.query("SELECT set_config('app.session_creation_admission',$1,true)", [JSON.stringify({ ...receipt, ...mutateReceipt, ...(pairedRow.group ? { groupId: pairedRow.group } : {}), ...(pairedRow.sensitivity ? { sensitivity: pairedRow.sensitivity } : {}) })])
    await afterAdmission?.()
    const row = (await client.query(`INSERT INTO sessions(assistant_id,user_id,workspace_id,channel_type,channel_id,app_id,app_origin,visibility,effective_clearance,context_group_id,context_project_id,context_compartments)
      VALUES($1,$2,$3,'web',$4,'Use Brian','chat','workspace',$5,$6,$7,$8) RETURNING id,visibility,context_group_id,context_project_id,context_compartments,effective_clearance`, [f.assistantId, actor, f.workspaceId, channelId, pairedRow.sensitivity ?? admitted.effectiveClearance, pairedRow.group ?? admitted.contextGroupId, admitted.contextProjectId, admitted.contextCompartments])).rows[0]
    await client.query('COMMIT'); return row
  } finally { await client.query('ROLLBACK'); client.release() }
}
describe('shared Project room native HTTP creation admission', () => {
  it.each(['departments', 'simple'])('creates the exact Project audience with both roster edges, including %s mode', async mode => {
    const f = await fixture(mode), response = await f.post()
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    expect(response.body).toMatchObject({ assistantId: f.assistantId, contextGroupId: null, contextProjectId: f.projectId })
    const expected = { visibility: 'workspace', context_group_id: null, context_project_id: f.projectId, context_compartments: [`project:${f.projectId}`], effective_clearance: 'internal' }
    const row = (await pool.query('SELECT visibility,context_group_id,context_project_id,context_compartments,effective_clearance FROM sessions WHERE id=$1', [response.body.id])).rows[0]
    expect(row).toEqual(expected)
    await expect(appInsert(f)).rejects.toMatchObject({ code: '42501', message: 'new row violates row-level security policy for table "sessions"' })
    expect((await queryWithRLS(f.userId, 'SELECT id FROM sessions WHERE id=$1', [response.body.id])).rows).toHaveLength(1)
    expect((await queryWithRLS(f.outsider, 'SELECT id FROM sessions WHERE id=$1', [response.body.id])).rows).toEqual([])
  })
  it.each(['user', 'assistant'] as const)('denies workspace membership alone without the Project %s participant', async kind => {
    const f = await fixture()
    await pool.query('DELETE FROM project_shared_members WHERE project_id=$1 AND principal_kind=$2 AND (user_id=$3 OR assistant_id=$4)', [f.projectId, kind, f.userId, f.assistantId])
    const response = await f.post()
    expect(response.status, JSON.stringify(response.body)).toBe(404)
    expect((await pool.query('SELECT id FROM sessions WHERE workspace_id=$1', [f.workspaceId])).rows).toEqual([])
  })
  it('retains stale revision, exact receipt mismatch and paired sensitivity denials', async () => {
    const f = await fixture(), response = await f.post({ expectedPolicyRevision: '0' })
    expect(response.status, JSON.stringify(response.body)).toBe(409)
    expect(response.body).toEqual({ error: 'access_policy_conflict' })
    for (const patch of [{ channelId: randomUUID() }, { policyRevision: '0' }, { compartments: [] }, { actor: f.owner }, { appOrigin: 'studio' }]) {
      await expect(appInsert(f, patch)).rejects.toMatchObject({ code: '42501', message: 'workspace_creation_admission_required' })
    }
    await expect(appInsert(f, {}, { sensitivity: 'public' })).rejects.toMatchObject({ code: '42501', message: 'workspace_creation_scope_unavailable' })
    expect((await pool.query('SELECT id FROM sessions WHERE workspace_id=$1', [f.workspaceId])).rows).toEqual([])
  })
  it('admits only the exact shared Project delivery audience and rechecks both live roster edges', async () => {
    const f = await fixture(), response = await f.post()
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    const assistant = (await findAssistantById(f.assistantId))!
    const scope = await resolveTurnScopeSystem({ workspaceId: f.workspaceId, userId: f.userId, assistant,
      memberMode: 'member', session: { contextGroupId: null, contextProjectId: f.projectId } })
    const input = { workspaceId: f.workspaceId, assistantId: f.assistantId, userId: f.userId, channelType: 'web',
      channelId: response.body.channelId, sessionId: response.body.id,
      scopeEvidence: { sensitivity: 'internal' as const, compartments: [`project:${f.projectId}`], projectIds: [f.projectId] } }
    const authorize = () => runWithAgentAccess({ ...scope.access, clearance: scope.access.clearance, compartments: scope.access.compartments }, () => createDeliveryAudienceAuthorizer()(input))
    expect(await authorize()).toMatchObject({ allowed: true })
    const { executionContext: execution } = await resolveExecutionContextSystem({
      workspaceId: f.workspaceId, userId: f.userId, assistant, memberMode: 'member', sharedAudience: true,
      session: { contextGroupId: null, contextProjectId: f.projectId, contextCompartments: [`project:${f.projectId}`], effectiveClearance: 'internal' },
      identity: { kind: 'attended', principal: { kind: 'workspace_member', userId: f.userId, authenticationKind: 'native_session' } },
      nativeSessionCredential: { userId: f.userId, sessionId: f.auth.id, authVersion: f.auth.authVersion },
      ownership: { kind: 'workspace', workspaceId: f.workspaceId },
      lifecycle: { sessionId: response.body.id, sessionPersisted: true, channelType: 'web', channelId: response.body.channelId, abortSignal: new AbortController().signal },
    })
    const accumulator = new ContextScopeAccumulator(execution.security.provenance)
    const captured = await readJointSessionQueryFrame({ execution, accumulator }, [], { sessionId: response.body.id, throughSequence: 0, topicThroughSequence: 0 })
    accumulator.note({ sources: nativeSessionQueryCaptureSources(captured, f.workspaceId) })
    expect(accumulator.evidence.sources?.some(source => source.resourceKind === 'application_field')).toBe(true)
    const before = JSON.stringify(execution.security.ceiling)
    expect(await createAttendedDeliveryAudienceAuthorizer(execution)({ ...input, scopeEvidence: accumulator.evidence })).toMatchObject({ allowed: true })
    expect(JSON.stringify(execution.security.ceiling)).toBe(before)
    const facts = { workspaceId: f.workspaceId, assistantId: f.assistantId, initiatingUserId: f.userId, identityUserId: f.userId }
    const connector = await createConnectorRuntimeAuthority(facts)
    await connector.assertCurrent()
    await runWithAgentAccess({ ...execution.security.access, clearance: execution.security.access.clearance,
      compartments: execution.security.access.compartments }, async () => {
      await connector.assertCurrent()
      expect(connector.allows({ compartments: [], projectIds: [] })).toBe(true)
      expect(connector.allows({ compartments: [], projectIds: [f.outsider] })).toBe(false)
      expect(connector.allows({ compartments: ['team:unadmitted'], projectIds: [] })).toBe(false)
    })
    await connector.assertCurrent()
    for (const kind of ['assistant', 'user']) {
      const liveConnector = await createConnectorRuntimeAuthority(facts)
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query('DELETE FROM project_shared_members WHERE project_id=$1 AND principal_kind=$2 AND (user_id=$3 OR assistant_id=$4)', [f.projectId, kind, f.userId, f.assistantId])
        await client.query('COMMIT')
        expect(await authorize()).toMatchObject({ allowed: false })
        await expect(liveConnector.assertCurrent()).rejects.toMatchObject({ reason: 'authority_changed' })
        await client.query(`INSERT INTO project_shared_members(workspace_id,project_id,principal_kind,user_id,assistant_id,origin)
          VALUES($1,$2,$3,$4,$5,'invited')`, [f.workspaceId, f.projectId, kind, kind === 'user' ? f.userId : null, kind === 'assistant' ? f.assistantId : null])
      } finally { await client.query('ROLLBACK'); client.release() }
      expect(await authorize()).toMatchObject({ allowed: true })
      await expect(liveConnector.assertCurrent()).rejects.toMatchObject({ reason: 'authority_changed' })
      await expect((await createConnectorRuntimeAuthority(facts)).assertCurrent()).resolves.toBeUndefined()
    }
  })
  it('compiles the complete native helper cohort without losing catalog metadata or exposing the attestation rows', async () => {
    const result = (await pool.query(`SELECT count(*)::int members,bool_and(c.expected_text=to_jsonb(p)::text
      AND c.expected_body=p.prosrc AND c.expected_metadata=to_jsonb(p)-'prosrc'
      AND c.original_fingerprint=h.fingerprint
      AND h.fingerprint=encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')) exact
      FROM native_turn_contract_helpers h FULL JOIN native_turn_helper_attestations c USING(signature)
      LEFT JOIN pg_proc p ON p.oid=to_regprocedure('public.'||h.signature)`)).rows[0]
    expect(result.members).toBeGreaterThan(100)
    expect(result.exact).toBe(true)
    await expect(getAppPool().query('SELECT expected_body FROM native_turn_helper_attestations')).rejects.toMatchObject({code:'42501'})
    const baseline = `SELECT bool_and(p.oid IS NOT NULL AND h.fingerprint=encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')) valid
      FROM native_turn_contract_helpers h LEFT JOIN pg_proc p ON p.oid=to_regprocedure('public.'||h.signature)`
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('ALTER FUNCTION native_turn_completed_point(uuid,text,uuid,text[],jsonb,jsonb) COST 101')
      expect((await client.query(baseline)).rows[0].valid).toBe(false)
      expect((await client.query('SELECT native_turn_helpers_current() valid')).rows[0].valid).toBe(false)
    } finally { await client.query('ROLLBACK'); client.release() }
    const timings = { serializedBaselineMs: [] as number[], exactCompiledMs: [] as number[] }
    for (let round=0;round<5;round++) {
      let start=performance.now()
      expect((await pool.query(baseline)).rows[0].valid).toBe(true)
      timings.serializedBaselineMs.push(performance.now()-start)
      start=performance.now()
      expect((await pool.query('SELECT native_turn_helpers_current() valid')).rows[0].valid).toBe(true)
      timings.exactCompiledMs.push(performance.now()-start)
    }
    console.info('native-helper-attestation-cost',JSON.stringify(timings))
  })
  it('retains all canonical executable contract proofs after the forward migration', async () => {
    for (const helper of ['native_turn_helpers_current', 'native_turn_publication_contract', 'application_native_worklist_helpers_current', 'application_native_dependency_batch_helpers_current', 'application_native_field_reference_helpers_current', 'application_memory_statement_helpers_current']) {
      expect((await pool.query(`SELECT public.${helper}() AS current`)).rows[0].current, helper).toBe(true)
    }
  })
})
