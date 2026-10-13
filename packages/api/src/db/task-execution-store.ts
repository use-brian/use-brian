/**
 * Task execution store: the SQL behind resumable task execution.
 *
 * Operational rows (migration 754). Engine and service writes use the owner
 * pool inside explicit transactions; the services in `goals/execution-state.ts`,
 * `goals/allowance-tree.ts`, `tasks/execution-control.ts` and
 * `tasks/external-progress.ts` are the authorization gate. The one viewer read,
 * `readExecutionForViewer`, runs under RLS so the source-aware policies decide
 * what exists.
 *
 * Concurrency: every allowance mutation locks the pool row (`FOR UPDATE`), and
 * every control or settle locks the state row, so reservations serialize and a
 * stale write-back observes the control that fenced it.
 *
 * Spec: docs/architecture/features/goals.md -> "Resumable task execution".
 * [COMP:goals/execution-checkpoint] [COMP:goals/allowance-tree]
 */
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import {
  iterationSpendEstimate,
  reserveIteration,
  type ExecutionCheckpoint,
  type ExecutionLane,
  type ExecutionPhase,
  type ExecutionPlan,
  type ExecutionSourceRef,
  type ExecutionStreaks,
} from '@use-brian/core'
import { applyRLSGucs, getAppPool, getPool, rollbackAndRelease } from './client.js'

type Db = Pick<pg.PoolClient, 'query'>

export type ExecutionActorKind = 'user' | 'assistant' | 'credential' | 'system'
export type ExecutionOrigin = 'ui' | 'chat' | 'mcp' | 'worker' | 'assignment'
export type ExecutionCommandKind = 'enter' | 'pause' | 'steer' | 'continue' | 'checkpoint' | 'recover' | 'retire' | 'bind' | 'report'
export type ExecutionCommandOutcome = 'applied' | 'stale' | 'blocked' | 'duplicate'

export type ExecutionExecutor = { kind: 'assistant' | 'person'; id: string } | null

export type ExecutionInFlight = {
  attemptId: string
  segment: number
  spend: number
  iterations: number
  /** The control revision the attempt was reserved under (the fence). */
  controlRevision: number
  runId: string | null
  startedAt: string
}

export type ExecutionSteering = {
  interventionId: string
  instruction: string
  byUserId: string
  at: string
}

export type ExecutionState = {
  id: string
  workspaceId: string
  taskId: string | null
  goalId: string | null
  parentStateId: string | null
  childKey: string | null
  poolId: string
  lane: ExecutionLane
  executor: ExecutionExecutor
  phase: ExecutionPhase
  controlRevision: number
  checkpointRevision: number
  plan: Partial<ExecutionPlan>
  sourceRefs: ExecutionSourceRef[]
  authoringRef: Record<string, unknown> | null
  blocker: { reason: string; detail?: string } | null
  wait: Record<string, unknown> | null
  pause: { byUserId: string | null; at: string; previousPhase: ExecutionPhase } | null
  inFlight: ExecutionInFlight | null
  checkpoint: ExecutionCheckpoint | null
  steering: ExecutionSteering[]
  streaks: ExecutionStreaks
  externalExecutionId: string | null
  harness: string | null
  lastReportedAt: Date | null
  lastReportSequence: number | null
  createdAt: Date
  updatedAt: Date
}

export type ExecutionSegment = {
  segmentNo: number
  openedReason: 'initial' | 'human_renewal'
  openedByCommandId: string | null
  spent: number
  iterations: number
  reservedSpend: number
  reservedIterations: number
  lateSpend: number
  openedAt: Date
  closedAt: Date | null
}

export type ExecutionPool = {
  id: string
  workspaceId: string
  rootKind: 'task' | 'goal'
  rootId: string
  maxSpend: number | null
  maxIterations: number | null
  activeSegment: number
  segments: ExecutionSegment[]
  lifetime: { spent: number; iterations: number; lateSpend: number; reservedSpend: number }
}

export type ExecutionReceipt = {
  id: string
  stateId: string
  kind: ExecutionCommandKind
  actorKind: ExecutionActorKind
  actorId: string | null
  origin: ExecutionOrigin
  humanOrigin: boolean
  expectedRevision: number | null
  resultRevision: number | null
  outcome: ExecutionCommandOutcome
  renewedSegment: number | null
  externalEventId: string | null
  externalSequence: number | null
  payload: Record<string, unknown>
  observedAt: Date | null
  createdAt: Date
}

export type ExecutionActor = {
  kind: ExecutionActorKind
  id: string | null
  origin: ExecutionOrigin
  /** Server-derived. Only an authenticated person can be a human origin. */
  humanOrigin: boolean
}

const STATE_COLUMNS = `id, workspace_id, task_id, goal_id, parent_state_id, child_key, pool_id, lane, executor_kind,
  executor_id, phase, control_revision::text, checkpoint_revision::text, plan, source_refs, authoring_ref, blocker, wait,
  pause, in_flight, checkpoint, steering, no_progress_streak, transient_streak, external_execution_id, harness,
  last_reported_at, last_report_sequence::text, created_at, updated_at`

type StateRow = {
  id: string; workspace_id: string; task_id: string | null; goal_id: string | null; parent_state_id: string | null
  child_key: string | null; pool_id: string; lane: ExecutionLane; executor_kind: 'assistant' | 'person' | null
  executor_id: string | null; phase: ExecutionPhase; control_revision: string; checkpoint_revision: string
  plan: Partial<ExecutionPlan>; source_refs: ExecutionSourceRef[]; authoring_ref: Record<string, unknown> | null
  blocker: ExecutionState['blocker']; wait: Record<string, unknown> | null; pause: ExecutionState['pause']
  in_flight: ExecutionInFlight | null; checkpoint: ExecutionCheckpoint | null; steering: ExecutionSteering[]
  no_progress_streak: number; transient_streak: number; external_execution_id: string | null; harness: string | null
  last_reported_at: Date | null; last_report_sequence: string | null; created_at: Date; updated_at: Date
}

function toState(r: StateRow): ExecutionState {
  return {
    id: r.id, workspaceId: r.workspace_id, taskId: r.task_id, goalId: r.goal_id, parentStateId: r.parent_state_id,
    childKey: r.child_key, poolId: r.pool_id, lane: r.lane,
    executor: r.executor_kind && r.executor_id ? { kind: r.executor_kind, id: r.executor_id } : null,
    phase: r.phase, controlRevision: Number(r.control_revision), checkpointRevision: Number(r.checkpoint_revision),
    plan: r.plan ?? {}, sourceRefs: r.source_refs ?? [], authoringRef: r.authoring_ref, blocker: r.blocker,
    wait: r.wait, pause: r.pause, inFlight: r.in_flight, checkpoint: r.checkpoint, steering: r.steering ?? [],
    streaks: { noProgress: r.no_progress_streak, transient: r.transient_streak },
    externalExecutionId: r.external_execution_id, harness: r.harness, lastReportedAt: r.last_reported_at,
    lastReportSequence: r.last_report_sequence === null ? null : Number(r.last_report_sequence),
    createdAt: r.created_at, updatedAt: r.updated_at,
  }
}

const RECEIPT_COLUMNS = `id, state_id, kind, actor_kind, actor_id, origin, human_origin, expected_revision::text,
  result_revision::text, outcome, renewed_segment, external_event_id, external_sequence::text, payload, observed_at, created_at`

type ReceiptRow = {
  id: string; state_id: string; kind: ExecutionCommandKind; actor_kind: ExecutionActorKind; actor_id: string | null
  origin: ExecutionOrigin; human_origin: boolean; expected_revision: string | null; result_revision: string | null
  outcome: ExecutionCommandOutcome; renewed_segment: number | null; external_event_id: string | null
  external_sequence: string | null; payload: Record<string, unknown>; observed_at: Date | null; created_at: Date
}

function toReceipt(r: ReceiptRow): ExecutionReceipt {
  return {
    id: r.id, stateId: r.state_id, kind: r.kind, actorKind: r.actor_kind, actorId: r.actor_id, origin: r.origin,
    humanOrigin: r.human_origin, expectedRevision: r.expected_revision === null ? null : Number(r.expected_revision),
    resultRevision: r.result_revision === null ? null : Number(r.result_revision), outcome: r.outcome,
    renewedSegment: r.renewed_segment, externalEventId: r.external_event_id,
    externalSequence: r.external_sequence === null ? null : Number(r.external_sequence), payload: r.payload ?? {},
    observedAt: r.observed_at, createdAt: r.created_at,
  }
}

type SegmentRow = {
  segment_no: number; opened_reason: 'initial' | 'human_renewal'; opened_by_command_id: string | null
  spent: string; iterations: number; reserved_spend: string; reserved_iterations: number; late_spend: string
  opened_at: Date; closed_at: Date | null
}

function toSegment(r: SegmentRow): ExecutionSegment {
  return {
    segmentNo: r.segment_no, openedReason: r.opened_reason, openedByCommandId: r.opened_by_command_id,
    spent: Number(r.spent), iterations: r.iterations, reservedSpend: Number(r.reserved_spend),
    reservedIterations: r.reserved_iterations, lateSpend: Number(r.late_spend), openedAt: r.opened_at, closedAt: r.closed_at,
  }
}

async function withTx<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const out = await work(client)
    await client.query('COMMIT')
    return out
  } finally {
    await rollbackAndRelease(client)
  }
}

async function lockState(db: Db, id: string): Promise<ExecutionState | null> {
  const r = await db.query(`SELECT ${STATE_COLUMNS} FROM task_execution_states WHERE id = $1 FOR UPDATE`, [id])
  return r.rows[0] ? toState(r.rows[0] as StateRow) : null
}

async function loadPool(db: Db, poolId: string, lock: boolean): Promise<ExecutionPool | null> {
  const p = await db.query(
    `SELECT id, workspace_id, root_kind, root_id, max_spend::text, max_iterations, active_segment
       FROM task_execution_pools WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [poolId])
  const row = p.rows[0] as { id: string; workspace_id: string; root_kind: 'task' | 'goal'; root_id: string
    max_spend: string | null; max_iterations: number | null; active_segment: number } | undefined
  if (!row) return null
  const s = await db.query(
    `SELECT segment_no, opened_reason, opened_by_command_id, spent::text, iterations, reserved_spend::text,
            reserved_iterations, late_spend::text, opened_at, closed_at
       FROM task_execution_segments WHERE pool_id = $1 ORDER BY segment_no`, [poolId])
  const segments = (s.rows as SegmentRow[]).map(toSegment)
  return {
    id: row.id, workspaceId: row.workspace_id, rootKind: row.root_kind, rootId: row.root_id,
    maxSpend: row.max_spend === null ? null : Number(row.max_spend), maxIterations: row.max_iterations,
    activeSegment: row.active_segment, segments,
    lifetime: {
      spent: round6(segments.reduce((n, x) => n + x.spent, 0)),
      iterations: segments.reduce((n, x) => n + x.iterations, 0),
      lateSpend: round6(segments.reduce((n, x) => n + x.lateSpend, 0)),
      reservedSpend: round6(segments.reduce((n, x) => n + x.reservedSpend, 0)),
    },
  }
}

async function insertReceipt(db: Db, state: Pick<ExecutionState, 'id' | 'workspaceId' | 'poolId'>, r: {
  id?: string; idempotencyKey: string; kind: ExecutionCommandKind; actor: ExecutionActor
  expectedRevision?: number | null; resultRevision?: number | null; outcome: ExecutionCommandOutcome
  renewedSegment?: number | null; externalEventId?: string | null; externalSequence?: number | null
  payload?: Record<string, unknown>; observedAt?: Date | null
}): Promise<ExecutionReceipt> {
  const res = await db.query(
    `INSERT INTO task_execution_commands (id, workspace_id, state_id, pool_id, idempotency_key, kind, actor_kind, actor_id,
       origin, human_origin, expected_revision, result_revision, outcome, renewed_segment, external_event_id,
       external_sequence, payload, observed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18)
     RETURNING ${RECEIPT_COLUMNS}`,
    [r.id ?? randomUUID(), state.workspaceId, state.id, state.poolId, r.idempotencyKey, r.kind, r.actor.kind, r.actor.id,
      r.actor.origin, r.actor.humanOrigin, r.expectedRevision ?? null, r.resultRevision ?? null, r.outcome,
      r.renewedSegment ?? null, r.externalEventId ?? null, r.externalSequence ?? null, JSON.stringify(r.payload ?? {}),
      r.observedAt ?? null])
  return toReceipt(res.rows[0] as ReceiptRow)
}

async function findReceipt(db: Db, stateId: string, key: string): Promise<ExecutionReceipt | null> {
  const r = await db.query(`SELECT ${RECEIPT_COLUMNS} FROM task_execution_commands WHERE state_id = $1 AND idempotency_key = $2`, [stateId, key])
  return r.rows[0] ? toReceipt(r.rows[0] as ReceiptRow) : null
}

// --- creation ---------------------------------------------------------------------

export type CreateRootExecutionInput = {
  workspaceId: string
  taskId: string | null
  goalId: string | null
  executor: ExecutionExecutor
  phase: Extract<ExecutionPhase, 'planning' | 'ready' | 'waiting' | 'blocked'>
  plan: Partial<ExecutionPlan>
  sourceRefs: ExecutionSourceRef[]
  authoringRef: Record<string, unknown> | null
  blocker?: ExecutionState['blocker']
  budget: { maxSpend: number | null; maxIterations: number | null }
  enter: { idempotencyKey: string; actor: ExecutionActor; payload?: Record<string, unknown> }
}

/**
 * Create the root execution, its pool and first segment, and the `enter`
 * receipt, atomically. A concurrent or duplicate entry for the same target
 * loses the partial unique index and gets the existing active state back with
 * `created: false`: duplicate events never create a second pursuit or pool.
 */
export async function createRootExecution(input: CreateRootExecutionInput): Promise<{ state: ExecutionState; created: boolean }> {
  try {
    return await withTx(async (client) => {
      const pool = await client.query<{ id: string }>(
        `INSERT INTO task_execution_pools (workspace_id, root_kind, root_id, max_spend, max_iterations)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [input.workspaceId, input.taskId ? 'task' : 'goal', input.taskId ?? input.goalId, input.budget.maxSpend, input.budget.maxIterations])
      const poolId = pool.rows[0].id
      await client.query(
        `INSERT INTO task_execution_segments (pool_id, workspace_id, segment_no, opened_reason) VALUES ($1,$2,1,'initial')`,
        [poolId, input.workspaceId])
      const st = await client.query(
        `INSERT INTO task_execution_states (workspace_id, task_id, goal_id, pool_id, lane, executor_kind, executor_id, phase,
           plan, source_refs, authoring_ref, blocker)
         VALUES ($1,$2,$3,$4,'native',$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb)
         RETURNING ${STATE_COLUMNS}`,
        [input.workspaceId, input.taskId, input.goalId, poolId, input.executor?.kind ?? null, input.executor?.id ?? null,
          input.phase, JSON.stringify(input.plan), JSON.stringify(input.sourceRefs),
          input.authoringRef ? JSON.stringify(input.authoringRef) : null, input.blocker ? JSON.stringify(input.blocker) : null])
      const state = toState(st.rows[0] as StateRow)
      await insertReceipt(client, state, {
        idempotencyKey: input.enter.idempotencyKey, kind: 'enter', actor: input.enter.actor, outcome: 'applied',
        resultRevision: state.controlRevision, payload: input.enter.payload,
      })
      return { state, created: true }
    })
  } catch (error) {
    if ((error as { code?: string }).code !== '23505') throw error
    const existing = input.taskId
      ? await findActiveNativeExecutionSystem({ taskId: input.taskId })
      : await findActiveNativeExecutionSystem({ goalId: input.goalId! })
    if (!existing) throw error
    return { state: existing, created: false }
  }
}

/** Bind the canonical Goal to a task-rooted execution once it exists. */
export async function bindExecutionGoalSystem(stateId: string, goalId: string): Promise<ExecutionState | null> {
  const r = await getPool().query(
    `UPDATE task_execution_states SET goal_id = $2 WHERE id = $1 AND (goal_id IS NULL OR goal_id = $2) RETURNING ${STATE_COLUMNS}`,
    [stateId, goalId])
  return r.rows[0] ? toState(r.rows[0] as StateRow) : null
}

/**
 * Derive a necessary child idempotently: same parent + child key returns the
 * existing child. The child joins the ROOT pool (the parent's pool), so it can
 * never get an allowance of its own.
 */
export async function deriveChildExecutionSystem(parentStateId: string, childKey: string, input: {
  taskId: string | null; executor: ExecutionExecutor; plan: Partial<ExecutionPlan>; sourceRefs: ExecutionSourceRef[]
  phase: Extract<ExecutionPhase, 'planning' | 'ready' | 'waiting'>
}): Promise<{ state: ExecutionState; created: boolean }> {
  return withTx(async (client) => {
    const parent = await lockState(client, parentStateId)
    if (!parent) throw Object.assign(new Error('execution_not_found'), { code: 'execution_not_found' })
    const existing = await client.query(
      `SELECT ${STATE_COLUMNS} FROM task_execution_states WHERE parent_state_id = $1 AND child_key = $2`, [parentStateId, childKey])
    if (existing.rows[0]) return { state: toState(existing.rows[0] as StateRow), created: false }
    const r = await client.query(
      `INSERT INTO task_execution_states (workspace_id, task_id, goal_id, parent_state_id, child_key, pool_id, lane,
         executor_kind, executor_id, phase, plan, source_refs, authoring_ref)
       VALUES ($1,$2,$12,$3,$4,$5,'native',$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb) RETURNING ${STATE_COLUMNS}`,
      [parent.workspaceId, input.taskId ?? parent.taskId, parent.id, childKey, parent.poolId, input.executor?.kind ?? null,
        input.executor?.id ?? null, input.phase, JSON.stringify(input.plan), JSON.stringify(input.sourceRefs),
        parent.authoringRef ? JSON.stringify(parent.authoringRef) : null, input.taskId ? null : parent.goalId])
    return { state: toState(r.rows[0] as StateRow), created: true }
  })
}

// --- reads --------------------------------------------------------------------------

export async function getExecutionSystem(id: string): Promise<ExecutionState | null> {
  const r = await getPool().query(`SELECT ${STATE_COLUMNS} FROM task_execution_states WHERE id = $1`, [id])
  return r.rows[0] ? toState(r.rows[0] as StateRow) : null
}

export async function findActiveNativeExecutionSystem(target: { taskId: string } | { goalId: string }): Promise<ExecutionState | null> {
  const [col, val] = 'taskId' in target ? ['task_id', target.taskId] : ['goal_id', target.goalId]
  const r = await getPool().query(
    `SELECT ${STATE_COLUMNS} FROM task_execution_states
      WHERE ${col} = $1 AND lane = 'native' AND parent_state_id IS NULL AND phase NOT IN ('done','retired') LIMIT 1`, [val])
  return r.rows[0] ? toState(r.rows[0] as StateRow) : null
}

/** True when a goal's native execution was retired (executor change, host
 *  deleted): the goal must not continue on the legacy path. */
export async function hasRetiredNativeExecutionSystem(goalId: string): Promise<boolean> {
  const r = await getPool().query(
    `SELECT EXISTS (SELECT 1 FROM task_execution_states WHERE goal_id = $1 AND lane = 'native' AND phase = 'retired') AS ok`, [goalId])
  return r.rows[0]?.ok === true
}

export async function getPoolSystem(poolId: string): Promise<ExecutionPool | null> {
  return loadPool(getPool(), poolId, false)
}

export async function listChildExecutionsSystem(parentStateId: string): Promise<ExecutionState[]> {
  const r = await getPool().query(
    `SELECT ${STATE_COLUMNS} FROM task_execution_states WHERE parent_state_id = $1 ORDER BY created_at, id`, [parentStateId])
  return (r.rows as StateRow[]).map(toState)
}

export type ExecutionViewerProjection = {
  state: ExecutionState
  pool: ExecutionPool
  children: ExecutionState[]
  externalLanes: ExecutionState[]
  receipts: ExecutionReceipt[]
}

/**
 * The viewer read. Everything runs under the viewer's RLS in one transaction:
 * a state the viewer cannot see (protected/private/out-of-Project task) is
 * absent, and children or external lanes on tasks the viewer cannot see are
 * dropped from rows AND counts. Returns null for anything not visible.
 */
export async function readExecutionForViewer(userId: string, target: { executionId: string } | { taskId: string }): Promise<ExecutionViewerProjection | null> {
  const client = await getAppPool().connect()
  try {
    await client.query('BEGIN')
    await applyRLSGucs(client, userId)
    const stateRes = 'executionId' in target
      ? await client.query(`SELECT ${STATE_COLUMNS} FROM task_execution_states WHERE id = $1`, [target.executionId])
      : await client.query(
        `SELECT ${STATE_COLUMNS} FROM task_execution_states WHERE task_id = $1 AND lane = 'native' AND parent_state_id IS NULL
          ORDER BY (phase IN ('done','retired')), created_at DESC LIMIT 1`, [target.taskId])
    if (!stateRes.rows[0]) { await client.query('COMMIT'); return null }
    const state = toState(stateRes.rows[0] as StateRow)
    const pool = await loadPool(client, state.poolId, false)
    if (!pool) { await client.query('COMMIT'); return null }
    const children = (await client.query(
      `SELECT ${STATE_COLUMNS} FROM task_execution_states WHERE parent_state_id = $1 ORDER BY created_at, id`, [state.id])).rows as StateRow[]
    const external = state.taskId
      ? (await client.query(
        `SELECT ${STATE_COLUMNS} FROM task_execution_states WHERE task_id = $1 AND lane = 'external' ORDER BY created_at, id`,
        [state.taskId])).rows as StateRow[]
      : []
    const receipts = (await client.query(
      `SELECT ${RECEIPT_COLUMNS} FROM task_execution_commands WHERE state_id = $1 ORDER BY created_at DESC, id DESC LIMIT 50`,
      [state.id])).rows as ReceiptRow[]
    await client.query('COMMIT')
    return { state, pool, children: children.map(toState), externalLanes: external.map(toState), receipts: receipts.map(toReceipt) }
  } finally {
    await rollbackAndRelease(client)
  }
}

// --- the iteration boundary -------------------------------------------------------

export type BeginIterationResult =
  | { kind: 'proceed'; state: ExecutionState; pool: ExecutionPool; inFlight: ExecutionInFlight }
  | { kind: 'fenced'; state: ExecutionState }
  | { kind: 'exhausted'; state: ExecutionState; reason: 'max_spend' | 'max_iterations' }
  | { kind: 'unsettled'; state: ExecutionState }
  | { kind: 'missing' }

/**
 * Reserve the next iteration against the ACTIVE segment under the pool lock.
 * Refuses a paused / blocked / terminal state (the fence), and refuses to
 * stack a second attempt on an unsettled one (the caller reconciles it from
 * the ledger first). Exhaustion blocks the state with the budget reason.
 */
export async function beginIterationSystem(stateId: string): Promise<BeginIterationResult> {
  return withTx(async (client) => {
    const state = await lockState(client, stateId)
    if (!state) return { kind: 'missing' as const }
    if (['paused', 'blocked', 'done', 'retired'].includes(state.phase)) return { kind: 'fenced' as const, state }
    if (state.inFlight) return { kind: 'unsettled' as const, state }
    const pool = (await loadPool(client, state.poolId, true))!
    // A branch stops with its root: a retired or paused root fences the tree.
    if (state.parentStateId) {
      const root = await client.query<{ phase: ExecutionPhase }>(
        `SELECT phase FROM task_execution_states WHERE pool_id = $1 AND parent_state_id IS NULL AND lane = 'native'
          ORDER BY created_at LIMIT 1`, [state.poolId])
      if (root.rows[0] && ['retired', 'paused', 'done'].includes(root.rows[0].phase)) return { kind: 'fenced' as const, state }
    }
    const seg = pool.segments.find(s => s.segmentNo === pool.activeSegment)!
    const settledIterations = pool.segments.reduce((n, s) => n + s.iterations, 0)
    const settledSpend = pool.segments.reduce((n, s) => n + s.spent, 0)
    const verdict = reserveIteration(
      { maxSpend: pool.maxSpend, maxIterations: pool.maxIterations },
      { spent: seg.spent, iterations: seg.iterations, reservedSpend: seg.reservedSpend, reservedIterations: seg.reservedIterations },
      iterationSpendEstimate(settledSpend, settledIterations))
    if (!verdict.ok) {
      const blocked = await client.query(
        `UPDATE task_execution_states SET phase = 'blocked', blocker = $2::jsonb WHERE id = $1 RETURNING ${STATE_COLUMNS}`,
        [state.id, JSON.stringify({ reason: verdict.reason })])
      return { kind: 'exhausted' as const, state: toState(blocked.rows[0] as StateRow), reason: verdict.reason }
    }
    await client.query(
      `UPDATE task_execution_segments SET reserved_spend = reserved_spend + $3, reserved_iterations = reserved_iterations + 1
        WHERE pool_id = $1 AND segment_no = $2`, [pool.id, seg.segmentNo, verdict.spend])
    const inFlight: ExecutionInFlight = {
      attemptId: randomUUID(), segment: seg.segmentNo, spend: verdict.spend, iterations: 1,
      controlRevision: state.controlRevision, runId: null, startedAt: new Date().toISOString(),
    }
    const updated = await client.query(
      `UPDATE task_execution_states SET phase = 'running', in_flight = $2::jsonb, wait = NULL WHERE id = $1 RETURNING ${STATE_COLUMNS}`,
      [state.id, JSON.stringify(inFlight)])
    return { kind: 'proceed' as const, state: toState(updated.rows[0] as StateRow), pool: (await loadPool(client, pool.id, false))!, inFlight }
  })
}

/** Record which run (and so which usage session) an attempt is bound to, before
 *  dispatch, so a crash can be reconciled from the ledger. */
export async function bindAttemptRunSystem(stateId: string, attemptId: string, runId: string): Promise<void> {
  await getPool().query(
    `UPDATE task_execution_states SET in_flight = jsonb_set(in_flight, '{runId}', to_jsonb($3::text))
      WHERE id = $1 AND in_flight->>'attemptId' = $2`, [stateId, attemptId, runId])
}

export type SettleOutcome = {
  /** Applied when the state was not fenced since the reservation. */
  kind: 'applied' | 'fenced' | 'duplicate'
  state: ExecutionState
  pool: ExecutionPool
}

export type SettleInput = {
  attemptId: string
  /** Actual metered spend for the attempt. `null` = metering unknown: the
   *  reservation is kept as spent (never treated as zero). */
  actualSpend: number | null
  checkpoint: ExecutionCheckpoint | null
  nextPhase: Extract<ExecutionPhase, 'ready' | 'waiting' | 'blocked' | 'done'>
  blocker?: ExecutionState['blocker']
  wait?: Record<string, unknown> | null
  streaks: ExecutionStreaks
}

/**
 * Settle an attempt: release its reservation, add the actual spend and one
 * iteration to the ORIGINATING segment (late use on a closed segment is also
 * recorded as `late_spend`, never erased), and write the checkpoint at the
 * next revision. If a control changed the state since the reservation (pause,
 * steer, continue) the attempt is FENCED: usage and the factual checkpoint are
 * still recorded, but its phase/streak decision is discarded so stale
 * write-back cannot override the human.
 */
export async function settleIterationSystem(stateId: string, input: SettleInput): Promise<SettleOutcome | null> {
  return withTx(async (client) => {
    const state = await lockState(client, stateId)
    if (!state) return null
    const pool = (await loadPool(client, state.poolId, true))!
    if (!state.inFlight || state.inFlight.attemptId !== input.attemptId) return { kind: 'duplicate' as const, state, pool }
    const f = state.inFlight
    const actual = input.actualSpend === null ? f.spend : Math.max(0, input.actualSpend)
    const late = f.segment < pool.activeSegment
    await client.query(
      `UPDATE task_execution_segments
          SET reserved_spend = greatest(0, reserved_spend - $3), reserved_iterations = greatest(0, reserved_iterations - $4),
              spent = spent + $5, iterations = iterations + $4, late_spend = late_spend + $6
        WHERE pool_id = $1 AND segment_no = $2`,
      [pool.id, f.segment, f.spend, f.iterations, actual, late ? actual : 0])
    const fenced = state.controlRevision !== f.controlRevision || state.phase !== 'running'
    const checkpoint = input.checkpoint ? { ...input.checkpoint, segment: f.segment } : state.checkpoint
    const cpRev = input.checkpoint ? state.checkpointRevision + 1 : state.checkpointRevision
    const r = fenced
      ? await client.query(
        `UPDATE task_execution_states SET in_flight = NULL, checkpoint = $2::jsonb, checkpoint_revision = $3,
                phase = CASE WHEN phase = 'running' THEN 'ready' ELSE phase END
          WHERE id = $1 RETURNING ${STATE_COLUMNS}`, [state.id, JSON.stringify(checkpoint), cpRev])
      : await client.query(
        `UPDATE task_execution_states SET in_flight = NULL, checkpoint = $2::jsonb, checkpoint_revision = $3, phase = $4,
                blocker = $5::jsonb, wait = $6::jsonb, no_progress_streak = $7, transient_streak = $8
          WHERE id = $1 RETURNING ${STATE_COLUMNS}`,
        [state.id, JSON.stringify(checkpoint), cpRev, input.nextPhase,
          input.blocker ? JSON.stringify(input.blocker) : null, input.wait ? JSON.stringify(input.wait) : null,
          input.streaks.noProgress, input.streaks.transient])
    return { kind: fenced ? 'fenced' as const : 'applied' as const, state: toState(r.rows[0] as StateRow), pool: (await loadPool(client, pool.id, false))! }
  })
}

/** Engine phase write outside an iteration (dependency wait resolved, done). */
export async function setExecutionPhaseSystem(stateId: string, phase: ExecutionPhase, extra: {
  blocker?: ExecutionState['blocker']; wait?: Record<string, unknown> | null; plan?: Partial<ExecutionPlan>
  sourceRefs?: ExecutionSourceRef[]
} = {}): Promise<ExecutionState | null> {
  const r = await getPool().query(
    `UPDATE task_execution_states SET phase = $2, blocker = $3::jsonb, wait = $4::jsonb,
            plan = coalesce($5::jsonb, plan), source_refs = coalesce($6::jsonb, source_refs)
      WHERE id = $1 AND phase NOT IN ('paused','retired') RETURNING ${STATE_COLUMNS}`,
    [stateId, phase, extra.blocker ? JSON.stringify(extra.blocker) : null, extra.wait ? JSON.stringify(extra.wait) : null,
      extra.plan ? JSON.stringify(extra.plan) : null, extra.sourceRefs ? JSON.stringify(extra.sourceRefs) : null])
  return r.rows[0] ? toState(r.rows[0] as StateRow) : null
}

// --- controls ---------------------------------------------------------------------

export type ControlCommand = {
  kind: 'pause' | 'steer' | 'continue'
  interventionId: string
  expectedRevision: number
  instruction?: string
  actor: ExecutionActor
}

export type ControlResult = { receipt: ExecutionReceipt; state: ExecutionState; pool: ExecutionPool }

const RESUMABLE_BLOCKERS = new Set(['max_spend', 'max_iterations', 'no_progress', 'transient_retries_exhausted'])

/**
 * Apply one control under the state row lock. Replay of an intervention id
 * returns its original receipt (`duplicate` is reported by the caller from
 * `replayed`), a revision mismatch writes a `stale` receipt with no effect, and
 * a renewal opens exactly one new segment, recording the receipt that opened
 * it. Lifetime use and prior segments are untouched.
 */
export async function applyControlSystem(stateId: string, cmd: ControlCommand,
  denied?: (state: ExecutionState) => Promise<string | null>): Promise<(ControlResult & { replayed: boolean }) | null> {
  return withTx(async (client) => {
    const state = await lockState(client, stateId)
    if (!state) return null
    const key = `control:${cmd.interventionId}`
    const prior = await findReceipt(client, state.id, key)
    if (prior) return { receipt: prior, state, pool: (await loadPool(client, state.poolId, false))!, replayed: true }
    const block = async (reason: string) => ({
      receipt: await insertReceipt(client, state, { idempotencyKey: key, kind: cmd.kind, actor: cmd.actor, outcome: 'blocked',
        expectedRevision: cmd.expectedRevision, resultRevision: state.controlRevision, payload: { reason } }),
      state, pool: (await loadPool(client, state.poolId, false))!, replayed: false,
    })
    // Admission is rechecked inside the lock, at application time.
    const denial = denied ? await denied(state) : null
    if (denial) return block(denial)
    if (state.lane !== 'native') return block('execution_reporting_only')
    if (cmd.expectedRevision !== state.controlRevision) {
      return {
        receipt: await insertReceipt(client, state, { idempotencyKey: key, kind: cmd.kind, actor: cmd.actor, outcome: 'stale',
          expectedRevision: cmd.expectedRevision, resultRevision: state.controlRevision }),
        state, pool: (await loadPool(client, state.poolId, false))!, replayed: false,
      }
    }
    if (state.phase === 'done' || state.phase === 'retired') return block('execution_terminal')
    if (cmd.kind !== 'pause' && !cmd.actor.humanOrigin) return block('human_intent_required')
    if (cmd.kind === 'steer' && !cmd.instruction?.trim()) return block('instruction_required')
    if (cmd.kind === 'continue' && state.phase === 'blocked' && state.blocker && !RESUMABLE_BLOCKERS.has(state.blocker.reason)) {
      // A known blocker (missing account, inaccessible source) is not cleared
      // by renewing allowance; continuing would retry the same futile action.
      return block('blocker_unresolved')
    }

    const receiptId = randomUUID()
    const nextRevision = state.controlRevision + 1
    let renewedSegment: number | null = null
    if (cmd.kind === 'steer' || cmd.kind === 'continue') {
      const pool = (await loadPool(client, state.poolId, true))!
      renewedSegment = pool.activeSegment + 1
      await client.query(
        `UPDATE task_execution_segments SET closed_at = now() WHERE pool_id = $1 AND segment_no = $2`, [pool.id, pool.activeSegment])
      await client.query(
        `UPDATE task_execution_pools SET active_segment = $2, revision = revision + 1 WHERE id = $1`, [pool.id, renewedSegment])
    }
    const receipt = await insertReceipt(client, state, {
      id: receiptId, idempotencyKey: key, kind: cmd.kind, actor: cmd.actor, outcome: 'applied',
      expectedRevision: cmd.expectedRevision, resultRevision: nextRevision, renewedSegment,
      payload: cmd.instruction ? { instruction: cmd.instruction.trim() } : {},
    })
    if (renewedSegment !== null) {
      await client.query(
        `INSERT INTO task_execution_segments (pool_id, workspace_id, segment_no, opened_reason, opened_by_command_id)
         VALUES ($1,$2,$3,'human_renewal',$4)`, [state.poolId, state.workspaceId, renewedSegment, receiptId])
    }
    let updated
    if (cmd.kind === 'pause') {
      updated = await client.query(
        `UPDATE task_execution_states SET phase = 'paused', control_revision = $2, pause = $3::jsonb WHERE id = $1 RETURNING ${STATE_COLUMNS}`,
        [state.id, nextRevision, JSON.stringify({ byUserId: cmd.actor.kind === 'user' ? cmd.actor.id : null,
          at: new Date().toISOString(), previousPhase: state.pause?.previousPhase ?? state.phase })])
    } else {
      const steering = cmd.kind === 'steer'
        ? [...state.steering, { interventionId: cmd.interventionId, instruction: cmd.instruction!.trim(), byUserId: cmd.actor.id!, at: new Date().toISOString() }]
        : state.steering
      // A running attempt keeps running (its write-back is fenced by the new
      // revision); anything else resumes from its checkpoint as ready.
      const phase = state.phase === 'running' ? 'running' : 'ready'
      updated = await client.query(
        `UPDATE task_execution_states SET phase = $2, control_revision = $3, pause = NULL, blocker = NULL,
                steering = $4::jsonb, no_progress_streak = 0, transient_streak = 0
          WHERE id = $1 RETURNING ${STATE_COLUMNS}`,
        [state.id, phase, nextRevision, JSON.stringify(steering)])
    }
    return { receipt, state: toState(updated.rows[0] as StateRow), pool: (await loadPool(client, state.poolId, false))!, replayed: false }
  })
}

// --- external lanes -----------------------------------------------------------------

/** Bind an external coding session to a task as its own `external` lane. The
 *  lane gets its own reporting-only pool record (never spent against: native
 *  usage ledgers cannot see external cost), so it cannot touch the native pool. */
export async function bindExternalLaneSystem(input: {
  workspaceId: string; taskId: string; externalExecutionId: string; harness: string; label: string | null; actor: ExecutionActor
}): Promise<{ state: ExecutionState; created: boolean }> {
  return withTx(async (client) => {
    const existing = await client.query(
      `SELECT ${STATE_COLUMNS} FROM task_execution_states WHERE task_id = $1 AND lane = 'external' AND external_execution_id = $2`,
      [input.taskId, input.externalExecutionId])
    if (existing.rows[0]) return { state: toState(existing.rows[0] as StateRow), created: false }
    const pool = await client.query<{ id: string }>(
      `INSERT INTO task_execution_pools (workspace_id, root_kind, root_id, max_spend, max_iterations)
       VALUES ($1,'task',$2,NULL,1) RETURNING id`, [input.workspaceId, input.taskId])
    await client.query(`INSERT INTO task_execution_segments (pool_id, workspace_id, segment_no, opened_reason) VALUES ($1,$2,1,'initial')`,
      [pool.rows[0].id, input.workspaceId])
    const r = await client.query(
      `INSERT INTO task_execution_states (workspace_id, task_id, pool_id, lane, phase, external_execution_id, harness, plan)
       VALUES ($1,$2,$3,'external','running',$4,$5,$6::jsonb) RETURNING ${STATE_COLUMNS}`,
      [input.workspaceId, input.taskId, pool.rows[0].id, input.externalExecutionId, input.harness,
        JSON.stringify(input.label ? { outcome: input.label } : {})])
    const state = toState(r.rows[0] as StateRow)
    await insertReceipt(client, state, { idempotencyKey: `bind:${input.externalExecutionId}`, kind: 'bind', actor: input.actor, outcome: 'applied',
      payload: { harness: input.harness } })
    return { state, created: true }
  })
}

export type ExternalReport = {
  eventId: string
  sequence: number
  milestone: string
  state: 'running' | 'waiting' | 'blocked' | 'claimed_done'
  summary: string | null
  artifacts: { kind: string; ref: string }[]
  blocker: string | null
  claims: string[]
  observedAt: Date | null
}

const REPORT_PHASE: Record<ExternalReport['state'], ExecutionPhase> = {
  running: 'running', waiting: 'waiting', blocked: 'blocked', claimed_done: 'running',
}

/**
 * Append a report. Deduplicated by event id; recorded even when out of order,
 * but only a higher sequence advances the lane's current state. A
 * `claimed_done` report never makes the lane (or the task) done: it is a claim.
 */
export async function appendExternalReportSystem(laneId: string, report: ExternalReport, actor: ExecutionActor): Promise<{ receipt: ExecutionReceipt; state: ExecutionState; advanced: boolean; replayed: boolean } | null> {
  return withTx(async (client) => {
    const lane = await lockState(client, laneId)
    if (!lane || lane.lane !== 'external') return null
    const prior = await client.query(`SELECT ${RECEIPT_COLUMNS} FROM task_execution_commands WHERE state_id = $1 AND external_event_id = $2`, [lane.id, report.eventId])
    if (prior.rows[0]) return { receipt: toReceipt(prior.rows[0] as ReceiptRow), state: lane, advanced: false, replayed: true }
    const advanced = lane.lastReportSequence === null || report.sequence > lane.lastReportSequence
    const receipt = await insertReceipt(client, lane, {
      idempotencyKey: `report:${report.eventId}`, kind: 'report', actor, outcome: 'applied',
      externalEventId: report.eventId, externalSequence: report.sequence, observedAt: report.observedAt,
      payload: { milestone: report.milestone, state: report.state, summary: report.summary, artifacts: report.artifacts,
        blocker: report.blocker, claims: report.claims, advanced },
    })
    const r = advanced
      ? await client.query(
        `UPDATE task_execution_states SET phase = $2, last_reported_at = now(), last_report_sequence = $3,
                blocker = $4::jsonb, checkpoint = $5::jsonb
          WHERE id = $1 RETURNING ${STATE_COLUMNS}`,
        [lane.id, REPORT_PHASE[report.state], report.sequence, report.blocker ? JSON.stringify({ reason: 'reported', detail: report.blocker }) : null,
          JSON.stringify({ summary: report.summary ?? report.milestone, sourceRefs: [], artifacts: report.artifacts, completedEffects: [],
            uncertainEffects: [], checkedResults: [], nextStep: null, questions: [], segment: 1, evidenceFingerprint: '',
            claims: report.claims, milestone: report.milestone, reportedState: report.state })])
      : await client.query(`UPDATE task_execution_states SET last_reported_at = now() WHERE id = $1 RETURNING ${STATE_COLUMNS}`, [lane.id])
    return { receipt, state: toState(r.rows[0] as StateRow), advanced, replayed: false }
  })
}

export async function findExternalLaneSystem(taskId: string, externalExecutionId: string): Promise<ExecutionState | null> {
  const r = await getPool().query(
    `SELECT ${STATE_COLUMNS} FROM task_execution_states WHERE task_id = $1 AND lane = 'external' AND external_execution_id = $2`,
    [taskId, externalExecutionId])
  return r.rows[0] ? toState(r.rows[0] as StateRow) : null
}

// --- task lineage --------------------------------------------------------------------

/** Follow task supersession: called inside `updateTask`'s transaction. */
export async function repointTaskExecutions(db: Db, fromTaskId: string, toTaskId: string): Promise<void> {
  // SECURITY DEFINER: the task writer runs RLS-enforced; the function verifies
  // that `fromTaskId` really was superseded by `toTaskId` before moving anything.
  await db.query(`SELECT public.task_execution_repoint($1, $2)`, [fromTaskId, toTaskId])
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6
}
