import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { ExtractionApplicationError } from '@use-brian/core/ingest/application.js'
import { freezeExtractionPlan } from '@use-brian/core/ingest/extraction-plan.js'
import { processEpisode } from '@use-brian/core/ingest/pipeline-b.js'
import type { PipelineBEntityApplication, PipelineBSourceEnvelope } from '@use-brian/core/ingest/pipeline-b-application.js'
import type { LLMProvider } from '@use-brian/agent-runtime/providers/types.js'
import type { AccessContext } from '@use-brian/agent-runtime/security/access-context.js'

import { getAppPool, getPool } from '../client.js'
import { createExtractionApplicationStore } from '../extraction-application-store.js'
import { bindImportedCrmIdentity } from '../crm-identity-store.js'
import { createDbCrmStore } from '../crm-store.js'
import { createCompany, createContact, getCompanyById, getContactById } from '../crm.js'
import { createDbEntitiesStore, createEntity } from '../entities-store.js'
import { createDbEntityLinksStore } from '../entity-links-store.js'
import { createDbEpisodesStore } from '../episodes-store.js'
import { createDbMemoryStore } from '../memory-store.js'
import { createDbWorkspaceGroupStore } from '../workspace-group-store.js'
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

async function fixture(options: { privateEpisode?: boolean } = {}) {
  const workspaceId = randomUUID()
  const sourceActorId = randomUUID()
  const replayActorId = randomUUID()
  const assistantId = randomUUID()
  const episodeId = randomUUID()
  const episodeUserId = options.privateEpisode ? sourceActorId : null

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
     ) VALUES($1,$2,$3,$5,$4,'manual_paste','{}',now(),'internal','archived','fixture')`,
    [episodeId, workspaceId, sourceActorId, assistantId, episodeUserId],
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
  return { workspaceId, sourceActorId, replayActorId, assistantId, episodeId, episodeUserId, plan, run }
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
  reuse?: boolean
}) {
  const name = 'Fictional shared label'
  const canonicalId = 'example.test/fictional-project'
  const scope = {
    workspaceId: input.workspaceId, userId: null, assistantId: input.assistantId,
    createdByUserId: input.sourceActorId, createdByAssistantId: null,
    sensitivity: 'internal' as const, compartments: [], projectIds: [],
  }
  const envelope: PipelineBSourceEnvelope = { ...scope, episodeId: input.episodeId, userId: input.episodeUserId }
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
          ...envelope, command: 'entity', action: options.reuse ? 'reuse_entity' : 'supersede_entity',
          entityKind: 'project', displayName: name,
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

const CONTACT_NAME = 'Fictional Orchard Contact'
const CONTACT_EMAIL = 'intake@example.test'
const COMPANY_NAME = 'Fictional Orchard Company'
const COMPANY_DOMAIN = 'orchard.example.test'

async function crmSourceFixture(setupState: 'ready' | 'legacy', privateEpisode: boolean) {
  const input = await fixture({ privateEpisode })
  const team = await createDbWorkspaceGroupStore().createTeam(input.replayActorId, input.workspaceId, {
    name: 'Fictional Intake', key: 'intake',
  })
  const projectId = randomUUID()
  const compartments = [team.compartmentKey!]
  const projectIds = [projectId]
  await pool.query('INSERT INTO workspace_group_members(group_id,user_id) VALUES($1,$2)', [team.id, input.sourceActorId])
  await pool.query(`INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by)
    VALUES($1,$2,'Fictional Orchard','fictional orchard',$3)`, [projectId, input.workspaceId, input.sourceActorId])
  await pool.query(`UPDATE workspace_access_policies
    SET access_mode='departments',setup_state=$2,default_department_id=$3 WHERE workspace_id=$1`,
  [input.workspaceId, setupState, team.id])
  await pool.query(`UPDATE episodes SET sensitivity='confidential',compartments=$2,project_ids=$3 WHERE id=$1`,
    [input.episodeId, compartments, projectIds])
  const episodes = createDbEpisodesStore()
  const source = (await episodes.getEpisodeByIdSystem(input.sourceActorId, input.episodeId))!
  const application = createDefaultIngestApplicationService()
  const links = createDbEntityLinksStore()
  const authority = { workspaceId: input.workspaceId, actorUserId: input.sourceActorId, mutationCompartments: compartments, projectIds }
  const identity = { provider: 'slack' as const, providerInstanceKey: 'fictional-workspace', subjectId: randomUUID() }
  const externalRef = { provider: 'slack', team_id: identity.providerInstanceKey, id: identity.subjectId }

  async function extract({ durable = true } = {}) {
    await pool.query("UPDATE episodes SET status='extracting' WHERE id=$1", [input.episodeId])
    const extractingSource = (await episodes.getEpisodeByIdSystem(input.sourceActorId, input.episodeId))!
    const model = {
      name: 'fixture', models: ['fixture'],
      createSession() { throw new Error('Extraction does not create provider sessions') },
      async *stream() {
        yield { type: 'text_delta', text: JSON.stringify({
          summary: 'Fictional CRM source', tags: [], edges: [], memories: [], tasks: [], ephemeral: [],
          entities: [
            { kind: 'person', display_name: CONTACT_NAME, canonical_id: CONTACT_EMAIL, attributes: {} },
            { kind: 'company', display_name: COMPANY_NAME, canonical_id: COMPANY_DOMAIN,
              attributes: { note: 'Fictional detail from the Episode' } },
          ],
        }) }
        yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10 } }
      },
    } satisfies LLMProvider
    return processEpisode({ ...extractingSource, sourceKind: 'manual_paste', sensitivity: 'confidential', personExternalRefs: [
      { name: CONTACT_NAME, externalRef, phone: '+12025550101' },
    ] }, `${CONTACT_NAME} <${CONTACT_EMAIL}> works with ${COMPANY_NAME} at ${COMPANY_DOMAIN}.`, {
      provider: model, model: 'fixture', classifierModel: null, episodes,
      crm: createDbCrmStore(), entities: createDbEntitiesStore({ entityLinks: links }),
      entityLinks: links, memories: createDbMemoryStore(), application: durable ? application : undefined,
    })
  }

  return { input, source, application, authority, compartments, projectIds, identity, extract }
}

async function crmSourceOutputs(input: Fixture) {
  return (await pool.query(`SELECT id,kind,user_id,assistant_id,sensitivity,compartments,project_ids,attributes
    FROM entities WHERE source_episode_id=$1 ORDER BY kind`, [input.episodeId])).rows
}

async function removeFixtureWorkspacePolicy(workspaceId: string) {
  // New authority rows initialize settings today. Recreate a pre-policy fixture
  // under the table lock and restore the named guard before exercising writes.
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('ALTER TABLE workspace_access_policies DISABLE TRIGGER workspace_access_mode_guard')
    await client.query('DELETE FROM workspace_access_policies WHERE workspace_id=$1', [workspaceId])
    await client.query('ALTER TABLE workspace_access_policies ENABLE TRIGGER workspace_access_mode_guard')
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

function frozenContactPlan(f: Awaited<ReturnType<typeof crmSourceFixture>>, overrides: Partial<PipelineBSourceEnvelope> = {}) {
  const { source } = f
  const sourceScope = {
    workspaceId: source.workspaceId, userId: source.userId, assistantId: source.assistantId,
    sensitivity: 'confidential' as const, compartments: f.compartments, projectIds: f.projectIds,
  }
  return freezeExtractionPlan({
    episodeId: source.id,
    sourceContentHash: 'c'.repeat(64),
    sourceScopeVersion: source.scopeVersion!,
    extractorContractVersion: 'pipeline-b-v2-delivery',
    candidates: [{ key: 'contact', primitiveKind: 'entity', payload: {
      ...sourceScope, episodeId: source.id, createdByUserId: source.createdByUserId,
      createdByAssistantId: source.createdByAssistantId,
      derivation: { producer: 'pipeline-b', sources: [{ ...sourceScope, resourceKind: 'episode', resourceId: source.id, version: source.scopeVersion! }] },
      ...overrides, command: 'entity', action: 'create_contact', entityKind: 'person', displayName: CONTACT_NAME,
      canonicalId: CONTACT_EMAIL, attributes: {}, targetEntityId: null, alias: null,
    } satisfies PipelineBEntityApplication }],
  })
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

  it.each([true, false])('keeps private Episode evidence off a shared entity (reuse=%s)', async (reuse) => {
    const input = await fixture({ privateEpisode: true })
    const { plan, target, attemptKey } = await aliasFixture(input, { strongIdentity: true, independentLabel: true, reuse })
    const service = createDefaultIngestApplicationService()
    const applied = await service.apply({ ...authority(input), actorUserId: input.sourceActorId, attemptKey, plan })

    expect(applied.items[0]).toMatchObject(reuse
      ? { disposition: 'committed', targetRecordId: target.id }
      : { disposition: 'held', failureCode: 'application_entity_scope_mismatch', targetRecordId: null })
    expect((await pool.query('SELECT id,aliases,attributes,valid_to FROM entities WHERE workspace_id=$1 AND canonical_id=$2',
      [input.workspaceId, target.canonicalId])).rows)
      .toEqual([{ id: target.id, aliases: [], attributes: { status: 'before' }, valid_to: null }])
    expect((await pool.query('SELECT source_id,user_id FROM entity_links WHERE source_episode_id=$1', [input.episodeId])).rows)
      .toEqual(reuse ? [{ source_id: target.id, user_id: input.sourceActorId }] : [])
  })

  it.each(['legacy', 'ready'] as const)('inherits private Episode scope for both CRM kinds and replays the same receipts (%s)', async (mode) => {
    const f = await crmSourceFixture(mode, true)
    const result = await f.extract()
    const run = await store.getRun(result.applicationRunId!)
    expect(run?.items.map(item => [item.disposition, item.failureCode])).toEqual([
      ['committed', null], ['committed', null], ['committed', null],
    ])
    expect(result.applicationState).toBe('complete')
    const outputs = await crmSourceOutputs(f.input)
    expect(outputs.map(row => row.kind)).toEqual(['company', 'person'])
    expect(run!.items.filter(item => item.primitiveKind === 'entity').map(item => item.targetRecordId).sort())
      .toEqual(outputs.map(row => row.id).sort())
    for (const row of outputs) {
      expect(row).toMatchObject({ user_id: f.input.sourceActorId, assistant_id: f.input.assistantId,
        sensitivity: 'confidential', compartments: f.compartments, project_ids: f.projectIds })
      const load = row.kind === 'person' ? getContactById : getCompanyById
      const access = { compartments: f.compartments, mutationCompartments: f.compartments, projectIds: f.projectIds }
      expect(await load(ctx(f.input, { ...access, userId: f.input.sourceActorId }), row.id)).toMatchObject(row.kind === 'person'
        ? { name: CONTACT_NAME, email: CONTACT_EMAIL, phone: '+12025550101' }
        : { name: COMPANY_NAME, domain: COMPANY_DOMAIN })
      expect(await load(ctx(f.input, access), row.id)).toBeNull()
    }
    const evidence = await pool.query(`SELECT d.resource_id, s.source_id, s.source_version::text
      FROM scope_derivations d JOIN scope_derivation_sources s ON s.derivation_id=d.id
      WHERE d.workspace_id=$1 AND d.resource_kind='entity' AND s.source_kind='episode' ORDER BY d.resource_id`,
    [f.input.workspaceId])
    const frozen = (await pool.query('SELECT attempt_key,frozen_plan FROM episode_extraction_runs WHERE id=$1', [run!.id])).rows[0]
    expect(evidence.rows).toEqual(outputs.map(row => ({ resource_id: row.id, source_id: f.input.episodeId,
      source_version: frozen.frozen_plan.sourceScopeVersion })).sort((a, b) => a.resource_id.localeCompare(b.resource_id)))
    const replay = await f.application.apply({ ...f.authority, attemptKey: frozen.attempt_key, plan: frozen.frozen_plan })
    expect(replay.items).toEqual(run!.items)
    expect(await crmSourceOutputs(f.input)).toEqual(outputs)
    expect((await pool.query('SELECT id FROM entities WHERE workspace_id=$1 ORDER BY id', [f.input.workspaceId])).rows)
      .toEqual(outputs.map(row => ({ id: row.id })).sort((a, b) => a.id.localeCompare(b.id)))

    await pool.query('UPDATE episodes SET scope_held=true WHERE id=$1', [f.input.episodeId])
    expect((await pool.query('SELECT scope_held FROM entities WHERE source_episode_id=$1', [f.input.episodeId])).rows)
      .toEqual([{ scope_held: true }, { scope_held: true }])
  })

  it.each(['legacy', 'ready'] as const)('preserves authorized shared CRM extraction (%s)', async (mode) => {
    const f = await crmSourceFixture(mode, false)
    const result = await f.extract()
    const run = await store.getRun(result.applicationRunId!)
    expect(run?.items.map(item => [item.disposition, item.failureCode])).toEqual([
      ['committed', null], ['committed', null], ['committed', null],
    ])
    expect(result.applicationState).toBe('complete')
    const outputs = await crmSourceOutputs(f.input)
    expect(outputs.map(row => row.kind)).toEqual(['company', 'person'])
    for (const row of outputs) expect(row).toMatchObject({ user_id: null, assistant_id: f.input.assistantId, sensitivity: 'confidential',
      compartments: f.compartments, project_ids: f.projectIds })
  })

  it('initializes the legacy policy revision for an installation with no setup row', async () => {
    const f = await crmSourceFixture('legacy', true)
    await removeFixtureWorkspacePolicy(f.input.workspaceId)
    const policy = async () => (await pool.query('SELECT setup_state FROM workspace_access_policies WHERE workspace_id=$1', [f.input.workspaceId])).rows
    expect(await policy()).toEqual([])

    const result = await f.extract()
    expect(result).toMatchObject({ applicationState: 'complete', applicationCounts: { committed: 3 } })
    expect(await policy()).toEqual([{ setup_state: 'legacy' }])
    expect((await pool.query(`SELECT d.source_policy_revision BETWEEN 1 AND p.revision AS valid_revision
      FROM scope_derivations d JOIN workspace_access_policies p USING (workspace_id)
      WHERE d.workspace_id=$1 AND d.resource_kind='entity'`, [f.input.workspaceId])).rows)
      .toEqual([{ valid_revision: true }, { valid_revision: true }])
  })

  it('holds direct CRM writes when the app-role source workspace has no policy', async () => {
    const f = await crmSourceFixture('legacy', true)
    await removeFixtureWorkspacePolicy(f.input.workspaceId)
    const input = { workspaceId: f.input.workspaceId, sourceEpisodeId: f.input.episodeId,
      source: 'extracted' as const, sensitivity: 'confidential' as const, compartments: f.compartments, projectIds: f.projectIds }
    await expect(createContact(f.input.sourceActorId, { ...input, name: CONTACT_NAME, email: CONTACT_EMAIL }))
      .rejects.toMatchObject({ code: 'application_crm_policy_unavailable' })
    await expect(createCompany(f.input.sourceActorId, { ...input, name: COMPANY_NAME, domain: COMPANY_DOMAIN }))
      .rejects.toMatchObject({ code: 'application_crm_policy_unavailable' })
    expect(await crmSourceOutputs(f.input)).toEqual([])
    expect((await pool.query('SELECT workspace_id FROM workspace_access_policies WHERE workspace_id=$1', [f.input.workspaceId])).rows).toEqual([])
  })

  it.each(['legacy', 'ready'] as const)('preserves scope on the direct Pipeline B CRM compatibility path (%s)', async (mode) => {
    const f = await crmSourceFixture(mode, true)
    expect(await f.extract({ durable: false })).toMatchObject({ extracted: true })
    const outputs = await crmSourceOutputs(f.input)
    expect(outputs.map(row => row.kind)).toEqual(['company', 'person'])
    for (const row of outputs) expect(row).toMatchObject({ user_id: f.input.sourceActorId,
      assistant_id: f.input.assistantId, sensitivity: 'confidential', compartments: f.compartments, project_ids: f.projectIds })
  })

  it.each([true, false])('keeps existing shared CRM records intact when the Episode is private (durable=%s)', async (durable) => {
    const f = await crmSourceFixture('legacy', true)
    const scope = { workspaceId: f.input.workspaceId, compartments: f.compartments,
      projectIds: f.projectIds, sensitivity: 'confidential' as const }
    const contact = await createContact(f.input.sourceActorId, {
      ...scope, name: CONTACT_NAME, phone: '+12025550102', stableIdentity: f.identity,
    })
    const company = await createCompany(f.input.sourceActorId, { ...scope, name: COMPANY_NAME, domain: COMPANY_DOMAIN })
    const readExisting = async () => (await pool.query(`SELECT id,user_id,assistant_id,aliases,attributes,
      scope_version,valid_to FROM entities WHERE id=ANY($1) ORDER BY kind`, [[contact.id, company.id]])).rows
    const before = await readExisting()
    const result = await f.extract({ durable })
    if (durable) {
      const run = (await store.getRun(result.applicationRunId!))!
      expect(run.items.filter(item => item.primitiveKind === 'entity')).toEqual([
        expect.objectContaining({ disposition: 'held', failureCode: 'application_entity_scope_mismatch', targetRecordId: null }),
        expect.objectContaining({ disposition: 'held', failureCode: 'application_entity_scope_mismatch', targetRecordId: null }),
      ])
    } else {
      expect(result.entitiesWritten).toEqual([])
    }
    expect(await readExisting()).toEqual(before)
    expect(await crmSourceOutputs(f.input)).toEqual([])
  })

  it('holds or preserves Episode lineage when adding detail to an existing private CRM record', async () => {
    const f = await crmSourceFixture('legacy', true)
    const scope = { workspaceId: f.input.workspaceId, userId: f.input.sourceActorId,
      assistantId: f.input.assistantId, createdByUserId: f.input.sourceActorId,
      compartments: f.compartments, projectIds: f.projectIds, sensitivity: 'confidential' as const, source: 'user' as const }
    const contact = await createEntity({ ...scope, kind: 'person', displayName: CONTACT_NAME,
      attributes: { phone: '+12025550102' } })
    expect(await bindImportedCrmIdentity({ workspaceId: f.input.workspaceId, entityId: contact.id,
      identity: f.identity, sensitivity: 'confidential' })).toMatchObject({ status: 'bound' })
    await createEntity({ ...scope, kind: 'company', displayName: COMPANY_NAME, canonicalId: COMPANY_DOMAIN,
      attributes: { note: 'Existing private details' } })
    const readExisting = async (kind: string) => (await pool.query(`SELECT id,attributes,canonical_id,scope_version,valid_to
      FROM entities WHERE workspace_id=$1 AND kind=$2 ORDER BY id`, [f.input.workspaceId, kind])).rows
    const before = await Promise.all(['person', 'company'].map(readExisting))
    const result = await f.extract()
    const run = (await store.getRun(result.applicationRunId!))!
    const plan = (await pool.query('SELECT frozen_plan FROM episode_extraction_runs WHERE id=$1', [run.id])).rows[0].frozen_plan
    const derivedIds: string[] = []

    for (const [index, kind] of ['person', 'company'].entries()) {
      const candidate = plan.candidates.find((value: { payload?: { entityKind?: string } }) => value.payload?.entityKind === kind)
      const item = run.items.find(value => value.candidateId === candidate.candidateId)!
      if (isDeepStrictEqual(await readExisting(kind), before[index])) {
        if (item.disposition === 'committed') expect(item.targetRecordId).toBe(before[index][0].id)
        else expect(item, `${kind} ${item.failureCode}`).toMatchObject({ disposition: 'held', targetRecordId: null })
        continue
      }
      expect(item).toMatchObject({ disposition: 'committed', targetRecordId: expect.any(String) })
      const lineage = await pool.query(`SELECT 1 FROM scope_derivations d JOIN scope_derivation_sources s ON s.derivation_id=d.id
        WHERE d.resource_kind='entity' AND d.resource_id=$1 AND s.source_kind='episode' AND s.source_id=$2`,
      [item.targetRecordId, f.input.episodeId])
      expect(lineage.rowCount).toBeGreaterThan(0)
      derivedIds.push(item.targetRecordId!)
    }
    await pool.query('UPDATE episodes SET scope_held=true WHERE id=$1', [f.input.episodeId])
    const held = await pool.query('SELECT scope_held FROM entities WHERE id=ANY($1)', [derivedIds])
    expect(held.rows).toEqual(derivedIds.map(() => ({ scope_held: true })))
  })

  it('leaves no CRM writes or effective receipts when the source envelope is widened', async () => {
    const f = await crmSourceFixture('ready', true)
    const plan = frozenContactPlan(f, { userId: null, assistantId: null, sensitivity: 'internal', compartments: [], projectIds: [] })
    const applied = await f.application.apply({ ...f.authority, attemptKey: 'initial:crm-scope-mismatch', plan })
    expect(applied.items[0]).toMatchObject({ disposition: 'held', failureCode: 'application_crm_source_changed', retryable: false, targetRecordId: null })
    expect(await crmSourceOutputs(f.input)).toEqual([])
    expect((await pool.query("SELECT id FROM scope_derivations WHERE workspace_id=$1 AND resource_kind='entity'", [f.input.workspaceId])).rows).toEqual([])
  })

  it('rejects another workspace member and stale evidence before applying a private CRM candidate', async () => {
    const f = await crmSourceFixture('ready', true)
    const plan = frozenContactPlan(f)
    const attemptKey = 'initial:crm-source-reauthorization'
    const run = await store.ensureRun({ ...f.authority, episodeId: f.input.episodeId, attemptKey, plan, extractionState: 'succeeded' })
    await expect(f.application.apply({ ...f.authority, actorUserId: f.input.replayActorId, attemptKey, plan }))
      .rejects.toMatchObject({ code: 'forbidden' })
    expect((await store.getRun(run.id))?.items[0]).toMatchObject({ disposition: 'pending', receiptId: null, attemptCount: 0 })
    await pool.query("UPDATE episodes SET sensitivity='internal' WHERE id=$1", [f.input.episodeId])
    await expect(f.application.apply({ ...f.authority, attemptKey, plan })).rejects.toMatchObject({ code: 'conflict' })
    expect((await store.getRun(run.id))?.items[0]).toMatchObject({ disposition: 'pending', receiptId: null, attemptCount: 0 })
    expect(await crmSourceOutputs(f.input)).toEqual([])
  })

  it('rebuilds verified lineage when resuming a pending older CRM plan', async () => {
    const f = await crmSourceFixture('ready', true)
    await pool.query("UPDATE workspace_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2",
      [f.input.workspaceId, f.input.sourceActorId])
    const plan = frozenContactPlan(f, { derivation: undefined })
    expect(plan.candidates[0].payload).not.toHaveProperty('derivation')
    const run = await store.ensureRun({ ...f.authority, episodeId: f.input.episodeId,
      attemptKey: 'initial:older-crm-plan', plan, extractionState: 'succeeded' })
    const access = ctx(f.input, { userId: f.input.sourceActorId, compartments: f.compartments,
      mutationCompartments: f.compartments, projectIds: f.projectIds })
    await expect(f.application.retry({ ctx: access, runId: run.id, episodeId: f.input.episodeId, expectedPlanHash: plan.planHash }))
      .resolves.toMatchObject({ applicationState: 'complete', counts: { committed: 1 }, resumable: false })
    const [row] = await crmSourceOutputs(f.input)
    expect(row).toMatchObject({ kind: 'person', user_id: f.input.sourceActorId, assistant_id: f.input.assistantId,
      sensitivity: 'confidential', compartments: f.compartments, project_ids: f.projectIds })
    expect((await pool.query(`SELECT s.source_id,s.source_version FROM scope_derivations d
      JOIN scope_derivation_sources s ON s.derivation_id=d.id WHERE d.resource_id=$1 AND s.source_kind='episode'`, [row.id])).rows)
      .toEqual([{ source_id: f.input.episodeId, source_version: plan.sourceScopeVersion }])
  })
})
