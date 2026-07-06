import { describe, it, expect, afterAll } from 'vitest'
import pg from 'pg'
import {
  createWorkflowRunQueueStore,
  countRecentRunsForWorkflowSystem,
  pauseWorkflowSystem,
  createDbWorkflowStore,
} from '../workflow-store.js'

/**
 * Integration tests for the event run-queue store (migration 302):
 * `claimNextPendingRunSystem`'s FOR UPDATE SKIP LOCKED claim with
 * per-workflow serialization + per-workspace cap + lease reclaim, the
 * exhausted/stale reapers, and the storm-guard count/pause pair.
 *
 * Requires the local `sidanclaw` PostgreSQL database with migration 302
 * applied. Skips silently when the DB isn't reachable — matches
 * aggregate-store.integration.test.ts.
 *
 * Claim scans are global-oldest-first, so every fixture run is backdated to
 * the epoch era — older than anything another suite might leave behind —
 * and each test deletes its runs when done.
 *
 * Spec: docs/architecture/features/workflow.md → "Event run queue".
 * [COMP:workflow/run-queue]
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'sidanclaw', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      // Probe the mig-302 columns; skip on a pre-302 database.
      await client.query('SELECT claimed_at, claim_attempts FROM workflow_runs LIMIT 1')
      await client.query('SELECT paused_reason FROM workflows LIMIT 1')
    } finally {
      client.release()
    }
    pool = p
    return true
  } catch {
    await p.end().catch(() => {})
    return false
  }
}

const ok = await canConnect()
const describeIf = ok ? describe : describe.skip

afterAll(async () => {
  if (pool) await pool.end()
})

const queue = createWorkflowRunQueueStore()
const DEFAULTS = { leaseSeconds: 120, maxClaimAttempts: 3, workspaceCap: 3 }

type Fixture = {
  userId: string
  workspaceId: string
  wfA: string
  wfB: string
  runIds: string[]
  addRun(params: {
    workflowId: string
    status?: string
    startedAgoSeconds?: number
    claimedAgoSeconds?: number | null
    claimAttempts?: number
    lastActiveAgoSeconds?: number
  }): Promise<string>
  cleanup(): Promise<void>
}

/** Epoch-era base so these runs are always the globally oldest pending. */
const BASE_AGO = 60 * 60 * 24 * 365 * 50 // ~50 years

async function makeFixture(): Promise<Fixture> {
  const client = await pool!.connect()
  try {
    const u = await client.query(
      `INSERT INTO users (id, auth_provider, auth_provider_id)
       VALUES (gen_random_uuid(), 'test', 'runq-' || gen_random_uuid()) RETURNING id`,
    )
    const userId = u.rows[0].id as string
    const w = await client.query(
      `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
       VALUES (gen_random_uuid(), 'runq-test-ws', 'test', $1, false) RETURNING id`,
      [userId],
    )
    const workspaceId = w.rows[0].id as string
    await client.query(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role)
       VALUES (gen_random_uuid(), $1, $2, 'owner')`,
      [workspaceId, userId],
    )
    const mkWf = async (name: string) => {
      const r = await client.query(
        `INSERT INTO workflows (id, workspace_id, created_by, name, definition, enabled)
         VALUES (gen_random_uuid(), $1, $2, $3, '{"startStepId":"s1","steps":[]}', true)
         RETURNING id`,
        [workspaceId, userId, name],
      )
      return r.rows[0].id as string
    }
    const wfA = await mkWf('runq A')
    const wfB = await mkWf('runq B')
    const runIds: string[] = []
    const fixture: Fixture = {
      userId,
      workspaceId,
      wfA,
      wfB,
      runIds,
      async addRun({
        workflowId,
        status = 'pending',
        startedAgoSeconds = 0,
        claimedAgoSeconds = null,
        claimAttempts = 0,
        lastActiveAgoSeconds = 0,
      }) {
        const c = await pool!.connect()
        try {
          const r = await c.query(
            `INSERT INTO workflow_runs
               (id, workflow_id, workspace_id, trigger_kind, status, started_at, last_active_at, claimed_at, claim_attempts)
             VALUES (gen_random_uuid(), $1, $2, 'manual', $3,
                     now() - make_interval(secs => $4),
                     now() - make_interval(secs => $5),
                     CASE WHEN $6::float8 IS NULL THEN NULL ELSE now() - make_interval(secs => $6::float8) END,
                     $7)
             RETURNING id`,
            [
              workflowId,
              workspaceId,
              status,
              BASE_AGO + startedAgoSeconds,
              lastActiveAgoSeconds,
              claimedAgoSeconds,
              claimAttempts,
            ],
          )
          runIds.push(r.rows[0].id as string)
          return r.rows[0].id as string
        } finally {
          c.release()
        }
      },
      async cleanup() {
        const c = await pool!.connect()
        try {
          await c.query(`DELETE FROM workflow_runs WHERE workspace_id = $1`, [workspaceId])
        } finally {
          c.release()
        }
      },
    }
    return fixture
  } finally {
    client.release()
  }
}

async function rowState(runId: string) {
  const r = await pool!.query(
    `SELECT status, claimed_at, claim_attempts, error->>'reason' AS reason
       FROM workflow_runs WHERE id = $1`,
    [runId],
  )
  return r.rows[0] as {
    status: string
    claimed_at: Date | null
    claim_attempts: number
    reason: string | null
  }
}

describeIf('[COMP:workflow/run-queue] claimNextPendingRunSystem (mig 302)', () => {
  it('claims FIFO and stamps the lease', async () => {
    const f = await makeFixture()
    try {
      const older = await f.addRun({ workflowId: f.wfA, startedAgoSeconds: 20 })
      await f.addRun({ workflowId: f.wfB, startedAgoSeconds: 10 })

      const claimed = await queue.claimNextPendingRunSystem(DEFAULTS)
      expect(claimed).not.toBeNull()
      expect(claimed!.runId).toBe(older) // oldest first
      expect(claimed!.workflowId).toBe(f.wfA)
      expect(claimed!.workspaceId).toBe(f.workspaceId)

      const state = await rowState(older)
      expect(state.status).toBe('pending') // advance flips it, not the claim
      expect(state.claimed_at).not.toBeNull()
      expect(state.claim_attempts).toBe(1)
    } finally {
      await f.cleanup()
    }
  })

  it('serializes per workflow: a freshly claimed or running sibling blocks the next run', async () => {
    const f = await makeFixture()
    try {
      await f.addRun({ workflowId: f.wfA, startedAgoSeconds: 30 })
      await f.addRun({ workflowId: f.wfA, startedAgoSeconds: 20 })
      const bRun = await f.addRun({ workflowId: f.wfB, startedAgoSeconds: 10 })

      const first = await queue.claimNextPendingRunSystem(DEFAULTS)
      expect(first!.workflowId).toBe(f.wfA)
      // wfA's second run is blocked by the fresh claim — wfB's run wins.
      const second = await queue.claimNextPendingRunSystem(DEFAULTS)
      expect(second!.runId).toBe(bRun)
      // Nothing else eligible: wfA serialized, wfB fresh-claimed.
      expect(await queue.claimNextPendingRunSystem(DEFAULTS)).toBeNull()
    } finally {
      await f.cleanup()
    }
  })

  it('serializes per workflow against a running sibling too', async () => {
    const f = await makeFixture()
    try {
      await f.addRun({ workflowId: f.wfA, status: 'running' })
      await f.addRun({ workflowId: f.wfA, startedAgoSeconds: 10 })

      expect(await queue.claimNextPendingRunSystem(DEFAULTS)).toBeNull()
    } finally {
      await f.cleanup()
    }
  })

  it('enforces the per-workspace in-flight cap', async () => {
    const f = await makeFixture()
    try {
      await f.addRun({ workflowId: f.wfA, status: 'running' })
      const bRun = await f.addRun({ workflowId: f.wfB, startedAgoSeconds: 10 })

      // cap 1: the running wfA run fills the workspace budget.
      expect(
        await queue.claimNextPendingRunSystem({ ...DEFAULTS, workspaceCap: 1 }),
      ).toBeNull()
      // cap 2: room for wfB.
      const claimed = await queue.claimNextPendingRunSystem({ ...DEFAULTS, workspaceCap: 2 })
      expect(claimed!.runId).toBe(bRun)
    } finally {
      await f.cleanup()
    }
  })

  it('reclaims after the lease expires, up to the attempts cap', async () => {
    const f = await makeFixture()
    try {
      const run = await f.addRun({
        workflowId: f.wfA,
        claimedAgoSeconds: 600, // stale lease (>120s)
        claimAttempts: 1,
      })
      const claimed = await queue.claimNextPendingRunSystem(DEFAULTS)
      expect(claimed!.runId).toBe(run)
      expect((await rowState(run)).claim_attempts).toBe(2)

      // At the cap it is no longer claimable.
      await pool!.query(
        `UPDATE workflow_runs SET claim_attempts = 3, claimed_at = now() - interval '10 minutes' WHERE id = $1`,
        [run],
      )
      expect(await queue.claimNextPendingRunSystem(DEFAULTS)).toBeNull()
    } finally {
      await f.cleanup()
    }
  })

  it('failExhaustedPendingRunsSystem fails lease-expired runs with no attempts left', async () => {
    const f = await makeFixture()
    try {
      const dead = await f.addRun({
        workflowId: f.wfA,
        claimedAgoSeconds: 600,
        claimAttempts: 3,
      })
      const fresh = await f.addRun({ workflowId: f.wfB, claimedAgoSeconds: 5, claimAttempts: 3 })

      const n = await queue.failExhaustedPendingRunsSystem({
        leaseSeconds: 120,
        maxClaimAttempts: 3,
      })
      expect(n).toBeGreaterThanOrEqual(1)
      const deadState = await rowState(dead)
      expect(deadState.status).toBe('failed')
      expect(deadState.reason).toBe('run_queue_exhausted')
      // A fresh lease is NOT failed even at the attempts cap — its claimer
      // may still be advancing it.
      expect((await rowState(fresh)).status).toBe('pending')
    } finally {
      await f.cleanup()
    }
  })

  it('requeueStaleRunningRunsSystem re-queues a crashed run and fails an exhausted one', async () => {
    const f = await makeFixture()
    try {
      const crashed = await f.addRun({
        workflowId: f.wfA,
        status: 'running',
        lastActiveAgoSeconds: 3600,
        claimAttempts: 1,
      })
      const poison = await f.addRun({
        workflowId: f.wfB,
        status: 'running',
        lastActiveAgoSeconds: 3600,
        claimAttempts: 3,
      })
      const live = await f.addRun({
        workflowId: f.wfB,
        status: 'running',
        lastActiveAgoSeconds: 10,
      })

      const n = await queue.requeueStaleRunningRunsSystem({
        staleSeconds: 1800,
        maxClaimAttempts: 3,
      })
      expect(n).toBeGreaterThanOrEqual(2)

      const crashedState = await rowState(crashed)
      expect(crashedState.status).toBe('pending')
      expect(crashedState.claimed_at).toBeNull()
      const poisonState = await rowState(poison)
      expect(poisonState.status).toBe('failed')
      expect(poisonState.reason).toBe('run_queue_stale')
      expect((await rowState(live)).status).toBe('running')
    } finally {
      await f.cleanup()
    }
  })

  it('storm guard: counts recent runs, pauses with a reason, re-enable clears it', async () => {
    const f = await makeFixture()
    try {
      await f.addRun({ workflowId: f.wfA, startedAgoSeconds: 0 })
      await f.addRun({ workflowId: f.wfA, startedAgoSeconds: 0 })

      // The fixture backdates started_at ~50 years — nothing recent…
      expect(await countRecentRunsForWorkflowSystem(f.wfA, 300)).toBe(0)
      // …but a wide-enough window sees both.
      expect(
        await countRecentRunsForWorkflowSystem(f.wfA, BASE_AGO + 3600),
      ).toBe(2)

      await pauseWorkflowSystem(f.wfA, 'Paused automatically: storm test.')
      const paused = await pool!.query(
        `SELECT enabled, paused_reason FROM workflows WHERE id = $1`,
        [f.wfA],
      )
      expect(paused.rows[0].enabled).toBe(false)
      expect(paused.rows[0].paused_reason).toContain('storm test')

      // PATCH re-enable clears the reason (createDbWorkflowStore().update).
      const updated = await createDbWorkflowStore().update(f.userId, f.wfA, { enabled: true })
      expect(updated?.enabled).toBe(true)
      expect(updated?.pausedReason).toBeNull()
    } finally {
      await f.cleanup()
    }
  })
})
