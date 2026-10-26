import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { advanceWorkflowRun, createRunQueueWorker, type ConsultRequest } from '@use-brian/core'
import { getAppPool, getPool } from '../../db/client.js'
import { createDbWorkflowRunStore, createDbWorkflowStore, createWorkflowRunQueueStore } from '../../db/workflow-store.js'
import { captureAuthoringAuthoritySystem, resolveWorkflowRunScope } from '../../context-scope/workflow-authority.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('[COMP:api/application-lifecycle] real queued claim stop and actor-bound restart', () => {
  afterAll(async () => { await getAppPool().end(); await pool.end() })

  it.each([false, true])('leaves a stopped claim pending and rechecks actor revocation on restart: %s', async revoked => {
    const role = (await getAppPool().query<{ rolsuper: boolean; rolbypassrls: boolean; active: boolean }>(
      "SELECT r.rolsuper,r.rolbypassrls,row_security_active('workflow_runs'::regclass) AS active FROM pg_roles r WHERE r.rolname=current_user",
    )).rows[0]
    expect(role.rolsuper).toBe(false)
    expect(role.rolbypassrls).toBe(false)
    expect(role.active).toBe(true)
    const workspaceId = randomUUID(), ownerId = randomUUID(), actorId = randomUUID(), assistantId = randomUUID()
    for (const id of [ownerId, actorId]) await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
    await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Synthetic queue workspace',$2,false)", [workspaceId, ownerId])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance,compartments) VALUES($1,$2,'owner','confidential',NULL),($1,$3,'member','internal',NULL)", [workspaceId, ownerId, actorId])
    await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance,compartments) VALUES($1,'Synthetic queue assistant',$2,$3,'primary','confidential',NULL)", [assistantId, ownerId, workspaceId])
    const workflows = createDbWorkflowStore(), runs = createDbWorkflowRunStore()
    const authority = await captureAuthoringAuthoritySystem({ workspaceId, userId: actorId, assistantId })
    const workflow = await workflows.create({ workspaceId, userId: actorId, name: 'Synthetic queued workflow', authoringAuthority: authority,
      definition: { startStepId: 'collect', steps: [{ id: 'collect', type: 'assistant_call', target: { assistantId: 'primary' }, prompt: 'Return synthetic output' }] },
    })
    const run = await runs.createRun({ workspaceId, workflowId: workflow.id, triggeredBy: actorId, triggerKind: 'event' })
    expect(run.triggeredBy).toBe(actorId)
    // A never-advanced run has no execution envelope and cannot be read yet.
    expect(await runs.getRunById(actorId, run.id)).toBeNull()
    expect((await workflows.getById(actorId, workflow.id))?.id).toBe(workflow.id)
    const queue = createWorkflowRunQueueStore(), entered = deferred<void>(), release = deferred<void>(), finished = deferred<void>()
    let first = true
    const consult = vi.fn(async (request: ConsultRequest) => {
      expect(request.caller.userId).toBe(actorId)
      expect(request.target.assistantId).toBe(assistantId)
      return { task: { taskId: randomUUID(), contextId: randomUUID(), status: { state: 'completed' as const, timestamp: new Date().toISOString() }, artifacts: [],
        history: [{ messageId: randomUUID(), role: 'agent' as const, parts: [{ kind: 'text' as const, text: 'Authorized synthetic queued output' }] }],
      } }
    })
    const deps = { workflowStore: workflows, runStore: runs, resolvePrimary: async () => assistantId,
      resolveRunScope: resolveWorkflowRunScope, buildToolRegistry: async () => new Map(), consultTransport: { send: consult },
    }
    const advances: Array<Promise<unknown>> = [], outcomes: string[] = []
    const advance = vi.fn((id: string) => {
      const promise = advanceWorkflowRun(deps, id).then(result => { outcomes.push(result.kind) }).finally(() => finished.resolve())
      advances.push(promise)
      return promise
    })
    const worker = createRunQueueWorker({ store: { ...queue, async claimNextPendingRunSystem(params) {
      const claimed = await queue.claimNextPendingRunSystem(params)
      if (first) { first = false; expect(claimed?.runId).toBe(run.id); entered.resolve(); await release.promise }
      return claimed
    } }, advance, maxConcurrent: 1, onError: () => finished.resolve() })
    try {
      const tick = worker.tick()
      await entered.promise
      worker.stop()
      release.resolve()
      await tick
      expect(advance).not.toHaveBeenCalled()
      expect(consult).not.toHaveBeenCalled()
      expect((await pool.query<{ status: string }>('SELECT status FROM workflow_runs WHERE id=$1', [run.id])).rows[0].status).toBe('pending')
      // Expire only this synthetic claim; production reclamation uses the same lease predicate.
      await pool.query("UPDATE workflow_runs SET claimed_at=now()-interval '3 minutes' WHERE id=$1", [run.id])
      if (revoked) {
        await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [workspaceId, actorId])
        expect(await workflows.getById(actorId, workflow.id)).toBeNull()
        expect(await runs.getRunById(actorId, run.id)).toBeNull()
      }
      worker.start()
      await finished.promise
      worker.stop()
      expect(advance).toHaveBeenCalledTimes(1)
      expect(outcomes).toEqual([revoked ? 'failed' : 'completed'])
      expect(consult).toHaveBeenCalledTimes(revoked ? 0 : 1)
      const status = (await pool.query<{ status: string }>('SELECT status FROM workflow_runs WHERE id=$1', [run.id])).rows[0].status
      expect(status).toBe(revoked ? 'failed' : 'completed')
    } finally {
      release.resolve()
      worker.stop()
      await Promise.allSettled(advances)
      await pool.query('DELETE FROM workflow_runs WHERE workspace_id=$1', [workspaceId])
    }
  })
})
