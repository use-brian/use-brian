/** [COMP:api/native-chat-read-cost] Canonical media provenance survives fresh native transcript proofs. */
import { ContextScopeAccumulator, type ExecutionContext, type ScopeSource, type SessionContextAuthority } from '@use-brian/core'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { PoolClient } from 'pg'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyRLSGucs, getAppPool, getPool, rollbackAndRelease, runWithAgentAccess } from '../../db/client.js'
import { createPersonalWebSession } from '../../db/sessions.js'
import { authSessionStore } from '../../db/auth-session-store.js'
import { findAssistantById } from '../../db/users.js'
import { resolveExecutionContextSystem } from '../../context-scope/execution-context.js'
import { readAdmittedSessionQuery } from '../../db/session-query-reader.js'
import { publishNativeSessionMessage } from '../../db/session-message-publication.js'
import { validateCallerScopeEvidence } from '../../context-scope/caller-evidence.js'
import { createRecordingTranscriptFixture } from '../../__tests__/fixtures/recording-transcript-chain.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const dependencyMigration = await readFile(new URL('../../../migrations/8262_native_media_admission_dependency.sql', import.meta.url), 'utf8')
const dependencySignatures = (JSON.parse(dependencyMigration.split('$media_dependencies$')[1]) as Array<{ signature: string }>).map(value => value.signature)

describe.sequential('[COMP:api/native-chat-read-cost] recording-derived file ancestry', () => {
  let fixture: Awaited<ReturnType<typeof persistentContextFixture>>
  let media: Awaited<ReturnType<typeof createRecordingTranscriptFixture>>
  let authority: SessionContextAuthority
  let sources: ScopeSource[]

  beforeEach(async () => {
    fixture = await persistentContextFixture()
    authority = { execution: await fixture.execution(), accumulator: new ContextScopeAccumulator() }
    media = await createRecordingTranscriptFixture(authority)
    const history = await fixture.history()
    await readAdmittedSessionQuery({ sessionId: fixture.session.id, throughSequence: history.at(-1)!.sequenceNum, authority })
    // Immutable observed metadata is an input, never a grant. The actual app_user
    // reader below independently admits every parent through canonical ports.
    const file = (await fixture.pool.query<{ source: ScopeSource }>(`SELECT jsonb_build_object('workspaceId',workspace_id,
      'userId',user_id,'assistantId',assistant_id,'sensitivity',sensitivity,'compartments',compartments,'projectIds',project_ids,
      'resourceKind','workspace_file','resourceId',id,'version',scope_version::text) source FROM workspace_files WHERE id=$1`,
    [media.transcriptFileId])).rows[0].source
    authority.accumulator.note({ sources: [file] })
    sources = authority.accumulator.evidence.sources!
  })
  afterEach(async () => {
    if (!fixture) return
    await fixture.pool.query('DELETE FROM recordings WHERE workspace_id=$1', [fixture.workspaceId])
    await fixture.cleanup()
  })
  afterAll(async () => { await getAppPool().end(); await getPool().end() })

  async function proof(input = sources, actor = fixture.ownerId, current?: ExecutionContext) {
    const execution = current ?? await fixture.execution(actor), client = await getAppPool().connect()
    try {
      return await runWithAgentAccess(execution.security.access, async () => {
        await client.query('BEGIN')
        await applyRLSGucs(client, actor)
        await client.query("SET LOCAL statement_timeout='15s'")
        return (await client.query<{ value: { admitted: true; immutable: ScopeSource[]; current: ScopeSource[] } | null }>(
          'SELECT read_native_turn_scope_evidence($1,$2) value', [fixture.workspaceId,
            JSON.stringify(input.map(source => ({ kind: source.resourceKind, id: source.resourceId, version: source.version })))])).rows[0].value
      })
    } finally { await rollbackAndRelease(client) }
  }

  it.each(['owner', 'member'] as const)('admits genuine recording ancestry for the actual %s principal', async role => {
    const result = await proof(sources, role === 'owner' ? fixture.ownerId : fixture.firstId)
    expect(result?.admitted).toBe(true)
    for (const [resourceKind, resourceId] of [['episode', media.episodeId], ['recording', media.recordingId], ['workspace_file', media.mediaFileId]]) {
      expect(result?.current).toContainEqual(expect.objectContaining({ resourceKind, resourceId, sensitivity: 'internal', userId: null }))
    }
    expect(result?.immutable.every(source => ['application_field', 'session_context_revision'].includes(source.resourceKind))).toBe(true)
  })

  it('refuses private recording provenance to another workspace member', async () => {
    const device = (await authSessionStore.create(fixture.ownerId, { deviceLabel: 'Fictional private media browser', userAgent: null, ipAddress: null }))!
    const session = await createPersonalWebSession({ assistantId: fixture.assistantId, userId: fixture.ownerId,
      channelType: 'web', channelId: randomUUID(), workspaceId: fixture.workspaceId, appOrigin: 'chat' },
    { actorUserId: fixture.ownerId, authSessionId: device.id, authVersion: device.authVersion })
    const { executionContext: execution } = await resolveExecutionContextSystem({ userId: fixture.ownerId,
      workspaceId: fixture.workspaceId, assistant: (await findAssistantById(fixture.assistantId))!, memberMode: 'member',
      sharedAudience: false, session, sessionAuthority: session,
      identity: { kind: 'attended', principal: { kind: 'workspace_member', userId: fixture.ownerId, authenticationKind: 'native_session' } },
      ownership: { kind: 'workspace', workspaceId: fixture.workspaceId }, lifecycle: { sessionId: session.id, sessionPersisted: true,
        channelType: 'web', channelId: session.channelId, abortSignal: new AbortController().signal } })
    const privateAuthority = { execution, accumulator: new ContextScopeAccumulator() }
    const privateMedia = await createRecordingTranscriptFixture(privateAuthority, 'Fictional private recording', { privateOwner: true })
    const privateSource = (await fixture.pool.query<{ source: ScopeSource }>(`SELECT jsonb_build_object('workspaceId',workspace_id,
      'userId',user_id,'assistantId',assistant_id,'sensitivity',sensitivity,'compartments',compartments,'projectIds',project_ids,
      'resourceKind','workspace_file','resourceId',id,'version',scope_version::text) source FROM workspace_files WHERE id=$1`,
    [privateMedia.transcriptFileId])).rows[0].source
    expect(privateSource.userId).toBe(fixture.ownerId)
    const input = [privateSource]
    expect((await proof(input, fixture.ownerId, execution))?.admitted).toBe(true)
    expect(await proof(input, fixture.firstId)).toBeNull()
  })

  it('retains every media ancestor through a published reply and a fresh subsequent history query', async () => {
    const reply = await publishNativeSessionMessage({ sessionId: fixture.session.id, role: 'assistant',
      content: [{ type: 'text', text: 'Fictional reply derived from the admitted recording transcript.' }],
      senderAssistantId: fixture.assistantId, authority, derivationTarget: fixture.envelope,
      derivation: { producer: 'fixture:recording-history', sources } })
    const next = { execution: await fixture.execution(), accumulator: new ContextScopeAccumulator() }
    await readAdmittedSessionQuery({ sessionId: fixture.session.id, throughSequence: reply.sequenceNum, authority: next })
    const nextSources = next.accumulator.evidence.sources!
    expect(nextSources.every(source => source.resourceKind === 'application_field')).toBe(true)
    const result = await proof(nextSources)
    expect(result?.admitted).toBe(true)
    expect(result?.current).toContainEqual(expect.objectContaining({ resourceKind: 'recording', resourceId: media.recordingId }))
    expect(result?.current).toContainEqual(expect.objectContaining({ resourceKind: 'workspace_file', resourceId: media.mediaFileId }))
  })

  it.each(['workspace_file', 'episode', 'recording'] as const)('refuses a freshly held %s ancestor', async kind => {
    const id = kind === 'workspace_file' ? media.mediaFileId : media.recordingId
    if (kind === 'recording') await fixture.pool.query('UPDATE recordings SET scope_held=true WHERE id=$1', [id])
    else await fixture.pool.query(`INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,
      review_state,classification_revision,holding_reason) VALUES($1,$2,$3,'1','held',1,'Fictional source review')`,
    [fixture.workspaceId, kind, id])
    await expect(proof()).rejects.toMatchObject({ code: '42501', message: 'scope_operation_denied' })
    const client = await getAppPool().connect()
    const queries: string[] = []
    const observed = { query: ((sql: string, values?: unknown[]) => {
      queries.push(sql)
      return client.query(sql, values)
    }) as PoolClient['query'] }
    try {
      await expect(runWithAgentAccess(authority.execution.security.access, async () => {
        await client.query('BEGIN'); await applyRLSGucs(client, fixture.ownerId)
        return validateCallerScopeEvidence({ sources }, authority.execution.security.ceiling, observed)
      })).rejects.toMatchObject({ reason: 'caller_evidence_unavailable', diagnostic: 'source_unverifiable',
        verificationPhase: 'native_proof', verificationSqlstateClass: '42' })
      expect(queries).toHaveLength(1)
      expect(queries.some(sql => sql.includes('read_native_session_field_dependencies'))).toBe(false)
    } finally { await rollbackAndRelease(client) }
  })

  it('keeps a held physical query candidate on the original fallback path', async () => {
    const reply = await publishNativeSessionMessage({ sessionId: fixture.session.id, role: 'assistant',
      content: [{ type: 'text', text: 'Fictional earlier media-backed reply.' }], senderAssistantId: fixture.assistantId,
      authority, derivationTarget: fixture.envelope, derivation: { producer: 'fixture:query-candidate', sources } })
    await fixture.pool.query(`INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,
      review_state,classification_revision,holding_reason) VALUES($1,'workspace_file',$2,'1','held',1,'Fictional candidate hold')`,
    [fixture.workspaceId, media.mediaFileId])
    const client = await getAppPool().connect()
    try {
      await runWithAgentAccess(authority.execution.security.access, async () => {
        await client.query('BEGIN'); await applyRLSGucs(client, fixture.ownerId)
        await client.query("SET LOCAL statement_timeout='15s'")
        // This is selector acquisition, not a declaration that every physical
        // candidate is factual input. It must not inherit the42501 fast denial.
        expect((await client.query('SELECT read_native_turn_session_query($1,$2,$3,$3) value',
          [fixture.workspaceId, fixture.session.id, reply.sequenceNum])).rows[0].value).toBeNull()
      })
    } finally { await rollbackAndRelease(client) }
  })

  it('refuses each permissive canonical admission callee until its exact catalog contract is restored', async () => {
    for (const signature of dependencySignatures) {
      const saved = (await fixture.pool.query<{ definition: string; body: string; routine: unknown; language: string }>(
        `SELECT pg_get_functiondef(p.oid) definition,p.prosrc body,to_jsonb(p) routine,l.lanname language
         FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=$1::regprocedure`, [signature])).rows[0]
      try {
        // This isolated owned fixture temporarily commits the mutation so the
        // independent real app_user connection sees it. No policy is mocked.
        const permissive = saved.language === 'sql' ? 'SELECT true' : 'BEGIN RETURN true;END'
        await fixture.pool.query(saved.definition.replace(saved.body, () => permissive))
        expect(await proof()).toBeNull()
      } finally {
        await fixture.pool.query(saved.definition)
        expect((await fixture.pool.query('SELECT to_jsonb(p) routine FROM pg_proc p WHERE p.oid=$1::regprocedure', [signature])).rows[0].routine).toEqual(saved.routine)
      }
      expect((await proof())?.admitted).toBe(true)
    }
  })

  it('falls back for an episode outside the canonical recording family', async () => {
    await fixture.pool.query("UPDATE episodes SET source_kind='manual',user_id=$2 WHERE id=$1", [media.episodeId, fixture.ownerId])
    expect(await proof()).toBeNull()
  })

  it('rejects the persisted transcript hold caused by recording retirement', async () => {
    await fixture.pool.query('UPDATE recordings SET valid_to=now() WHERE id=$1', [media.recordingId])
    const state = (await fixture.pool.query(`SELECT r.scope_held recording_held,r.valid_to IS NOT NULL retired,
      (SELECT scope_held FROM workspace_files WHERE id=$2) transcript_held,
      (SELECT scope_held FROM workspace_files WHERE id=$3) media_held,
      (SELECT scope_held FROM episodes WHERE id=$1) episode_held,
      (SELECT count(*)::int FROM scope_resource_states WHERE workspace_id=$4) review_markers
      FROM recordings r WHERE r.id=$1`, [media.recordingId, media.transcriptFileId, media.mediaFileId, fixture.workspaceId])).rows[0]
    expect(state).toEqual({ recording_held: false, retired: true, transcript_held: true,
      media_held: false, episode_held: false, review_markers: 0 })
    await expect(proof()).rejects.toMatchObject({ code: '42501', message: 'scope_operation_denied' })
  })

  it('keeps an unheld retired transcript root on the original fallback path', async () => {
    await fixture.pool.query('UPDATE workspace_files SET valid_to=now() WHERE id=$1', [media.transcriptFileId])
    expect((await fixture.pool.query(`SELECT scope_held,valid_to IS NOT NULL retired,
      (SELECT count(*)::int FROM scope_resource_states WHERE workspace_id=$2) review_markers
      FROM workspace_files WHERE id=$1`, [media.transcriptFileId, fixture.workspaceId])).rows[0])
      .toEqual({ scope_held: false, retired: true, review_markers: 0 })
    expect(await proof()).toBeNull()
  })
})
