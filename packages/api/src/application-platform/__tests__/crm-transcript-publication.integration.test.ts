import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { ContextScopeAccumulator, boundScopeSources, pinAccessCeiling, type ScopeSource } from '@use-brian/core'
import { getAppPool, getPool } from '../../db/client.js'
import { createDeal } from '../../db/crm.js'
import { addSessionMessage, findOrCreateSession } from '../../db/sessions.js'
import { findAssistantById } from '../../db/users.js'
import { publishNativeSessionMessageBatch } from '../../db/session-message-publication.js'
import { withSessionMessagePublication } from '../../db/session-context-revisions.js'
import { resolveExecutionContextSystem } from '../../context-scope/execution-context.js'
import { resolveTurnScopeSystem, turnOutputWrite } from '../../context-scope/resolve-turn-scope.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

describe.sequential('[COMP:api/application-persistence] delegated CRM transcript publication', () => {
  let fixture: Awaited<ReturnType<typeof persistentContextFixture>> | undefined
  afterEach(async () => { await fixture?.cleanup(); fixture = undefined })
  afterAll(async () => { await getAppPool().end(); await getPool().end() })

  async function setup() {
    fixture = await persistentContextFixture()
    const f = fixture, entity = await createDeal(f.ownerId, { workspaceId: f.workspaceId }), eventId = randomUUID()
    await f.pool.query(`INSERT INTO crm_domain_event_outbox(id,workspace_id,event_type,event_key,subject_kind,subject_id,payload,actor_kind)
      VALUES($1::uuid,$2,'crm.deal.stage_changed',$1::text,'deal',$3,'{}','user')`, [eventId, f.workspaceId, entity.id])
    const sources = (await f.pool.query<{ source: ScopeSource }>(`SELECT jsonb_build_object(
      'workspaceId',source->'workspaceId','userId',source->'userId','assistantId',source->'assistantId',
      'sensitivity',source->'sensitivity','compartments',source->'compartments','projectIds',source->'projectIds',
      'resourceKind',kind,'resourceId',id,'version',source->'version') AS source
      FROM (SELECT kind,id,read_scope_source($1,kind,id) AS source
        FROM (VALUES('crm_event'::text,$2::uuid),('entity'::text,$3::uuid)) input(kind,id)) snapshots`,
    [f.workspaceId, eventId, entity.id])).rows.map(row => row.source)
    const session = await findOrCreateSession({ assistantId: f.assistantId, userId: f.ownerId,
      workspaceId: f.workspaceId, channelType: 'assistant-call', channelId: `workflow-run:${randomUUID()}`,
      contextCompartments: [], contextGroupId: null, contextProjectId: null })
    const assistant = (await findAssistantById(f.assistantId))!
    const parent = await resolveTurnScopeSystem({ userId: f.ownerId, workspaceId: f.workspaceId, assistant, session })
    const { executionContext: execution } = await resolveExecutionContextSystem({
      userId: f.ownerId, workspaceId: f.workspaceId, assistant, session, sessionAuthority: session,
      identity: { kind: 'delegated', actorUserId: f.ownerId, delegationId: randomUUID(), parentCeiling: pinAccessCeiling(parent.access) },
      ownership: { kind: 'workspace', workspaceId: f.workspaceId }, lifecycle: { sessionId: session.id,
        channelId: session.channelId, channelType: 'assistant-call', abortSignal: new AbortController().signal },
    })
    const accumulator = new ContextScopeAccumulator({ sources }), authority = { execution, accumulator }
    const envelope = { ...f.envelope, userId: f.ownerId }
    const write = turnOutputWrite({ producer: 'turn:delegated-input', accumulator, envelope })
    if (!('derivation' in write)) throw new Error('CRM fixture did not produce canonical derivation')
    const message = { role: 'user', content: [{ type: 'text', text: 'Fictional CRM enquiry notification' }] }
    return { f, eventId, entity, session, sources, authority, write, message }
  }

  type Prepared = Awaited<ReturnType<typeof setup>>
  async function publish(current: Prepared, mode: 'single' | 'batch', sources = current.sources) {
    const { session, authority, write, message } = current
    const params = { sessionId: session.id, authority, ...write, derivation: { ...write.derivation, sources } }
    return mode === 'single' ? [await addSessionMessage({ ...params, ...message })]
      : publishNativeSessionMessageBatch({ ...params, messages: [message,
        { role: 'assistant', content: [{ type: 'text', text: 'Fictional saved enquiry response' }] }] })
  }

  async function assertNothingSaved(current: Prepared) {
    const { f, session } = current
    expect((await f.pool.query('SELECT id FROM session_messages WHERE session_id=$1', [session.id])).rows).toEqual([])
    expect((await f.pool.query(`SELECT id FROM scope_derivations
      WHERE workspace_id=$1 AND resource_kind='session_message'`, [f.workspaceId])).rows).toEqual([])
  }

  // Enter with the real original sources, then independently challenge SQL at
  // its publication boundary. The TypeScript validator cannot mask a SQL gap.
  async function publishSql(current: Prepared, mode: 'single' | 'batch', sources: ScopeSource[], mutateEvent?: 'changed' | 'retired') {
    const { f, session, authority, write, message } = current
    const payload = { ...message, channelMessageId: null, senderUserId: null, senderAssistantId: null, attachments: [] }
    const mutation = 'fixture_crm_' + randomUUID().replaceAll('-', '')
    // A real source change in the admitted transaction, without replacing a
    // policy/reader. Its owner function can touch only this disposable event.
    if (mutateEvent) {
      const patch = mutateEvent === 'changed' ? "payload='{\"changed\":true}'"
        : "retired_from_status=status,retired_at=now(),status='retired',subject_id='00000000-0000-0000-0000-000000000000',payload=jsonb_build_object('erased',true,'eventType',event_type)"
      await f.pool.query(`CREATE FUNCTION public.${mutation}() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture$
        UPDATE crm_domain_event_outbox SET ${patch} WHERE id='${current.eventId}'::uuid AND workspace_id='${f.workspaceId}'::uuid;$fixture$;
        REVOKE ALL ON FUNCTION public.${mutation}() FROM PUBLIC;GRANT EXECUTE ON FUNCTION public.${mutation}() TO app_user;`)
    }
    try {
      return await withSessionMessagePublication(authority, current.sources, async db => {
        if (mutateEvent) await db.query(`SELECT public.${mutation}()`)
        return db.query(mode === 'single' ? 'SELECT publish_native_session_message($1,$2,$3,$4,$5,$6)'
          : 'SELECT publish_native_session_message_batch($1,$2,$3,$4,$5,$6)',
        [f.workspaceId, session.id, JSON.stringify(mode === 'single' ? payload : [payload, payload]),
          write.derivation.producer, JSON.stringify(sources), write.derivationTarget])
      })
    } finally { if (mutateEvent) await f.pool.query(`DROP FUNCTION public.${mutation}()`) }
  }

  it.each(['single', 'batch'] as const)('persists the first %s delegated CRM prompt with complete causal lineage', async mode => {
    const current = await setup(), { f, sources, session } = current
    expect((await f.pool.query("SELECT scope_source_table('crm_event') AS editable")).rows[0].editable).toBeNull()
    const rows = await publish(current, mode)
    expect(rows.map(row => row.sequenceNum)).toEqual(mode === 'single' ? [1] : [1, 2])
    for (const row of rows) {
      expect(row.sessionId).toBe(session.id)
      expect(boundScopeSources(row)).toMatchObject([{ resourceKind: 'session_message', resourceId: row.id }])
      const edges = (await f.pool.query(`SELECT e.source_kind,e.source_id,e.source_version FROM scope_derivations d
        JOIN scope_derivation_sources e ON e.workspace_id=d.workspace_id AND e.derivation_id=d.id
        WHERE d.workspace_id=$1 AND d.resource_kind='session_message' AND d.resource_id=$2`, [f.workspaceId, row.id])).rows
      expect(edges.map(edge => [edge.source_kind, edge.source_id, edge.source_version]).sort())
        .toEqual(sources.map(source => [source.resourceKind, source.resourceId, source.version]).sort())
    }
  })

  it.each(['single', 'batch'] as const)('refuses a %s CRM prompt without the live causal entity', async mode => {
    const current = await setup()
    await expect(publish(current, mode, current.sources.filter(source => source.resourceKind === 'crm_event')))
      .rejects.toThrow(/scope_source_changed|caller_evidence_unavailable/)
    await assertNothingSaved(current)
  })

  for (const mode of ['single', 'batch'] as const) {
    it.each(['changed', 'retired'] as const)(`refuses ${mode} publication after its CRM event is %s`, async state => {
      const current = await setup(), { f, eventId } = current
      if (state === 'changed') await f.pool.query("UPDATE crm_domain_event_outbox SET payload='{\"changed\":true}' WHERE id=$1", [eventId])
      else await f.pool.query(`UPDATE crm_domain_event_outbox SET retired_from_status=status,retired_at=now(),status='retired',
        subject_id='00000000-0000-0000-0000-000000000000',payload=jsonb_build_object('erased',true,'eventType',event_type) WHERE id=$1`, [eventId])
      await expect(publish(current, mode)).rejects.toThrow(/scope_source_changed|caller_evidence_unavailable/)
      await assertNothingSaved(current)
    })
    it.each(['unknown-kind', 'altered-labels', 'malformed-envelope'] as const)(`refuses ${mode} publication with %s evidence`, async change => {
      const current = await setup()
      const sources = current.sources.map(source => source.resourceKind !== 'crm_event' ? source : change === 'unknown-kind'
        ? { ...source, resourceKind: 'fictional_unknown_source' }
        : change === 'altered-labels' ? { ...source, sensitivity: 'public' as const }
        : { ...source, projectIds: undefined } as unknown as ScopeSource)
      await expect(publish(current, mode, sources)).rejects.toThrow(/scope_evidence_missing|scope_source_changed|caller_evidence_unavailable/)
      await assertNothingSaved(current)
    })
    it.each(['missing-entity', 'unknown-kind', 'altered-labels', 'malformed-envelope'] as const)(`SQL independently refuses ${mode} publication with %s`, async change => {
      const current = await setup()
      const sources = change === 'missing-entity' ? current.sources.filter(source => source.resourceKind === 'crm_event')
        : current.sources.map(source => source.resourceKind !== 'crm_event' ? source : change === 'unknown-kind'
          ? { ...source, resourceKind: 'fictional_unknown_source' }
          : change === 'altered-labels' ? { ...source, sensitivity: 'public' as const }
          : { ...source, projectIds: undefined } as unknown as ScopeSource)
      await expect(publishSql(current, mode, sources)).rejects.toThrow(/scope_evidence_missing|scope_source_changed/)
      await assertNothingSaved(current)
    })
    it.each(['changed', 'retired'] as const)(`SQL independently refuses ${mode} publication after its admitted CRM event is %s`, async state => {
      const current = await setup()
      await expect(publishSql(current, mode, current.sources, state)).rejects.toThrow('scope_source_changed')
      await assertNothingSaved(current)
    })
  }
})
