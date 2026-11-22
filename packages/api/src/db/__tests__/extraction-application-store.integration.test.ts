import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { ExtractionApplicationError } from '@use-brian/core/ingest/application.js'
import { freezeExtractionPlan } from '@use-brian/core/ingest/extraction-plan.js'
import type { PipelineBEntityApplication, PipelineBSourceEnvelope } from '@use-brian/core/ingest/pipeline-b-application.js'
import type { AccessContext } from '@use-brian/agent-runtime/security/access-context.js'

import { getAppPool, getPool } from '../client.js'
import { createExtractionApplicationStore } from '../extraction-application-store.js'
import { createEntity } from '../entities-store.js'
import { createDefaultIngestApplicationService } from '../../ingest/default-application-service.js'
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

async function aliasFixture(input: Fixture, options: {
  strongIdentity: boolean
  sameKind?: boolean
  privateTarget?: boolean
  independentLabel?: boolean
  duplicateCanonical?: boolean
  movedCanonical?: boolean
}) {
  const name = 'Fictional shared label'
  const canonicalId = 'example.test/fictional-project'
  const scope = {
    workspaceId: input.workspaceId, userId: null, assistantId: input.assistantId,
    createdByUserId: input.sourceActorId, createdByAssistantId: null,
    sensitivity: 'internal' as const, compartments: [], projectIds: [],
  }
  const envelope: PipelineBSourceEnvelope = { ...scope, episodeId: input.episodeId }
  const target = await createEntity({
    ...scope, kind: 'project', displayName: 'Fictional canonical project',
    canonicalId: options.movedCanonical ? null : canonicalId,
    userId: options.privateTarget ? input.sourceActorId : null,
    attributes: { status: 'before' }, source: 'user',
  })
  const conflict = await createEntity({
    ...scope, kind: options.sameKind ? 'project' : 'product',
    displayName: options.independentLabel ? 'Unrelated fictional label' : name,
    canonicalId: options.duplicateCanonical || options.movedCanonical ? canonicalId : null,
    attributes: {}, source: 'user',
  })
  const plan = freezeExtractionPlan({
    episodeId: input.episodeId, sourceContentHash: 'b'.repeat(64),
    sourceScopeVersion: input.plan.sourceScopeVersion, extractorContractVersion: 'pipeline-b-v2-delivery',
    candidates: [
      {
        key: 'target', primitiveKind: 'entity', payload: {
          ...envelope, command: 'entity', action: 'supersede_entity', entityKind: 'project', displayName: name,
          canonicalId: options.strongIdentity ? canonicalId : null, targetEntityId: target.id,
          attributes: { status: 'after' }, alias: ` ${name.toUpperCase()} `,
        } satisfies PipelineBEntityApplication,
      },
      {
        key: 'other', primitiveKind: 'entity', payload: {
          ...envelope, command: 'entity', action: 'create_entity', entityKind: 'project',
          displayName: 'Fictional independent project', canonicalId: null, targetEntityId: null,
          attributes: {}, alias: null,
        } satisfies PipelineBEntityApplication,
      },
      {
        key: 'edge', primitiveKind: 'edge', dependencyKeys: ['target', 'other'], payload: {
          ...envelope, command: 'edge', edgeType: 'mentioned', attributes: {},
          sourceDependencyIndex: 0, targetDependencyIndex: 1, targetRecordId: null,
          sourceKind: 'entity', targetKind: 'entity',
        },
      },
      {
        key: 'finalization', primitiveKind: 'episode_finalization',
        payload: { ...envelope, command: 'episode_finalization' },
      },
    ],
  })
  return { plan, target, conflict, attemptKey: 'initial:alias-fixture' }
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

  it('resumes the legacy alias failure against the unique canonical record and keeps the original receipt for independent work', async () => {
    const input = await fixture()
    const { plan, target, conflict, attemptKey } = await aliasFixture(input, { strongIdentity: true, sameKind: true })
    const service = createDefaultIngestApplicationService()
    const run = await store.ensureRun({ ...input, plan, attemptKey, extractionState: 'succeeded' })
    const claim = await store.claim(run.id, plan.planHash, authority(input))
    await store.recordFailure(claim, plan.candidates[0].candidateId, { code: 'application_policy_changed', retryable: false })
    const finalized = await store.applyItem(claim, plan.candidates[3], async () => ({ targetRecordId: input.episodeId }))
    expect((await store.finish(claim)).applicationState).toBe('partial')
    expect(await service.get(ctx(input), input.episodeId)).toMatchObject({ resumable: true })
    await expect(service.retry({ ctx: ctx(input, { userId: input.sourceActorId }), episodeId: input.episodeId,
      runId: run.id, expectedPlanHash: plan.planHash })).rejects.toMatchObject({ code: 'forbidden' })

    const recovered = await service.retry({ ctx: ctx(input), episodeId: input.episodeId,
      runId: run.id, expectedPlanHash: plan.planHash })
    expect(recovered).toMatchObject({ applicationState: 'complete', resumable: false, counts: { committed: 4, pending: 0, failed: 0 } })
    const receipts = (await store.getRun(run.id))!.items
    const successorId = receipts[0].targetRecordId
    expect(receipts[0]).toMatchObject({ disposition: 'committed', attemptCount: 2 })
    expect(successorId).not.toBe(target.id)
    expect(successorId).not.toBe(conflict.id)
    expect(receipts[3]).toMatchObject({ receiptId: finalized.receiptId, attemptCount: 1 })
    const entities = (await pool.query('SELECT id,aliases,attributes,valid_to FROM entities WHERE id=ANY($1::uuid[])',
      [[target.id, successorId, conflict.id]])).rows
    expect(entities.find((entity) => entity.id === successorId)).toMatchObject({ aliases: [], attributes: { status: 'after' }, valid_to: null })
    expect(entities.find((entity) => entity.id === target.id)?.valid_to).not.toBeNull()
    expect(entities.find((entity) => entity.id === conflict.id)).toMatchObject({ aliases: [], valid_to: null })
    expect((await pool.query('SELECT source_id,target_id FROM entity_links WHERE source_episode_id=$1', [input.episodeId])).rows)
      .toEqual([{ source_id: successorId, target_id: receipts[1].targetRecordId }])
    await expect(service.retry({ ctx: ctx(input), episodeId: input.episodeId,
      runId: run.id, expectedPlanHash: plan.planHash })).rejects.toMatchObject({ code: 'conflict' })
  })

  it.each([
    { label: 'a visible alias collision', strongIdentity: false, code: 'application_entity_alias_conflict' },
    { label: 'a hidden canonical target', strongIdentity: true, privateTarget: true, code: 'application_target_changed' },
    { label: 'a duplicate same-kind canonical ID', strongIdentity: true, sameKind: true, duplicateCanonical: true, code: 'application_entity_identity_ambiguous' },
    { label: 'a canonical ID that now matches another record', strongIdentity: true, sameKind: true,
      movedCanonical: true, independentLabel: true, code: 'application_entity_identity_ambiguous' },
  ])('holds the frozen entity and its relationship for $label while applying unrelated work', async ({ code, ...options }) => {
    const input = await fixture()
    const { plan, target, attemptKey } = await aliasFixture(input, options)
    const service = createDefaultIngestApplicationService()
    const applied = await service.apply({ ...authority(input), attemptKey, plan })

    expect(applied).toMatchObject({ applicationState: 'complete', counts: { committed: 2, held: 2, pending: 0, failed: 0 } })
    expect(applied.items[0]).toMatchObject({ disposition: 'held', failureCode: code, retryable: false, targetRecordId: null })
    expect(applied.items[2]).toMatchObject({ disposition: 'held', failureCode: 'application_dependency_unavailable', retryable: false, targetRecordId: null })
    expect((await pool.query('SELECT id,aliases,attributes,valid_to,superseded_by FROM entities WHERE id=$1',
      [target.id])).rows)
      .toEqual([{ id: target.id, aliases: [], attributes: { status: 'before' }, valid_to: null, superseded_by: null }])
    expect((await pool.query('SELECT id FROM entity_links WHERE source_episode_id=$1', [input.episodeId])).rows).toHaveLength(0)
    expect(await service.get(ctx(input), input.episodeId)).toMatchObject({ resumable: false })
  })

  it('still learns a free alias on the superseded record through ordinary application', async () => {
    const input = await fixture()
    const { plan, target, attemptKey } = await aliasFixture(input, { strongIdentity: false, independentLabel: true })
    const service = createDefaultIngestApplicationService()
    const applied = await service.apply({ ...authority(input), attemptKey, plan })
    expect(applied).toMatchObject({ applicationState: 'complete', counts: { committed: 4, held: 0 } })
    const ids = [target.id, applied.items[0].targetRecordId]
    const entities = (await pool.query('SELECT id,aliases FROM entities WHERE id=ANY($1::uuid[])', [ids])).rows
    expect(entities.find((entity) => entity.id === target.id)?.aliases).toEqual([])
    expect(entities.find((entity) => entity.id === ids[1])?.aliases).toEqual(['fictional shared label'])
  })
})
