import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import {
  ExtractionApplicationError,
  freezeExtractionPlan,
  type AccessContext,
} from '@use-brian/core'

import { getAppPool, getPool } from '../client.js'
import { createExtractionApplicationStore } from '../extraction-application-store.js'
import { _resetCoalescerForTests } from '../../brain-stream/notify.js'

const { assertLocalFixture } = await import(
  new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href
)
await assertLocalFixture()

const pool = getPool()
const appPool = getAppPool()
const store = createExtractionApplicationStore()

type Fixture = Awaited<ReturnType<typeof fixture>>

async function fixture() {
  const workspaceId = randomUUID()
  const sourceActorId = randomUUID()
  const replayActorId = randomUUID()
  const assistantId = randomUUID()
  const episodeId = randomUUID()

  for (const userId of [sourceActorId, replayActorId]) {
    await pool.query(
      'INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',
      [userId],
    )
  }
  await pool.query(
    "INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Extraction application fixture',$2)",
    [workspaceId, replayActorId],
  )
  await pool.query(
    "INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential'),($1,$3,'member','confidential')",
    [workspaceId, replayActorId, sourceActorId],
  )
  await pool.query(
    "INSERT INTO assistants(id,name,workspace_id,owner_user_id,kind,clearance,compartments) VALUES($1,'Fixture assistant',$2,$3,'primary','confidential',NULL)",
    [assistantId, workspaceId, replayActorId],
  )
  await pool.query(
    `INSERT INTO episodes(
       id,workspace_id,created_by_user_id,user_id,assistant_id,source_kind,
       source_ref,occurred_at,sensitivity,status,summary_text
     ) VALUES($1,$2,$3,NULL,$4,'manual_paste','{}',now(),'internal','archived','fixture')`,
    [episodeId, workspaceId, sourceActorId, assistantId],
  )
  const source = await pool.query<{ scopeVersion: string }>(
    'SELECT scope_version::text AS "scopeVersion" FROM episodes WHERE id=$1',
    [episodeId],
  )
  const plan = freezeExtractionPlan({
    episodeId,
    sourceContentHash: 'a'.repeat(64),
    sourceScopeVersion: source.rows[0].scopeVersion,
    extractorContractVersion: 'pipeline-b-integration-v1',
    candidates: [{
      key: 'memory',
      primitiveKind: 'memory',
      payload: { summary: 'Fictional durable fact' },
    }],
  })
  const run = await store.ensureRun({
    workspaceId,
    episodeId,
    attemptKey: 'initial:fixture',
    plan,
    extractionState: 'succeeded',
  })
  return { workspaceId, sourceActorId, replayActorId, assistantId, episodeId, plan, run }
}

function authority(input: Fixture) {
  return {
    actorUserId: input.replayActorId,
    workspaceId: input.workspaceId,
    mutationCompartments: [] as string[],
    projectIds: [] as string[],
  }
}

function ctx(input: Fixture, overrides: Partial<AccessContext> = {}): AccessContext {
  return {
    workspaceId: input.workspaceId,
    userId: input.replayActorId,
    assistantId: input.assistantId,
    assistantKind: 'primary',
    clearance: 'confidential',
    mutationCompartments: [],
    projectIds: [],
    ...overrides,
  }
}

async function insertEffect(client: unknown, input: Fixture) {
  const tx = client as { query<T>(sql: string, values: unknown[]): Promise<{ rows: T[] }> }
  const effect = await tx.query<{ id: string }>(
    `INSERT INTO analytics_events(user_id,assistant_id,event_name,metadata)
     VALUES($1,$2,'extraction_application_fixture',$3::jsonb) RETURNING id`,
    [input.replayActorId, input.assistantId, JSON.stringify({ episodeId: input.episodeId })],
  )
  return effect.rows[0].id
}

async function effectCount(input: Fixture) {
  return Number((await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM analytics_events
      WHERE event_name='extraction_application_fixture' AND metadata->>'episodeId'=$1`,
    [input.episodeId],
  )).rows[0].count)
}

describe('[COMP:brain/extraction-application-store] PostgreSQL receipt fencing', () => {
  afterAll(async () => {
    _resetCoalescerForTests()
    await pool.end()
    await appPool.end()
  })

  it('I3 rolls back the domain mutation when the receipt transaction fails', async () => {
    const input = await fixture()
    const claim = await store.claim(input.run.id, input.plan.planHash, authority(input))
    await expect(store.applyItem(claim, input.plan.candidates[0], async (client) => {
      await insertEffect(client, input)
      throw new ExtractionApplicationError('synthetic_before_commit', undefined, true)
    })).rejects.toMatchObject({ code: 'synthetic_before_commit' })

    expect(await effectCount(input)).toBe(0)
    expect((await store.getRun(input.run.id))?.items[0]).toMatchObject({
      disposition: 'pending', receiptId: null, attemptCount: 0,
    })
  })

  it('I3 treats a lost acknowledgement as already applied without duplicating the write', async () => {
    const input = await fixture()
    const claim = await store.claim(input.run.id, input.plan.planHash, authority(input))
    const first = await store.applyItem(claim, input.plan.candidates[0], async (client) => ({
      targetRecordId: await insertEffect(client, input),
    }))
    const replay = await store.applyItem(claim, input.plan.candidates[0], async () => {
      throw new Error('terminal receipts must skip mutation')
    })

    expect(first.disposition).toBe('committed')
    expect(replay).toMatchObject({ disposition: 'already_applied', receiptId: first.receiptId })
    expect(await effectCount(input)).toBe(1)
  })

  it('I3 fences stale lease owners after another worker claims the run', async () => {
    const input = await fixture()
    const stale = await store.claim(input.run.id, input.plan.planHash, authority(input))
    await pool.query(
      "UPDATE episode_extraction_runs SET lease_until=now()-interval '1 second' WHERE id=$1",
      [input.run.id],
    )
    const current = await store.claim(input.run.id, input.plan.planHash, authority(input))

    await expect(store.applyItem(stale, input.plan.candidates[0], async (client) => ({
      targetRecordId: await insertEffect(client, input),
    }))).rejects.toMatchObject({ code: 'application_lease_lost' })
    await store.applyItem(current, input.plan.candidates[0], async (client) => ({
      targetRecordId: await insertEffect(client, input),
    }))
    expect(await effectCount(input)).toBe(1)
  })

  it('I4 reauthorizes reads and replay against live workspace and source authority', async () => {
    const input = await fixture()
    expect(await store.getAuthorized(ctx(input), input.episodeId)).not.toBeNull()
    expect(await store.getAuthorized(
      ctx(input, { workspaceId: randomUUID() }),
      input.episodeId,
    )).toBeNull()

    const claim = await store.claim(input.run.id, input.plan.planHash, authority(input))
    await pool.query(
      'DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',
      [input.workspaceId, input.sourceActorId],
    )
    await expect(store.applyItem(claim, input.plan.candidates[0], async (client) => ({
      targetRecordId: await insertEffect(client, input),
    }))).rejects.toMatchObject({ code: 'application_authority_denied' })
    expect(await effectCount(input)).toBe(0)
    expect((await pool.query('SELECT status FROM episodes WHERE id=$1', [input.episodeId])).rows[0].status)
      .toBe('archived')
  })

  it('I4 blocks replay after source hold/version invalidation and cascades erasure', async () => {
    const input = await fixture()
    const claim = await store.claim(input.run.id, input.plan.planHash, authority(input))
    await pool.query('UPDATE episodes SET scope_held=true WHERE id=$1', [input.episodeId])
    await expect(store.applyItem(claim, input.plan.candidates[0], async (client) => ({
      targetRecordId: await insertEffect(client, input),
    }))).rejects.toSatisfy((error: unknown) =>
      error instanceof ExtractionApplicationError
        && ['application_lease_lost', 'application_source_blocked'].includes(error.code))
    await pool.query('DELETE FROM episodes WHERE id=$1', [input.episodeId])
    expect(await store.getRun(input.run.id)).toBeNull()
  })
})
