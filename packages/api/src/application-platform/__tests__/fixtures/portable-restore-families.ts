/**
 * Source-side seeds for the portable restore proof: one admitted row per
 * validator family that refused historical rows on import before the validator
 * audit (docs/architecture/platform/portable-brain-restore.md, "Validator
 * audit"). Every row is written through the product path (or, where the product
 * writes with owner SQL, the same SQL) at origin, so each was admitted then.
 * All identities are fictional. [COMP:api/portable-restore]
 */
import { randomUUID } from 'node:crypto'
import { vi } from 'vitest'
import type { WorkflowDefinition } from '@use-brian/core/workflow/types.js'
import { executionToolContext, createExecutionContext } from '@use-brian/agent-runtime/security/execution-context.js'
import { ContextScopeAccumulator } from '@use-brian/agent-runtime/security/context-scope.js'
import { getPool } from '../../../db/client.js'
import { createDbBrainKeyStore } from '../../../db/brain-keys-store.js'
import { createDbApiKeyStore } from '../../../db/api-key-store.js'
import { createDbWorkspaceGroupStore } from '../../../db/workspace-group-store.js'
import { withExternalKeyActor } from '../../../db/external-key-admission.js'
import { authSessionStore } from '../../../db/auth-session-store.js'
import { createTask } from '../../../db/tasks.js'
import { confirmRetainedGoal, getRetainedGoalById } from '../../../db/goals.js'
import { produceTaskGoalDraft } from '../../../db/goal-task-producer.js'
import { findAssistantById } from '../../../db/users.js'
import { findSessionAuthorityById } from '../../../db/sessions.js'
import { runWithAgentAccess } from '../../../db/agent-access-context.js'
import { createDbWorkflowStore, createDbWorkflowRunStore } from '../../../db/workflow-store.js'
import { createDbJobStore } from '../../../db/job-store.js'
import { createGoalWorkTools } from '../../../goals/work-tools.js'
import { resolveWorkflowRunScope } from '../../../context-scope/workflow-authority.js'
import { resolveLiveAccessCeilingSystem } from '../../../context-scope/resolve-turn-scope.js'
import { createSessionAuthorityLease } from '../../../context-scope/authority-lease.js'
import { advanceRetainedGoalWorkflow, pauseWorkflowRunForWait } from '../../../workflow/wait-lifecycle.js'
import type { ExecutorDeps } from '@use-brian/core/workflow/executor.js'

export type SeededFamilies = {
  workspaces: string[]
  /** Rows the target must hold; each check is `SELECT count(*) FROM table WHERE column = id`, expected `count`. */
  rows: { family: string; table: string; column: string; id: string; count: number }[]
}

/** Ready workspace: legacy keys from before setup, a reviewed Team-bound key, an application grant and a linked teamspace. */
async function readyWorkspaceFamilies(rows: SeededFamilies['rows']) {
  const pool = getPool(), actor = randomUUID(), member = randomUUID(), w = randomUUID(), a = randomUUID()
  for (const id of [actor, member]) await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Fictional ready keys',$2,false)", [w, actor])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [w, actor, member])
  await pool.query("INSERT INTO assistants(id,workspace_id,name,kind,clearance) VALUES($1,$2,'Primary','primary','internal')", [a, w])
  const team = await createDbWorkspaceGroupStore().createTeam(actor, w, { name: 'Fictional shared team', key: 'fictional-shared' })
  const device = (await authSessionStore.create(actor, { deviceLabel: 'Fictional key admin', userAgent: null, ipAddress: null }))!
  // Keys issued while the workspace was legacy; the ready workspace now refuses such an insert.
  const brainKeys = createDbBrainKeyStore()
  const legacyBrain = await brainKeys.create({ workspaceId: w, actingUserId: actor, name: 'Fictional legacy brain key', scope: 'read' })
  const legacyApi = await createDbApiKeyStore().create({ assistantId: a, actingUserId: actor, name: 'Fictional legacy API key' })
  await pool.query("UPDATE workspace_access_policies SET setup_state='ready',access_mode='simple',default_department_id=$2,reviewed_inventory_revision=2 WHERE workspace_id=$1", [w, team.id])
  // A reviewed key admitted under the configuration session (external key admission).
  const reviewed = await withExternalKeyActor(actor, device.id, () => brainKeys.create({ workspaceId: w, actingUserId: actor, name: 'Fictional reviewed key',
    scope: 'read', maxClearance: 'internal', contextGroupId: team.id, contextProjectId: null }))
  rows.push({ family: 'external-key-admission', table: 'brain_keys', column: 'id', id: legacyBrain.id, count: 1 }, { family: 'external-key-admission', table: 'api_keys', column: 'id', id: legacyApi.id, count: 1 },
    { family: 'external-key-admission', table: 'brain_keys', column: 'id', id: reviewed.id, count: 1 })
  // An application client and grant issued by the owner (issuer checks compare with the acting user).
  const app = randomUUID(), grant = randomUUID(), schema = randomUUID()
  await pool.query("INSERT INTO entity_types(id,workspace_id,name,properties,created_by) VALUES($1,$2,'Fictional requests','[]',$3)", [schema, w, actor])
  await pool.query(`INSERT INTO application_clients(id,workspace_id,module_key,name,client_mode,executing_assistant_id,created_by_user_id)
    VALUES($1,$2,'records','Fictional client','external_frontend',$3,$4)`, [app, w, a, actor])
  await pool.query(`INSERT INTO application_access_grants(id,app_id,workspace_id,principal_kind,principal_user_id,issued_by_user_id,resource_origin,resource_type,actions,read_fields,write_fields,
    selector,compartments,project_ids,clearance,parent_grant_id,starts_at)
    VALUES($1,$2,$3,'member',$4,$4,$5,$6,ARRAY['read'],ARRAY[]::text[],'{}','{"kind":"self"}','{}','{}','internal',NULL,'2020-01-01T00:00:00Z')`,
  [grant, app, w, actor, { kind: 'generic', entityTypeId: schema }, `record.${schema}`])
  rows.push({ family: 'application-issuer', table: 'application_clients', column: 'id', id: app, count: 1 }, { family: 'application-issuer', table: 'application_access_grants', column: 'id', id: grant, count: 1 })
  // A teamspace with a direct roster that was later linked to the Team (its roster becomes derived).
  const teamspace = (await pool.query<{ id: string }>("INSERT INTO teamspaces(workspace_id,name,created_by) VALUES($1,'Fictional linked teamspace',$2) RETURNING id", [w, actor])).rows[0].id
  await pool.query('INSERT INTO teamspace_members(teamspace_id,user_id) VALUES($1,$2),($1,$3)', [teamspace, actor, member])
  await pool.query('UPDATE teamspaces SET workspace_group_id=$2 WHERE id=$1', [teamspace, team.id])
  rows.push({ family: 'linked-teamspace', table: 'teamspace_members', column: 'teamspace_id', id: teamspace, count: 2 })
  return w
}

/** A retained Goal's workflow run (goal scope) on a Team-bound session, through the real goal work tool. */
async function goalScopedRun(rows: SeededFamilies['rows']) {
  const pool = getPool()
  const workspaceId = randomUUID(), owner = randomUUID(), userId = randomUUID(), assistantId = randomUUID(), teamId = randomUUID(), compartment = `team:${teamId}`
  for (const id of [owner, userId]) await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Fictional goal workspace',$2,false)", [workspaceId, owner])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential'),($1,$3,'member','internal')", [workspaceId, owner, userId])
  await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1,$2,'Team',$3,'team',$1::uuid::text,$4)", [teamId, workspaceId, owner, compartment])
  await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,created_by,managed_by,managed_ref_id) VALUES($1,$2,'Team',$3,'team',$4)", [workspaceId, compartment, owner, teamId])
  await pool.query('INSERT INTO workspace_group_compartment_grants(group_id,compartment_key,granted_by_user_id) VALUES($1,$2,$3)', [teamId, compartment, owner])
  await pool.query('INSERT INTO workspace_group_members(group_id,user_id) VALUES($1,$2)', [teamId, userId])
  await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance,team_scope_mode) VALUES($1,'Primary',$2,$3,'primary','internal','assigned')", [assistantId, owner, workspaceId])
  await pool.query('INSERT INTO workspace_group_assistants(group_id,assistant_id) VALUES($1,$2)', [teamId, assistantId])
  await pool.query('UPDATE assistants SET default_workspace_group_id=$2 WHERE id=$1', [assistantId, teamId])
  await pool.query("UPDATE workspace_members SET team_scope_mode='assigned' WHERE workspace_id=$1 AND user_id=$2", [workspaceId, userId])
  await pool.query("UPDATE workspace_access_policies SET access_mode='departments',setup_state='ready' WHERE workspace_id=$1", [workspaceId])
  const access = { workspaceId, userId, clearance: 'internal' as const, compartments: [compartment], mutationCompartments: [compartment], projectIds: [] as string[], visibilityAssistantIds: [assistantId] }
  const task = await createTask(owner, { workspaceId, title: 'Fictional canonical task', executorAssistantId: assistantId, compartments: [compartment], projectIds: [] })
  const sessionId = randomUUID(), credential = (await authSessionStore.create(userId, { deviceLabel: 'Fictional retained workflow', userAgent: 'Fixture', ipAddress: '127.0.0.1' }))!
  // A Team-bound session: its context_group_id is a deferred reference on import.
  await pool.query(`INSERT INTO sessions(id,workspace_id,assistant_id,user_id,channel_type,channel_id,status,visibility,context_locked_at,context_group_id,context_compartments,effective_clearance)
    VALUES($1::uuid,$2,$3,$4,'web',$1::text,'idle','personal',clock_timestamp(),$5,$6,'internal')`, [sessionId, workspaceId, assistantId, userId, teamId, [compartment]])
  const assistant = (await findAssistantById(assistantId))!
  const session = { ...(await findSessionAuthorityById(sessionId))!, ...(await pool.query('SELECT visibility,mode,effective_clearance AS "effectiveClearance",context_compartments AS "contextCompartments" FROM sessions WHERE id=$1', [sessionId])).rows[0] }
  const ceiling = await resolveLiveAccessCeilingSystem({ userId, workspaceId, assistant, session, memberMode: 'member' })
  const lease = createSessionAuthorityLease({ starting: ceiling, session, executingAssistantId: assistantId, userId, memberMode: 'member', durableSessionSource: true,
    nativeSessionCredential: { userId, sessionId: credential.id, authVersion: credential.authVersion } })
  const execution = createExecutionContext({ identity: { kind: 'attended', principal: { kind: 'workspace_member', userId, authenticationKind: 'native_session' } },
    ownership: { kind: 'workspace', workspaceId }, access: { ...ceiling, assistantId, assistantKind: assistant.kind }, authority: lease,
    writeDefaults: { compartments: [compartment], projectIds: [] },
    lifecycle: { sessionId, channelType: 'web', channelId: sessionId, abortSignal: new AbortController().signal, sessionPersisted: true } })
  const authority = { execution, accumulator: new ContextScopeAccumulator() }
  const brief = { outcome: 'Finish the fictional task', verification: 'Check it', approach: 'Work it', judgeReason: 'Actionable' }
  const goal = (await runWithAgentAccess(execution.security.access, () => produceTaskGoalDraft({ workspaceId, userId, assistantId, taskId: task.id, authority }, async () => brief)))!
  await confirmRetainedGoal(userId, (await getRetainedGoalById(userId, goal.id, authority))!, {}, authority)
  const definition: WorkflowDefinition = { startStepId: 'begin', steps: [{ id: 'begin', type: 'branch' as const, condition: { '==': [1, 1] }, nextStepIdIfTrue: null, nextStepIdIfFalse: null }] }
  const workflows = createDbWorkflowStore(), runs = createDbWorkflowRunStore(), jobs = createDbJobStore()
  const workflow = await runWithAgentAccess(execution.security.access, () => workflows.create({ workspaceId, userId, name: 'Fictional retained workflow', definition,
    authoringAuthority: goal.authoringAuthority!, contextGroupId: teamId, contextProjectId: null }, { authoring: { kind: 'internal-human', userId, assistantId } }))
  const deps: ExecutorDeps = { workflowStore: workflows, runStore: runs, resolvePrimary: async () => assistantId, resolveRunScope: resolveWorkflowRunScope,
    buildToolRegistry: async () => new Map(), consultTransport: { async send() { throw new Error('Unexpected model call') } },
    pauseRunForWait: params => pauseWorkflowRunForWait(params, { jobStore: jobs, runStore: runs, resolvePrimary: async () => assistantId }) }
  const dispatch = vi.fn((id: string, claim: Parameters<typeof advanceRetainedGoalWorkflow>[2]) => advanceRetainedGoalWorkflow(id, deps, claim))
  const tools = createGoalWorkTools({ createCompletionWorkflow: async () => { throw new Error('Explicit workflow required') },
    kickoffGoal: async () => { throw new Error('Recurring Goal driver remains held') }, advanceRetainedWorkflowRun: dispatch })
  const worked = await tools.workTask.execute({ goal_id: goal.id, workflow_id: workflow.id }, { ...executionToolContext(execution, { appId: 'native' }), scopeAccumulator: authority.accumulator })
  if (worked.isError) throw new Error('goal workflow not started: ' + JSON.stringify(worked.data))
  const runId = (await pool.query<{ id: string }>('SELECT id FROM workflow_runs WHERE source_goal_id=$1', [goal.id])).rows[0]?.id
  if (!runId) throw new Error('goal workflow run not recorded')
  rows.push({ family: 'workflow-goal-scope', table: 'workflow_runs', column: 'id', id: runId, count: 1 },
    { family: 'team-bound-session', table: 'sessions', column: 'id', id: sessionId, count: 1 })
  return workspaceId
}

export async function seedRefusedFamilies(): Promise<SeededFamilies> {
  const rows: SeededFamilies['rows'] = []
  const workspaces = [await readyWorkspaceFamilies(rows), await goalScopedRun(rows)]
  return { workspaces, rows }
}
